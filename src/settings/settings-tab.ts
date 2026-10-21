import {
  type App,
  Notice,
  PluginSettingTab,
  type Setting,
  type SettingDefinitionItem,
  type TextComponent,
} from "obsidian";
import type GitLabGitlessSyncPlugin from "../main";
import type { LocalSyncState } from "../settings/settings";
import type { ConflictStrategy, LogLevel } from "../sync/types";
import { copyToClipboard } from "../utils";
import { enclavePresence } from "../enclave/enclave-api";
import { ConnectConfirmModal } from "../views/connect-confirm-modal";
import { confirmAction } from "../views/confirm-modal";
import { parseDeviceSpecificEntries } from "../sync/device-specific";
import { formatWhen, renderSyncHistory } from "../views/sync-history-view";
import { OBSIDIAN_SYNC_WARNING, obsidianSyncEnabled } from "../obsidian-sync";

export interface VaultSetupViewState {
  initialized: boolean;
  title: string;
  description: string;
  showSetupActions: boolean;
  showResetAction: boolean;
}

export function vaultSetupViewState(state: LocalSyncState): VaultSetupViewState {
  if (!state.initialized) {
    return {
      initialized: false,
      title: "Connect to GitLab",
      description:
        "Download the GitLab repository into this vault. Existing local files are kept and pushed on the next sync; nothing is deleted.",
      showSetupActions: true,
      showResetAction: false,
    };
  }

  const dirtyCount = Object.keys(state.dirtyEntries).length;
  const base = state.lastSyncedCommitSha?.slice(0, 8) ?? "unknown";
  return {
    initialized: true,
    title: "Vault connected",
    description: `Base commit ${base}. Local pending changes: ${dirtyCount}.`,
    showSetupActions: false,
    showResetAction: true,
  };
}

/**
 * What the GitLab token needs, shown under the token field (line breaks kept
 * by styles.css). Envoy calls the REST API for the project itself, to see
 * whether it's empty and its default branch (Project: Read); branches (Branch:
 * Read); compare, the tree, raw files and blobs, and the archive (Repository:
 * Read); and creating commits (Commit: Create). See GitLab's "Fine-grained
 * permissions for REST API" page.
 */
export const TOKEN_HELP = [
  "Stored in Obsidian's secret storage on this device, never in the vault.",
  "Use a fine-grained token limited to this project, with these permissions:",
  "• Projects: Project → Read",
  "• Repository: Branch → Read, Repository → Read, Commit → Create",
  "Without fine-grained tokens: a project access token with the Maintainer role and the api scope. write_repository alone isn't enough.",
].join("\n");

const CONFLICT_STRATEGIES: Record<ConflictStrategy, string> = {
  remote: "GitLab's version",
  local: "This device's version",
  "auto-remote": "Merge, else GitLab's version",
  "auto-local": "Merge, else this device's version",
};

const LOG_LEVELS: Record<LogLevel, string> = {
  off: "Off",
  error: "Errors",
  info: "Info",
  debug: "Debug",
};

const DEFAULT_EDIT_DEBOUNCE_SECONDS = 8;
const DEFAULT_INTERVAL_MINUTES = 10;

export default class GitLabSyncSettingsTab extends PluginSettingTab {
  private connectPreviewInProgress = false;
  /** Whether Obsidian's own Sync is on, as last read from the config folder. */
  private obsidianSyncOn = false;

