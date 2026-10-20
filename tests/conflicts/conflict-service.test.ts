import { describe, expect, it } from "vitest";
import { ConflictService, type ConflictVault } from "../../src/conflicts/conflict-service";
import type { EnclaveApi, EnclaveMergeVersion } from "../../src/enclave/enclave-api";
import { isEnclaveLockedText } from "../../src/enclave/locked-format";
import { assembleMerge } from "../../src/merge/merge-chunks";
import type { ConflictRecord, PluginData } from "../../src/sync/types";

const record: ConflictRecord = {
  path: "note.md",
  copyPath: "note — conflict iPhone 2026-10-20 18-00.md",
  keptSide: "remote",
  baseBlobId: "base-blob",
  createdAt: 1,
};

describe("ConflictService", () => {
  it("merges a plain note: one-sided changes are taken, the rest is chosen", async () => {
    const setup = fixture({
      "note.md": "title\na\nb theirs\nc\nd theirs",
      [record.copyPath]: "title mine\na\nb mine\nc\nd",
    }, "title\na\nb\nc\nd");

    const conflict = await setup.service.open(record);
    expect(conflict?.kind).toBe("merge");
    if (conflict?.kind !== "merge") return;
    expect(conflict.hasBase).toBe(true);

    const text = assembleMerge(conflict.chunks, ["both"]);
    expect(text).toBe("title mine\na\nb mine\nb theirs\nc\nd theirs");
    await setup.service.saveMerged(conflict, text!);

    expect(setup.files.get("note.md")).toBe("title mine\na\nb mine\nb theirs\nc\nd theirs");
    expect(setup.files.has(record.copyPath)).toBe(false);
    expect(setup.data.state.conflicts).toEqual([]);
  });

  it("keeps one whole side when asked", async () => {
    const setup = fixture({ "note.md": "theirs", [record.copyPath]: "mine" }, "base");

    const conflict = await setup.service.open(record);
    await setup.service.keepSide(conflict!, "mine");

    expect(setup.files.get("note.md")).toBe("mine");
    expect(setup.files.has(record.copyPath)).toBe(false);
  });

  it("merges a locked note only through Enclave, and writes only the locked result", async () => {
    const setup = fixture({
      "note.md": locked("line 1\nline 2 theirs"),
      [record.copyPath]: locked("line 1 mine\nline 2"),
    }, locked("line 1\nline 2"));
    const enclave = fakeEnclave();
    setup.enclave = enclave.api;

    const conflict = await setup.service.open(record);
    expect(conflict?.kind).toBe("merge");
    if (conflict?.kind !== "merge") return;
    expect(conflict.locked).toBe(true);
    expect(enclave.opened.map((version) => version.label)).toEqual([
      "the last synced version",
      "this device's version",
      "GitLab's version",
    ]);

    const text = assembleMerge(conflict.chunks, []);
    expect(text).toBe("line 1 mine\nline 2 theirs");
    await setup.service.saveMerged(conflict, text!);

    const written = setup.files.get("note.md")!;
    expect(isEnclaveLockedText(written)).toBe(true);
    expect(written).not.toContain("line 1 mine");
    expect(enclave.sealedWith).toEqual([{ text: "line 1 mine\nline 2 theirs", keep: 1 }]);
  });

  it("offers only whole versions of a locked note without Enclave", async () => {
    const setup = fixture({ "note.md": locked("theirs"), [record.copyPath]: locked("mine") }, null);

    const conflict = await setup.service.open(record);

    expect(conflict).toMatchObject({ kind: "whole", reason: expect.stringMatching(/Enable Enclave/) });
    await setup.service.keepSide(conflict!, "theirs");
    expect(setup.files.get("note.md")).toBe(locked("theirs"));
  });

  it("does nothing when the user cancels Enclave's password prompt", async () => {
    const setup = fixture({ "note.md": locked("theirs"), [record.copyPath]: locked("mine") }, null);
    setup.enclave = { ...fakeEnclave().api, openForMerge: async () => null };

    expect(await setup.service.open(record)).toBeNull();
    expect(setup.files.get("note.md")).toBe(locked("theirs"));
    expect(setup.data.state.conflicts).toEqual([record]);
  });

  it("offers only whole versions of a binary file", async () => {
    const setup = fixture({ "note.md": "x", [record.copyPath]: "y" }, null);
    setup.binary.add("note.md");

    const conflict = await setup.service.open(record);

    expect(conflict).toMatchObject({ kind: "whole", reason: expect.stringMatching(/isn't text/) });
  });

  it("compares the two versions directly when the base can't be fetched", async () => {
    const setup = fixture({ "note.md": "a\nb theirs", [record.copyPath]: "a\nb mine" }, null);

    const conflict = await setup.service.open(record);

    expect(conflict).toMatchObject({ kind: "merge", hasBase: false });
  });

  it("forgets conflicts whose copy was deleted by hand", async () => {
    const setup = fixture({ "note.md": "theirs" }, null);

    expect(await setup.service.pending()).toEqual([]);
    expect(setup.data.state.conflicts).toEqual([]);
  });
});

/** A note as Enclave locks it; the text stands in for the encrypted content. */
function locked(text: string): string {
  const payload = { v: 1, alg: "AES-GCM", kdf: "PBKDF2", hash: "SHA-256", iterations: 310000, salt: "c2FsdA==", iv: "aXY=", ct: Buffer.from(text).toString("base64"), scope: "vault" };
  return ["---", "locked: true", "lock-scope: vault", "---", "```enclave", JSON.stringify(payload), "```", ""].join("\n");
}

function unlockedText(content: string): string {
  const json = content.split("\n")[5];
  return Buffer.from(JSON.parse(json).ct, "base64").toString("utf8");
}

function fakeEnclave() {
  const opened: EnclaveMergeVersion[] = [];
  const sealedWith: { text: string; keep: number }[] = [];
  const api = {
    version: 1,
    openForMerge: async (_path: string, versions: EnclaveMergeVersion[]) => {
      opened.push(...versions);
      const texts = versions.map((version) => (version.content === null ? null : unlockedText(version.content)));
      return {
        texts,
        locks: versions.map(() => ({ scope: "vault" as const })),
        sameLock: true,
        close: () => undefined,
        seal: async (text: string, keep: number) => {
          sealedWith.push({ text, keep });
          return locked(`sealed:${text}`);
        },
      };
    },
  } as unknown as EnclaveApi;
  return { api, opened, sealedWith };
}

function fixture(initial: Record<string, string>, base: string | null) {
  const files = new Map(Object.entries(initial));
  const binary = new Set<string>();
  const data = { state: { conflicts: [record] } } as unknown as PluginData;
  const vault: ConflictVault = {
    getFileByPath: (path) => (files.has(path) ? { path } : null),
    readBinary: async (file) => {
      const path = (file as unknown as { path: string }).path;
      return binary.has(path)
        ? new Uint8Array([0xff, 0xfe, 0x00]).buffer
        : (new TextEncoder().encode(files.get(path)!).buffer as ArrayBuffer);
    },
    modifyBinary: async (file, buffer) => {
      files.set((file as unknown as { path: string }).path, new TextDecoder().decode(buffer));
    },
    delete: async (file) => {
      files.delete((file as unknown as { path: string }).path);
    },
  };
  const setup = {
    files,
    binary,
    data,
    enclave: null as EnclaveApi | null,
    service: undefined as unknown as ConflictService,
  };
  setup.service = new ConflictService({
    vault,
    stateStore: {
      load: async () => data,
      update: async (mutator) => {
        await mutator(data);
        return data;
      },
    },
    readBase: async () => (base === null ? null : new TextEncoder().encode(base)),
    enclave: () => setup.enclave,
  });
  return setup;
}
