/*
 * Recognizes notes locked by Enclave (https://github.com/flo-wolf/obsidian-enclave)
 * from their content alone, so Courier can protect them even when Enclave isn't
 * installed or loaded. Mirrors Enclave's own check: the leading frontmatter
 * holds `locked: true`, and an ```enclave block holds an AES-GCM payload.
 */

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---(?:\n|$)/;
const MARKER_RE = /^locked:\s*true\s*$/m;
const FENCE_RE = /```enclave[^\n]*\n([\s\S]*?)\n```/;

/** Whether `text` is a note locked by Enclave. */
export function isEnclaveLockedText(text: string): boolean {
  const normalized = text.replace(/\r\n?/g, "\n");
  const frontmatter = normalized.match(FRONTMATTER_RE);
  if (!frontmatter || !MARKER_RE.test(frontmatter[1])) {
    return false;
  }
  const block = normalized.match(FENCE_RE);
  if (!block) {
    return false;
  }
  try {
    const payload = JSON.parse(block[1].trim()) as Record<string, unknown> | null;
    return (
      !!payload &&
      payload.alg === "AES-GCM" &&
      typeof payload.ct === "string" &&
      payload.ct.length > 0 &&
      typeof payload.salt === "string" &&
      typeof payload.iv === "string"
    );
  } catch {
    return false;
  }
}

/** Whether `bytes` are a note locked by Enclave. Only Markdown files can be. */
export function isEnclaveLocked(path: string, bytes: Uint8Array | null): boolean {
  if (bytes === null || !path.toLowerCase().endsWith(".md")) {
    return false;
  }
  return isEnclaveLockedText(new TextDecoder().decode(bytes));
}
