/*
 * Decides which notes Courier must not upload right now, so the plain text of a
 * note Enclave encrypts never reaches GitLab (or its history).
 *
 * Two independent layers, and when in doubt, a note is held back:
 * 1. Enclave's own answer (holdReason): unlocked notes, notes a crash left
 *    unlocked, and unencrypted notes in a locked folder.
 * 2. A content check that needs no Enclave: a note that was locked when last
 *    synced and is plain now is only uploaded if Enclave confirms it was made
 *    plain on purpose.
 * If Enclave is enabled but not ready (still loading, or an API version Courier
 * doesn't know), the sync doesn't run at all.
 */

import type { LocalSnapshotEntry } from "../sync/local-snapshot";
import { enclavePresence, type EnclaveApi, type EnclaveHoldReason, type EnclavePresence } from "./enclave-api";
import { isEnclaveLocked } from "./locked-format";
import type { App } from "obsidian";

/** Why a note is held back: Enclave's reasons, plus Courier's own content check. */
export type HoldReason = EnclaveHoldReason | "locked-turned-plain";

export interface HeldNote {
  path: string;
  reason: HoldReason;
}

export interface UploadGuardLike {
  /** Get ready for one sync. Throws if Enclave is enabled but can't be relied on. */
  prepare(): Promise<void>;
  /** Why the local version of a note must not be uploaded now, or null if it may be. */
  holdLocal(snapshot: Pick<LocalSnapshotEntry, "path" | "local" | "base">): Promise<HoldReason | null>;
  /** Why a remote change to `path` must wait (the note is open in plain text here), or null. */
  holdRemote(path: string): Promise<HoldReason | null>;
  /** Enclave's API for this sync, if it's installed and ready. */
  enclave(): EnclaveApi | null;
}

interface UploadGuardOptions {
  /** How long to wait for Enclave to finish loading before giving up on this sync. */
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class UploadGuard implements UploadGuardLike {
  private api: EnclaveApi | null = null;
  private readonly waitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly presence: () => EnclavePresence,
    options: UploadGuardOptions = {},
  ) {
    this.waitMs = options.waitMs ?? 10_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => window.setTimeout(resolve, ms)));
  }

  static forApp(app: App | undefined, options?: UploadGuardOptions): UploadGuard {
    return new UploadGuard(() => enclavePresence(app), options);
  }

  async prepare(): Promise<void> {
    // Right after Obsidian starts, Enclave may still be loading: give it a moment.
    let presence = this.presence();
    for (let waited = 0; presence.state === "unavailable" && waited < this.waitMs; waited += 250) {
      await this.sleep(250);
      presence = this.presence();
    }
    if (presence.state === "unavailable") {
      throw new Error(`Not syncing, so no unlocked note can be uploaded: ${presence.reason}.`);
    }
    this.api = presence.state === "ready" ? presence.api : null;
    if (this.api && !(await settlesWithin(this.api.ready(), this.waitMs, this.sleep))) {
      throw new Error("Not syncing, so no unlocked note can be uploaded: Enclave is still starting up.");
    }
  }

  enclave(): EnclaveApi | null {
    return this.api;
  }

  async holdLocal(snapshot: Pick<LocalSnapshotEntry, "path" | "local" | "base">): Promise<HoldReason | null> {
    // A deletion uploads no content, so it can never leak a note.
    if (!snapshot.local.exists || snapshot.local.bytes === null) {
      return null;
    }
    const reason = this.api ? await this.api.holdReason(snapshot.path) : null;
    if (reason) {
      return reason;
    }
    const wasLocked = isEnclaveLocked(snapshot.path, snapshot.base?.bytes ?? null);
    if (wasLocked && !isEnclaveLocked(snapshot.path, snapshot.local.bytes) && !this.api?.isIntentionallyPlain(snapshot.path)) {
      return "locked-turned-plain";
    }
    return null;
  }

  async holdRemote(path: string): Promise<HoldReason | null> {
    return this.api ? await this.api.holdReason(path) : null;
  }
}

/** Whether `promise` settles within `ms` (`sleep` is injectable so tests control time). */
function settlesWithin(promise: Promise<unknown>, ms: number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    sleep(ms).then(() => false),
  ]);
}
