import { normalizePath, Platform, type App, type Plugin, type Vault } from "obsidian";
import { commitDeviceLabel, deviceLabel, type DevicePlatform } from "../device-label";
import { UploadGuard, type HeldNote, type HoldReason, type UploadGuardLike } from "../enclave/upload-guard";
import { GitLabClient } from "../gitlab/client";
import type {
  CreatedGitLabCommit,
  GitLabBranch,
  GitLabCommitAction,
  GitLabTreeItem,
} from "../gitlab/types";
import type Logger from "../logger";
import { ChangeJournal } from "./change-journal";
import { IgnoreMatcher } from "./ignore-matcher";
import { LocalMaterializer } from "./local-materializer";
import { LocalSnapshotService, type LocalSnapshotEntry, type VersionState } from "./local-snapshot";
import { calculateGitBlobId, toBase64 } from "./conflict-resolver";
import { DeviceSpecificPaths } from "./device-specific";
import { describeChanges, isNoteworthy, withEntry, type SyncChanges } from "./sync-history";
import { RemoteDiffService, type RemoteChange, type RemoteDiffClient } from "./remote-diff";
import type { StateStore } from "./state-store";
import { SyncPlanner, type SyncPlan } from "./sync-planner";
import type {
  DirtyEntry,
  GitLabSyncSettings,
  MaterializeOperation,
  PendingTransaction,
  PluginData,
  SyncHistoryEntry,
  TrackedFile,
} from "./types";

export interface SyncResult {
  status: "success" | "conflict" | "error" | "already-running";
  trigger: SyncTrigger;
  message: string;
  commitSha?: string;
  recovered?: boolean;
  attempts?: number;
  /** Notes not uploaded this time because their plain text must not leave the device. */
  held?: HeldNote[];
  /** Files written or deleted in this vault. */
  pulled?: number;
  /** Files created, changed or deleted on GitLab. */
  pushed?: number;
  /** What changed, file by file, for the sync history. */
  changes?: SyncChanges;
}

export type SyncTrigger =
  | "startup"
  | "manual"
  | "audit"
  | "foreground"
  | "background"
  | "edit"
  | "interval";

export interface ConflictFile {
  filePath: string;
  remoteContent: string;
  localContent: string;
}

export interface ConflictResolution {
  filePath: string;
  content: string;
}

interface GitLabClientLike {
  getBranch(): Promise<GitLabBranch>;
  validateAccess?(): Promise<void>;
  getRawBlob(blobId: string): Promise<ArrayBuffer | null>;
  getRawFile(path: string, ref: string): Promise<ArrayBuffer | null>;
  getTree(ref: string): Promise<GitLabTreeItem[]>;
  createCommit(input: {
    message: string;
    actions: SyncPlan["actions"];
  }): Promise<CreatedGitLabCommit>;
}

interface RemoteDiffLike {
  discover(input: {
    baseSha: string;
    remoteSha: string;
    baseIndex: Record<string, TrackedFile>;
  }): Promise<{
    changes: RemoteChange[];
    remoteTree?: Record<string, TrackedFile>;
    usedFallback: boolean;
  }>;
}

interface IgnoreMatcherLike {
  reload(): Promise<void>;
  isIgnored(path: string, trackedFiles: Record<string, TrackedFile>): boolean;
  isDirIgnored?(path: string): boolean;
}

interface LocalSnapshotLike {
  snapshot(
    entries: DirtyEntry[],
    tracked: Record<string, TrackedFile>,
  ): Promise<LocalSnapshotEntry[]>;
}

interface PlannerLike {
  plan(input: {
    baseSha: string;
    remoteSha: string;
    trackedFiles: Record<string, TrackedFile>;
    dirtyEntries: DirtyEntry[];
    remoteChanges: RemoteChange[];
    localSnapshots: LocalSnapshotEntry[];
    now: Date;
  }): Promise<SyncPlan>;
}

interface JournalLike {
  start?(): void;
  stop?(): Promise<void>;
  list(): DirtyEntry[];
  recordUpsert?(path: string): Promise<void>;
  recordDelete?(path: string): Promise<void>;
  suppress<T>(operation: () => Promise<T>): Promise<T>;
}

interface MaterializerLike {
  apply(operations: MaterializeOperation[]): Promise<void>;
  recoverPendingTransaction(): Promise<boolean>;
}

interface ProgressNotice {
  setMessage?(message: string): void;
  hide?(): void;
}

export interface SyncManagerOptions {
  app?: App;
  vault?: Vault;
  plugin?: Plugin;
  stateStore: Pick<StateStore, "load" | "save" | "update">;
  settings?: GitLabSyncSettings;
  logger?: Pick<Logger, "debug" | "info" | "warn" | "error">;
  getToken?: (settings: GitLabSyncSettings) => Promise<string | null>;
  createGitLabClient?: (settings: GitLabSyncSettings, token: string) => GitLabClientLike;
  createRemoteDiffService?: (
    client: GitLabClientLike,
    isHardExcluded: (path: string) => boolean,
  ) => RemoteDiffLike;
  createIgnoreMatcher?: () => IgnoreMatcherLike;
  createLocalSnapshotService?: (
    client: GitLabClientLike,
    ignoreMatcher: IgnoreMatcherLike,
  ) => LocalSnapshotLike;
  createPlanner?: (client: GitLabClientLike, settings: GitLabSyncSettings) => PlannerLike;
  journal?: JournalLike;
  materializer?: MaterializerLike;
  now?: () => number;
  nowDate?: () => Date;
  /** `detail` is an optional second, smaller line. */
  notice?: (message: string, detail?: string) => void;
  createProgressNotice?: (message: string) => ProgressNotice;
  /** Overrides Obsidian's `Platform` so device naming can be exercised in tests. */
  platform?: DevicePlatform;
  /** Decides which notes must not be uploaded (see enclave/upload-guard.ts). */
  uploadGuard?: UploadGuardLike;
  /** Whether to have Enclave lock every unlocked note before a sync with this trigger. */
  lockBeforeSync?: (trigger: SyncTrigger) => boolean;
}

