import ignore, { type Ignore } from "ignore";
import { normalizePath } from "obsidian";
import type { RemoteChange } from "./remote-diff";
import type { TrackedFile } from "./types";

/**
 * Settings files this device keeps for itself ("Device-specific settings"):
 * never uploaded from here, never overwritten or deleted here by a sync. The
 * entries are .gitignore-style patterns relative to the config folder, e.g.
 * `appearance.json` or `themes/`.
 */
export class DeviceSpecificPaths {
  private readonly configDir: string;
  private readonly matcher: Ignore | null;

  constructor(configDir: string, entries: readonly string[] = []) {
    this.configDir = normalizePath(configDir);
    const patterns = entries.map((entry) => entry.trim()).filter((entry) => entry !== "" && !entry.startsWith("#"));
    this.matcher = patterns.length > 0 ? ignore().add(patterns) : null;
  }

  /** Whether the file at `path` (a vault path) is kept on this device only. */
  matches(path: string): boolean {
    const relative = this.relative(path);
    if (relative === null || !this.matcher) {
      return false;
    }
    if (this.matcher.ignores(relative)) {
      return true;
    }
    // A folder entry such as `themes/` also covers everything inside it.
    const parts = relative.split("/");
    for (let end = 1; end < parts.length; end += 1) {
      if (this.matcher.ignores(`${parts.slice(0, end).join("/")}/`)) {
        return true;
      }
    }
    return false;
  }

  /** Whether the folder at `path` (a vault path) is kept on this device only. */
  matchesFolder(path: string): boolean {
    const relative = this.relative(path);
    return relative !== null && !!this.matcher && (this.matcher.ignores(`${relative}/`) || this.matches(path));
  }

  private relative(path: string): string | null {
    const normalized = normalizePath(path);
    return normalized.startsWith(`${this.configDir}/`) ? normalized.slice(this.configDir.length + 1) : null;
  }

  /** `files` without the device-specific paths. */
  withoutMatches(files: Record<string, TrackedFile>): Record<string, TrackedFile> {
    return Object.fromEntries(Object.entries(files).filter(([path]) => !this.matches(path)));
  }

  /**
   * Remote changes this device applies: changes to device-specific paths are
   * left out. A rename across the boundary keeps the side that isn't.
   */
  applicable(changes: RemoteChange[]): { changes: RemoteChange[]; skippedPaths: string[] } {
    const kept: RemoteChange[] = [];
    const skippedPaths: string[] = [];
    for (const change of changes) {
      if (change.type !== "rename") {
        if (this.matches(change.path)) {
          skippedPaths.push(change.path);
        } else {
          kept.push(change);
        }
        continue;
      }
      const oldLocal = this.matches(change.oldPath);
      const newLocal = this.matches(change.newPath);
      if (oldLocal) skippedPaths.push(change.oldPath);
      if (newLocal) skippedPaths.push(change.newPath);
      if (!oldLocal && !newLocal) {
        kept.push(change);
      } else if (!oldLocal) {
        kept.push({ type: "delete", path: change.oldPath });
      } else if (!newLocal) {
        kept.push({ type: "create", path: change.newPath });
      }
    }
    return { changes: kept, skippedPaths };
  }
}

/** Splits the settings text (one entry per line) into entries. */
export function parseDeviceSpecificEntries(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}
