import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitLabClient } from "../../src/gitlab/client";
import { BootstrapService } from "../../src/sync/bootstrap-service";
import { SyncManager } from "../../src/sync/sync-manager";
import { StateStore } from "../../src/sync/state-store";
import type {
  DirtyOperation,
  GitLabSyncSettings,
  LocalSyncState,
  PluginData,
} from "../../src/sync/types";
import { GitLabTestServer } from "../helpers/gitlab-test-server";
import { UploadGuard } from "../../src/enclave/upload-guard";
import type { EnclaveApi } from "../../src/enclave/enclave-api";
import { isEnclaveLockedText } from "../../src/enclave/locked-format";

const requestUrlMock = vi.hoisted(() => vi.fn());
const conflictNow = new Date("2026-07-26T20:15:00+03:00");
const conflictStamp = formatConflictStamp(conflictNow);

vi.mock("obsidian", () => ({
  requestUrl: requestUrlMock,
  normalizePath: (path: string) =>
    path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, ""),
  // A desktop host, so device labels resolve to "Mac" when no author is set.
  Platform: { isMacOS: true },
}));

describe("GitLab sync integration", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
  });

  it("imports a private project into an empty vault with an exact tracked index", async () => {
    const setup = await initializedFixture({
      "folder/note.md": "hello",
      "unicode/Привет 😀.md": "emoji",
      ".obsidian/plugins/courier/main.js": "remote plugin is skipped",
    });

    expect(setup.vault.text("folder/note.md")).toBe("hello");
    expect(setup.vault.text("unicode/Привет 😀.md")).toBe("emoji");
    expect(setup.vault.text(".obsidian/plugins/courier/main.js")).toBe("local plugin");

    const tree = await setup.server.tree();
    const state = (await setup.store.load()).state;
    expect(state.initialized).toBe(true);
    expect(state.lastSyncedCommitSha).toBe(setup.server.head);
    expect(Object.keys(state.trackedFiles).sort()).toEqual(
      tree
        .filter((item) => item.path !== ".obsidian/plugins/courier/main.js")
        .map((item) => item.path)
        .sort(),
    );
    for (const item of tree.filter((entry) => state.trackedFiles[entry.path])) {
      expect(state.trackedFiles[item.path].blobId).toBe(item.id);
      expect(state.trackedFiles[item.path].mode).toBe(item.mode);
    }
  });

  it("syncs ordinary desktop branch mutations without remote plugin metadata", async () => {
    const setup = await initializedFixture({
      "desktop-update.md": "base",
      "desktop-delete.md": "base",
    });
    await setup.server.desktopCommit({
      "desktop-create.md": "created on desktop",
      "desktop-update.md": "updated on desktop",
      "desktop-delete.md": null,
    });

    const result = await setup.manager().sync("startup");

    expect(result).toMatchObject({ status: "success", commitSha: setup.server.head });
    expect(setup.server.commitActions).toEqual([]);
    expect(setup.vault.text("desktop-create.md")).toBe("created on desktop");
    expect(setup.vault.text("desktop-update.md")).toBe("updated on desktop");
    expect(setup.vault.exists("desktop-delete.md")).toBe(false);
    await expectNoMetadata(setup);
  });

  it("preserves local, remote, conflict, ignore, Unicode, and binary changes", async () => {
    const setup = await initializedFixture({
      "remote-update.md": "base",
      "remote-delete.md": "base",
      "local-update.md": "base",
      "local-delete.md": "base",
      "both-local.md": "base",
      "both-remote.md": "base",
      "conflict.md": "base",
      "binary.bin": bytes([1, 2, 3]),
      "local-delete-remote-update.md": "base",
      "remote-delete-local-update.md": "base",
      "rename-old.md": "base",
      "nested/.gitignore": "*.tmp\n",
      "nested/tracked.tmp": "tracked base",
      "unicode/Привет 😀.md": "base",
    });
    await setup.server.desktopCommit({
      "remote-create.md": "remote create",
      "remote-update.md": "remote update",
      "remote-delete.md": null,
      "both-remote.md": "remote side",
      "conflict.md": "remote text",
      "binary.bin": bytes([9, 9, 9]),
      "local-delete-remote-update.md": "remote kept",
      "remote-delete-local-update.md": null,
      "rename-old.md": null,
      "rename-new.md": "remote rename target",
    });

    await setup.writeDirty("local-create.md", "local create");
    await setup.writeDirty("local-update.md", "local update");
    await setup.deleteDirty("local-delete.md");
    await setup.writeDirty("both-local.md", "local side");
    await setup.writeDirty("conflict.md", "local text");
    await setup.writeDirty("binary.bin", bytes([4, 5, 6]));
    await setup.deleteDirty("local-delete-remote-update.md");
    await setup.writeDirty("remote-delete-local-update.md", "local kept");
    await setup.writeDirty("rename-old.md", "local edit before noticing rename");
    await setup.writeDirty("nested/ignored.tmp", "ignored");
    await setup.writeDirty("nested/tracked.tmp", "tracked local update");
    await setup.writeDirty("unicode/Привет 😀.md", "unicode local");
    await setup.writeDirty("gitlab-sync-metadata.json", "{}");
    await setup.writeDirty("github-sync-metadata.json", "{}");

    const result = await setup.manager().sync("manual");

    expect(result.status).toBe("conflict");
    expect(setup.server.fileText("remote-create.md")).toBe("remote create");
    expect(setup.server.fileText("remote-update.md")).toBe("remote update");
    expect(setup.server.fileText("remote-delete.md")).toBeNull();
    expect(setup.server.fileText("local-create.md")).toBe("local create");
    expect(setup.server.fileText("local-update.md")).toBe("local update");
    expect(setup.server.fileText("local-delete.md")).toBeNull();
    expect(setup.server.fileText("both-local.md")).toBe("local side");
    expect(setup.server.fileText("both-remote.md")).toBe("remote side");
    expect(setup.server.fileText("conflict.md")).toBe("remote text");
    expect(setup.server.fileText("local-delete-remote-update.md")).toBe("remote kept");
    expect(setup.server.fileText("remote-delete-local-update.md")).toBeNull();
    expect(setup.server.fileText("rename-new.md")).toBe("remote rename target");
    expect(setup.server.fileText("nested/ignored.tmp")).toBeNull();
    expect(setup.server.fileText("nested/tracked.tmp")).toBe("tracked local update");
    expect(setup.server.fileText("unicode/Привет 😀.md")).toBe("unicode local");

    const paths = setup.server.paths();
    expect(paths).toContain(`conflict — conflict Mobile User ${conflictStamp}.md`);
    expect(paths).toContain(`binary — conflict Mobile User ${conflictStamp}.bin`);
    expect(paths).toContain(`local-delete-remote-update — deletion conflict Mobile User ${conflictStamp}.md`);
    expect(paths).toContain(`remote-delete-local-update — conflict Mobile User ${conflictStamp}.md`);
    expect(paths).toContain(`rename-old — conflict Mobile User ${conflictStamp}.md`);
    await expectNoMetadata(setup);
  });

  it("recomputes after a branch-head race before committing", async () => {
    const setup = await initializedFixture({ "note.md": "base" });
    await setup.writeDirty("note.md", "local");
    const branchReadsBeforeSync = setup.server.branchReads;
    setup.server.mutateBranchOnRead(
      branchReadsBeforeSync + 3,
      async () => {
        await setup.server.desktopCommit({ "desktop.md": "raced in" });
      },
    );

    const result = await setup.manager().sync("manual");

    expect(result).toMatchObject({ status: "success", attempts: 2 });
    expect(setup.server.branchReads).toBe(branchReadsBeforeSync + 4);
    expect(setup.server.fileText("note.md")).toBe("local");
    expect(setup.vault.text("desktop.md")).toBe("raced in");
    await expectNoMetadata(setup);
  });

  it("falls back to a full remote tree when GitLab compare times out", async () => {
    const setup = await initializedFixture({
      "update.md": "base",
      "delete.md": "base",
    });
    const base = setup.server.head;
    await setup.server.desktopCommit({
      "create.md": "remote create",
      "update.md": "remote update",
      "delete.md": null,
    });
    setup.server.forceCompareTimeout(base, setup.server.head);

    const result = await setup.manager().sync("startup");

    expect(result.status).toBe("success");
    expect(setup.vault.text("create.md")).toBe("remote create");
    expect(setup.vault.text("update.md")).toBe("remote update");
    expect(setup.vault.exists("delete.md")).toBe(false);
    expect(setup.server.requests.some((request) => request.url.includes("/repository/tree"))).toBe(true);
    await expectNoMetadata(setup);
  });

  it("recovers interrupted local materialization after a successful commit", async () => {
    const setup = await initializedFixture({ "note.md": "base" });
    await setup.writeDirty("note.md", "local");
    const failingManager = setup.manager({
      materializer: {
        recoverPendingTransaction: async () => false,
        apply: async () => {
          throw new Error("terminated during materialization");
        },
      },
    });

    const failed = await failingManager.sync("manual");
    expect(failed).toMatchObject({
      status: "error",
      message: "terminated during materialization",
    });
    expect(setup.vault.text("note.md")).toBe("local");
    expect((await setup.store.load()).state.pendingTransaction?.committedSha).toBe(setup.server.head);

    const recovered = await setup.manager().sync("startup");

    expect(recovered).toMatchObject({ status: "success", recovered: true });
    const state = (await setup.store.load()).state;
    expect(state.pendingTransaction).toBeNull();
    expect(state.lastSyncedCommitSha).toBe(setup.server.head);
    await expectNoMetadata(setup);
  });

  it("full audit discovers a missed external local edit", async () => {
    const setup = await initializedFixture({ "missed.md": "base" });
    await setup.vault.write("missed.md", "edited outside the journal");

    const result = await setup.manager().sync("audit");

    expect(result.status).toBe("success");
    expect(setup.server.fileText("missed.md")).toBe("edited outside the journal");
    expect(setup.journal.recorded).toEqual([{ path: "missed.md", operation: "upsert" }]);
    await expectNoMetadata(setup);
  });

  it("keeps the normal path to dirty reads and remote diffs for a 5,000-file vault", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 5_000; index += 1) {
      files[`notes/${String(index).padStart(4, "0")}.md`] = `base ${index}`;
    }
    const setup = await initializedFixture(files);
    setup.vault.resetCounters();
    setup.server.requests.length = 0;
    await setup.server.desktopCommit({
      "remote-a.md": "remote a",
      "remote-b.md": "remote b",
    });
    await setup.writeDirty("notes/0042.md", "dirty local");
    setup.journal.recorded.length = 0;
    setup.vault.resetCounters();
    const startedAt = Date.now();

    const result = await setup.manager().sync("startup");
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).toBe("success");
    expect((await setup.store.load()).state.lastSyncAt).toBe(123_456);
    expect(elapsedMs).toBeGreaterThanOrEqual(0);
    expect(setup.vault.readBinaryPaths).toEqual(["notes/0042.md"]);
    expect(setup.journal.recorded).toEqual([]);
    expect(setup.server.requests.some((request) => request.url.includes("/repository/compare"))).toBe(true);
    expect(setup.server.requests.some((request) => request.url.includes("/repository/tree"))).toBe(false);
    expect(setup.server.fileText("notes/0042.md")).toBe("dirty local");
    await expectNoMetadata(setup);
  }, 20_000);
});