const MAX_PLAN_ATTEMPTS = 2;

export class SyncManager {
  private syncing = false;
  private journal?: JournalLike;
  private materializer?: MaterializerLike;

  constructor(private readonly options: SyncManagerOptions) {}

  isSyncing(): boolean {
    return this.syncing;
  }

  startEventsListener(plugin?: Plugin): void {
    this.getJournal(plugin).start?.();
  }

  async stopEventsListener(): Promise<void> {
    await this.journal?.stop?.();
  }

  async recoverIfNeeded(): Promise<boolean> {
    return await this.getMaterializer().recoverPendingTransaction();
  }

  async adoptExistingVault(): Promise<{
    status: "success" | "error" | "already-running";
    message: string;
    commitSha?: string;
    dirtyPaths?: number;
  }> {
    if (this.syncing) {
      this.options.notice?.("Sync already running");
      return { status: "already-running", message: "Sync already running" };
    }

    this.syncing = true;
    const progress = this.options.createProgressNotice?.("Adopting existing vault…");
    try {
      const data = await this.options.stateStore.load();
      const settings = this.validateSettings(this.options.settings ?? data.settings);
      await this.logGitLabTarget("Adopt existing vault target", settings);
      const token = await this.readToken(settings);
      const client = this.createClient(settings, token);
      await client.validateAccess?.();
      const { commitSha, dirtyPaths } = await this.finalizeAdoption(client);
      this.options.notice?.(
        dirtyPaths === 0
          ? "Existing vault adopted"
          : `Existing vault adopted with ${dirtyPaths} local changes`,
      );
      return {
        status: "success",
        message: "Existing vault adopted",
        commitSha,
        dirtyPaths,
      };
    } catch (error) {
      const message = errorMessage(error);
      await this.options.logger?.error("Adopt existing vault failed", { message });
      this.options.notice?.(`Error adopting existing vault. ${message}`);
      return { status: "error", message };
    } finally {
      progress?.hide?.();
      this.syncing = false;
    }
  }

  private async finalizeAdoption(
    client: GitLabClientLike,
  ): Promise<{ commitSha: string; dirtyPaths: number }> {
    const branch = await client.getBranch();
    this.validateBranch(branch);
    const remoteFiles = treeToTrackedFiles(
      await client.getTree(branch.commit.id),
      (path: string) => this.isHardExcluded(path),
    );
    const deviceSpecific = await this.currentDeviceSpecific();
    const trackedFiles = deviceSpecific.withoutMatches(remoteFiles);
    await this.options.stateStore.update((next) => {
      next.state.initialized = true;
      next.state.lastSyncedCommitSha = branch.commit.id;
      next.state.trackedFiles = trackedFiles;
      next.state.deviceSpecificPaths = Object.keys(remoteFiles).filter((path) => deviceSpecific.matches(path)).sort();
      next.state.dirtyEntries = {};
      next.state.pendingTransaction = null;
      next.state.lastSyncAt = this.now();
      next.state.lastSyncResult = "success";
    });
    await this.auditLocalChanges();
    const adopted = await this.options.stateStore.load();
    return {
      commitSha: branch.commit.id,
      dirtyPaths: Object.keys(adopted.state.dirtyEntries).length,
    };
  }

  async initializeEmptyRemote(): Promise<{
    status: "success" | "error" | "already-running";
    message: string;
    commitSha?: string;
    dirtyPaths?: number;
  }> {
    if (this.syncing) {
      this.options.notice?.("Sync already running");
      return { status: "already-running", message: "Sync already running" };
    }

    this.syncing = true;
    const progress = this.options.createProgressNotice?.("Creating first commit…");
    try {
      const data = await this.options.stateStore.load();
      const settings = this.validateSettings(this.options.settings ?? data.settings);
      if (!settings.authorName.trim() || !settings.authorEmail.trim()) {
        throw new Error("Set a commit author name and email before creating the first commit.");
      }
      await this.logGitLabTarget("Initialize empty remote target", settings);
      const token = await this.readToken(settings);
      const client = this.createClient(settings, token);
      // Deliberately no client.validateAccess?.() here: on a truly empty remote there is no
      // branch yet, so validateAccess (which calls getBranch) would spuriously fail. createCommit
      // below is intentionally the first remote call and surfaces auth errors via the try/catch.

      const paths = await this.listSyncableLocalFiles();
      if (paths.length === 0) {
        throw new Error("The vault has no files to push.");
      }
      if (!this.options.vault) {
        throw new Error("Vault is required to initialize the repository.");
      }
      const vault = this.options.vault;
      const guard = this.uploadGuard();
      await guard.prepare();
      const actions: GitLabCommitAction[] = [];
      for (const path of paths) {
        const bytes = new Uint8Array(await vault.adapter.readBinary(path));
        // Held notes stay out of the first commit; once they're locked, the next
        // sync picks them up as local changes.
        if (await guard.holdLocal({ path, local: { exists: true, bytes }, base: null })) {
          continue;
        }
        actions.push({
          action: "create",
          file_path: path,
          content: toBase64(bytes),
          encoding: "base64",
        });
      }
      // Non-atomic commit→finalize window: if createCommit succeeds but finalizeAdoption throws,
      // state.initialized stays false while the remote commit exists. This is recoverable: a
      // re-run/adopt re-fetches the remote as source of truth.
      const commit = await client.createCommit({ message: "Initialize vault", actions });
      const { dirtyPaths } = await this.finalizeAdoption(client);
      this.options.notice?.("Repository initialized from vault");
      return {
        status: "success",
        message: "Repository initialized",
        commitSha: commit.id,
        dirtyPaths,
      };
    } catch (error) {
      const message = errorMessage(error);
      await this.options.logger?.error("Initialize empty remote failed", { message });
      this.options.notice?.(`Error initializing repository. ${message}`);
      return { status: "error", message };
    } finally {
      progress?.hide?.();
      this.syncing = false;
    }
  }

