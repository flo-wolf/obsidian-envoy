import { type App, Menu, Modal, Notice, Setting, setIcon } from "obsidian";
import type { ConflictService, OpenConflict, Side } from "../conflicts/conflict-service";
import { assembleMerge, conflictCount, type ChunkChoice, type MergeChunk } from "../merge/merge-chunks";
import { type DiffSegment, wordDiff } from "../merge/word-diff";
import type { ConflictRecord } from "../sync/types";

/** How many lines of unchanged text to show around the parts that matter. */
const CONTEXT_LINES = 3;

/**
 * The conflict window: shows both versions of a note, fills in what was merged
 * automatically, and lets the user pick this device's version, GitLab's, or
 * both for each remaining spot. Or keep one whole version.
 */
export class ConflictModal extends Modal {
  private readonly choices: (ChunkChoice | undefined)[] = [];
  private lockLike: Side = "mine";
  private done = false;

  constructor(
    app: App,
    private readonly service: ConflictService,
    private readonly conflict: OpenConflict,
    private readonly onResolved: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("envoy-conflict-modal");
    this.titleEl.setText(`Resolve conflict: ${noteName(this.conflict.record)}`);
    this.render();
  }

  onClose(): void {
    if (!this.done) {
      this.service.cancel(this.conflict);
    }
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    if (this.conflict.kind === "whole") {
      contentEl.createEl("p", { text: `This device and GitLab both changed this file. ${this.conflict.reason}` });
      this.renderActions(null);
      return;
    }

    const { chunks, locked, hasBase, sameLock } = this.conflict;
    const open = conflictCount(chunks);
    contentEl.createEl("p", {
      text:
        open === 0
          ? "This device and GitLab changed different parts of this note, so they were merged automatically. Check the result and save it."
          : `This device and GitLab both changed this note. Parts changed on one side only are already filled in. Pick the version to keep for ${open === 1 ? "the part" : `each of the ${open} parts`} changed on both.`,
    });
    if (!hasBase) {
      contentEl.createEl("p", {
        cls: "envoy-conflict-hint",
        text: "The last synced version couldn't be loaded, so every difference is shown as a choice.",
      });
    }
    if (locked) {
      contentEl.createEl("p", {
        cls: "envoy-conflict-hint",
        text: "This note is locked. Its versions are decrypted only in memory, and the result is locked again before it's saved.",
      });
    }

    const list = contentEl.createDiv({ cls: "envoy-conflict-chunks" });
    let conflictIndex = 0;
    chunks.forEach((chunk, position) => {
      if (chunk.kind === "conflict") {
        this.renderConflict(list, chunk, conflictIndex++);
      } else {
        renderSettled(list, chunk, position === 0, position === chunks.length - 1);
      }
    });

    if (locked && !sameLock) {
      new Setting(contentEl)
        .setName("Lock the result like")
        .setDesc("The two versions are locked with different passwords. Choose which one the merged note keeps.")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("mine", "This device's version")
            .addOption("theirs", "GitLab's version")
            .setValue(this.lockLike)
            .onChange((value) => {
              this.lockLike = value === "theirs" ? "theirs" : "mine";
            }),
        );
    }