describe("Enclave: plain text never leaves the device", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
  });

  it("holds back an unlocked note and uploads it once it's locked", async () => {
    const setup = await initializedFixture({ "diary.md": lockedNote("v1") });
    const enclave = new FakeEnclave(setup);
    await enclave.unlock("diary.md", "SECRET diary text", lockedNote("v2"));
    await setup.writeDirty("todo.md", "ordinary note");

    const first = await setup.manager({ uploadGuard: enclave.guard() }).sync("manual");

    expect(first.held).toEqual([{ path: "diary.md", reason: "unlocked" }]);
    expect(setup.server.fileText("todo.md")).toBe("ordinary note");
    expect(setup.server.fileText("diary.md")).toBe(lockedNote("v1"));

    await enclave.lock("diary.md");
    const second = await setup.manager({ uploadGuard: enclave.guard() }).sync("manual");

    expect(second.held).toEqual([]);
    expect(setup.server.fileText("diary.md")).toBe(lockedNote("v2"));
    expectNoPlainTextUploaded(setup, ["SECRET diary text"]);
  });

  it("holds back a locked note turned plain even without Enclave", async () => {
    const setup = await initializedFixture({ "diary.md": lockedNote("v1") });
    await setup.writeDirty("diary.md", "SECRET left unlocked");

    const result = await setup.manager().sync("manual");

    expect(result.held).toEqual([{ path: "diary.md", reason: "locked-turned-plain" }]);
    expect(setup.server.fileText("diary.md")).toBe(lockedNote("v1"));
    expectNoPlainTextUploaded(setup, ["SECRET left unlocked"]);
  });

  it("uploads a note Enclave says was made plain on purpose", async () => {
    const setup = await initializedFixture({ "diary.md": lockedNote("v1") });
    const enclave = new FakeEnclave(setup);
    enclave.plain.add("diary.md");
    await setup.writeDirty("diary.md", "decrypted for good");

    const result = await setup.manager({ uploadGuard: enclave.guard() }).sync("manual");

    expect(result.held).toEqual([]);
    expect(setup.server.fileText("diary.md")).toBe("decrypted for good");
  });

  it("leaves a note that's waiting to be locked in a locked folder out of the commit", async () => {
    const setup = await initializedFixture({ "private/old.md": lockedNote("old") });
    const enclave = new FakeEnclave(setup);
    enclave.notLockedYet.add("private/new.md");
    await setup.writeDirty("private/new.md", "SECRET fresh draft");

    const result = await setup.manager({ uploadGuard: enclave.guard() }).sync("manual");

    expect(result.held).toEqual([{ path: "private/new.md", reason: "not-locked-yet" }]);
    expect(setup.server.fileText("private/new.md")).toBeNull();
    expectNoPlainTextUploaded(setup, ["SECRET fresh draft"]);
  });

  it("doesn't overwrite an unlocked note with a remote change, and applies it once locked unchanged", async () => {
    const setup = await initializedFixture({ "diary.md": lockedNote("v1") });
    const enclave = new FakeEnclave(setup);
    // Locking unchanged restores the exact earlier version, as Enclave does.
    await enclave.unlock("diary.md", "SECRET diary text", lockedNote("v1"));
    await setup.server.desktopCommit({ "diary.md": lockedNote("from another device") });

    const first = await setup.manager({ uploadGuard: enclave.guard() }).sync("manual");

    expect(first.held).toEqual([{ path: "diary.md", reason: "unlocked" }]);
    expect(setup.vault.text("diary.md")).toBe("SECRET diary text");
    expect((await setup.store.load()).state.deferredPaths).toEqual(["diary.md"]);

    await enclave.lock("diary.md");
    const second = await setup.manager({ uploadGuard: enclave.guard() }).sync("manual");

    expect(second.status).toBe("success");
    expect(setup.vault.text("diary.md")).toBe(lockedNote("from another device"));
    expect(setup.server.fileText("diary.md")).toBe(lockedNote("from another device"));
    expect((await setup.store.load()).state.deferredPaths).toEqual([]);
    expectNoPlainTextUploaded(setup, ["SECRET diary text"]);
  });

  it("keeps both versions of a locked note changed on two devices, each still locked", async () => {
    const setup = await initializedFixture({ "diary.md": lockedNote("v1") });
    const enclave = new FakeEnclave(setup);
    await enclave.unlock("diary.md", "SECRET edited here", lockedNote("edited here"));
    await setup.server.desktopCommit({ "diary.md": lockedNote("edited elsewhere") });
    await setup.manager({ uploadGuard: enclave.guard() }).sync("manual");

    await enclave.lock("diary.md");
    const result = await setup.manager({ uploadGuard: enclave.guard() }).sync("manual");

    expect(result.status).toBe("conflict");
    const copy = setup.server.paths().find((path) => path.startsWith("diary — conflict"));
    expect(copy).toBeDefined();
    const versions = [setup.server.fileText("diary.md"), setup.server.fileText(copy!)];
    expect(versions.sort()).toEqual([lockedNote("edited elsewhere"), lockedNote("edited here")].sort());
    expectNoPlainTextUploaded(setup, ["SECRET edited here"]);
  });

  it("can lock everything first, so nothing needs holding back", async () => {
    const setup = await initializedFixture({ "diary.md": lockedNote("v1") });
    const enclave = new FakeEnclave(setup);
    await enclave.unlock("diary.md", "SECRET diary text", lockedNote("v2"));

    const result = await setup
      .manager({ uploadGuard: enclave.guard(), lockBeforeSync: (trigger) => trigger === "manual" })
      .sync("manual");

    expect(result.held).toEqual([]);
    expect(setup.server.fileText("diary.md")).toBe(lockedNote("v2"));
    expectNoPlainTextUploaded(setup, ["SECRET diary text"]);
  });
});