  async sync(trigger: SyncTrigger): Promise<SyncResult> {
    if (this.syncing) {
      this.options.notice?.("Sync already running");
      return { status: "already-running", message: "Sync already running", trigger };
    }

    this.syncing = true;
    const progress = this.options.createProgressNotice?.("Checking GitLab…");
    try {
      return await this.syncLocked(trigger, progress);
    } finally {
      progress?.hide?.();
      this.syncing = false;
    }
  }

  private async syncLocked(
    trigger: SyncTrigger,
    progress?: ProgressNotice,
  ): Promise<SyncResult> {
    try {
      this.setProgress(progress, "Checking GitLab…");
      const recovered = await this.recoverIfNeeded();
      if (recovered) {
        this.setProgress(progress, "Sync complete");
        this.options.notice?.("Sync complete");
        return {
          status: "success",
          trigger,
          recovered: true,
          message: "Recovered pending sync",
        };
      }

      const data = await this.options.stateStore.load();
      this.validateInitialized(data);
      const settings = this.validateSettings(this.options.settings ?? data.settings);
      await this.logGitLabTarget("Sync target", settings);
      const token = await this.readToken(settings);
      const client = this.createClient(settings, token);

      await client.validateAccess?.();
      const firstBranch = await client.getBranch();
      this.validateBranch(firstBranch);

      const guard = this.uploadGuard();
      await guard.prepare();
      if (this.options.lockBeforeSync?.(trigger)) {
        this.setProgress(progress, "Locking notes…");
        await guard.enclave()?.lockAll();
      }

      if (trigger === "audit") {
        await this.auditLocalChanges();
      } else {
        await this.auditHiddenFiles();
      }

      this.setProgress(progress, "Finding remote changes…");
      const result = await this.planAndApply({
        trigger,
        settings,
        client,
        guard,
        firstRemoteSha: firstBranch.commit.id,
        progress,
      });
      this.options.notice?.("Sync complete", completionDetail(result));
      await this.recordHistory({
        trigger,
        status: result.status === "conflict" ? "conflict" : "success",
        held: (result.held ?? []).map((note) => note.path),
        ...(result.changes ?? { pulled: [], pushed: [], merged: [], conflicts: [] }),
      });
      return result;
    } catch (error) {
      const message = errorMessage(error);
      await this.markError();
      await this.options.logger?.error("Sync failed", { message });
      this.options.notice?.(`Error syncing. ${message}`);
      await this.recordHistory({
        trigger,
        status: "error",
        error: message,
        held: [],
        pulled: [],
        pushed: [],
        merged: [],
        conflicts: [],
      });
      return {
        status: "error",
        trigger,
        message,
        attempts: error instanceof BranchRaceError ? error.attempts : undefined,
      };
    }
  }

  private async planAndApply(input: {
    trigger: SyncTrigger;
    settings: GitLabSyncSettings;
    client: GitLabClientLike;
    guard: UploadGuardLike;
    firstRemoteSha: string;
    progress?: ProgressNotice;
  }): Promise<SyncResult> {
    let remoteSha = input.firstRemoteSha;
    let attempt = 1;
    const deviceSpecific = this.deviceSpecificFor(input.settings);
    await this.updateDeviceSpecific(input.client, deviceSpecific, remoteSha);

    while (attempt <= MAX_PLAN_ATTEMPTS) {
      const data = await this.options.stateStore.load();
      const baseSha = data.state.lastSyncedCommitSha;
      if (baseSha === null) {
        throw new Error("Sync is not initialized");
      }

      const ignoreMatcher = this.createIgnoreMatcher(deviceSpecific);
      await ignoreMatcher.reload();
      const remoteDiff = this.createRemoteDiffService(input.client);
      const remote = await remoteDiff.discover({
        baseSha,
        remoteSha,
        baseIndex: data.state.trackedFiles,
      });
      // Device-specific settings stay as they are here: not tracked, and their
      // remote changes are not applied.
      const applicable = deviceSpecific.applicable(remote.changes);
      await this.rememberDeviceSpecific(applicable.skippedPaths);
      const trackedFiles = deviceSpecific.withoutMatches(remote.remoteTree ?? data.state.trackedFiles);
      const dirtyEntries = this.filteredDirtyEntries(
        data.state.dirtyEntries,
        trackedFiles,
        ignoreMatcher,
        input.trigger,
      );
      const snapshotService = this.createLocalSnapshotService(input.client, ignoreMatcher);

      this.setProgress(input.progress, "Saving local changes…");
      const holds = await this.applyHolds(
        input.guard,
        await snapshotService.snapshot(dirtyEntries, trackedFiles),
        applicable.changes,
        data.state.deferredPaths ?? [],
      );
      if (remote.remoteTree) {
        // The full-tree fallback indexes the remote head; deferred notes must keep
        // their last synced base so their remote change is still seen as one later.
        for (const path of holds.deferred) {
          if (data.state.trackedFiles[path]) {
            trackedFiles[path] = data.state.trackedFiles[path];
          } else {
            delete trackedFiles[path];
          }
        }
      }
      await this.rememberDeferred(holds.deferred);

      this.setProgress(input.progress, "Resolving conflicts…");
      const planner = this.createPlanner(input.client, input.settings);
      const plan = await planner.plan({
        baseSha,
        remoteSha,
        trackedFiles,
        dirtyEntries,
        remoteChanges: holds.changes,
        localSnapshots: holds.snapshots,
        now: this.nowDate(),
      });

      if (plan.actions.length === 0) {
        return {
          ...(await this.applyRemoteOnlyPlan(input.trigger, remoteSha, plan, holds.deferred, input.progress)),
          held: holds.held,
          changes: describeChanges({
            actions: [],
            materialized: plan.materializeWithoutCommit,
            mergedPaths: plan.mergedPaths,
            conflictRecords: plan.conflictRecords,
            trackedBefore: data.state.trackedFiles,
          }),
        };
      }

      const branchBeforeCommit = await input.client.getBranch();
      this.validateBranch(branchBeforeCommit);
      if (branchBeforeCommit.commit.id !== remoteSha) {
        attempt += 1;
        if (attempt > MAX_PLAN_ATTEMPTS) {
          throw new BranchRaceError(MAX_PLAN_ATTEMPTS);
        }
        remoteSha = branchBeforeCommit.commit.id;
        continue;
      }

      this.setProgress(input.progress, "Creating GitLab commit…");
      const createdCommit = await input.client.createCommit({
        message: this.commitMessage(input.trigger, input.settings),
        actions: plan.actions,
      });
      const finalizedPlan = await this.planForActualCreatedCommit(
        input.client,
        input.settings,
        baseSha,
        createdCommit,
        plan,
        holds,
        deviceSpecific,
      );
      await this.rememberDeferred(holds.deferred);
      const transaction = this.pendingTransaction(createdCommit.id, finalizedPlan);
      await this.persistPendingTransaction(transaction);

      this.setProgress(input.progress, "Updating local vault…");
      await this.getMaterializer().apply(transaction.materializeOperations);
      await this.finalizeTransaction(transaction, holds.deferred);
      this.setProgress(input.progress, "Sync complete");

      return {
        status: transaction.conflictPaths.length > 0 ? "conflict" : "success",
        trigger: input.trigger,
        message: "Sync complete",
        commitSha: createdCommit.id,
        attempts: attempt,
        held: holds.held,
        pulled: transaction.materializeOperations.length,
        pushed: plan.actions.length,
        changes: describeChanges({
          actions: plan.actions,
          materialized: transaction.materializeOperations,
          mergedPaths: finalizedPlan.mergedPaths,
          conflictRecords: finalizedPlan.conflictRecords,
          trackedBefore: data.state.trackedFiles,
        }),
      };
    }

    throw new BranchRaceError(MAX_PLAN_ATTEMPTS);
  }