    this.renderActions(assembleMerge(chunks, this.choices));
  }

  /** Both versions of one part; clicking a version picks it, "Use both" keeps this device's then GitLab's. */
  private renderConflict(parent: HTMLElement, chunk: Extract<MergeChunk, { kind: "conflict" }>, index: number): void {
    const choice = this.choices[index];
    const pick = (value: ChunkChoice) => {
      this.choices[index] = value;
      this.render();
    };
    const box = parent.createDiv({ cls: "envoy-chunk envoy-chunk-conflict" });
    const sides = box.createDiv({ cls: "envoy-conflict-sides" });
    const diff = wordDiff(chunk.mine.join("\n"), chunk.theirs.join("\n"));
    renderSide(sides, "This device", chunk.mine, choice === "mine" || choice === "both", diff?.mine, () => pick("mine"));
    renderSide(sides, "GitLab", chunk.theirs, choice === "theirs" || choice === "both", diff?.theirs, () => pick("theirs"));

    new Setting(box).setClass("envoy-conflict-choice").addButton((button) => {
      button.setButtonText("Use both").onClick(() => pick("both"));
      if (choice === "both") {
        button.setCta();
      }
    });
  }

  private renderActions(merged: string | null): void {
    const actions = new Setting(this.contentEl).setClass("envoy-conflict-actions");
    if (this.conflict.kind === "whole") {
      // Not text: a whole version is the only choice.
      actions.addButton((button) =>
        button.setButtonText("Keep this device's version").onClick(() => void this.keepWhole("mine")),
      );
      actions.addButton((button) =>
        button.setButtonText("Keep GitLab's version").onClick(() => void this.keepWhole("theirs")),
      );
      actions.addButton((button) => button.setButtonText("Decide later").onClick(() => this.close()));
      return;
    }

    const { chunks } = this.conflict;
    const left = conflictCount(chunks) - this.choices.filter((choice) => choice !== undefined).length;
    if (left > 0) {
      actions.setDesc(left === 1 ? "1 part left to pick" : `${left} parts left to pick`);
    }
    if (offersWholeVersion(chunks)) {
      actions.addButton((button) =>
        button.setButtonText("Keep a whole version…").onClick((event) => this.wholeVersionMenu(event)),
      );
    }
    actions.addButton((button) => button.setButtonText("Decide later").onClick(() => this.close()));
    actions.addButton((button) => {
      button
        .setButtonText("Save")
        .setCta()
        .setDisabled(merged === null)
        .onClick(() => {
          if (merged !== null) {
            void this.finish(() => this.service.saveMerged(this.conflict, merged, this.lockLike));
          }
        });
    });
  }

  /** Keep one version as it is, saying what of the other side that drops. */
  private wholeVersionMenu(event: MouseEvent): void {
    if (this.conflict.kind !== "merge") return;
    const { chunks } = this.conflict;
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(`This device's version, without ${changes(dropped(chunks, "theirs"))} from GitLab`)
        .setIcon("monitor-smartphone")
        .onClick(() => void this.keepWhole("mine")),
    );
    menu.addItem((item) =>
      item
        .setTitle(`GitLab's version, without ${changes(dropped(chunks, "mine"))} from this device`)
        .setIcon("cloud")
        .onClick(() => void this.keepWhole("theirs")),
    );
    menu.showAtMouseEvent(event);
  }

  private async keepWhole(side: Side): Promise<void> {
    await this.finish(() => this.service.keepSide(this.conflict, side));
  }

  private async finish(action: () => Promise<void>): Promise<void> {
    try {
      await action();
      this.done = true;
      this.close();
      new Notice(`Conflict in "${noteName(this.conflict.record)}" resolved. It's uploaded on the next sync.`);
      this.onResolved();
    } catch (error) {
      new Notice(`Couldn't resolve the conflict: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Lists open conflicts so the user can pick one to resolve. */
export class ConflictListModal extends Modal {
  constructor(
    app: App,
    private readonly records: ConflictRecord[],
    private readonly onPick: (record: ConflictRecord) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Sync conflicts");
    this.contentEl.createEl("p", {
      text: "These notes were changed on this device and on GitLab before either side synced. Each has a copy with the other version next to it until you resolve it.",
    });
    for (const record of this.records) {
      new Setting(this.contentEl)
        .setName(noteName(record))
        .setDesc(`${record.path}, since ${new Date(record.createdAt).toLocaleString()}`)
        .addButton((button) =>
          button
            .setButtonText("Resolve")
            .setCta()
            .onClick(() => {
              this.close();
              this.onPick(record);
            }),
        );
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Whether "Keep a whole version" adds anything: with a single part to pick and
 * nothing combined on its own, picking a side already gives that whole version.
 */
export function offersWholeVersion(chunks: MergeChunk[]): boolean {
  return !(conflictCount(chunks) === 1 && chunks.every((chunk) => chunk.kind !== "auto"));
}

/** How many changes from `side` keeping the other whole version throws away. */
export function dropped(chunks: MergeChunk[], side: "mine" | "theirs"): number {
  return chunks.filter((chunk) => chunk.kind === "conflict" || (chunk.kind === "auto" && chunk.from === side)).length;
}

function changes(count: number): string {
  return count === 1 ? "1 change" : `${count} changes`;
}

/**
 * One version of a conflicting part, as a button that picks it. `segments`
 * mark the words that differ from the other version.
 */
function renderSide(
  parent: HTMLElement,
  label: string,
  lines: string[],
  chosen: boolean,
  segments: DiffSegment[] | undefined,
  onPick: () => void,
): void {
  const side = parent.createDiv({ cls: `envoy-conflict-side${chosen ? " is-chosen" : ""}` });
  side.setAttribute("role", "button");
  side.setAttribute("tabindex", "0");
  side.setAttribute("aria-pressed", String(chosen));
  side.setAttribute("aria-label", `Use ${label === "GitLab" ? "GitLab's" : "this device's"} version of this part`);
  side.addEventListener("click", onPick);
  side.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onPick();
    }
  });
  const header = side.createDiv({ cls: "envoy-conflict-side-label" });
  header.createSpan({ text: label });
  setIcon(header.createSpan({ cls: "envoy-conflict-side-mark" }), chosen ? "circle-check" : "circle");
  if (lines.length === 0) {
    side.createEl("pre", { text: "(Removed)" });
    return;
  }
  const pre = side.createEl("pre");
  if (!segments) {
    pre.setText(lines.join("\n"));
    return;
  }
  for (const segment of segments) {
    if (segment.changed) {
      pre.createSpan({ cls: "envoy-diff-changed", text: segment.text });
    } else {
      pre.appendText(segment.text);
    }
  }
}

/** Unchanged or automatically merged text; long unchanged stretches are shortened. */
function renderSettled(parent: HTMLElement, chunk: Exclude<MergeChunk, { kind: "conflict" }>, first: boolean, last: boolean): void {
  if (chunk.kind === "auto") {
    const box = parent.createDiv({ cls: "envoy-chunk envoy-chunk-auto" });
    box.createDiv({
      cls: "envoy-chunk-label",
      text: chunk.from === "mine" ? "Changed on this device" : chunk.from === "theirs" ? "Changed on GitLab" : "Changed the same way on both",
    });
    box.createEl("pre", { text: chunk.lines.length > 0 ? chunk.lines.join("\n") : "(Removed)" });
    return;
  }
  const box = parent.createDiv({ cls: "envoy-chunk envoy-chunk-same" });
  const { lines } = chunk;
  const keep = CONTEXT_LINES;
  if (lines.length <= keep * 2 + 1) {
    box.createEl("pre", { text: lines.join("\n") });
    return;
  }
  // Show a little context next to the changes; at the start or end of the note, only on the inner side.
  const head = first ? [] : lines.slice(0, keep);
  const tail = last ? [] : lines.slice(-keep);
  if (head.length > 0) box.createEl("pre", { text: head.join("\n") });
  box.createDiv({
    cls: "envoy-chunk-skipped",
    text: `${lines.length - head.length - tail.length} unchanged lines`,
  });
  if (tail.length > 0) box.createEl("pre", { text: tail.join("\n") });
}

function noteName(record: ConflictRecord): string {
  return record.path.split("/").pop()?.replace(/\.md$/i, "") ?? record.path;
}