/** A note as Enclave locks it; `tag` stands in for the encrypted content. */
function lockedNote(tag: string): string {
  const payload = {
    v: 1,
    alg: "AES-GCM",
    kdf: "PBKDF2",
    hash: "SHA-256",
    iterations: 310000,
    salt: "c2FsdA==",
    iv: "aXZpdmk=",
    ct: Buffer.from(tag).toString("base64"),
    scope: "vault",
  };
  return ["---", "locked: true", "lock-scope: vault", "---", "```enclave", JSON.stringify(payload), "```", ""].join("\n");
}

/** Stands in for Enclave: unlocking writes plain text, locking writes the locked version back. */
class FakeEnclave {
  readonly unlocked = new Map<string, string>();
  readonly notLockedYet = new Set<string>();
  readonly plain = new Set<string>();

  constructor(private readonly setup: Fixture) {}

  /** Unlock `path`: `plain` goes to disk; `lockedAgain` is what locking writes back. */
  async unlock(path: string, plain: string, lockedAgain: string): Promise<void> {
    this.unlocked.set(path, lockedAgain);
    await this.setup.writeDirty(path, plain);
  }

  async lock(path: string): Promise<void> {
    const locked = this.unlocked.get(path);
    if (locked === undefined) {
      throw new Error(`${path} isn't unlocked`);
    }
    this.unlocked.delete(path);
    await this.setup.writeDirty(path, locked);
  }