  private async planForActualCreatedCommit(
    client: GitLabClientLike,
    settings: GitLabSyncSettings,
    baseSha: string,
    createdCommit: CreatedGitLabCommit,
    plan: SyncPlan,
    holds: Holds,
    deviceSpecific: DeviceSpecificPaths,
  ): Promise<SyncPlan> {
    if (createdCommit.parent_ids.includes(plan.basedOnRemoteSha)) {
      return plan;
    }

    const actualParent = createdCommit.parent_ids[0];
    if (!actualParent) {
      return plan;
    }

    const remoteDiff = this.createRemoteDiffService(client);
    const actual = await remoteDiff.discover({
      baseSha: actualParent,
      remoteSha: createdCommit.id,
      baseIndex: plan.nextTrackedFiles,
    });
    if (actual.changes.length === 0) {
      return plan;
    }

    const remoteChanges: RemoteChange[] = [];
    for (const change of deviceSpecific.applicable(actual.changes).changes) {
      const paths = changePaths(change);
      if (await this.firstHeld(holds, paths, (path) => holds.guard.holdRemote(path))) {
        holds.deferred = unique([...holds.deferred, ...paths]);
      } else {
        remoteChanges.push(change);
      }
    }

    const planner = this.createPlanner(client, settings);
    const replanned = await planner.plan({
      baseSha,
      remoteSha: createdCommit.id,
      trackedFiles: plan.nextTrackedFiles,
      dirtyEntries: [],
      remoteChanges,
      localSnapshots: [],
      now: this.nowDate(),
    });
    // The replan only covers what the created commit changed; this sync's own
    // conflicts still stand.
    return {
      ...replanned,
      conflictPaths: [...plan.conflictPaths, ...replanned.conflictPaths],
      conflictRecords: [...plan.conflictRecords, ...replanned.conflictRecords],
      mergedPaths: [...plan.mergedPaths, ...replanned.mergedPaths],
    };
  }

  private async applyRemoteOnlyPlan(
    trigger: SyncTrigger,
    remoteSha: string,
    plan: SyncPlan,
    deferredPaths: string[],
    progress?: ProgressNotice,
  ): Promise<SyncResult> {
    this.setProgress(progress, "Updating local vault…");
    await this.getJournal().suppress(async () => {
      await this.getMaterializer().apply(plan.materializeWithoutCommit);
    });
    await this.options.stateStore.update((data) => {
      data.state.lastSyncedCommitSha = remoteSha;
      data.state.trackedFiles = cloneTrackedFiles(plan.nextTrackedFiles);
      for (const path of plan.acknowledgedDirtyPaths) {
        delete data.state.dirtyEntries[normalizePath(path)];
      }
      data.state.pendingTransaction = null;
      data.state.deferredPaths = [...deferredPaths];
      data.state.conflicts = [...(data.state.conflicts ?? []), ...plan.conflictRecords];
      data.state.lastSyncAt = this.now();
      data.state.lastSyncResult = plan.conflictPaths.length > 0 ? "conflict" : "success";
    });
    this.setProgress(progress, "Sync complete");
    return {
      status: plan.conflictPaths.length > 0 ? "conflict" : "success",
      trigger,
      message: "Sync complete",
      commitSha: remoteSha,
      attempts: 1,
      pulled: plan.materializeWithoutCommit.length,
      pushed: 0,
    };
  }

  private pendingTransaction(
    committedSha: string,
    plan: SyncPlan,
  ): PendingTransaction {
    return {
      transactionId: `${committedSha}-${this.now().toString(36)}`,
      committedSha,
      materializeOperations: plan.materializeAfterCommit,
      nextTrackedFiles: cloneTrackedFiles(plan.nextTrackedFiles),
      acknowledgedDirtyPaths: [...plan.acknowledgedDirtyPaths],
      conflictPaths: [...plan.conflictPaths],
      conflicts: [...plan.conflictRecords],
      createdAt: this.now(),
    };
  }

