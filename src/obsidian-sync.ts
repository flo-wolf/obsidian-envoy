import { normalizePath } from "obsidian";

interface ConfigVault {
  configDir: string;
  adapter: {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
  };
}

export const OBSIDIAN_SYNC_WARNING =
  "Obsidian Sync is also turned on in this vault. Envoy already syncs it, so turn Obsidian Sync off under " +
  "Settings → Core plugins → Sync. That also removes its status bar icon and menu entries.";

/**
 * Whether Obsidian's own Sync core plugin is turned on, read from the config
 * folder's core-plugins.json (an object of plugin ids, or a list in older vaults).
 */
export async function obsidianSyncEnabled(vault: ConfigVault): Promise<boolean> {
  try {
    const path = normalizePath(`${vault.configDir}/core-plugins.json`);
    if (!(await vault.adapter.exists(path))) {
      return false;
    }
    const parsed: unknown = JSON.parse(await vault.adapter.read(path));
    if (Array.isArray(parsed)) {
      return parsed.includes("sync");
    }
    return typeof parsed === "object" && parsed !== null && (parsed as Record<string, unknown>).sync === true;
  } catch {
    return false;
  }
}
