/*
 * The logic behind the conflict window: which conflicts are open, what both
 * versions are, and writing the user's decision back.
 *
 * Each recorded conflict is a note whose file holds one side's version and a
 * copy next to it with the other side's. Resolving writes the result to the
 * note and deletes the copy; the next sync uploads both changes.
 *
 * Locked notes (Enclave) are decrypted only in memory, through Enclave, and the
 * merged result is encrypted again by Enclave before anything is written: this
 * module never writes a locked note's plain text to disk.
 */

import type { EnclaveApi, EnclaveMergeSession } from "../enclave/enclave-api";
import { isEnclaveLockedText } from "../enclave/locked-format";
import { mergeChunks, type MergeChunk } from "../merge/merge-chunks";
import type { ConflictRecord, PluginData } from "../sync/types";

/** The vault operations the service needs (Obsidian's Vault provides them). */
export interface ConflictVault {
  getFileByPath(path: string): unknown;
  readBinary(file: never): Promise<ArrayBuffer>;
  modifyBinary(file: never, data: ArrayBuffer): Promise<void>;
  delete(file: never): Promise<void>;
}

export interface ConflictServiceOptions {
  vault: ConflictVault;
  stateStore: {
    load(): Promise<PluginData>;
    update(mutator: (data: PluginData) => void | Promise<void>): Promise<PluginData>;
  };
  /** The common base version from GitLab, or null if it can't be fetched (offline). */
  readBase: (blobId: string) => Promise<Uint8Array | null>;
  /** Enclave's API, if it's installed and ready. */
  enclave: () => EnclaveApi | null;
}

export type Side = "mine" | "theirs";

interface Versions {
  record: ConflictRecord;
  /** This device's and GitLab's version of the file (null if a side is gone). */
  mine: Uint8Array;
  theirs: Uint8Array;
}

/** A conflict opened in the window. */
export type OpenConflict =
  | (Versions & {
      kind: "merge";
      chunks: MergeChunk[];
      /** Whether the note is locked: the result is then encrypted by Enclave. */
      locked: boolean;
      /** For a locked note: whether both versions share one password and kind of lock. */
      sameLock: boolean;
      /** Whether the merge could compare against the last synced version. */
      hasBase: boolean;
      session: EnclaveMergeSession | null;
    })
  | (Versions & {
      kind: "whole";
      /** Why only whole versions can be chosen. */
      reason: string;
    });

export class ConflictService {
  constructor(private readonly options: ConflictServiceOptions) {}

  /** Open conflicts. Records whose note or copy no longer exists are dropped. */
  async pending(): Promise<ConflictRecord[]> {
    const records = (await this.options.stateStore.load()).state.conflicts ?? [];
    const live = records.filter(
      (record) => this.file(record.path) !== null && this.file(record.copyPath) !== null,
    );
    if (live.length !== records.length) {
      await this.options.stateStore.update((data) => {
        data.state.conflicts = (data.state.conflicts ?? []).filter((record) => live.some((kept) => sameRecord(kept, record)));
      });
    }
    return live;
  }