  private async persistPendingTransaction(transaction: PendingTransaction): Promise<void> {
    await this.options.stateStore.update((data) => {
      data.state.pendingTransaction = transaction;
    });
  }

  private async finalizeTransaction(transaction: PendingTransaction, deferredPaths: string[]): Promise<void> {
    await this.options.stateStore.update((data) => {
      data.state.lastSyncedCommitSha = transaction.committedSha;
      data.state.trackedFiles = cloneTrackedFiles(transaction.nextTrackedFiles);
      for (const path of transaction.acknowledgedDirtyPaths) {
        delete data.state.dirtyEntries[normalizePath(path)];
      }
      data.state.pendingTransaction = null;
      data.state.deferredPaths = [...deferredPaths];
      data.state.conflicts = [...(data.state.conflicts ?? []), ...(transaction.conflicts ?? [])];
      data.state.lastSyncAt = this.now();
      data.state.lastSyncResult = transaction.conflictPaths.length > 0 ? "conflict" : "success";
    });
  }

  /**
   * Take the notes that must not be uploaded out of this sync. Their local
   * versions aren't uploaded (they stay dirty, so they go out once they're safe),
   * and remote changes to them wait as "deferred": not applied, and the note
   * keeps its last synced base, so the change is still seen when the note can be
   * compared safely. A deferred note whose hold has cleared gets its remote
   * change looked at again now.
   */
  private async applyHolds(
    guard: UploadGuardLike,
    snapshots: LocalSnapshotEntry[],
    changes: RemoteChange[],
    deferredBefore: string[],
  ): Promise<Holds> {
    const holds: Holds = { guard, reasons: new Map(), snapshots: [], changes: [], held: [], deferred: [] };

    for (const snapshot of snapshots) {
      const reason = await guard.holdLocal(snapshot);
      if (reason) {
        holds.reasons.set(snapshot.path, reason);
      } else {
        holds.snapshots.push(snapshot);
      }
    }

    const remotePaths = new Set(changes.flatMap(changePaths));
    for (const change of changes) {
      const paths = changePaths(change);
      if (await this.firstHeld(holds, paths, (path) => guard.holdRemote(path))) {
        holds.deferred.push(...paths);
      } else {
        holds.changes.push(change);
      }
    }

    for (const path of deferredBefore) {
      if (await this.firstHeld(holds, [path], (candidate) => guard.holdRemote(candidate))) {
        holds.deferred.push(path);
      } else if (!remotePaths.has(path)) {
        holds.changes.push({ type: "update", path });
      }
    }

    holds.deferred = unique(holds.deferred);
    // A local change to a deferred note waits with its remote change, so both are compared together.
    holds.snapshots = holds.snapshots.filter((snapshot) => !holds.deferred.includes(snapshot.path));
    holds.held = [...holds.reasons]
      .map(([path, reason]) => ({ path, reason }))
      .sort((left, right) => left.path.localeCompare(right.path));
    return holds;
  }

  /** Whether any of `paths` is held, asking `check` for paths not decided yet (and remembering the answer). */
  private async firstHeld(
    holds: Holds,
    paths: string[],
    check: (path: string) => Promise<HoldReason | null>,
  ): Promise<boolean> {
    let held = false;
    for (const path of paths) {
      if (!holds.reasons.has(path)) {
        const reason = await check(path);
        if (reason) {
          holds.reasons.set(path, reason);
        }
      }
      held = held || holds.reasons.has(path);
    }
    return held;
  }

  /**
   * Save newly deferred notes before anything is committed. Only ever adds, so
   * an interrupted sync can't forget a remote change; finishing a sync stores
   * the exact list.
   */
  private async rememberDeferred(deferred: string[]): Promise<void> {
    if (deferred.length === 0) {
      return;
    }
    await this.options.stateStore.update((data) => {
      data.state.deferredPaths = unique([...(data.state.deferredPaths ?? []), ...deferred]);
    });
  }

  private uploadGuard(): UploadGuardLike {
    return this.options.uploadGuard ?? UploadGuard.forApp(this.options.app);
  }

  private filteredDirtyEntries(
    dirtyEntries: Record<string, DirtyEntry>,
    trackedFiles: Record<string, TrackedFile>,
    ignoreMatcher: IgnoreMatcherLike,
    trigger: SyncTrigger,
  ): DirtyEntry[] {
    const entries = Object.values(dirtyEntries)
      .map((entry) => ({ ...entry, path: normalizePath(entry.path) }))
      .sort((left, right) => left.path.localeCompare(right.path));

    if (trigger === "audit") {
      return entries;
    }

    return entries.filter((entry) => {
      if (trackedFiles[entry.path]) {
        return true;
      }
      return !ignoreMatcher.isIgnored(entry.path, trackedFiles);
    });
  }

  private validateInitialized(data: PluginData): void {
    if (!data.state.initialized || data.state.lastSyncedCommitSha === null) {
      throw new Error("Sync is not initialized");
    }
  }

  private validateSettings(settings: GitLabSyncSettings): GitLabSyncSettings {
    if (!settings.gitlabBaseUrl.trim()) {
      throw new Error("GitLab base URL is missing");
    }
    if (!settings.gitlabBaseUrl.trim().startsWith("https://")) {
      throw new Error("GitLab base URL must use HTTPS");
    }
    if (!settings.projectPath.trim()) {
      throw new Error("GitLab project is missing");
    }
    if (!settings.branch.trim()) {
      throw new Error("GitLab branch is missing");
    }
    if (!settings.tokenSecretName.trim()) {
      throw new Error("GitLab token secret name is missing");
    }
    return {
      ...settings,
      gitlabBaseUrl: settings.gitlabBaseUrl.trim().replace(/\/+$/, ""),
      projectPath: settings.projectPath.trim(),
      branch: settings.branch.trim(),
      tokenSecretName: settings.tokenSecretName.trim(),
      conflictStrategy: normalizeConflictStrategy(settings.conflictStrategy),
    };
  }

