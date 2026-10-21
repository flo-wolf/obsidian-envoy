import { describe, expect, it } from "vitest";
import { wordDiff } from "../../src/merge/word-diff";

const marked = (segments: { text: string; changed: boolean }[]) =>
  segments.filter((segment) => segment.changed).map((segment) => segment.text);

describe("wordDiff", () => {
  it("marks only the words that differ", () => {
    const diff = wordDiff(
      "Lock your private notes with a password. Encrypted on file, editable only in Obsidian.",
      "Lock your private notes with a password. Encrypted on disk, readable only in Obsidian.",
    )!;
    expect(marked(diff.mine)).toEqual(["file", "editable"]);
    expect(marked(diff.theirs)).toEqual(["disk", "readable"]);
    expect(diff.mine.map((segment) => segment.text).join("")).toContain("Encrypted on file, editable");
  });

  it("marks words added on one side only", () => {
    const diff = wordDiff("readable only in Obsidian.", "readable only in Obsidian. It's awesome!")!;
    expect(marked(diff.mine)).toEqual([]);
    expect(marked(diff.theirs).join("")).toBe(" It's awesome!");
  });

  it("keeps every character, so the text reads the same", () => {
    const mine = "Über 3 Äpfel,\n  und  mehr";
    const theirs = "Über 4 Äpfel,\nund mehr 🙂";
    const diff = wordDiff(mine, theirs)!;
    expect(diff.mine.map((s) => s.text).join("")).toBe(mine);
    expect(diff.theirs.map((s) => s.text).join("")).toBe(theirs);
  });

  it("gives up on very long parts instead of slowing the window down", () => {
    const long = "word ".repeat(2000);
    expect(wordDiff(long, `${long}x`)).toBeNull();
  });
});
