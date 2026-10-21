import { Notice, Plugin, setIcon } from "obsidian";
import { DEFAULT_STATE, type GitLabSyncSettings, type PluginData } from "./settings/settings";
import GitLabSyncSettingsTab from "./settings/settings-tab";
import Logger from "./logger";
import { StateStore } from "./sync/state-store";
import SyncManager, { type SyncResult, type SyncTrigger } from "./sync/sync-manager";
import { SyncStatusModal } from "./views/sync-status-modal";
import { BootstrapService, type ConnectPreview } from "./sync/bootstrap-service";
import { GitLabClient } from "./gitlab/client";
import { GitLabNotFoundError } from "./gitlab/errors";
import { DeviceSpecificPaths } from "./sync/device-specific";
import { confirmAction } from "./views/confirm-modal";
import { OBSIDIAN_SYNC_WARNING, obsidianSyncEnabled } from "./obsidian-sync";
import { ConflictService } from "./conflicts/conflict-service";
import { enclaveApi } from "./enclave/enclave-api";
import { ConflictListModal, ConflictModal } from "./views/conflict-modal";
import type { ConflictRecord, SyncHistoryEntry } from "./sync/types";

const FOREGROUND_SYNC_COOLDOWN_MS = 30_000;
const BACKGROUND_SYNC_COOLDOWN_MS = 30_000;
const AUTO_SYNC_COOLDOWN_MS = 30_000;
const EDIT_SYNC_COOLDOWN_MS = 10_000;
const INTERVAL_SYNC_COOLDOWN_MS = 10_000;
const DEFAULT_EDIT_DEBOUNCE_SECONDS = 8;
const DEFAULT_INTERVAL_MINUTES = 10;
const MIN_EDIT_DEBOUNCE_SECONDS = 1;
const MIN_INTERVAL_MINUTES = 1;

export default class GitLabGitlessSyncPlugin extends Plugin {
  settings: GitLabSyncSettings;
  pluginData: PluginData;
  stateStore: StateStore;
  syncManager: SyncManager;
  conflicts: ConflictService;
  logger: Logger;

  syncRibbonIcon: HTMLElement | null = null;
  private layoutReady = false;
  private settingsTab: GitLabSyncSettingsTab | null = null;
  /** Desktop status bar: how many conflicts wait, until they're resolved. */
  private conflictStatusEl: HTMLElement | null = null;
  private lastForegroundSyncAt: number | null = null;
  private lastBackgroundSyncAt: number | null = null;
  private lastAutoSyncAt: number | null = null;
  private lastAutoSyncTrigger: "foreground" | "background" | null = null;
  private lastEditSyncAt: number | null = null;
  private lastIntervalSyncAt: number | null = null;
  private editSyncTimer: number | null = null;
  private autoSyncIntervalHandle: number | null = null;

  onUserEnable(): void {
    if (!this.isConfigured()) {
      new Notice("Go to settings to configure syncing");
    }
  }

  async onload() {
    await this.loadSettings();

    this.logger = new Logger(this.app.vault, this.settings.loggingLevel);
    await this.logger.init();

    this.syncManager = new SyncManager({
      app: this.app,
      vault: this.app.vault,
      plugin: this,
      stateStore: this.stateStore,
      settings: this.settings,
      logger: this.logger,
      createProgressNotice: (message) => new Notice(message, 0),
      notice: (message, detail) => new Notice(detail ? withDetail(message, detail) : message, 5000),
      lockBeforeSync: (trigger) => trigger === "manual" && this.settings.lockBeforeManualSync,
    });
    this.conflicts = new ConflictService({
      vault: this.app.vault,
      stateStore: this.stateStore,
      readBase: (blobId) => this.syncManager.readBlob(blobId),
      enclave: () => enclaveApi(this.app),
    });
    this.registerAppLifecycleHandlers();

    this.settingsTab = new GitLabSyncSettingsTab(this.app, this);
    this.addSettingTab(this.settingsTab);
    this.conflictStatusEl = this.addStatusBarItem();
    this.conflictStatusEl.addClass("mod-clickable", "envoy-conflict-status");
    this.conflictStatusEl.setAttribute("aria-label", "Resolve sync conflicts");
    this.conflictStatusEl.hide();
    // The item is removed with the plugin, and its listener with it.
    this.conflictStatusEl.addEventListener("click", () => void this.openConflicts());

    this.app.workspace.onLayoutReady(async () => {
      this.syncManager.startEventsListener(this);
      this.layoutReady = true;

      if (this.settings.showRibbonIcon) {
        this.showSyncRibbonIcon();
      }

      this.registerEditSyncListeners();
      this.refreshAutoSyncInterval();
      void this.warnAboutObsidianSync();
      void this.refreshConflicts();

      const recovered = await this.syncManager.recoverIfNeeded();
      if (!recovered && this.settings.syncOnStartup && this.pluginData.state.initialized) {
        await this.sync("startup");
      }
    });

    this.addCommand({
      id: "sync-files",
      name: "Sync with GitLab",
      repeatable: false,
      icon: "refresh-cw",
      callback: () => void this.sync("manual"),
    });

    this.addCommand({
      id: "full-audit-sync",
      name: "Full audit and sync",
      repeatable: false,
      icon: "scan-search",
      callback: () => {
        void confirmAction(this.app, {
          title: "Full audit and sync",
          text: "This reads every file in the vault to find changes, which can take a while on a phone.",
          confirm: "Start",
        }).then((confirmed) => {
          if (confirmed) {
            void this.sync("audit");
          }
        });
      },
    });

    this.addCommand({
      id: "resolve-sync-conflicts",
      name: "Resolve sync conflicts",
      repeatable: false,
      icon: "git-merge",
      callback: () => void this.openConflicts(),
    });

    this.addCommand({
      id: "show-gitlab-sync-status",
      name: "Show GitLab sync status",
      repeatable: false,
      icon: "info",
      callback: () => {
        new SyncStatusModal(this.app, this.settings, this.pluginData.state).open();
      },
    });
  }