  private async readToken(settings: GitLabSyncSettings): Promise<string> {
    const token = this.options.getToken ? await this.options.getToken(settings) : this.defaultGetToken(settings);
    if (!token?.trim()) {
      throw new Error("GitLab token is missing");
    }
    return token.trim();
  }

  private async logGitLabTarget(message: string, settings: GitLabSyncSettings): Promise<void> {
    await this.options.logger?.info(message, {
      gitlabBaseUrl: settings.gitlabBaseUrl,
      projectPath: settings.projectPath,
      branch: settings.branch,
      apiProjectUrl: `${settings.gitlabBaseUrl}/api/v4/projects/${encodeURIComponent(settings.projectPath)}`,
    });
  }

  private defaultGetToken(settings: GitLabSyncSettings): string | null {
    if (!this.options.app) {
      return null;
    }
    return this.options.app.secretStorage.getSecret(settings.tokenSecretName);
  }

  private validateBranch(branch: GitLabBranch): void {
    if (!branch.can_push) {
      throw new Error("GitLab branch does not allow pushes");
    }
  }

  private createClient(settings: GitLabSyncSettings, token: string): GitLabClientLike {
    return this.options.createGitLabClient?.(settings, token) ?? new GitLabClient(settings, token, {
      onRequest: async (diagnostic) => {
        await this.options.logger?.debug("GitLab request", diagnostic);
      },
      onArchiveDiagnostic: async (diagnostic) => {
        await this.options.logger?.debug("GitLab archive transport", diagnostic);
      },
    });
  }

  private createRemoteDiffService(client: GitLabClientLike): RemoteDiffLike {
    if (this.options.createRemoteDiffService) {
      return this.options.createRemoteDiffService(client, (path: string) => this.isHardExcluded(path));
    }
    return new RemoteDiffService(this.requireRemoteDiffClient(client), (path: string) => this.isHardExcluded(path));
  }

  private requireRemoteDiffClient(client: GitLabClientLike): RemoteDiffClient {
    if (!isRemoteDiffClient(client)) {
      throw new Error("GitLab client does not support remote diff discovery");
    }
    return client;
  }

  /** Adds a sync to the history shown in the settings, if it changed something or failed. */
  private async recordHistory(entry: Omit<SyncHistoryEntry, "at">): Promise<void> {
    const full: SyncHistoryEntry = { at: this.now(), ...entry };
    if (!isNoteworthy(full)) {
      return;
    }
    try {
      await this.options.stateStore.update((data) => {
        data.state.syncHistory = withEntry(data.state.syncHistory ?? [], full);
      });
    } catch (error) {
      await this.options.logger?.warn("Could not save the sync history", { message: errorMessage(error) });
    }
  }

  private deviceSpecificFor(settings: GitLabSyncSettings): DeviceSpecificPaths {
    // Without a vault there is nothing local to keep.
    return this.options.vault
      ? new DeviceSpecificPaths(this.options.vault.configDir, settings.deviceSpecificPaths ?? [])
      : new DeviceSpecificPaths("", []);
  }

  private async currentDeviceSpecific(): Promise<DeviceSpecificPaths> {
    const data = await this.options.stateStore.load();
    return this.deviceSpecificFor(this.options.settings ?? data.settings);
  }

  /**
   * Keeps the record of device-specific paths current, and hands paths that
   * were taken off the list back to sync: the repository's version replaces
   * this device's, as when connecting, or this device's file is uploaded if
   * the repository has none.
   */
  private async updateDeviceSpecific(
    client: GitLabClientLike,
    deviceSpecific: DeviceSpecificPaths,
    remoteSha: string,
  ): Promise<void> {
    const vault = this.options.vault;
    const data = await this.options.stateStore.load();
    const before = data.state.deviceSpecificPaths ?? [];
    const localSettings = vault ? await this.listLocalFiles(normalizePath(vault.configDir)) : [];
    const current = unique([...before, ...Object.keys(data.state.trackedFiles), ...localSettings])
      .filter((path) => deviceSpecific.matches(path))
      .sort();
    const released = before.filter((path) => !deviceSpecific.matches(path));

    const tracked: Record<string, TrackedFile> = {};
    const upload: string[] = [];
    for (const path of released) {
      const remote = await client.getRawFile(path, remoteSha);
      if (remote) {
        const bytes = new Uint8Array(remote);
        await this.getMaterializer().apply([{ type: "write", path, contentBase64: toBase64(bytes) }]);
        tracked[path] = { blobId: await calculateGitBlobId(bytes), mode: "100644", size: bytes.byteLength };
      } else if (vault && (await vault.adapter.exists(path))) {
        upload.push(path);
      }
    }

    await this.options.stateStore.update((next) => {
      for (const path of current) {
        delete next.state.trackedFiles[path];
        delete next.state.dirtyEntries[path];
      }
      for (const path of released) {
        delete next.state.dirtyEntries[path];
      }
      Object.assign(next.state.trackedFiles, tracked);
      for (const path of upload) {
        next.state.dirtyEntries[path] = { path, operation: "upsert", recordedAt: this.now() };
      }
      next.state.deviceSpecificPaths = current;
    });
  }

  /** Adds paths whose remote change this device skipped, so taking them off the list later fetches them. */
  private async rememberDeviceSpecific(paths: string[]): Promise<void> {
    if (paths.length === 0) {
      return;
    }
    await this.options.stateStore.update((data) => {
      data.state.deviceSpecificPaths = unique([...(data.state.deviceSpecificPaths ?? []), ...paths]).sort();
    });
  }

  private createIgnoreMatcher(deviceSpecific?: DeviceSpecificPaths): IgnoreMatcherLike {
    if (this.options.createIgnoreMatcher) {
      return this.options.createIgnoreMatcher();
    }
    if (!this.options.vault) {
      throw new Error("Vault is required for ignore matching");
    }
    return new IgnoreMatcher(this.options.vault, "envoy", deviceSpecific);
  }

