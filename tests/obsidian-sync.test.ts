import { describe, expect, it, vi } from "vitest";
import { obsidianSyncEnabled } from "../src/obsidian-sync";

vi.mock("obsidian", () => ({ normalizePath: (path: string) => path }));

function vault(content: string | null) {
  return {
    configDir: ".obsidian",
    adapter: {
      exists: async (path: string) => path === ".obsidian/core-plugins.json" && content !== null,
      read: async () => content ?? "",
    },
  };
}

describe("obsidianSyncEnabled", () => {
  it("reads the core plugin list", async () => {
    expect(await obsidianSyncEnabled(vault('{"sync": true, "graph": true}'))).toBe(true);
    expect(await obsidianSyncEnabled(vault('{"sync": false}'))).toBe(false);
  });

  it("understands the older list format", async () => {
    expect(await obsidianSyncEnabled(vault('["graph", "sync"]'))).toBe(true);
    expect(await obsidianSyncEnabled(vault('["graph"]'))).toBe(false);
  });

  it("says no when the file is missing or broken", async () => {
    expect(await obsidianSyncEnabled(vault(null))).toBe(false);
    expect(await obsidianSyncEnabled(vault("{not json"))).toBe(false);
  });
});