  api(): EnclaveApi {
    return {
      version: 1,
      ready: async () => undefined,
      holdReason: async (path) =>
        this.unlocked.has(path) ? "unlocked" : this.notLockedYet.has(path) ? "not-locked-yet" : null,
      isLockedContent: (content) => isEnclaveLockedText(content),
      isIntentionallyPlain: (path) => this.plain.has(path),
      lockAll: async () => {
        for (const path of [...this.unlocked.keys()]) {
          await this.lock(path);
        }
        return 0;
      },
      onLocked: () => () => undefined,
      openForMerge: async () => null,
    };
  }

  guard(): UploadGuard {
    return new UploadGuard(() => ({ state: "ready", api: this.api() }));
  }
}

/** Fails if any commit sent to GitLab contains one of `secrets`. */
function expectNoPlainTextUploaded(setup: Fixture, secrets: string[]): void {
  const uploaded = setup.server.commitActions
    .flat()
    .map((action) => ("content" in action && action.content ? Buffer.from(action.content, "base64").toString("utf8") : ""));
  for (const secret of secrets) {
    expect(uploaded.filter((text) => text.includes(secret))).toEqual([]);
  }
}

type Fixture = Awaited<ReturnType<typeof initializedFixture>>;

async function initializedFixture(initialRemoteFiles: Record<string, string | Uint8Array | ArrayBuffer>) {
  const server = await GitLabTestServer.create(initialRemoteFiles);
  requestUrlMock.mockImplementation(server.requestUrl.bind(server));
  const settings = gitlabSettings(server);
  const vault = new MemoryVault({
    ".obsidian/plugins/courier/main.js": bytes("local plugin"),
  });
  const store = pluginStore(pluginData(settings));
  const journal = journalFor(store);
  const client = () => new GitLabClient(settings, server.token, { sleep: async () => undefined });

  const manager = (overrides: Partial<ConstructorParameters<typeof SyncManager>[0]> = {}): SyncManager =>
    new SyncManager({
      vault: vault.vault as any,
      stateStore: store,
      settings,
      getToken: async () => server.token,
      createGitLabClient: client,
      journal,
      now: () => 123_456,
      nowDate: () => conflictNow,
      logger: silentLogger,
      ...overrides,
    });

  // Seed the vault via the production connect path: merge() writes remote bytes
  // into the vault, then adoptExistingVault() finalizes the tracked index and
  // clean state (the same two steps plugin.connect() runs).
  await new BootstrapService({
    vault: vault.vault as any,
    client: client() as any,
    journal,
  }).merge();
  await manager().adoptExistingVault();

  return {
    server,
    vault,
    store,
    journal,
    async writeDirty(path: string, content: string | Uint8Array): Promise<void> {
      await vault.write(path, content);
      await journal.recordUpsert(path);
    },
    async deleteDirty(path: string): Promise<void> {
      await vault.remove(path);
      await journal.recordDelete(path);
    },
    manager,
  };
}

