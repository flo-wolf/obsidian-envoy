import { base64ToArrayBuffer } from "obsidian";

const TEXT_EXTENSIONS = [
  ".css",
  ".md",
  ".json",
  ".txt",
  ".csv",
  ".js",
  ".log",
] as const;

/**
 * Decodes a base64 encoded string, this properly
 * handles emojis and other non ASCII chars.
 *
 * @param s base64 encoded string
 * @returns Decoded string
 */
export function decodeBase64String(s: string): string {
  const buffer = base64ToArrayBuffer(s);
  const decoder = new TextDecoder();
  return decoder.decode(buffer);
}

/** Copies text to the system clipboard; rejects if the system doesn't allow it. */
export async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

/**
 * Checks if a file path has one of the predefined text extensions.
 * This is a best guess at best.
 *
 * @param filePath The path of the file to check
 * @returns True if the file has a text extension, false otherwise
 */
export function hasTextExtension(filePath: string) {
  for (const extension of TEXT_EXTENSIONS) {
    if (filePath.endsWith(extension)) {
      return true;
    }
  }
  return false;
}

/**
 * Retries an async function until its return value satisfies a condition or max retries is reached.
 * Uses exponential backoff between retry attempts.
 *
 * @param fn - The async function to execute and potentially retry
 * @param condition - Function that evaluates if the result is acceptable
 * @param maxRetries - Maximum number of retry attempts (default: 5)
 * @param initialDelay - Initial delay in ms before first retry (default: 1000)
 * @param backoffFactor - Multiplicative factor for delay between retries (default: 2)
 * @returns The result of the function execution
 */
export async function retryUntil<T>(
  fn: () => Promise<T>,
  condition: (result: T) => boolean,
  maxRetries: number = 5,
  initialDelay: number = 1000,
  backoffFactor: number = 2,
): Promise<T> {
  let retries = 0;
  let delay = initialDelay;

  while (true) {
    const result = await fn();

    if (condition(result) || retries >= maxRetries) {
      return result;
    }

    retries++;
    await new Promise((resolve) => window.setTimeout(resolve, delay));
    delay *= backoffFactor;
  }
}
