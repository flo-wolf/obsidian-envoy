import { type App, ButtonComponent, Modal, Notice, Setting } from "obsidian";
import type { ConnectPreview, ConnectMergePreview, ConnectSeedPreview } from "../sync/bootstrap-service";

const MAX_NAMES = 10;

export class ConnectConfirmModal extends Modal {
  private inProgress = false;
  private cancelButton: ButtonComponent | null = null;
  private confirmButton: ButtonComponent | null = null;

  constructor(
    app: App,
    private readonly projectPath: string,
    private readonly branch: string,
    private readonly preview: ConnectPreview,
    private readonly onConfirm: () => void | Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Connect to GitLab");
    this.contentEl.empty();
    if (this.preview.mode === "seed") {
      this.renderSeed(this.preview);
    } else {
      this.renderMerge(this.preview);
    }
    new Setting(this.contentEl)
      .addButton((button) => {
        this.cancelButton = button;
        button.setButtonText("Cancel").onClick(() => this.close());
      })
      .addButton((button) => {
        this.confirmButton = button;
        button
          .setButtonText(this.preview.mode === "seed" ? "Create first commit" : "Connect")
          .setCta()
          .onClick(() => void this.confirm());
      });
  }

  private renderMerge(preview: ConnectMergePreview): void {
    this.contentEl.createEl("p", {
      text: `Repository (${this.projectPath} · branch ${this.branch}):`,
    });
    this.contentEl.createEl("p", {
      text: `${files(preview.remoteFileCount)} will be downloaded to this vault.`,
    });

    this.contentEl.createEl("p", { text: "This vault:" });
    const pushPaths = preview.localPushPaths;
    if (pushPaths.length === 0) {
      this.contentEl.createEl("p", { text: "No new files to push." });
    } else {
      this.contentEl.createEl("p", {
        text: `${files(pushPaths.length)} only on this device will be pushed to GitLab on the next sync, e.g.:`,
      });
      this.renderPathList(pushPaths, pushPaths.length);
    }
    const replaced = preview.replacedSettingsPaths;
    if (replaced.length > 0) {
      this.contentEl.createEl("p", {
        text: `${files(replaced.length)} of this device's settings will be replaced by the repository's version:`,
      });
      this.renderPathList(replaced, replaced.length);
    }
    this.contentEl.createEl("p", {
      text: `${files(preview.conflictCount)} changed on both sides.`,
    });
    this.contentEl.createEl("p", {
      text: "Nothing is deleted. When a file outside the settings differs on both sides, both versions are kept.",
    });
  }

  private renderSeed(preview: ConnectSeedPreview): void {
    this.contentEl.createEl("p", { text: "The repository is empty." });
    this.contentEl.createEl("p", {
      text: `${files(preview.localPushCount)} will be pushed to GitLab as the first commit on branch "${preview.branch}", e.g.:`,
    });
    this.renderPathList(preview.localPushPaths, preview.localPushCount);
    this.contentEl.createEl("p", { text: "Nothing is downloaded and nothing is deleted." });
  }

  private renderPathList(paths: string[], total: number): void {
    const list = this.contentEl.createEl("ul");
    for (const path of paths.slice(0, MAX_NAMES)) {
      list.createEl("li", { text: path });
    }
    const remainder = total - Math.min(paths.length, MAX_NAMES);
    if (remainder > 0) {
      list.createEl("li", { text: `…and ${remainder} more` });
    }
  }

  async confirm(): Promise<void> {
    if (this.inProgress) return;
    this.inProgress = true;
    this.cancelButton?.setDisabled(true);
    this.confirmButton?.setDisabled(true).setButtonText("Connecting…");
    const progress = new Notice("Connecting to GitLab…", 0);
    try {
      await this.onConfirm();
    } finally {
      progress.hide();
      this.close();
    }
  }
}

function files(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
}