function formatConflictStamp(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + ` ${pad(date.getHours())}-${pad(date.getMinutes())}`;
}

class MemoryVault {
  readonly readBinaryPaths: string[] = [];
  readonly listPaths: string[] = [];
  readonly vault = {
    configDir: ".obsidian",
    adapter: {
      list: async (dir: string) => this.list(dir),
      exists: async (path: string) => this.exists(path),
      mkdir: async (path: string) => this.mkdir(path),
      read: async (path: string) => this.text(path) ?? "",
      readBinary: async (path: string) => this.readBinary(path),
      writeBinary: async (path: string, data: ArrayBuffer) => this.write(path, new Uint8Array(data)),
      remove: async (path: string) => this.remove(path),
      rmdir: async (path: string, recursive: boolean) => this.rmdir(path, recursive),
      rename: async (path: string, newPath: string) => this.rename(path, newPath),
    },
  };

  private files = new Map<string, Uint8Array>();
  private folders = new Set<string>(["", ".obsidian", ".obsidian/plugins", ".obsidian/plugins/courier"]);

  constructor(files: Record<string, Uint8Array> = {}) {
    for (const [path, content] of Object.entries(files)) {
      this.files.set(path, content);
      this.addParentFolders(path);
    }
  }

  resetCounters(): void {
    this.readBinaryPaths.length = 0;
    this.listPaths.length = 0;
  }