  onunload(): void {
    if (this.editSyncTimer !== null) {
      window.clearTimeout(this.editSyncTimer);
      this.editSyncTimer = null;
    }
    if (this.autoSyncIntervalHandle !== null) {
      window.clearInterval(this.autoSyncIntervalHandle);
      this.autoSyncIntervalHandle = null;
    }
    void this.syncManager?.stopEventsListener();
  }

  async sync(trigger: SyncTrigger = "manual"): Promise<SyncResult | void> {
    if (!this.isConfigured()) {
      new Notice("Sync plugin not configured");
      return;
    }

    const result = await this.syncManager.sync(trigger);
    const waiting = await this.refreshConflicts();
    if (trigger === "manual" && waiting > 0) {
      // A sync the user started goes straight to the conflicts, including ones
      // left for later; automatic syncs only mention new ones, so they don't interrupt.
      void this.openConflicts();
    } else if (result.status === "conflict") {
      new Notice("Sync found conflicts. Sync by hand or run the command to resolve sync conflicts to compare the versions.", 8000);
    }
    return result;
  }

  /** Open the conflict window, or the list of conflicts when there are several. */
  async openConflicts(): Promise<void> {
    const records = await this.conflicts.pending();
    if (records.length === 0) {
      new Notice("No sync conflicts to resolve.");
      return;
    }
    if (records.length === 1) {
      await this.resolveConflict(records[0]);
      return;
    }
    new ConflictListModal(this.app, records, (record) => void this.resolveConflict(record)).open();
  }