  /**
   * Read both versions and prepare the merge. For a locked note, Enclave asks
   * for any password it needs; resolves null if the user cancels that.
   */
  async open(record: ConflictRecord): Promise<OpenConflict | null> {
    const atPath = await this.read(record.path);
    const inCopy = await this.read(record.copyPath);
    const mine = record.keptSide === "local" ? atPath : inCopy;
    const theirs = record.keptSide === "local" ? inCopy : atPath;
    const versions = { record, mine, theirs };

    const mineText = decodeText(mine);
    const theirsText = decodeText(theirs);
    if (mineText === null || theirsText === null) {
      return { ...versions, kind: "whole", reason: "This file isn't text, so it can't be merged line by line." };
    }

    const base = record.baseBlobId ? await this.options.readBase(record.baseBlobId).catch(() => null) : null;
    const baseText = base ? decodeText(base) : null;
    const locked = isEnclaveLockedText(mineText) || isEnclaveLockedText(theirsText);
    if (!locked) {
      return {
        ...versions,
        kind: "merge",
        chunks: mergeChunks(baseText, mineText, theirsText),
        locked: false,
        sameLock: true,
        hasBase: baseText !== null,
        session: null,
      };
    }

    const enclave = this.options.enclave();
    if (!enclave) {
      return {
        ...versions,
        kind: "whole",
        reason: "This note is locked. Enable Enclave to merge it; without it you can keep one whole version.",
      };
    }
    const session = await enclave.openForMerge(record.path, [
      { label: "the last synced version", content: baseText, optional: true },
      { label: "this device's version", content: mineText },
      { label: "GitLab's version", content: theirsText },
    ]);
    if (!session) {
      return null;
    }
    const [plainBase, plainMine, plainTheirs] = session.texts;
    if (plainMine === null || plainTheirs === null) {
      session.close();
      return { ...versions, kind: "whole", reason: "One version couldn't be opened, so only whole versions can be kept." };
    }
    return {
      ...versions,
      kind: "merge",
      chunks: mergeChunks(plainBase ?? null, plainMine, plainTheirs),
      locked: true,
      sameLock: session.sameLock,
      hasBase: plainBase !== null && plainBase !== undefined,
      session,
    };
  }

  /** Keep one whole version. Needs no decryption: a locked version is written as it is. */
  async keepSide(conflict: OpenConflict, side: Side): Promise<void> {
    closeSession(conflict);
    await this.finish(conflict.record, side === "mine" ? conflict.mine : conflict.theirs);
  }

  /**
   * Save a merged text. For a locked note, Enclave encrypts it with the password
   * of the version `lockLike` (this device's by default), and only that is written.
   */
  async saveMerged(conflict: OpenConflict, text: string, lockLike: Side = "mine"): Promise<void> {
    if (conflict.kind !== "merge") {
      throw new Error("Only a merge conflict has merged text to save.");
    }
    if (!conflict.locked || !conflict.session) {
      await this.finish(conflict.record, new TextEncoder().encode(text));
      return;
    }
    const sealed = await conflict.session.seal(text, this.lockIndex(conflict, lockLike));
    if (!isEnclaveLockedText(sealed)) {
      throw new Error("Enclave didn't return a locked note; nothing was saved.");
    }
    await this.finish(conflict.record, new TextEncoder().encode(sealed));
  }

  /** Close without deciding: the conflict stays open. */
  cancel(conflict: OpenConflict): void {
    closeSession(conflict);
  }

  /** Session index of the version whose lock the result takes (1: this device's, 2: GitLab's). */
  private lockIndex(conflict: Extract<OpenConflict, { kind: "merge" }>, preferred: Side): number {
    const locks = conflict.session?.locks ?? [];
    const index = preferred === "mine" ? 1 : 2;
    if (locks[index]) {
      return index;
    }
    // The preferred version wasn't locked (made plain on the other device): use the locked one.
    return index === 1 ? 2 : 1;
  }

  private async finish(record: ConflictRecord, bytes: Uint8Array): Promise<void> {
    const note = this.file(record.path);
    const copy = this.file(record.copyPath);
    if (note === null) {
      throw new Error(`"${record.path}" no longer exists.`);
    }
    await this.options.vault.modifyBinary(note as never, toArrayBuffer(bytes));
    if (copy !== null) {
      await this.options.vault.delete(copy as never);
    }
    await this.options.stateStore.update((data) => {
      data.state.conflicts = (data.state.conflicts ?? []).filter((other) => !sameRecord(other, record));
    });
  }

  private file(path: string): unknown {
    return this.options.vault.getFileByPath(path) ?? null;
  }

  private async read(path: string): Promise<Uint8Array> {
    const file = this.file(path);
    if (file === null) {
      throw new Error(`"${path}" no longer exists.`);
    }
    return new Uint8Array(await this.options.vault.readBinary(file as never));
  }
}

function closeSession(conflict: OpenConflict): void {
  if (conflict.kind === "merge") {
    conflict.session?.close();
  }
}

function sameRecord(left: ConflictRecord, right: ConflictRecord): boolean {
  return left.path === right.path && left.copyPath === right.copyPath;
}

/** UTF-8 text, or null for binary content. */
function decodeText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
