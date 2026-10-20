import { describe, expect, it } from "vitest";
import { describeChanges, isNoteworthy, MAX_HISTORY_ENTRIES, withEntry } from "../../src/sync/sync-history";
import type { SyncHistoryEntry } from "../../src/sync/types";

const tracked = { "old.md": { blobId: "a", mode: "100644", size: 1 } };

function entry(overrides: Partial<SyncHistoryEntry> = {}): SyncHistoryEntry {
  return { at: 1, trigger: "manual", status: "success", pulled: [], pushed: [], merged: [], conflicts: [], held: [], ...overrides };
}

describe("describeChanges", () => {
  it("tells added, changed and deleted files apart on both sides", () => {
    const changes = describeChanges({
      actions: [
        { action: "create", file_path: "new.md", content: "", encoding: "base64" },
        { action: "update", file_path: "old.md", content: "", encoding: "base64" },
        { action: "delete", file_path: "gone.md" },
      ],
      materialized: [
        { type: "write", path: "old.md", contentBase64: "" },
        { type: "write", path: "fresh.md", contentBase64: "" },
        { type: "delete", path: "removed.md" },
      ],
      mergedPaths: [],
      conflictRecords: [],
      trackedBefore: tracked,
    });

    expect(changes.pushed).toEqual([
      { path: "gone.md", change: "deleted" },
      { path: "new.md", change: "added" },
      { path: "old.md", change: "changed" },
    ]);
    expect(changes.pulled).toEqual([
      { path: "fresh.md", change: "added" },
      { path: "old.md", change: "changed" },
      { path: "removed.md", change: "deleted" },
    ]);
  });

  it("lists merged files and conflicts only once", () => {
    const changes = describeChanges({
      actions: [
        { action: "update", file_path: "merged.md", content: "", encoding: "base64" },
        { action: "create", file_path: "clash (conflict).md", content: "", encoding: "base64" },
      ],
      materialized: [
        { type: "write", path: "merged.md", contentBase64: "" },
        { type: "write", path: "clash.md", contentBase64: "" },
      ],
      mergedPaths: ["merged.md"],
      conflictRecords: [
        { path: "clash.md", copyPath: "clash (conflict).md", keptSide: "remote", baseBlobId: null, createdAt: 1 },
      ],
      trackedBefore: {},
    });

    expect(changes).toEqual({
      pulled: [],
      pushed: [],
      merged: ["merged.md"],
      conflicts: [{ path: "clash.md", copyPath: "clash (conflict).md" }],
    });
  });

  it("counts files beyond the per-sync limit instead of listing them", () => {
    const actions = Array.from({ length: 250 }, (_, i) => ({
      action: "create" as const,
      file_path: `note-${String(i).padStart(3, "0")}.md`,
      content: "",
      encoding: "base64" as const,
    }));
    const changes = describeChanges({ actions, materialized: [], mergedPaths: [], conflictRecords: [], trackedBefore: {} });

    expect(changes.pushed).toHaveLength(200);
    expect(changes.omitted).toBe(50);
  });
});

describe("history", () => {
  it("leaves out syncs that changed nothing", () => {
    expect(isNoteworthy(entry())).toBe(false);
    expect(isNoteworthy(entry({ pulled: [{ path: "a.md", change: "added" }] }))).toBe(true);
    expect(isNoteworthy(entry({ held: ["a.md"] }))).toBe(true);
    expect(isNoteworthy(entry({ status: "error", error: "offline" }))).toBe(true);
  });

  it("keeps the newest syncs first, up to the limit", () => {
    let history: SyncHistoryEntry[] = [];
    for (let at = 1; at <= MAX_HISTORY_ENTRIES + 5; at += 1) {
      history = withEntry(history, entry({ at, pushed: [{ path: "a.md", change: "changed" }] }));
    }
    expect(history).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(history[0].at).toBe(MAX_HISTORY_ENTRIES + 5);
  });

  it("counts the same error in a row on one entry", () => {
    let history = withEntry([], entry({ at: 1, status: "error", error: "offline" }));
    history = withEntry(history, entry({ at: 2, status: "error", error: "offline" }));
    history = withEntry(history, entry({ at: 3, status: "error", error: "offline" }));
    expect(history).toEqual([entry({ at: 3, status: "error", error: "offline", repeated: 3 })]);

    history = withEntry(history, entry({ at: 4, status: "error", error: "token expired" }));
    expect(history.map((item) => item.error)).toEqual(["token expired", "offline"]);
  });
});
