/*
 * Splits a conflict between two versions of a note into the pieces the conflict
 * window shows: unchanged text, changes made on one side only (taken
 * automatically), and spots changed differently on both sides, where the user
 * picks this device's version, GitLab's, or both.
 *
 * With the common base (the last synced version), changes are compared against
 * it, like the sync's own automatic merge. Without it, the two versions are
 * compared directly and every difference is the user's choice.
 */

import { diffTextEdits, type TextEdit } from "../sync/text-diff";

export type MergeChunk =
  /** Unchanged on both sides. */
  | { kind: "same"; lines: string[] }
  /** Changed on one side only, or the same way on both: taken as is. */
  | { kind: "auto"; from: "mine" | "theirs" | "both"; lines: string[] }
  /** Changed differently on both sides: the user decides. */
  | { kind: "conflict"; mine: string[]; theirs: string[] };

/** What the user picked for a conflict chunk: one side, or this device's followed by GitLab's. */
export type ChunkChoice = "mine" | "theirs" | "both";

export function mergeChunks(base: string | null, mine: string, theirs: string): MergeChunk[] {
  return joinSame(base === null ? twoWay(mine, theirs) : threeWay(base, mine, theirs));
}

/**
 * The merged text, given a choice for every conflict chunk (`choices[i]` for
 * the i-th conflict). Null while any conflict is still undecided.
 */
export function assembleMerge(chunks: MergeChunk[], choices: (ChunkChoice | undefined)[]): string | null {
  const lines: string[] = [];
  let conflict = 0;
  for (const chunk of chunks) {
    if (chunk.kind !== "conflict") {
      lines.push(...chunk.lines);
      continue;
    }
    const choice = choices[conflict++];
    if (!choice) {
      return null;
    }
    if (choice !== "theirs") lines.push(...chunk.mine);
    if (choice !== "mine") lines.push(...chunk.theirs);
  }
  return lines.join("\n");
}

export function conflictCount(chunks: MergeChunk[]): number {
  return chunks.filter((chunk) => chunk.kind === "conflict").length;
}

type SidedEdit = TextEdit & { side: "mine" | "theirs" };

function threeWay(baseText: string, mineText: string, theirsText: string): MergeChunk[] {
  const base = baseText.split("\n");
  const edits: SidedEdit[] = [
    ...diffTextEdits(base, mineText.split("\n")).map((edit) => ({ ...edit, side: "mine" as const })),
    ...diffTextEdits(base, theirsText.split("\n")).map((edit) => ({ ...edit, side: "theirs" as const })),
  ].sort((left, right) => left.start - right.start || left.end - right.end);

  const chunks: MergeChunk[] = [];
  let cursor = 0;
  let index = 0;
  while (index < edits.length) {
    // Grow a region of edits that touch the same part of the base.
    const region = [edits[index]];
    const start = edits[index].start;
    let end = edits[index].end;
    index += 1;
    while (index < edits.length && touches(edits[index], start, end)) {
      end = Math.max(end, edits[index].end);
      region.push(edits[index]);
      index += 1;
    }

    chunks.push({ kind: "same", lines: base.slice(cursor, start) });
    const mine = applyEdits(base, start, end, region.filter((edit) => edit.side === "mine"));
    const theirs = applyEdits(base, start, end, region.filter((edit) => edit.side === "theirs"));
    const mineChanged = region.some((edit) => edit.side === "mine");
    const theirsChanged = region.some((edit) => edit.side === "theirs");
    if (!theirsChanged) {
      chunks.push({ kind: "auto", from: "mine", lines: mine });
    } else if (!mineChanged) {
      chunks.push({ kind: "auto", from: "theirs", lines: theirs });
    } else if (sameLines(mine, theirs)) {
      chunks.push({ kind: "auto", from: "both", lines: mine });
    } else {
      chunks.push({ kind: "conflict", mine, theirs });
    }
    cursor = end;
  }
  chunks.push({ kind: "same", lines: base.slice(cursor) });
  return chunks;
}

function twoWay(mineText: string, theirsText: string): MergeChunk[] {
  const mine = mineText.split("\n");
  const chunks: MergeChunk[] = [];
  let cursor = 0;
  for (const edit of diffTextEdits(mine, theirsText.split("\n"))) {
    chunks.push({ kind: "same", lines: mine.slice(cursor, edit.start) });
    chunks.push({ kind: "conflict", mine: mine.slice(edit.start, edit.end), theirs: edit.lines });
    cursor = edit.end;
  }
  chunks.push({ kind: "same", lines: mine.slice(cursor) });
  return chunks;
}

/**
 * Whether `edit` affects the base region [start, end): it overlaps it, or both
 * are insertions at the same point. Edits that merely meet at a boundary don't,
 * matching the sync's automatic merge.
 */
function touches(edit: TextEdit, start: number, end: number): boolean {
  if (edit.start < end) {
    return true;
  }
  return edit.start === end && edit.start === edit.end && start === end;
}

/** Base lines [start, end) with one side's edits in that region applied. */
function applyEdits(base: string[], start: number, end: number, edits: TextEdit[]): string[] {
  const lines: string[] = [];
  let cursor = start;
  for (const edit of edits) {
    lines.push(...base.slice(cursor, edit.start), ...edit.lines);
    cursor = edit.end;
  }
  lines.push(...base.slice(cursor, end));
  return lines;
}

/** Drop empty unchanged chunks and join neighbouring ones. */
function joinSame(chunks: MergeChunk[]): MergeChunk[] {
  const joined: MergeChunk[] = [];
  for (const chunk of chunks) {
    const previous = joined[joined.length - 1];
    if (chunk.kind === "same") {
      if (chunk.lines.length === 0) continue;
      if (previous?.kind === "same") {
        previous.lines.push(...chunk.lines);
        continue;
      }
    }
    joined.push(chunk);
  }
  return joined;
}

function sameLines(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}
