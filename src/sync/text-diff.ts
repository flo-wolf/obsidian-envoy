/*
 * Line diffs shared by the sync's automatic merge (conflict-resolver.ts) and
 * the conflict window (merge/merge-chunks.ts).
 */

/** Replace `base` lines [start, end) with `lines`. An insertion has start === end. */
export interface TextEdit {
  start: number;
  end: number;
  lines: string[];
}

/** The edits that turn `baseLines` into `changedLines`, in order and non-overlapping. */
export function diffTextEdits(baseLines: string[], changedLines: string[]): TextEdit[] {
  const lcs = lcsTable(baseLines, changedLines);
  const edits: TextEdit[] = [];
  let baseIndex = 0;
  let changedIndex = 0;

  while (baseIndex < baseLines.length || changedIndex < changedLines.length) {
    if (
      baseIndex < baseLines.length &&
      changedIndex < changedLines.length &&
      baseLines[baseIndex] === changedLines[changedIndex]
    ) {
      baseIndex += 1;
      changedIndex += 1;
      continue;
    }

    const start = baseIndex;
    const replacement: string[] = [];
    while (baseIndex < baseLines.length || changedIndex < changedLines.length) {
      if (
        baseIndex < baseLines.length &&
        changedIndex < changedLines.length &&
        baseLines[baseIndex] === changedLines[changedIndex]
      ) {
        break;
      }

      const skipChanged = changedIndex < changedLines.length
        ? lcs[baseIndex][changedIndex + 1] ?? 0
        : -1;
      const skipBase = baseIndex < baseLines.length
        ? lcs[baseIndex + 1]?.[changedIndex] ?? 0
        : -1;

      if (changedIndex < changedLines.length && skipChanged >= skipBase) {
        replacement.push(changedLines[changedIndex]);
        changedIndex += 1;
      } else {
        baseIndex += 1;
      }
    }

    edits.push({ start, end: baseIndex, lines: replacement });
  }

  return edits;
}

function lcsTable(left: string[], right: string[]): number[][] {
  const table = Array.from(
    { length: left.length + 1 },
    () => Array<number>(right.length + 1).fill(0),
  );

  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      table[leftIndex][rightIndex] = left[leftIndex] === right[rightIndex]
        ? table[leftIndex + 1][rightIndex + 1] + 1
        : Math.max(table[leftIndex + 1][rightIndex], table[leftIndex][rightIndex + 1]);
    }
  }

  return table;
}