  private createLocalSnapshotService(
    client: GitLabClientLike,
    ignoreMatcher: IgnoreMatcherLike,
  ): LocalSnapshotLike {
    if (this.options.createLocalSnapshotService) {
      return this.options.createLocalSnapshotService(client, ignoreMatcher);
    }
    if (!this.options.vault) {
      throw new Error("Vault is required for local snapshots");
    }
    return new LocalSnapshotService(
      this.options.vault,
      (blobId) => client.getRawBlob(blobId),
      (path, trackedFiles) => ignoreMatcher.isIgnored(path, trackedFiles),
    );
  }

  private createPlanner(client: GitLabClientLike, settings: GitLabSyncSettings): PlannerLike {
    return this.options.createPlanner?.(client, settings) ?? new SyncPlanner({
      getRemoteVersion: async (path, remoteSha) =>
        versionFromArrayBuffer(await client.getRawFile(path, remoteSha)),
      deviceName: deviceLabel(settings.authorName, this.platform()),
      conflictStrategy: settings.conflictStrategy,
    });
  }

  private getJournal(plugin?: Plugin): JournalLike {
    if (this.options.journal) {
      return this.options.journal;
    }
    if (!this.journal) {
      if (!this.options.vault) {
        throw new Error("Vault is required for change journal");
      }
      this.journal = new ChangeJournal({
        vault: this.options.vault,
        stateStore: this.options.stateStore,
        plugin: plugin ?? this.options.plugin,
      });
    }
    return this.journal;
  }

  private getMaterializer(): MaterializerLike {
    if (this.options.materializer) {
      return this.options.materializer;
    }
    if (!this.materializer) {
      if (!this.options.vault) {
        throw new Error("Vault is required for local materialization");
      }
      this.materializer = new LocalMaterializer({
        vault: this.options.vault,
        stateStore: this.options.stateStore,
        journal: this.getJournal(),
        logger: this.options.logger,
      });
    }
    return this.materializer;
  }

  private async markError(): Promise<void> {
    try {
      await this.options.stateStore.update((data) => {
        data.state.lastSyncAt = this.now();
        data.state.lastSyncResult = "error";
      });
    } catch (error) {
      await this.options.logger?.warn("Failed to persist sync error state", {
        message: errorMessage(error),
      });
    }
  }

  /** A file version from GitLab by blob id (a conflict's base), or null if it can't be fetched. */
  async readBlob(blobId: string): Promise<Uint8Array | null> {
    try {
      const data = await this.options.stateStore.load();
      const settings = this.validateSettings(this.options.settings ?? data.settings);
      const client = this.createClient(settings, await this.readToken(settings));
      const buffer = await client.getRawBlob(blobId);
      return buffer ? new Uint8Array(buffer) : null;
    } catch (error) {
      await this.options.logger?.warn("Could not fetch a conflict's base version", { message: errorMessage(error) });
      return null;
    }
  }

  async listSyncableLocalFiles(): Promise<string[]> {
    if (!this.options.vault) {
      return [];
    }
    const ignoreMatcher = this.createIgnoreMatcher(await this.currentDeviceSpecific());
    await ignoreMatcher.reload();
    const localFiles = await this.listLocalFiles("", ignoreMatcher);
    // Empty tracked-files map: this lists what a fresh sync would push, so no file is yet tracked.
    return localFiles.filter((path) => !ignoreMatcher.isIgnored(path, {})).sort();
  }

  private async auditLocalChanges(): Promise<void> {
    if (!this.options.vault) {
      return;
    }
    const data = await this.options.stateStore.load();
    const ignoreMatcher = this.createIgnoreMatcher(await this.currentDeviceSpecific());
    await ignoreMatcher.reload();
    const localFiles = await this.listLocalFiles("", ignoreMatcher);
    const localSet = new Set(localFiles);
    const journal = this.getJournal();

    for (const [path, tracked] of Object.entries(data.state.trackedFiles)) {
      if (!localSet.has(path)) {
        await journal.recordDelete?.(path);
        continue;
      }
      const bytes = new Uint8Array(await this.options.vault.adapter.readBinary(path));
      if ((await calculateGitBlobId(bytes)) !== tracked.blobId) {
        await journal.recordUpsert?.(path);
      }
    }

    for (const path of localFiles) {
      if (data.state.trackedFiles[path] || ignoreMatcher.isIgnored(path, data.state.trackedFiles)) {
        continue;
      }
      await journal.recordUpsert?.(path);
    }
  }

  /**
   * Obsidian sends no file events for its config folder or other dot-files
   * (such as .gitignore), so every sync looks at them directly. A file is read
   * again only when its modification time or size changed since it last
   * matched the synced version.
   */
  private async auditHiddenFiles(): Promise<void> {
    const vault = this.options.vault;
    if (!vault) {
      return;
    }
    const data = await this.options.stateStore.load();
    const ignoreMatcher = this.createIgnoreMatcher(this.deviceSpecificFor(this.options.settings ?? data.settings));
    await ignoreMatcher.reload();
    const configDir = normalizePath(vault.configDir);
    const isHidden = (path: string) => path.startsWith(".") || path === configDir || path.startsWith(`${configDir}/`);

    const root = await vault.adapter.list("");
    const local = root.files.map((path) => normalizePath(path)).filter((path) => isHidden(path) && !this.isHardExcluded(path));
    const folders = unique([configDir, ...root.folders.map((path) => normalizePath(path)).filter(isHidden)]);
    for (const folder of folders) {
      if (this.isHardExcluded(folder) || ignoreMatcher.isDirIgnored?.(folder) || !(await vault.adapter.exists(folder))) {
        continue;
      }
      local.push(...(await this.listLocalFiles(folder, ignoreMatcher)));
    }

    const tracked = data.state.trackedFiles;
    const seenBefore = data.state.hiddenFiles ?? {};
    const seen: Record<string, HiddenFileStat> = {};
    const journal = this.getJournal();
    for (const path of local) {
      if (ignoreMatcher.isIgnored(path, tracked)) {
        continue;
      }
      const stat = await vault.adapter.stat(path);
      const before = seenBefore[path];
      if (stat && before && before.mtime === stat.mtime && before.size === stat.size) {
        seen[path] = before;
        continue;
      }
      const bytes = new Uint8Array(await vault.adapter.readBinary(path));
      if (tracked[path] && (await calculateGitBlobId(bytes)) === tracked[path].blobId) {
        if (stat) {
          seen[path] = { mtime: stat.mtime, size: stat.size };
        }
        continue;
      }
      await journal.recordUpsert?.(path);
    }

    const localSet = new Set(local);
    for (const path of Object.keys(tracked)) {
      if (isHidden(path) && !localSet.has(path) && !(await vault.adapter.exists(path))) {
        await journal.recordDelete?.(path);
      }
    }

    await this.options.stateStore.update((next) => {
      next.state.hiddenFiles = seen;
    });
  }

