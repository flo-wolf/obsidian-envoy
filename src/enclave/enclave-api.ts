/*
 * Courier's side of the interface Enclave offers at
 * `app.plugins.getPlugin("enclave").api`. A copy of Enclave's src/api.ts for the
 * version Courier understands; Courier never imports Enclave's code, so it works
 * the same whether Enclave is installed or not.
 */

import type { App } from "obsidian";

export const ENCLAVE_PLUGIN_ID = "enclave";
export const SUPPORTED_ENCLAVE_API_VERSION = 1;

/** Why Enclave says a note must not be uploaded right now. */
export type EnclaveHoldReason = "unlocked" | "exposed" | "not-locked-yet";

export interface EnclaveMergeVersion {
  label: string;
  content: string | null;
  optional?: boolean;
}

export interface EnclaveMergeSession {
  texts: (string | null)[];
  locks: ({ scope: "vault" | "note" } | null)[];
  sameLock: boolean;
  seal(text: string, keep: number): Promise<string>;
  close(): void;
}

export interface EnclaveApi {
  readonly version: number;
  ready(): Promise<void>;
  holdReason(path: string): Promise<EnclaveHoldReason | null>;
  isLockedContent(content: string): boolean;
  isIntentionallyPlain(path: string): boolean;
  lockAll(): Promise<number>;
  onLocked(callback: (path: string) => void): () => void;
  openForMerge(path: string, versions: EnclaveMergeVersion[]): Promise<EnclaveMergeSession | null>;
}

interface PluginRegistry {
  enabledPlugins?: Set<string>;
  getPlugin?(id: string): { api?: unknown } | null;
}

function registry(app: App | undefined): PluginRegistry | undefined {
  // `app.plugins` isn't in Obsidian's public typings, but every plugin that talks
  // to another plugin goes through it.
  return (app as unknown as { plugins?: PluginRegistry } | undefined)?.plugins;
}

/**
 * How Enclave is present in this vault:
 * - "absent": not enabled, so only Courier's own content check applies;
 * - "ready": enabled, loaded, and offering an API version Courier understands;
 * - "unavailable": enabled but not loaded yet, or an API Courier doesn't know.
 *   Courier then doesn't sync at all, rather than guess what's safe to upload.
 */
export type EnclavePresence =
  | { state: "absent" }
  | { state: "ready"; api: EnclaveApi }
  | { state: "unavailable"; reason: string };

export function enclavePresence(app: App | undefined): EnclavePresence {
  const plugins = registry(app);
  if (!plugins?.enabledPlugins?.has(ENCLAVE_PLUGIN_ID)) {
    return { state: "absent" };
  }
  const api = plugins.getPlugin?.(ENCLAVE_PLUGIN_ID)?.api as Partial<EnclaveApi> | undefined;
  if (!api) {
    return { state: "unavailable", reason: "Enclave is enabled but hasn't finished loading" };
  }
  if (api.version !== SUPPORTED_ENCLAVE_API_VERSION) {
    return {
      state: "unavailable",
      reason: `Enclave offers API version ${String(api.version)}; this Courier understands version ${SUPPORTED_ENCLAVE_API_VERSION}. Update Courier and Enclave.`,
    };
  }
  return { state: "ready", api: api as EnclaveApi };
}

/** Enclave's API if it's ready, otherwise null (absent or unavailable). */
export function enclaveApi(app: App | undefined): EnclaveApi | null {
  const presence = enclavePresence(app);
  return presence.state === "ready" ? presence.api : null;
}