  private async resolveConflict(record: ConflictRecord): Promise<void> {
    try {
      // For a locked note, Enclave may ask for passwords here.
      const conflict = await this.conflicts.open(record);
      if (conflict) {
        new ConflictModal(this.app, this.conflicts, conflict, () => void this.refreshConflicts()).open();
      }
    } catch (error) {
      new Notice(`Couldn't open the conflict: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Re-reads which conflicts still wait (forgetting ones whose files are gone)
   * and updates the status bar and the settings row. Returns how many wait.
   */
  async refreshConflicts(): Promise<number> {
    const count = (await this.conflicts.pending()).length;
    this.pluginData = await this.stateStore.load();
    const el = this.conflictStatusEl;
    if (el) {
      el.empty();
      if (count === 0) {
        el.hide();
      } else {
        setIcon(el.createSpan({ cls: "envoy-conflict-status-icon" }), "triangle-alert");
        el.createSpan({ text: count === 1 ? "1 conflict" : `${count} conflicts` });
        el.show();
      }
    }
    this.settingsTab?.update();
    return count;
  }

  private async makeConnectContext(): Promise<
    { client: GitLabClient; service: BootstrapService } | null
  > {
    if (!this.isConfigured()) {
      new Notice("Sync plugin not configured");
      return null;
    }
    const token = await this.readToken();
    if (!token) {
      new Notice("GitLab token is missing");
      return null;
    }
    const client = new GitLabClient(this.settings, token);
    const service = new BootstrapService({
      vault: this.app.vault,
      client,
      journal: { suppress: async (operation) => operation() },
      deviceSpecific: new DeviceSpecificPaths(this.app.vault.configDir, this.settings.deviceSpecificPaths),
    });
    return { client, service };
  }

  async previewConnect(): Promise<ConnectPreview | null> {
    const ctx = await this.makeConnectContext();
    if (!ctx) return null;
    try {
      const project = await ctx.client.getProject();
      if (project.empty_repo) {
        const paths = await this.syncManager.listSyncableLocalFiles();
        return {
          mode: "seed",
          branch: this.settings.branch,
          localPushCount: paths.length,
          localPushPaths: paths,
        };
      }
      try {
        return await ctx.service.preview();
      } catch (error) {
        if (error instanceof GitLabNotFoundError) {
          const branches = await ctx.client.listBranches();
          const defaultBranchHint = project.default_branch
            ? `Default: ${project.default_branch}. `
            : "";
          await this.logger.error("Connect branch not found", {
            branch: this.settings.branch,
            branches,
          });
          new Notice(
            `Branch "${this.settings.branch}" not found. ${defaultBranchHint}Available: ${branches.join(", ")}`,
          );
          return null;
        }
        throw error;
      }
    } catch (error) {
      await this.logger.error("Connect preview failed", { error: String(error) });
      new Notice(
        `Could not read GitLab: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async connect(preview: ConnectPreview): Promise<void> {
    const ctx = await this.makeConnectContext();
    if (!ctx) return;
    try {
      const result =
        preview.mode === "seed"
          ? await this.syncManager.initializeEmptyRemote()
          : await this.connectMerge(ctx.service);
      this.pluginData = await this.stateStore.load();
      if (result.status !== "success") {
        await this.logger.error("Connect failed", {
          status: result.status,
          message: result.message,
        });
        new Notice(`Connect failed: ${result.message}`);
        return;
      }
      new Notice(
        preview.mode === "seed"
          ? "Repository initialized from vault"
          : "settingsChanged" in result && result.settingsChanged
            ? "Connected to GitLab. Restart Obsidian to load the vault's settings and plugins."
            : "Connected to GitLab",
      );
    } catch (error) {
      await this.logger.error("Connect failed", { error: String(error) });
      new Notice(
        `Connect failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async connectMerge(
    service: BootstrapService,
  ): Promise<Awaited<ReturnType<SyncManager["adoptExistingVault"]>> & { settingsChanged: boolean }> {
    const { settingsChanged } = await service.merge();
    return { ...(await this.syncManager.adoptExistingVault()), settingsChanged };
  }

  showSyncRibbonIcon() {
    if (this.syncRibbonIcon) {
      return;
    }
    this.syncRibbonIcon = this.addRibbonIcon(
      "refresh-cw",
      "Sync with GitLab",
      () => void this.sync("manual"),
    );
  }

  hideSyncRibbonIcon() {
    this.syncRibbonIcon?.remove();
    this.syncRibbonIcon = null;
  }

  async loadSettings() {
    this.stateStore = new StateStore(this);
    this.pluginData = await this.stateStore.load();
    this.settings = this.pluginData.settings;
  }

  async saveSettings() {
    this.pluginData.settings = this.settings;
    await this.stateStore.save(this.pluginData);
  }

  async reset() {
    this.pluginData.state = { ...DEFAULT_STATE, trackedFiles: {}, dirtyEntries: {} };
    await this.saveSettings();
  }

  /** Once per device: two sync services on the same files get in each other's way. */
  private async warnAboutObsidianSync(): Promise<void> {
    if (this.settings.obsidianSyncWarningShown || !(await obsidianSyncEnabled(this.app.vault))) {
      return;
    }
    new Notice(OBSIDIAN_SYNC_WARNING, 20000);
    this.settings.obsidianSyncWarningShown = true;
    await this.saveSettings();
  }

  /** The latest syncs on this device that changed something or failed, newest first. */
  async loadSyncHistory(): Promise<SyncHistoryEntry[]> {
    return (await this.stateStore.load()).state.syncHistory ?? [];
  }

  async clearSyncHistory(): Promise<void> {
    await this.stateStore.update((data) => {
      data.state.syncHistory = [];
    });
    this.pluginData = await this.stateStore.load();
  }

  private isConfigured(): boolean {
    return (
      this.settings.gitlabBaseUrl.trim() !== "" &&
      this.settings.projectPath.trim() !== "" &&
      this.settings.branch.trim() !== ""
    );
  }

  private async readToken(): Promise<string | null> {
    const token = this.app.secretStorage.getSecret(this.settings.tokenSecretName);
    return token?.trim() || null;
  }

  private registerAppLifecycleHandlers(): void {
    if (typeof document !== "undefined") {
      this.registerDomEvent(document, "visibilitychange", (event) => {
        void this.logAppLifecycleEvent(event);
        void this.syncOnVisibilityChangeIfNeeded();
      });
    }

    if (typeof window !== "undefined") {
      for (const eventName of ["focus", "blur", "pageshow", "pagehide"] as const) {
        this.registerDomEvent(window, eventName, (event) => {
          void this.logAppLifecycleEvent(event);
        });
      }
    }
  }

  private async logAppLifecycleEvent(event: Event): Promise<void> {
    await this.logger.debug("App lifecycle event", {
      event: event.type,
      visibilityState: typeof document === "undefined" ? null : document.visibilityState,
      documentHidden: typeof document === "undefined" ? null : document.hidden,
      hasFocus: typeof document === "undefined" ? null : document.hasFocus(),
      persisted: "persisted" in event ? Boolean((event as PageTransitionEvent).persisted) : null,
    });
  }

  private async syncOnForegroundIfNeeded(): Promise<void> {
    const reason = this.foregroundSyncSkipReason();
    if (reason) {
      await this.logger.debug("Foreground sync skipped", { reason });
      return;
    }

    this.lastForegroundSyncAt = Date.now();
    this.rememberAutoSync("foreground");
    await this.logger.info("Foreground sync started", {
      cooldownMs: FOREGROUND_SYNC_COOLDOWN_MS,
    });
    await this.logAutoSyncResult("Foreground", await this.sync("foreground"));
  }

  private async syncOnVisibilityChangeIfNeeded(): Promise<void> {
    if (typeof document === "undefined") {
      await this.logger.debug("Visibility sync skipped", { reason: "document-unavailable" });
      return;
    }

    if (document.visibilityState === "hidden" || document.hidden) {
      await this.syncOnBackgroundIfNeeded();
      return;
    }

    await this.syncOnForegroundIfNeeded();
  }

  private async syncOnBackgroundIfNeeded(): Promise<void> {
    const reason = this.backgroundSyncSkipReason();
    if (reason) {
      await this.logger.debug("Background sync skipped", { reason });
      return;
    }

    this.lastBackgroundSyncAt = Date.now();
    this.rememberAutoSync("background");
    await this.logger.info("Background sync started", {
      cooldownMs: BACKGROUND_SYNC_COOLDOWN_MS,
    });
    await this.logAutoSyncResult("Background", await this.sync("background"));
  }

  private foregroundSyncSkipReason(): string | null {
    if (typeof document === "undefined") {
      return "document-unavailable";
    }
    if (document.visibilityState !== "visible" || document.hidden) {
      return "not-visible";
    }
    if (!this.settings.syncOnForeground) {
      return "setting-disabled";
    }
    if (!this.layoutReady) {
      return "layout-not-ready";
    }
    if (!this.pluginData.state.initialized) {
      return "vault-not-initialized";
    }
    if (this.syncManager.isSyncing()) {
      return "sync-already-running";
    }
    if (this.wasRecentAutoSync("background")) {
      return "recent-background-sync";
    }
    if (
      this.lastForegroundSyncAt !== null &&
      Date.now() - this.lastForegroundSyncAt < FOREGROUND_SYNC_COOLDOWN_MS
    ) {
      return "cooldown";
    }
    return null;
  }

  private backgroundSyncSkipReason(): string | null {
    if (typeof document === "undefined") {
      return "document-unavailable";
    }
    if (document.visibilityState !== "hidden" && !document.hidden) {
      return "not-hidden";
    }
    if (!this.settings.syncOnBackground) {
      return "setting-disabled";
    }
    if (!this.layoutReady) {
      return "layout-not-ready";
    }
    if (!this.pluginData.state.initialized) {
      return "vault-not-initialized";
    }
    if (this.syncManager.isSyncing()) {
      return "sync-already-running";
    }
    if (
      this.lastBackgroundSyncAt !== null &&
      Date.now() - this.lastBackgroundSyncAt < BACKGROUND_SYNC_COOLDOWN_MS
    ) {
      return "cooldown";
    }
    return null;
  }

  private rememberAutoSync(trigger: "foreground" | "background"): void {
    this.lastAutoSyncAt = Date.now();
    this.lastAutoSyncTrigger = trigger;
  }

  private wasRecentAutoSync(trigger: "foreground" | "background"): boolean {
    return (
      this.lastAutoSyncTrigger === trigger &&
      this.lastAutoSyncAt !== null &&
      Date.now() - this.lastAutoSyncAt < AUTO_SYNC_COOLDOWN_MS
    );
  }

  private registerEditSyncListeners(): void {
    const vault = this.app.vault as unknown as {
      on?: (name: string, callback: (...args: unknown[]) => void) => unknown;
    };
    if (typeof vault.on !== "function") {
      return;
    }
    for (const name of ["create", "modify", "delete", "rename"] as const) {
      const ref = vault.on(name, () => this.scheduleEditSync());
      this.registerEvent(ref as never);
    }
  }

  private scheduleEditSync(): void {
    if (!this.settings.syncAfterEdit) {
      return;
    }
    // Ignore file events emitted by the plugin's own writes during a sync so
    // materialization does not trigger a follow-up sync loop.
    if (this.syncManager.isSyncing()) {
      return;
    }
    if (this.editSyncTimer !== null) {
      window.clearTimeout(this.editSyncTimer);
    }
    const seconds = Math.max(
      MIN_EDIT_DEBOUNCE_SECONDS,
      this.settings.syncAfterEditDebounceSeconds || DEFAULT_EDIT_DEBOUNCE_SECONDS,
    );
    this.editSyncTimer = window.setTimeout(() => {
      this.editSyncTimer = null;
      void this.syncOnEditIfNeeded();
    }, seconds * 1000);
  }

  private async syncOnEditIfNeeded(): Promise<void> {
    const reason =
      this.autoSyncBaseSkipReason() ??
      (!this.settings.syncAfterEdit ? "setting-disabled" : null) ??
      (this.lastEditSyncAt !== null && Date.now() - this.lastEditSyncAt < EDIT_SYNC_COOLDOWN_MS
        ? "cooldown"
        : null);
    if (reason) {
      await this.logger.debug("Edit sync skipped", { reason });
      return;
    }

    this.lastEditSyncAt = Date.now();
    await this.logger.info("Edit sync started", {
      debounceSeconds: this.settings.syncAfterEditDebounceSeconds,
    });
    await this.logAutoSyncResult("Edit", await this.sync("edit"));
  }

  refreshAutoSyncInterval(): void {
    if (this.autoSyncIntervalHandle !== null) {
      window.clearInterval(this.autoSyncIntervalHandle);
      this.autoSyncIntervalHandle = null;
    }
    if (!this.settings.syncOnInterval) {
      return;
    }
    const minutes = Math.max(
      MIN_INTERVAL_MINUTES,
      this.settings.syncIntervalMinutes || DEFAULT_INTERVAL_MINUTES,
    );
    this.autoSyncIntervalHandle = window.setInterval(() => {
      void this.syncOnIntervalIfNeeded();
    }, minutes * 60_000);
    this.registerInterval(this.autoSyncIntervalHandle);
  }

  private async syncOnIntervalIfNeeded(): Promise<void> {
    const reason =
      this.autoSyncBaseSkipReason() ??
      (!this.settings.syncOnInterval ? "setting-disabled" : null) ??
      (this.lastIntervalSyncAt !== null &&
      Date.now() - this.lastIntervalSyncAt < INTERVAL_SYNC_COOLDOWN_MS
        ? "cooldown"
        : null);
    if (reason) {
      await this.logger.debug("Interval sync skipped", { reason });
      return;
    }

    this.lastIntervalSyncAt = Date.now();
    await this.logger.info("Interval sync started", {
      intervalMinutes: this.settings.syncIntervalMinutes,
    });
    await this.logAutoSyncResult("Interval", await this.sync("interval"));
  }

  private autoSyncBaseSkipReason(): string | null {
    if (!this.layoutReady) {
      return "layout-not-ready";
    }
    if (!this.pluginData.state.initialized) {
      return "vault-not-initialized";
    }
    if (this.syncManager.isSyncing()) {
      return "sync-already-running";
    }
    return null;
  }

  private async logAutoSyncResult(
    label: "Foreground" | "Background" | "Edit" | "Interval",
    result: SyncResult | void,
  ): Promise<void> {
    if (!result) {
      await this.logger.info(`${label} sync finished`, { status: "skipped" });
      return;
    }
    await this.logger.info(`${label} sync finished`, {
      status: result.status,
      trigger: result.trigger,
      commitSha: result.commitSha ?? null,
      recovered: result.recovered ?? false,
      attempts: result.attempts ?? null,
    });
  }
}

/** A notice with a second, smaller line, e.g. what a sync changed. */
function withDetail(message: string, detail: string): DocumentFragment {
  return createFragment((fragment) => {
    fragment.createDiv({ text: message });
    fragment.createDiv({ cls: "envoy-notice-detail", text: detail });
  });
}