  private async listLocalFiles(dir: string, ignoreMatcher?: IgnoreMatcherLike): Promise<string[]> {
    if (!this.options.vault) {
      return [];
    }
    const { files, folders } = await this.options.vault.adapter.list(dir);
    const visibleFiles = files.map((path) => normalizePath(path)).filter((path) => !this.isHardExcluded(path));
    for (const folder of folders.map((path) => normalizePath(path)).filter((path) => !this.isHardExcluded(path))) {
      // Prune ignored directories during descent so their contents are never
      // listed/stat-ed (avoids aborting on broken symlinks inside them).
      if (ignoreMatcher?.isDirIgnored?.(folder)) {
        continue;
      }
      visibleFiles.push(...(await this.listLocalFiles(folder, ignoreMatcher)));
    }
    return visibleFiles.sort();
  }

  private commitMessage(trigger: SyncTrigger, settings: GitLabSyncSettings): string {
    const label = commitDeviceLabel(settings.authorName, this.platform());
    if (trigger === "audit" || trigger === "foreground" || trigger === "background") {
      return `Sync vault from ${label} ${trigger}`;
    }
    return `Sync vault from ${label}`;
  }

  private platform(): DevicePlatform {
    return this.options.platform ?? Platform;
  }

  private setProgress(progress: ProgressNotice | undefined, message: string): void {
    progress?.setMessage?.(message);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private nowDate(): Date {
    return this.options.nowDate?.() ?? new Date();
  }

  private isHardExcluded(path: string): boolean {
    const vault = this.options.vault;
    if (!vault) {
      return false;
    }
    const normalized = normalizePath(path);
    const configDir = normalizePath(vault.configDir);
    const runtimeDir = `${configDir}/plugins/envoy/`;
    return (
      normalized === ".git" ||
      normalized.startsWith(".git/") ||
      normalized === `${configDir}/envoy.log` ||
      isMetadataPath(normalized) ||
      normalized === `${configDir}/plugins/envoy` ||
      normalized.startsWith(runtimeDir)
    );
  }
}

/** What applyHolds() decided for one sync. */
interface HiddenFileStat {
  mtime: number;
  size: number;
}

interface Holds {
  guard: UploadGuardLike;
  reasons: Map<string, HoldReason>;
  /** Local changes that may be uploaded. */
  snapshots: LocalSnapshotEntry[];
  /** Remote changes that may be applied, including re-checks of earlier deferred notes. */
  changes: RemoteChange[];
  /** Held notes, for the sync result. */
  held: HeldNote[];
  /** Notes whose remote change waits until they can be compared safely. */
  deferred: string[];
}

function changePaths(change: RemoteChange): string[] {
  return change.type === "rename" ? [change.oldPath, change.newPath] : [change.path];
}

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

/** The line under "Sync complete": files pulled and pushed, and notes held back. */
export function completionDetail(result: Pick<SyncResult, "pulled" | "pushed" | "held">): string {
  const pulled = result.pulled ?? 0;
  const pushed = result.pushed ?? 0;
  const counts = pulled === 0 && pushed === 0 ? "No changes" : `${pulled} ↓   ${pushed} ↑`;
  const held = result.held?.length ?? 0;
  if (held === 0) {
    return counts;
  }
  return held === 1
    ? `${counts}\n1 note held back until it's locked`
    : `${counts}\n${held} notes held back until they're locked`;
}

function isRemoteDiffClient(client: GitLabClientLike): client is GitLabClientLike & RemoteDiffClient {
  return typeof (client as Partial<RemoteDiffClient>).compare === "function";
}

export default SyncManager;

function versionFromArrayBuffer(buffer: ArrayBuffer | null): VersionState {
  if (buffer === null) {
    return { exists: false, bytes: null };
  }
  return { exists: true, bytes: new Uint8Array(buffer) };
}

function cloneTrackedFiles(
  trackedFiles: Record<string, TrackedFile>,
): Record<string, TrackedFile> {
  return Object.fromEntries(
    Object.entries(trackedFiles).map(([path, file]) => [path, { ...file }]),
  );
}

function treeToTrackedFiles(
  tree: GitLabTreeItem[],
  isHardExcluded: (path: string) => boolean,
): Record<string, TrackedFile> {
  return Object.fromEntries(
    tree
      .filter((item) => item.type === "blob" && !isHardExcluded(normalizePath(item.path)))
      .map((item) => [
        normalizePath(item.path),
        {
          blobId: item.id,
          mode: item.mode,
          size: 0,
        },
      ]),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeConflictStrategy(
  strategy: GitLabSyncSettings["conflictStrategy"],
): GitLabSyncSettings["conflictStrategy"] {
  if (
    strategy === "local" ||
    strategy === "auto-remote" ||
    strategy === "auto-local"
  ) {
    return strategy;
  }
  return "remote";
}

class BranchRaceError extends Error {
  constructor(readonly attempts: number) {
    super("GitLab branch changed during sync; retry later");
  }
}

function isMetadataPath(path: string): boolean {
  return path.endsWith("github-sync-metadata.json") ||
    path.endsWith("gitlab-sync-metadata.json");
}