  constructor(
    app: App,
    private plugin: GitLabGitlessSyncPlugin,
  ) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const connected = () => this.plugin.pluginData.state.initialized;
    void this.checkObsidianSync();
    return [
      {
        name: "Obsidian Sync is turned on",
        desc: OBSIDIAN_SYNC_WARNING,
        searchable: false,
        visible: () => this.obsidianSyncOn,
        render: (setting) => {
          setting.setClass("envoy-warning-setting");
        },
      },
      {
        name: "Sync now",
        visible: connected,
        render: (setting) => this.renderSyncNow(setting),
      },
      {
        type: "group",
        heading: "GitLab repository",
        items: [
          {
            name: "GitLab base URL",
            desc: "Your GitLab address, starting with https://",
            control: { type: "text", key: "gitlabBaseUrl", placeholder: "https://gitlab.com" },
          },
          {
            name: "Project path",
            desc: "Your user or group name and the project name, as in the project's address on GitLab",
            control: { type: "text", key: "projectPath", placeholder: "yourname/vault-personal" },
          },
          {
            name: "Branch",
            desc: "The branch to sync",
            control: { type: "text", key: "branch", placeholder: "main" },
          },
          {
            name: "GitLab token",
            desc: TOKEN_HELP,
            aliases: ["access token", "permissions"],
            render: (setting) => this.renderToken(setting),
          },
          {
            name: "Token secret name",
            desc: "The name the token is stored under in Obsidian's secret storage on this device",
            control: { type: "text", key: "tokenSecretName", placeholder: "envoy-token" },
          },
        ],
      },
      {
        type: "group",
        heading: "Commit author",
        items: [
          {
            name: "Author name",
            desc: "Also names this device in commit messages and conflict copies. Leave empty to use the detected platform.",
            control: { type: "text", key: "authorName" },
          },
          {
            name: "Author email",
            control: { type: "text", key: "authorEmail" },
          },
        ],
      },
      {
        type: "group",
        heading: "Vault setup",
        items: [
          {
            name: "Connect to GitLab",
            aliases: ["vault connected"],
            render: (setting) => this.renderSetup(setting),
          },
          {
            name: "Reset local sync state",
            desc:
              "Makes this device forget everything it remembers about past syncs, as if it had never been connected. " +
              "Use it when sync is stuck or keeps failing. Your files and GitLab stay as they are; afterwards you connect again.",
            visible: connected,
            render: (setting) => this.renderReset(setting),
          },
        ],
      },
      {
        type: "group",
        heading: "Sync",
        items: [
          {
            name: "Sync on startup",
            desc: "Run one sync after Obsidian is ready. On phones, the app is usually suspended before this runs, so use the next setting there instead.",
            control: { type: "toggle", key: "syncOnStartup" },
          },
          {
            name: "Sync on app foreground (mobile only)",
            desc: "Run one sync whenever you open Obsidian again on a phone or tablet. The reliable choice on mobile.",
            control: { type: "toggle", key: "syncOnForeground" },
          },
          {
            name: "Sync on app background (mobile only)",
            desc: "Run one sync when you leave Obsidian on a phone or tablet. Not always reliable: some devices suspend the app before the sync finishes.",
            control: { type: "toggle", key: "syncOnBackground" },
          },
          {
            name: "Sync after edits",
            desc: "Run a sync a few seconds after you stop editing",
            control: { type: "toggle", key: "syncAfterEdit" },
          },
          {
            name: "Edit debounce (seconds)",
            desc: "How long to wait after the last change before syncing",
            visible: () => this.plugin.settings.syncAfterEdit,
            control: {
              type: "number",
              key: "syncAfterEditDebounceSeconds",
              placeholder: String(DEFAULT_EDIT_DEBOUNCE_SECONDS),
              min: 1,
              validate: (value) => wholeNumberFrom(value, 1),
            },
          },
          {
            name: "Sync on a timer",
            desc: "Run a sync regularly to pull in changes from your other devices. Good for a desktop that stays open.",
            control: { type: "toggle", key: "syncOnInterval" },
          },
          {
            name: "Timer interval (minutes)",
            desc: "How often the timer syncs",
            visible: () => this.plugin.settings.syncOnInterval,
            control: {
              type: "number",
              key: "syncIntervalMinutes",
              placeholder: String(DEFAULT_INTERVAL_MINUTES),
              min: 1,
              validate: (value) => wholeNumberFrom(value, 1),
            },
          },
          {
            name: "When a file changed on both sides",
            desc:
              "Merge combines the changes in text files line by line. When it can't, or for other files, the chosen " +
              "version stays in place and the other one goes into a copy, ready for the conflict window.",
            aliases: ["conflict strategy"],
            control: { type: "dropdown", key: "conflictStrategy", options: CONFLICT_STRATEGIES },
          },
          {
            name: "Lock all notes before syncing",
            desc: "When you sync with the sidebar button or the sync command, Enclave locks every unlocked note first, so all your changes go up. Automatic syncs never lock your notes; they hold unlocked notes back until they lock.",
            // Only meaningful with Enclave, so only shown when it's enabled.
            visible: () => enclavePresence(this.app).state !== "absent",
            control: { type: "toggle", key: "lockBeforeManualSync" },
          },
        ],
      },
      {
        type: "group",
        heading: "This device",
        items: [
          {
            name: "Device-specific settings",
            desc: lines(
              `Settings files this device keeps for itself, one per line, relative to the ${this.app.vault.configDir} folder. ` +
                "Envoy never uploads them from this device and never changes or deletes them here, so this device can " +
                "use its own theme or plugins while your other devices keep sharing theirs.",
              "For example:",
              "• appearance.json: theme, light or dark mode, font size and enabled CSS snippets",
              "• community-plugins.json: which community plugins are turned on",
              "A folder ends with a slash, e.g. themes/. This list is stored on this device only.",
              "Take a file off the list to share it again: on the next sync, the repository's version replaces this " +
                "device's (restart Obsidian to load it). If the repository has none, this device's file is uploaded.",
            ),
            control: {
              type: "textarea",
              key: "deviceSpecificPaths",
              placeholder: "appearance.json\ncommunity-plugins.json",
              rows: 4,
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Interface",
        items: [
          {
            name: "Show sidebar icon",
            desc: "Show a sync button in the left sidebar",
            control: { type: "toggle", key: "showRibbonIcon" },
          },
          {
            name: "Log level",
            desc: "Use debug only while looking into a sync problem",
            control: { type: "dropdown", key: "loggingLevel", options: LOG_LEVELS },
          },
          {
            name: "Copy logs",
            render: (setting) => {
              setting.addButton((button) =>
                button.setButtonText("Copy").onClick(async () => {
                  try {
                    await copyToClipboard(await this.plugin.logger.read());
                    new Notice("Logs copied", 5000);
                  } catch (error) {
                    new Notice(`Couldn't copy the logs: ${error instanceof Error ? error.message : String(error)}`, 10000);
                  }
                }),
              );
            },
          },
          {
            name: "Clean logs",
            render: (setting) => {
              setting.addButton((button) =>
                button.setButtonText("Clean").onClick(async () => {
                  await this.plugin.logger.clean();
                  new Notice("Logs cleaned", 5000);
                }),
              );
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Sync history",
        items: [
          {
            name: "Recent syncs",
            desc:
              "The latest syncs on this device that changed something or failed, newest first. " +
              "Open one to see which files were pulled, pushed or merged. Syncs that found nothing to do aren't listed.",
            aliases: ["history", "pulled", "pushed"],
            render: (setting) => this.renderHistory(setting),
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    if (key === "deviceSpecificPaths") {
      return this.plugin.settings.deviceSpecificPaths.join("\n");
    }
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  /**
   * Edits the plugin's settings object in place: the sync engine holds on to it.
   */
  async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.settings;
    const text = typeof value === "string" ? value : "";
    switch (key) {
      case "gitlabBaseUrl":
        settings.gitlabBaseUrl = text.trim().replace(/\/+$/, "");
        break;
      case "projectPath":
        settings.projectPath = text.trim();
        break;
      case "branch":
        settings.branch = text.trim() || "main";
        break;
      case "tokenSecretName":
        settings.tokenSecretName = text.trim() || "envoy-token";
        break;
      case "deviceSpecificPaths":
        settings.deviceSpecificPaths = parseDeviceSpecificEntries(text);
        break;
      case "syncAfterEditDebounceSeconds":
        settings.syncAfterEditDebounceSeconds = wholeNumber(value, DEFAULT_EDIT_DEBOUNCE_SECONDS);
        break;
      case "syncIntervalMinutes":
        settings.syncIntervalMinutes = wholeNumber(value, DEFAULT_INTERVAL_MINUTES);
        break;
      case "loggingLevel":
        settings.loggingLevel = value === "error" || value === "info" || value === "debug" ? value : "off";
        settings.loggingEnabled = settings.loggingLevel !== "off";
        this.plugin.logger.setLevel(settings.loggingLevel);
        break;
      default:
        (settings as unknown as Record<string, unknown>)[key] = value;
    }

    if (key === "showRibbonIcon") {
      if (settings.showRibbonIcon) {
        this.plugin.showSyncRibbonIcon();
      } else {
        this.plugin.hideSyncRibbonIcon();
      }
    }
    if (key === "syncOnInterval" || key === "syncIntervalMinutes") {
      this.plugin.refreshAutoSyncInterval();
    }
    if (key === "syncOnInterval" || key === "syncAfterEdit") {
      this.refreshDomState();
    }
    await this.plugin.saveSettings();
  }

  /**
   * Reads whether Obsidian's own Sync is on. The warning's visibility follows
   * the answer; Obsidian applies it, so the row isn't hidden by hand.
   */
  private async checkObsidianSync(): Promise<void> {
    const enabled = await obsidianSyncEnabled(this.app.vault);
    if (enabled !== this.obsidianSyncOn) {
      this.obsidianSyncOn = enabled;
      this.refreshDomState();
    }
  }

  private renderSyncNow(setting: Setting): void {
    const lastSyncAt = this.plugin.pluginData.state.lastSyncAt;
    setting
      .setDesc(lastSyncAt ? `Last synced: ${formatWhen(lastSyncAt)}` : "Not synced yet")
      .addButton((button) =>
        button
          .setButtonText("Sync now")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true).setButtonText("Syncing…");
            await this.plugin.sync("manual");
            this.update();
          }),
      );
  }

  private renderToken(setting: Setting): void {
    let tokenInput: TextComponent | undefined;
    setting
      .setClass("envoy-token-setting")
      .addButton((button) =>
        button.setIcon("eye-off").setTooltip("Show or hide the token").onClick(() => {
          if (!tokenInput) return;
          const hidden = tokenInput.inputEl.type === "password";
          tokenInput.inputEl.type = hidden ? "text" : "password";
          button.setIcon(hidden ? "eye" : "eye-off");
        }),
      )
      .addText((text) => {
        text.setPlaceholder("Paste the token").onChange((value) => {
          this.app.secretStorage.setSecret(this.plugin.settings.tokenSecretName, value);
        });
        text.inputEl.type = "password";
        tokenInput = text;
      });
  }

  private renderSetup(setting: Setting): void {
    const setupState = vaultSetupViewState(this.plugin.pluginData.state);
    setting.setName(setupState.title).setDesc(setupState.description);
    if (!setupState.showSetupActions) {
      return;
    }
    setting.addButton((button) => {
      button
        .setButtonText("Connect to GitLab")
        .setCta()
        .onClick(async () => {
          if (this.connectPreviewInProgress) return;
          this.connectPreviewInProgress = true;
          button.setDisabled(true).setButtonText("Checking GitLab…");
          const progress = new Notice("Checking GitLab…", 0);
          try {
            const preview = await this.plugin.previewConnect();
            if (!preview) return; // error/misconfig already surfaced by previewConnect
            new ConnectConfirmModal(
              this.plugin.app,
              this.plugin.settings.projectPath,
              this.plugin.settings.branch,
              preview,
              async () => {
                await this.plugin.connect(preview);
                this.update();
              },
            ).open();
          } finally {
            progress.hide();
            this.connectPreviewInProgress = false;
            button.setDisabled(false).setButtonText("Connect to GitLab");
          }
        });
    });
  }

  private renderReset(setting: Setting): void {
    setting.addButton((button) =>
      button
        .setButtonText("Reset")
        .setDestructive()
        .onClick(async () => {
          const confirmed = await confirmAction(this.plugin.app, {
            title: "Reset local sync state?",
            text:
              "No file is deleted and nothing changes on GitLab. Afterwards, connect again: files that match the " +
              "repository are kept, settings files take the repository's version, and any other file that differs " +
              "is kept in both versions. Conflicts waiting in the conflict window are forgotten, but their copies stay in the vault.",
            confirm: "Reset",
            destructive: true,
          });
          if (!confirmed) return;
          await this.plugin.reset();
          this.update();
        }),
    );
  }

  private renderHistory(setting: Setting): void {
    setting.setClass("envoy-history-setting");
    const historyEl = setting.settingEl.createDiv({ cls: "envoy-history" });
    setting.addButton((button) =>
      button.setButtonText("Clear").onClick(async () => {
        await this.plugin.clearSyncHistory();
        historyEl.empty();
        renderSyncHistory(historyEl, []);
      }),
    );
    void this.plugin.loadSyncHistory().then((history) => renderSyncHistory(historyEl, history));
  }
}

/** A description with line breaks. */
function lines(...parts: string[]): DocumentFragment {
  return createFragment((fragment) => {
    parts.forEach((part, index) => {
      if (index > 0) fragment.createEl("br");
      fragment.appendText(part);
    });
  });
}

function wholeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.round(value) : fallback;
}

function wholeNumberFrom(value: number, min: number): string | void {
  if (!Number.isInteger(value) || value < min) {
    return `Enter a whole number of at least ${min}.`;
  }
}
