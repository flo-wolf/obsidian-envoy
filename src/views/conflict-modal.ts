import { type App, Menu, Modal, Notice, Setting, setIcon } from "obsidian";
import type { ConflictService, OpenConflict, Side } from "../conflicts/conflict-service";
import { assembleMerge, conflictCount, type ChunkChoice, type MergeChunk } from "../merge/merge-chunks";
import { type DiffSegment, wordDiff } from "../merge/word-diff";
import type { ConflictRecord } from "../sync/types";

/** How many unchanged lines to show next to each change; the rest fold away. */
const CONTEXT_LINES = 1;

/**
 * The conflict window: shows both versions of a note, fills in what was merged
 * automatically, and lets the user pick this device's version, GitLab's, or
 * both for each remaining spot. Or keep one whole version.
 */
export class ConflictModal extends Modal {
  private readonly choices: (ChunkChoice | undefined)[] = [];
  /** Unchanged stretches the user unfolded, by chunk position. */
  private readonly unfolded = new Set<number>();
  /** The scrolling note listing, kept so a redraw after a pick stays where the user was. */
  private fileEl: HTMLElement | null = null;
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
      new Notice("Conflict saved for later. Sync by hand or run the command to resolve sync conflicts to come back to it.", 8000);
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
    const combined = chunks.filter((chunk) => chunk.kind === "auto").length;
    const what = `a version for ${open === 1 ? "the part" : `each of the ${open} parts`} changed on both.`;
    const combinedText = `${combined === 1 ? "1 change was" : `${combined} changes were`} combined on their own`;
    contentEl.createEl("p", {
      cls: "envoy-conflict-intro",
      text:
        open === 0
          ? "Both devices changed different parts of this note, so they were combined on their own. Check the result and save it."
          : combined === 0
            ? `Both devices changed this note. Pick ${what}`
            : `Both devices changed this note. ${combinedText}; pick ${what}`,
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

    this.renderFile(contentEl, chunks);

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

  /**
   * The note as it will be saved, line by line: unchanged stretches fold
   * away, lines combined on their own are marked, and each part changed on
   * both is a choice until it's picked.
   */
  private renderFile(parent: HTMLElement, chunks: MergeChunk[]): void {
    const open = conflictCount(chunks);
    const left = open - this.choices.filter((choice) => choice !== undefined).length;
    const combined = chunks.filter((chunk) => chunk.kind === "auto").length;
    const scrolledTo = this.fileEl?.scrollTop ?? 0;
    const file = parent.createDiv({ cls: "envoy-file" });
    this.fileEl = file;
    const head = file.createDiv({ cls: "envoy-file-head" });
    const title = head.createSpan();
    title.createSpan({ cls: "envoy-file-name", text: fileName(this.conflict.record) });
    title.createSpan({ cls: "envoy-file-sub", text: " · as it will be saved" });
    const counts = [
      combined > 0 ? `${combined} combined` : "",
      open > 0 ? (left > 0 ? `${left} to pick` : "all picked") : "",
    ].filter(Boolean);
    head.createSpan({ cls: "envoy-file-counts", text: counts.join(" · ") });

    let number = 1;
    let conflictIndex = 0;
    chunks.forEach((chunk, position) => {
      const last = position === chunks.length - 1;
      if (chunk.kind === "same") {
        // The empty "line" after the note's final line break isn't worth a row.
        const lines = last && chunk.lines[chunk.lines.length - 1] === "" ? chunk.lines.slice(0, -1) : chunk.lines;
        number = this.renderUnchanged(file, lines, position, number, position === 0, last);
      } else if (chunk.kind === "auto") {
        const tag = chunk.from === "mine" ? "from this device" : chunk.from === "theirs" ? "from GitLab" : "same on both";
        if (chunk.lines.length === 0) {
          lineRow(file, null, "Removed", { cls: "is-combined is-removed", tag });
        }
        chunk.lines.forEach((text, i) => {
          lineRow(file, number++, text, { cls: "is-combined", tag: i === 0 ? tag : undefined });
        });
      } else {
        number = this.renderClash(file, chunk, conflictIndex++, number);
      }
    });
    file.scrollTop = scrolledTo;
  }

  /** Unchanged lines, with only a little context next to the changes unless unfolded. */
  private renderUnchanged(file: HTMLElement, lines: string[], position: number, number: number, first: boolean, last: boolean): number {
    const head = first ? 0 : CONTEXT_LINES;
    const tail = last ? 0 : CONTEXT_LINES;
    const hidden = lines.length - head - tail;
    if (hidden < 2) {
      lines.forEach((text, i) => lineRow(file, number + i, text));
      return number + lines.length;
    }
    if (this.unfolded.has(position)) {
      lines.forEach((text, i) => lineRow(file, number + i, text));
      return number + lines.length;
    }
    lines.slice(0, head).forEach((text, i) => lineRow(file, number + i, text));
    foldRow(file, `${hidden} unchanged ${hidden === 1 ? "line" : "lines"}`, () => this.unfold(position));
    lines.slice(lines.length - tail).forEach((text, i) => lineRow(file, number + head + hidden + i, text));
    return number + lines.length;
  }

  private unfold(position: number): void {
    this.unfolded.add(position);
    this.render();
  }

  /**
   * A part changed on both: this device's version, GitLab's and "both", each
   * a card that picks it. Once picked, the part shows as the lines it saves.
   */
  private renderClash(file: HTMLElement, chunk: Extract<MergeChunk, { kind: "conflict" }>, index: number, number: number): number {
    const choice = this.choices[index];
    const pick = (value: ChunkChoice | undefined) => {
      this.choices[index] = value;
      this.render();
    };

    if (choice) {
      const parts: [string[], string][] =
        choice === "both" ? [[chunk.mine, "this device's"], [chunk.theirs, "GitLab's"]]
        : choice === "mine" ? [[chunk.mine, "this device's"]]
        : [[chunk.theirs, "GitLab's"]];
      let first = true;
      for (const [lines, label] of parts) {
        const change = first ? () => pick(undefined) : undefined;
        if (lines.length === 0) {
          lineRow(file, null, "Removed", { cls: "is-picked is-removed", tag: label, change });
        }
        lines.forEach((text, i) => {
          lineRow(file, number++, text, { cls: "is-picked", tag: i === 0 ? label : undefined, change: i === 0 ? change : undefined });
        });
        first = false;
      }
      return number;
    }

    const clash = file.createDiv({ cls: "envoy-clash" });
    // The number this device's first line would get; none if this device removed the part.
    clash.createSpan({ cls: "envoy-line-n", text: chunk.mine.length > 0 ? String(number) : "" });
    // When one side removed the part there's nothing to compare word by word.
    const diff = chunk.mine.length > 0 && chunk.theirs.length > 0
      ? wordDiff(chunk.mine.join("\n"), chunk.theirs.join("\n"))
      : null;
    codeBlock(clashCard(clash, "This device", () => pick("mine")), chunk.mine, diff?.mine);
    codeBlock(clashCard(clash, "GitLab", () => pick("theirs")), chunk.theirs, diff?.theirs);
    clashCard(clash, "Both", () => pick("both"), "is-both").createDiv({ cls: "envoy-clash-hint", text: "this device's first" });
    // Until it's picked, the lines below are numbered as if this device's version stays.
    return number + chunk.mine.length;
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

/** One line of the note: number, text, and an optional tag on the right ("from GitLab", "GitLab's · Change"). */
function lineRow(
  file: HTMLElement,
  number: number | null,
  text: string,
  options: { cls?: string; tag?: string; change?: () => void } = {},
): void {
  const row = file.createDiv({ cls: `envoy-line${options.cls ? ` ${options.cls}` : ""}` });
  row.createSpan({ cls: "envoy-line-n", text: number === null ? "" : String(number) });
  row.createSpan({ cls: "envoy-line-text", text });
  const tag = row.createSpan({ cls: "envoy-line-tag" });
  if (options.tag) tag.createSpan({ text: options.tag });
  if (options.change) {
    const change = tag.createEl("a", { cls: "envoy-line-change", text: "Change" });
    change.setAttribute("role", "button");
    change.setAttribute("tabindex", "0");
    activate(change, options.change);
  }
}

/** A row standing in for folded unchanged lines; clicking it shows them. */
function foldRow(file: HTMLElement, text: string, onClick: () => void): void {
  const row = file.createDiv({ cls: "envoy-fold" });
  row.setAttribute("role", "button");
  row.setAttribute("tabindex", "0");
  setIcon(row.createSpan({ cls: "envoy-fold-icon" }), "chevrons-up-down");
  row.createSpan({ text });
  activate(row, onClick);
}

/** A card in a part changed on both: its header with a radio, and whatever goes below. */
function clashCard(clash: HTMLElement, label: string, onPick: () => void, cls = ""): HTMLElement {
  const card = clash.createDiv({ cls: `envoy-clash-card${cls ? ` ${cls}` : ""}` });
  card.setAttribute("role", "button");
  card.setAttribute("tabindex", "0");
  card.setAttribute("aria-label", label === "Both" ? "Keep both versions, this device's first" : `Keep ${label === "GitLab" ? "GitLab's" : "this device's"} version`);
  activate(card, onPick);
  const head = card.createDiv({ cls: "envoy-clash-head" });
  head.createSpan({ cls: "envoy-radio" });
  head.createSpan({ text: label });
  return card;
}

/** One version's lines; `segments` mark the words that differ from the other version. */
function codeBlock(card: HTMLElement, lines: string[], segments: DiffSegment[] | undefined): void {
  const code = card.createDiv({ cls: "envoy-clash-code" });
  if (lines.length === 0) {
    code.addClass("is-removed");
    code.setText("Removed");
  } else if (!segments) {
    code.setText(lines.join("\n"));
  } else {
    for (const segment of segments) {
      if (segment.changed) {
        code.createSpan({ cls: "envoy-diff-changed", text: segment.text });
      } else {
        code.appendText(segment.text);
      }
    }
  }
}

/** Click, Enter and Space all run `action`. */
function activate(el: HTMLElement, action: () => void): void {
  el.addEventListener("click", (event) => {
    event.stopPropagation();
    action();
  });
  el.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  });
}

function fileName(record: ConflictRecord): string {
  return record.path.split("/").pop() ?? record.path;
}

function noteName(record: ConflictRecord): string {
  return record.path.split("/").pop()?.replace(/\.md$/i, "") ?? record.path;
}
