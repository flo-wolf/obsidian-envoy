/** A run of text in one version, marked when it differs from the other version. */
export interface DiffSegment {
  text: string;
  changed: boolean;
}

/** Above this many token comparisons the diff is skipped, so huge conflicts stay fast. */
const MAX_COMPARISONS = 1_000_000;

/**
 * Word-level differences between two versions of a conflicting part: each
 * side as segments, with the words the other side doesn't have marked.
 * Null when the texts are too long to compare quickly.
 */
export function wordDiff(mine: string, theirs: string): { mine: DiffSegment[]; theirs: DiffSegment[] } | null {
  const a = tokenize(mine);
  const b = tokenize(theirs);
  if (a.length * b.length > MAX_COMPARISONS) {
    return null;
  }

  // Longest common subsequence of tokens, filled from the end.
  const width = b.length + 1;
  const lengths = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i * width + j] = a[i] === b[j]
        ? lengths[(i + 1) * width + j + 1] + 1
        : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }

  const left: DiffSegment[] = [];
  const right: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      push(left, a[i], false);
      push(right, b[j], false);
      i += 1;
      j += 1;
    } else if (j >= b.length || (i < a.length && lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) {
      push(left, a[i], true);
      i += 1;
    } else {
      push(right, b[j], true);
      j += 1;
    }
  }
  return { mine: left, theirs: right };
}

/** Words, runs of whitespace, and single punctuation marks. */
function tokenize(text: string): string[] {
  return text.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? [];
}

/** Appends a token, joining it to the previous segment when both are (un)changed alike. */
function push(segments: DiffSegment[], token: string, changed: boolean): void {
  const last = segments[segments.length - 1];
  if (last && last.changed === changed) {
    last.text += token;
  } else {
    segments.push({ text: token, changed });
  }
}
