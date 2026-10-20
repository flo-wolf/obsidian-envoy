export type DirtyOperation = "upsert" | "delete";
export type LogLevel = "off" | "error" | "info" | "debug";
export type ConflictStrategy = "remote" | "local" | "auto-remote" | "auto-local";

export interface DirtyEntry {
  path: string;
  operation: DirtyOperation;
  recordedAt: number;
}

export interface TrackedFile {
  blobId: string;
  mode: string;
  size: number;
}

export interface GitLabSyncSettings {
  gitlabBaseUrl: string;
  projectPath: string;
  branch: string;
  tokenSecretName: string;
  authorName: string;
  authorEmail: string;
  syncOnStartup: boolean;
  syncOnForeground: boolean;
  syncOnBackground: boolean;
  syncAfterEdit: boolean;
  syncAfterEditDebounceSeconds: number;
  syncOnInterval: boolean;
  syncIntervalMinutes: number;
  showRibbonIcon: boolean;
  loggingLevel: LogLevel;
  loggingEnabled: boolean;
  conflictStrategy: ConflictStrategy;
  /** With Enclave: lock every unlocked note before a manual sync (sidebar button, Sync command). */
  lockBeforeManualSync: boolean;
  /**
   * Settings files this device keeps for itself: .gitignore-style patterns
   * relative to the config folder. Stored with Envoy's settings, which never sync.
   */
  deviceSpecificPaths: string[];
}

/**
 * A conflict the sync couldn't merge: the note keeps one side's version at its
 * path and the other side's version sits in a copy next to it, until the user
 * resolves it in the conflict window.
 */
export interface ConflictRecord {
  /** The note; its file holds `keptSide`'s version. */
  path: string;
  /** The conflict copy, holding the other side's version. */
  copyPath: string;
  /** Which side's version stayed at `path`. */
  keptSide: "local" | "remote";
  /** Git blob id of the last synced version both sides started from, if known. */
  baseBlobId: string | null;
  createdAt: number;
}

export interface MaterializeOperation {
  type: "write" | "delete";
  path: string;
  contentBase64?: string;
}

export interface PendingTransaction {
  transactionId: string;
  committedSha: string;
  materializeOperations: MaterializeOperation[];
  nextTrackedFiles: Record<string, TrackedFile>;
  acknowledgedDirtyPaths: string[];
  conflictPaths: string[];
  /** Conflicts to record once the transaction is applied. */
  conflicts?: ConflictRecord[];
  createdAt: number;
}

export interface LocalSyncState {
  schemaVersion: 1;
  initialized: boolean;
  lastSyncedCommitSha: string | null;
  trackedFiles: Record<string, TrackedFile>;
  dirtyEntries: Record<string, DirtyEntry>;
  pendingTransaction: PendingTransaction | null;
  lastSyncAt: number | null;
  lastSyncResult: "never" | "success" | "conflict" | "error";
  /**
   * Notes whose remote change hasn't been applied because the note was held back
   * (open in plain text here). Looked at again on every sync until applied.
   */
  deferredPaths?: string[];
  /** Conflicts waiting to be resolved in the conflict window. */
  conflicts?: ConflictRecord[];
  /**
   * Paths kept as device-specific settings at the last sync, so a path taken
   * off the list can be handed back to sync.
   */
  deviceSpecificPaths?: string[];
  /**
   * Modification time and size of config-folder files and dot-files when they
   * last matched the synced version, so a sync only re-reads the ones that changed.
   */
  hiddenFiles?: Record<string, { mtime: number; size: number }>;
}

export interface PluginData {
  settings: GitLabSyncSettings;
  state: LocalSyncState;
}
