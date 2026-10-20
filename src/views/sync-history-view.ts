import type { SyncHistoryEntry, SyncHistoryFile } from "../sync/types";

const TRIGGER_LABELS: Record<string, string> = {
  manual: "Sync button",
  startup: "Startup",
  foreground: "App opened",
  background: "App closed",
  edit: "After edits",
  interval: "Timer",
  audit: "Full audit",
};

/**
 * The sync history as one collapsible block per sync: a summary line (when,
 * what started it, counts) that opens to the files, grouped by what happened.
 */
export function renderSyncHistory(containerEl: HTMLElement, history: SyncHistoryEntry[], now = Date.now()): void {
  if (history.length === 0) {
    containerEl.createEl("p", { cls: "envoy-history-empty", text: "No syncs recorded yet." });
    return;
  }
  for (const entry of history) {
    const details = containerEl.createEl("details", { cls: "envoy-history-entry" });
    const summary = details.createEl("summary");
    summary.createSpan({ cls: "envoy-history-when", text: formatWhen(entry.at, now) });
    summary.createSpan({ cls: "envoy-history-trigger", text: TRIGGER_LABELS[entry.trigger] ?? entry.trigger });
    summary.createSpan({
      cls: `envoy-history-counts${entry.status === "error" ? " mod-error" : ""}`,
      text: summaryCounts(entry),
    });

    const body = details.createDiv({ cls: "envoy-history-body" });
    if (entry.status === "error") {
      body.createEl("p", { cls: "envoy-history-error", text: entry.error ?? "Sync failed" });
    }
    fileGroup(body, "Pulled to this device", entry.pulled);
    fileGroup(body, "Pushed to GitLab", entry.pushed);
    pathGroup(body, "Merged (changed on both sides, combined)", entry.merged);
    pathGroup(
      body,
      "Conflicts (the other version is in a copy)",
      entry.conflicts.map((conflict) => `${conflict.path} → ${conflict.copyPath}`),
    );
    pathGroup(body, "Held back until locked", entry.held);
    if (entry.omitted) {
      body.createEl("p", {
        cls: "envoy-history-more",
        text: `…and ${entry.omitted} more ${entry.omitted === 1 ? "file" : "files"}`,
      });
    }
  }
}

/** "4 ↓ 1 ↑ · 1 merged", "Failed", or "Failed 3 times". */
export function summaryCounts(entry: SyncHistoryEntry): string {
  if (entry.status === "error") {
    return entry.repeated && entry.repeated > 1 ? `Failed ${entry.repeated} times` : "Failed";
  }
  const parts: string[] = [];
  if (entry.pulled.length > 0 || entry.pushed.length > 0) {
    parts.push(`${entry.pulled.length} ↓  ${entry.pushed.length} ↑`);
  }
  if (entry.merged.length > 0) parts.push(`${entry.merged.length} merged`);
  if (entry.conflicts.length > 0) {
    parts.push(entry.conflicts.length === 1 ? "1 conflict" : `${entry.conflicts.length} conflicts`);
  }
  if (entry.held.length > 0) parts.push(`${entry.held.length} held back`);
  return parts.join(" · ") || "No changes";
}

/** "Today, 14:32", "Yesterday, 09:05", or "12 Oct, 18:20". */
export function formatWhen(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  if (at >= startOfToday.getTime()) return `Today, ${time}`;
  if (at >= startOfToday.getTime() - dayMs) return `Yesterday, ${time}`;
  return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`;
}

function fileGroup(body: HTMLElement, label: string, files: SyncHistoryFile[]): void {
  if (files.length === 0) return;
  const list = group(body, label, files.length);
  for (const file of files) {
    const item = list.createEl("li");
    item.createSpan({ cls: `envoy-history-change mod-${file.change}`, text: file.change });
    item.createSpan({ cls: "envoy-history-path", text: file.path });
  }
}

function pathGroup(body: HTMLElement, label: string, paths: string[]): void {
  if (paths.length === 0) return;
  const list = group(body, label, paths.length);
  for (const path of paths) {
    list.createEl("li").createSpan({ cls: "envoy-history-path", text: path });
  }
}

function group(body: HTMLElement, label: string, count: number): HTMLElement {
  body.createDiv({ cls: "envoy-history-label", text: `${label} (${count})` });
  return body.createEl("ul", { cls: "envoy-history-files" });
}
