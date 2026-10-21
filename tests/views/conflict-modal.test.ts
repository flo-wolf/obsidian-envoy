import { describe, expect, it, vi } from "vitest";
import { ConflictModal, dropped, offersWholeVersion } from "../../src/views/conflict-modal";
import { mergeChunks } from "../../src/merge/merge-chunks";
import type { OpenConflict } from "../../src/conflicts/conflict-service";
import { Menu, type MockElement } from "../helpers/mock-obsidian";

const base = "# Enclave\n\nLock your private notes with a password. Encrypted on disk, readable only in Obsidian.\n";
const mine = "# Enclave\n\nLock your private notes with a password. Encrypted on file, editable only in Obsidian.\n";
const theirs = "# Enclave\n\nLock your private notes with a password. Encrypted on disk, readable only in Obsidian. It's awesome!\n";

// The example from the screenshots: one change from each side merges on its own, one line clashes.
const saturday = [
  "# Saturday", "", "## Groceries", "- [ ] Milk", "- [ ] Bread", "- [ ] Coffee beans", "",
  "## Errands", "- [ ] Pick up the parcel", "- [ ] Call grandma at 4 pm", "- [ ] Return the library books", "",
  "## Evening", "- [ ] Pizza with Sam", "",
].join("\n");
const saturdayMine = saturday
  .replace("Call grandma at 4 pm", "Call grandma tomorrow at 4 pm")
  .replace("Pizza with Sam", "Pizza and a movie with Sam");
const saturdayTheirs = saturday.replace("- [ ] Milk", "- [x] Milk").replace("Call grandma at 4 pm", "Call grandma at 5 pm");

function open(b: string, m: string, t: string) {
  const conflict: OpenConflict = {
    kind: "merge",
    record: { path: "Note.md", copyPath: "Note — conflict.md", keptSide: "remote", baseBlobId: "b", createdAt: 1 },
    mine: new TextEncoder().encode(m),
    theirs: new TextEncoder().encode(t),
    chunks: mergeChunks(b, m, t),
    locked: false,
    sameLock: true,
    hasBase: true,
    session: null,
  };
  const service = { cancel: vi.fn(), saveMerged: vi.fn(async () => undefined), keepSide: vi.fn(async () => undefined) };
  const modal = new ConflictModal({} as never, service as never, conflict, vi.fn());
  modal.onOpen();
  const content = () => modal.contentEl as unknown as MockElement;
  const footer = () => content().buttons.map((button) => button.buttonText);
  const button = (text: string) => content().buttons.find((candidate) => candidate.buttonText === text)!;
  return { modal, service, conflict, content, footer, button };
}

describe("ConflictModal", () => {
  it("highlights the words that differ between the two versions", () => {
    const { content } = open(base, mine, theirs);
    const changed = content().findAll("envoy-diff-changed").map((el) => el.textContent);

    expect(changed).toEqual(["file", "editable", "disk", "readable", "It's awesome!"]);
  });

  it("picks a version by clicking its card, shows the lines it saves, then lets you save", async () => {
    const { content, button, service } = open(base, mine, theirs);
    expect(button("Save").disabled).toBe(true);

    const [, gitlab] = content().findAll("envoy-clash-card");
    gitlab.dispatch("click");

    expect(content().findAll("envoy-clash")).toHaveLength(0);
    const picked = content().findAll("is-picked");
    expect(picked.map((line) => line.textContent)).toEqual([
      "3Lock your private notes with a password. Encrypted on disk, readable only in Obsidian. It's awesome!GitLab'sChange",
    ]);
    expect(button("Save").disabled).toBe(false);
    button("Save").clickHandler?.();
    await vi.waitFor(() => expect(service.saveMerged).toHaveBeenCalledWith(expect.anything(), theirs, "mine"));
  });

  it("shows both versions in the order they're saved, and Change brings the choice back", () => {
    const { content } = open(saturday, saturdayMine, saturdayTheirs);
    content().findAll("envoy-clash-card")[2].dispatch("click");

    const picked = content().findAll("is-picked").map((line) => line.findAll("envoy-line-text")[0].textContent);
    expect(picked).toEqual(["- [ ] Call grandma tomorrow at 4 pm", "- [ ] Call grandma at 5 pm"]);

    content().findAll("envoy-line-change")[0].dispatch("click");
    expect(content().findAll("envoy-clash")).toHaveLength(1);
  });

  it("folds unchanged stretches and marks lines combined on their own", () => {
    const { content } = open(saturday, saturdayMine, saturdayTheirs);
    const folds = () => content().findAll("envoy-fold").map((row) => row.textContent);
    // A single hidden line is just shown: folding it would save nothing.
    expect(folds()).toEqual(["2 unchanged lines", "3 unchanged lines"]);
    expect(content().findAll("is-combined").map((line) => line.textContent)).toEqual([
      "4- [x] Milkfrom GitLab",
      "14- [ ] Pizza and a movie with Samfrom this device",
    ]);

    content().findAll("envoy-fold")[1].dispatch("click");
    // Unfolded lines just join the note, with no row to fold them back.
    expect(folds()).toEqual(["2 unchanged lines"]);
    const numbers = content().findAll("envoy-line").map((line) => line.findAll("envoy-line-n")[0].textContent);
    expect(numbers.slice(0, 7)).toEqual(["3", "4", "5", "6", "7", "8", "9"]);
  });

  it("stays scrolled where it was after a pick", () => {
    const { content } = open(saturday, saturdayMine, saturdayTheirs);
    (content().findAll("envoy-file")[0] as unknown as { scrollTop: number }).scrollTop = 120;

    content().findAll("envoy-clash-card")[1].dispatch("click");

    expect((content().findAll("envoy-file")[0] as unknown as { scrollTop: number }).scrollTop).toBe(120);
  });

  it("doesn't highlight words when one side removed the part", () => {
    const removedHere = saturdayMine.replace("- [ ] Call grandma tomorrow at 4 pm\n", "");
    const { content } = open(saturday, removedHere, saturdayTheirs);
    expect(content().findAll("envoy-diff-changed")).toHaveLength(0);
    const clash = content().findAll("envoy-clash")[0];
    expect(clash.findAll("envoy-line-n")[0].textContent).toBe("");
    expect(clash.findAll("envoy-clash-code")[0].textContent).toBe("Removed");
  });

  it("offers no whole version when picking the single part already gives one", () => {
    const { footer } = open(base, mine, theirs);
    expect(footer()).toEqual(["Decide later", "Save"]);
  });

  it("offers a whole version, saying what it drops, when changes were combined on their own", () => {
    const { footer, button, conflict } = open(saturday, saturdayMine, saturdayTheirs);
    expect(footer()).toEqual(["Keep a whole version…", "Decide later", "Save"]);

    button("Keep a whole version…").clickHandler?.();
    expect(Menu.last?.shown).toBe(true);
    expect(Menu.last?.items.map((item) => item.title)).toEqual([
      "This device's version, without 2 changes from GitLab",
      "GitLab's version, without 2 changes from this device",
    ]);
    if (conflict.kind === "merge") {
      expect(offersWholeVersion(conflict.chunks)).toBe(true);
      expect(dropped(conflict.chunks, "theirs")).toBe(2);
    }
  });
});