  exists(path: string): boolean {
    return this.files.has(path) || this.folders.has(path);
  }

  text(path: string): string | null {
    const content = this.files.get(path);
    return content ? new TextDecoder().decode(content) : null;
  }

  async write(path: string, content: string | Uint8Array): Promise<void> {
    const data = typeof content === "string" ? bytes(content) : content;
    this.files.set(path, new Uint8Array(data));
    this.addParentFolders(path);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  private async rmdir(path: string, recursive: boolean): Promise<void> {
    if (!recursive) {
      throw new Error(`Path is a directory: rm returned EISDIR (is a directory) ${path}`);
    }
    this.folders.delete(path);
  }

  private async rename(path: string, newPath: string): Promise<void> {
    const content = this.files.get(path);
    if (!content) {
      return;
    }
    this.files.set(newPath, content);
    this.files.delete(path);
    this.addParentFolders(newPath);
  }

  private async readBinary(path: string): Promise<ArrayBuffer> {
    this.readBinaryPaths.push(path);
    const content = this.files.get(path);
    if (!content) {
      throw new Error(`Missing local file ${path}`);
    }
    return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
  }

  private async list(dir: string): Promise<{ files: string[]; folders: string[] }> {
    this.listPaths.push(dir);
    const prefix = dir === "" ? "" : `${dir}/`;
    const files = new Set<string>();
    const folders = new Set<string>();

    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) {
        continue;
      }
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) {
        files.add(path);
      } else {
        folders.add(`${prefix}${rest.slice(0, slash)}`);
      }
    }

    for (const folder of this.folders) {
      if (folder === dir || !folder.startsWith(prefix)) {
        continue;
      }
      const rest = folder.slice(prefix.length);
      if (rest !== "" && !rest.includes("/")) {
        folders.add(folder);
      }
    }

    return { files: [...files].sort(), folders: [...folders].sort() };
  }

  private async mkdir(path: string): Promise<void> {
    this.folders.add(path);
    this.addParentFolders(`${path}/.placeholder`);
  }

  private addParentFolders(path: string): void {
    const parts = path.split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current === "" ? part : `${current}/${part}`;
      this.folders.add(current);
    }
  }
}

