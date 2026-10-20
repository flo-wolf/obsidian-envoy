import { describe, expect, it } from "vitest";
import { assembleMerge, conflictCount, mergeChunks } from "../../src/merge/merge-chunks";

const lines = (...values: string[]) => values.join("\n");

describe("mergeChunks", () => {
  it("takes changes made on one side only automatically", () => {
    const chunks = mergeChunks(
      lines("title", "a", "b", "c"),
      lines("title", "a mine", "b", "c"),
      lines("title", "a", "b", "c theirs"),
    );

    expect(chunks).toEqual([
      { kind: "same", lines: ["title"] },
      { kind: "auto", from: "mine", lines: ["a mine"] },
      { kind: "same", lines: ["b"] },
      { kind: "auto", from: "theirs", lines: ["c theirs"] },
    ]);
    expect(conflictCount(chunks)).toBe(0);
    expect(assembleMerge(chunks, [])).toBe(lines("title", "a mine", "b", "c theirs"));
  });

  it("leaves the same line changed differently on both sides for the user", () => {
    const chunks = mergeChunks(lines("a", "b", "c"), lines("a", "b mine", "c"), lines("a", "b theirs", "c"));

    expect(chunks).toEqual([
      { kind: "same", lines: ["a"] },
      { kind: "conflict", mine: ["b mine"], theirs: ["b theirs"] },
      { kind: "same", lines: ["c"] },
    ]);
    expect(assembleMerge(chunks, [undefined])).toBeNull();
    expect(assembleMerge(chunks, ["mine"])).toBe(lines("a", "b mine", "c"));
    expect(assembleMerge(chunks, ["theirs"])).toBe(lines("a", "b theirs", "c"));
    expect(assembleMerge(chunks, ["both"])).toBe(lines("a", "b mine", "b theirs", "c"));
  });

  it("treats the same change on both sides as no conflict", () => {
    const chunks = mergeChunks(lines("a", "b"), lines("a", "b fixed"), lines("a", "b fixed"));

    expect(chunks).toEqual([
      { kind: "same", lines: ["a"] },
      { kind: "auto", from: "both", lines: ["b fixed"] },
    ]);
  });

  it("asks once for edits that overlap the same region", () => {
    const chunks = mergeChunks(
      lines("a", "b", "c", "d"),
      lines("a", "b mine", "c mine", "d"),
      lines("a", "b", "c theirs", "d"),
    );

    expect(chunks).toEqual([
      { kind: "same", lines: ["a"] },
      { kind: "conflict", mine: ["b mine", "c mine"], theirs: ["b", "c theirs"] },
      { kind: "same", lines: ["d"] },
    ]);
  });

  it("asks about two insertions at the same point", () => {
    const chunks = mergeChunks(lines("a", "b"), lines("a", "mine", "b"), lines("a", "theirs", "b"));

    expect(chunks).toEqual([
      { kind: "same", lines: ["a"] },
      { kind: "conflict", mine: ["mine"], theirs: ["theirs"] },
      { kind: "same", lines: ["b"] },
    ]);
    expect(assembleMerge(chunks, ["both"])).toBe(lines("a", "mine", "theirs", "b"));
  });

  it("compares the two versions directly when the base isn't known", () => {
    const chunks = mergeChunks(null, lines("a", "b mine", "c"), lines("a", "b theirs", "c", "d"));

    expect(chunks).toEqual([
      { kind: "same", lines: ["a"] },
      { kind: "conflict", mine: ["b mine"], theirs: ["b theirs"] },
      { kind: "same", lines: ["c"] },
      { kind: "conflict", mine: [], theirs: ["d"] },
    ]);
    expect(assembleMerge(chunks, ["mine", "theirs"])).toBe(lines("a", "b mine", "c", "d"));
  });

  it("keeps a trailing newline", () => {
    const chunks = mergeChunks("a\n", "a mine\n", "a\n");
    expect(assembleMerge(chunks, [])).toBe("a mine\n");
  });
});
