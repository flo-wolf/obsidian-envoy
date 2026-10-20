import { describe, expect, it, vi } from "vitest";
import { completionDetail } from "../../src/sync/sync-manager";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => path,
  Platform: {},
}));

describe("completionDetail", () => {
  it("says nothing changed", () => {
    expect(completionDetail({ pulled: 0, pushed: 0 })).toBe("No changes");
    expect(completionDetail({})).toBe("No changes");
  });

  it("counts files pulled and pushed", () => {
    expect(completionDetail({ pulled: 4, pushed: 5 })).toBe("4 ↓   5 ↑");
  });

  it("adds notes held back on their own line", () => {
    const held = [{ path: "a.md", reason: "unlocked" as const }];
    expect(completionDetail({ pulled: 0, pushed: 0, held })).toBe(
      "No changes\n1 note held back until it's locked",
    );
  });
});