function pluginStore(initial: PluginData): StateStore {
  let data: PluginData = clone(initial);
  return new StateStore({
    loadData: async () => clone(data),
    saveData: async (next: unknown) => {
      data = clone(next as PluginData);
    },
  });
}

function journalFor(store: StateStore) {
  const recorded: Array<{ path: string; operation: DirtyOperation }> = [];
  return {
    recorded,
    list: () => [],
    suppress: async <T>(operation: () => Promise<T>) => operation(),
    recordUpsert: async (path: string) => {
      recorded.push({ path, operation: "upsert" });
      await recordDirty(store, path, "upsert");
    },
    recordDelete: async (path: string) => {
      recorded.push({ path, operation: "delete" });
      await recordDirty(store, path, "delete");
    },
  };
}

async function recordDirty(store: StateStore, path: string, operation: DirtyOperation): Promise<void> {
  await store.update((data) => {
    data.state.dirtyEntries[path] = { path, operation, recordedAt: 1 };
  });
}

function pluginData(settings: GitLabSyncSettings): PluginData {
  return {
    settings,
    state: {
      schemaVersion: 1,
      initialized: false,
      lastSyncedCommitSha: null,
      trackedFiles: {},
      dirtyEntries: {},
      pendingTransaction: null,
      lastSyncAt: null,
      lastSyncResult: "never",
    } satisfies LocalSyncState,
  };
}

function gitlabSettings(server: GitLabTestServer): GitLabSyncSettings {
  return {
    gitlabBaseUrl: server.baseUrl,
    projectPath: server.projectPath,
    branch: server.branch,
    tokenSecretName: "gitlab-token",
    authorName: "Mobile User",
    authorEmail: "mobile@example.com",
    syncOnStartup: true,
    syncOnForeground: true,
    syncOnBackground: false,
    syncAfterEdit: false,
    syncAfterEditDebounceSeconds: 8,
    syncOnInterval: false,
    syncIntervalMinutes: 10,
    showRibbonIcon: true,
    loggingLevel: "off",
    loggingEnabled: false,
    conflictStrategy: "remote",
    lockBeforeManualSync: false,
  };
}

async function expectNoMetadata(setup: Awaited<ReturnType<typeof initializedFixture>>): Promise<void> {
  expect(setup.server.hasPathEndingWithMetadata()).toBe(false);
  for (const action of setup.server.commitActions.flat()) {
    expect(action.file_path).not.toMatch(/(?:github|gitlab)-sync-metadata\.json$/);
  }
  expect((await setup.server.tree()).map((item) => item.path)).not.toEqual(
    expect.arrayContaining([
      expect.stringMatching(/github-sync-metadata\.json$/),
      expect.stringMatching(/gitlab-sync-metadata\.json$/),
    ]),
  );
}

function bytes(value: string | number[]): Uint8Array {
  return typeof value === "string"
    ? new TextEncoder().encode(value)
    : Uint8Array.from(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const silentLogger = {
  debug: async () => undefined,
  info: async () => undefined,
  warn: async () => undefined,
  error: async () => undefined,
};
