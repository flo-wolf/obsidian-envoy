import type { GitLabCommitAction } from "../gitlab/types";
import type {
  ConflictRecord,
  MaterializeOperation,
  SyncHistoryEntry,
  SyncHistoryFile,
  TrackedFile,
} from "./types";

/** Syncs kept in the history, newest first. */
export const MAX_HISTORY_ENTRIES = 30;
/** Files listed per sync; the rest are only counted. */
const MAX_FILES_PER_ENTRY = 200;

export type SyncChanges = Pick<SyncHistoryEntry, "pulled" | "pushed" | "merged" | "conflicts" | "omitted">;

/**
 * What a sync did, file by file. Merged files and conflicts (the file and its
 * copy) are listed only under merged and conflicts, not also as pulled or pushed.
 */
export function describeChanges(input: {
  actions: GitLabCommitAction[];
  materialized: MaterializeOperation[];
  mergedPaths: string[];
  conflictRecords: ConflictRecord[];
  /** The synced index before this sync, to tell added files from changed ones. */
  trackedBefore: Record<string, TrackedFile>;
}): SyncChanges {
  const special = new Set([
    ...input.mergedPaths,
    ...input.conflictRecords.flatMap((record) => [record.path, record.copyPath]),
  ]);

  const pulled = new Map<string, SyncHistoryFile>();
  for (const operation of input.materialized) {
    if (special.has(operation.path)) continue;
    pulled.set(operation.path, {
      path: operation.path,
      change: operation.type === "delete" ? "deleted" : input.trackedBefore[operation.path] ? "changed" : "added",
    });
  }

  const pushed = new Map<string, SyncHistoryFile>();
  for (const action of input.actions) {
    if (special.has(action.file_path)) continue;
    pushed.set(action.file_path, {
      path: action.file_path,
      change: action.action === "create" ? "added" : action.action === "delete" ? "deleted" : "changed",
    });
  }

  const lists = {
    pulled: sortedFiles(pulled),
    pushed: sortedFiles(pushed),
    merged: [...new Set(input.mergedPaths)].sort(),
    conflicts: input.conflictRecords
      .map((record) => ({ path: record.path, copyPath: record.copyPath }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
  return capped(lists);
}

/** Whether a sync is worth a history entry: it changed something, held notes back, or failed. */
export function isNoteworthy(entry: SyncHistoryEntry): boolean {
  return (
    entry.status === "error" ||
    entry.pulled.length + entry.pushed.length + entry.merged.length + entry.conflicts.length + entry.held.length > 0 ||
    (entry.omitted ?? 0) > 0
  );
}

/**
 * The history with `entry` added at the front. The same error again right
 * away is counted on the previous entry instead of filling the list.
 */
export function withEntry(history: SyncHistoryEntry[], entry: SyncHistoryEntry): SyncHistoryEntry[] {
  const [latest, ...older] = history;
  if (latest && entry.status === "error" && latest.status === "error" && latest.error === entry.error) {
    return [{ ...latest, at: entry.at, repeated: (latest.repeated ?? 1) + 1 }, ...older];
  }
  return [entry, ...history].slice(0, MAX_HISTORY_ENTRIES);
}

function sortedFiles(files: Map<string, SyncHistoryFile>): SyncHistoryFile[] {
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function capped(lists: Omit<SyncChanges, "omitted">): SyncChanges {
  let room = MAX_FILES_PER_ENTRY;
  let omitted = 0;
  const take = <T>(items: T[]): T[] => {
    const kept = items.slice(0, Math.max(room, 0));
    room -= kept.length;
    omitted += items.length - kept.length;
    return kept;
  };
  const result: SyncChanges = {
    conflicts: take(lists.conflicts),
    merged: take(lists.merged),
    pushed: take(lists.pushed),
    pulled: take(lists.pulled),
  };
  if (omitted > 0) {
    result.omitted = omitted;
  }
  return result;
}
