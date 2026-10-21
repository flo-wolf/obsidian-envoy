import { describe, expect, it, vi } from "vitest";
import { ConflictModal } from "../../src/views/conflict-modal";
import { mergeChunks } from "../../src/merge/merge-chunks";
import type { OpenConflict } from "../../src/conflicts/conflict-service";

const base = "# Enclave\n\nLock your private notes with a password. Encrypted on disk, readable only in Obsidian.\n";
const mine = "# Enclave\n\nLock your private notes with a password. Encrypted on file, editable only in Obsidian.\n";
const theirs = "# Enclave\n\nLock your private notes with a password. Encrypted on disk, readable only in Obsidian. It's awesome!\n";

function open(): ConflictModal {
  const conflict: OpenConflict = {
    kind: "merge",
    record: { path: "Enclave.md", copyPath: "Enclave — conflict.md", keptSide: "remote", baseBlobId: "b", createdAt: 1 },
    mine: new TextEncoder().encode(mine),
    theirs: new TextEncoder().encode(theirs),
    chunks: mergeChunks(base, mine, theirs),
    locked: false,
    sameLock: true,
    hasBase: true,
    session: null,
  };
  const modal = new ConflictModal({} as never, { cancel: vi.fn() } as never, conflict, vi.fn());
  modal.onOpen();
  return modal;
}

describe("ConflictModal", () => {
  it("highlights the words that differ between the two versions", () => {
    const modal = open();
    const changed = (modal.contentEl as { findAll(cls: string): { textContent: string }[] })
      .findAll("envoy-diff-changed")
      .map((el) => el.textContent);

    expect(changed).toEqual(["file", "editable", "disk", "readable", " It's awesome!"]);
  });
});
