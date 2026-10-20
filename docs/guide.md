# Envoy guide

Everything about setting up and using [Envoy](https://github.com/flo-wolf/obsidian-envoy): the
GitLab token in detail, automatic sync, `.gitignore`, conflicts, device-specific settings, how
Envoy works with [Enclave](https://github.com/flo-wolf/obsidian-enclave), and what it can't do.

Envoy keeps a vault and one branch of a GitLab repository in sync through GitLab's REST API, so it
works the same on Windows, macOS, Linux, iPhone and Android. Every sync is an ordinary Git commit, so
the full history is on GitLab and the repository works with a normal desktop Git workflow too.

## Installation

Requires Obsidian 1.11.4 or newer.

### Community plugins

Open **Settings → Community plugins → Browse**, search for **Envoy**, install and enable it.

### BRAT

To get new versions before they reach the directory, install
[BRAT](https://github.com/TfTHacker/obsidian42-brat) and add the repository `flo-wolf/obsidian-envoy`.

### Manual

Download `main.js`, `manifest.json`, and `styles.css` from the
[latest release](https://github.com/flo-wolf/obsidian-envoy/releases/latest) and copy them
into `<vault>/.obsidian/plugins/envoy/`, then enable the plugin.

## Getting started

Four steps: create the repository and a token, connect the vault, turn on automatic sync, add a
`.gitignore`.

If Obsidian's own Sync is turned on (Settings → Core plugins → Sync, on by default in new vaults),
turn it off first: two sync services on the same files get in each other's way. Envoy reminds you
once per device, and shows a warning in its settings while it's on.

### Step 1 — Create the GitLab repository and an access token

1. Create a project in GitLab — either on [gitlab.com](https://gitlab.com) or on a self-managed
   instance (any HTTPS base URL works). A brand-new **empty** project is fine: the plugin can create
   the first commit from your vault. An existing project with content is fine too.
2. Create a fine-grained access token for the plugin, either a personal one (in your user
   settings, under access tokens) or one for the project (**Project → Settings → Access tokens**):

   - **Access:** only the vault project.
   - **Permissions**, as grouped in GitLab's token form:
     - **Projects:** Project → **Read**
     - **Repository:** Branch → **Read**, Repository → **Read**, Commit → **Create**

   That's all Envoy calls: the project itself, to see whether it's empty and which branch is the
   default (Project: Read); branches (Branch: Read); compare, the file tree, raw files and blobs,
   and the archive (Repository: Read); and creating commits (Commit: Create). See GitLab's
   [fine-grained permissions for the REST API](https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens_rest/).
   Pushing to a protected branch such as `main` depends on your role in the project, not on the
   token, so no protected-branch permission is needed.

3. If your GitLab instance does not support fine-grained access tokens, use a project access token
   with role `Maintainer` and scope `api`. The plugin uses GitLab's REST API to create commits;
   `write_repository` is only for Git-over-HTTP and is not enough for this plugin.

Keep the token private. If you stop using the plugin or move the vault to another repository, revoke
the old token and create a new one.

### Step 2 — Connect the vault

**Back up the vault before connecting.** The plugin never deletes a file and never overwrites one
side silently, but connecting does bring remote content into the vault.

Fill in **Settings → Envoy → GitLab repository**:

- **GitLab base URL** — `https://gitlab.com`, or your self-managed HTTPS instance
  (e.g. `https://gitlab.example.com`). HTTPS is required.
- **Project path** — namespace and project path, for example `developing/obsidian-world`.
- **Branch** — the branch to synchronize, for example `main`.
- **GitLab token** — the token from step 1. Stored securely in Obsidian SecretStorage on this
  device.
- **Commit author name** and **Commit author email** — used as the author of every commit the plugin
  creates. Required.

Then press **Connect to GitLab**. The plugin inspects both sides and shows a summary before changing
anything; nothing happens until you confirm. One button handles every starting state:

- **Repository has commits (the default case) → merge.** Remote files are downloaded into the vault.
  Files that exist only locally are kept and pushed on the next sync. When the same file exists on
  both sides and differs, **both versions are kept**: the GitLab version takes the original path and
  your version is saved beside it as `<name> (local conflict).<ext>`. Nothing is deleted. These
  copies from connecting aren't listed in the conflict window; compare them by hand and delete the
  one you don't need.
- **Repository is empty (no commits, no branches) → initial commit.** Your whole vault is pushed as
  the first commit, and that commit creates the branch named in **Branch**, whatever you typed there —
  it does not have to match the default branch GitLab preconfigured for the project. Nothing is
  downloaded and nothing is deleted. This path needs the commit author name and email, and the vault
  must contain at least one syncable file (an empty vault plus an empty repository has nothing to
  push and reports an error).

Keep Obsidian open until the confirmation notice appears. After that, **Sync with GitLab** (sidebar
icon or command palette) syncs on demand at any time.

### Step 3 — Turn on automatic sync

All automatic modes live under **Settings → Envoy → Sync** and are off-by-default
except *Sync on startup*. Pick the set that matches the device.

**On desktop — sync by time.** The desktop app stays open for hours, so time-based triggers are what
keep it current:

- **Sync after edits** — on. Runs a sync a few seconds after you stop typing.
- **Edit debounce (seconds)** — `8` is a good starting point; raise it if you get commits mid-thought.
- **Sync on a timer** — on. Pulls in what other devices pushed while you were idle.
- **Timer interval (minutes)** — `10` for an actively shared vault, `60` if you mostly write alone.
- **Sync on startup** — on. One sync when Obsidian launches.

**On mobile — sync on app lifecycle.** iOS and Android suspend the app instead of leaving it
running, so foreground/background transitions are the most reliable mobile sync triggers:

- **Sync on app foreground (mobile only)** — on. Runs a sync when you reopen Obsidian from the
  background. This is the reliable mobile replacement for *Sync on startup*.
- **Sync on app background (mobile only)** — optional. Runs a sync when you leave the app. It gets
  your latest notes out sooner, but some devices suspend the app before the request finishes, so
  treat it as best-effort rather than a guarantee.
- **Sync on startup** — on. Useful when Obsidian is launched cold; foreground sync still handles
  the more common reopen-from-background case.
- **Sync on a timer** — off. A suspended app has no timer.

Every mode runs the same engine as the manual button, and each trigger has a cooldown so overlapping
events cannot stack up syncs.

### Step 4 — Add a `.gitignore`

The plugin excludes only its own runtime folder (`.obsidian/plugins/envoy/`), its log,
the `.git` directory, and sync-metadata files. **Everything else — including the rest of
`.obsidian/` — is synced unless you ignore it.** So on a new vault, create a `.gitignore` in the
vault root.

**Recommended — keep settings shared, drop device-specific state.** Obsidian's `workspace*.json` and
caches change on every device on every session and cause constant churn and needless conflicts:

```gitignore
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/cache
.trash/
```

**Also reasonable — keep Obsidian's config out of the repository entirely.** Choose this when
settings, themes, and plugin sets should stay per-device:

```gitignore
.obsidian/
```

**Not recommended — no `.gitignore` at all.** Everything syncs, including `workspace.json`, which
means the desktop and the phone fight over layout state on every sync and generate conflict copies
of a file you never edit by hand.

Root and nested `.gitignore` files are both honored, for normal syncs and for the first commit when
seeding an empty repository. Files that are already tracked stay tracked even if a rule starts
matching them later — ignore rules keep new files out, they do not remove history. `.gitignore`
itself is an ordinary file: it is committed and shared, so the rules apply on every device.

## Features

**Works without Git on the device.** No local `.git`, no `isomorphic-git`, no shell Git — only HTTPS
calls to the GitLab REST API. That is what makes it work on iOS and Android.

**Ordinary Git commits.** The plugin writes real commits with your configured author, so desktop
collaborators keep using plain `git pull`/`git push` on the same branch and see nothing unusual.

**Nothing is silently lost.** Both sides of a conflict are always preserved; the other version
becomes a conflict copy instead of being overwritten, until you resolve it. A delete that clashes
with an edit produces a Markdown marker rather than removing the file. Binary files are copied
byte-for-byte.

**Fast, incremental syncs.** A normal sync does not scan or hash the whole vault — it works from a
local journal of what changed plus a remote diff. There is a separate **Full audit and sync** command
for when you want an exhaustive local rescan.

**Crash-safe.** Sync runs as a transaction. If a remote commit succeeds but writing files locally is
interrupted, the next sync detects the pending transaction and finishes it.

**Local-only sync state.** The tracked-file index, base commit, and journal live on the device and
are never committed, so the repository stays clean and devices never fight over metadata.

**Self-managed GitLab.** Any HTTPS GitLab instance works, alongside gitlab.com.

## Resolving conflicts

A conflict is a file changed on this device and on GitLab before either side synced, in ways the
automatic merge couldn't combine. Envoy keeps one version at the file's path and the other in a
copy next to it, named `<name> — conflict <device> <date>`, and records the conflict.

Run **Resolve sync conflicts**, or just sync by hand: a manual sync that finds conflicts opens the
conflict window right away.

- Parts changed on one side only are already filled in, compared against the last synced version.
- For each spot changed on both sides, choose **this device's**, **GitLab's**, or **both**. The two
  versions are shown side by side, or stacked on a phone.
- Or keep one whole version. Files that aren't text, such as images, only offer that.

Saving writes the result to the note and deletes the copy; the next sync uploads both. **Decide
later** leaves everything as it is.

## Working with Enclave

[Enclave](https://github.com/flo-wolf/obsidian-enclave) encrypts notes and folders. An unlocked
note's plain text is on disk while you work on it, so a sync tool could upload it. Envoy never
does:

- **Unlocked notes are held back.** The note's last locked version stays on GitLab. Once Enclave
  locks it again (when you leave the note, after inactivity, or when Obsidian is hidden or closed),
  the next sync uploads it, locked. The sync notice tells you how many notes were held back.
- **Notes waiting to be locked** in a locked folder, and notes a crash left unlocked, are held back
  too.
- **A second check works without Enclave.** A note that was locked when last synced and is plain
  now is only uploaded if Enclave confirms you decrypted it on purpose. If Enclave is enabled but
  hasn't finished loading, Envoy doesn't sync at all rather than guess.
- **Changes from other devices wait for unlocked notes.** Envoy doesn't overwrite a note you have
  open in plain text. The change is applied once the note is locked; if you changed it too, you get a
  conflict to resolve, nothing is lost.
- **Lock all notes before syncing.** With this setting (on by default, only shown when Enclave is
  enabled), syncing with the sidebar button or the Sync command locks every unlocked note first, so
  everything goes up at once. Automatic syncs never lock your notes; they only hold them back.
- **Locked notes are never merged line by line**, since encrypted text can't be merged. In the
  conflict window, Enclave decrypts the versions in memory only, asking for any password it doesn't
  have, and the merged note is locked again before it's saved. Without Enclave, you can still keep
  one whole version.

Enclave also writes back a note's exact earlier encrypted version when you lock it unchanged, so
opening a note without editing it causes no upload and no conflict.

## Settings reference

### Sync modes

| Setting | What it does |
| --- | --- |
| **Sync on startup** | One sync after Obsidian is ready. Desktop-oriented — on mobile the app is usually suspended before it runs. |
| **Sync on app foreground** (mobile only) | One sync when you reopen the app. The reliable mobile trigger. |
| **Sync on app background** (mobile only) | One sync when you leave the app. Best-effort: the OS may suspend the app first. |
| **Sync after edits** | One sync a few seconds after your last change, per **Edit debounce**. |
| **Sync on a timer** | One sync every **Timer interval** minutes, to pull other devices' changes. |
| **Manual** | *Sync with GitLab* — sidebar icon or command palette — runs the same engine on demand. |

### Conflict strategy

A conflict is a file that changed on **both** the device and GitLab since the last sync. The plugin
never overwrites either side; this setting only decides which version keeps the original path.

- **Auto merge, fallback Remote** *(default)* — try a line-based three-way merge of the text file
  first; if it conflicts or the file is binary, fall back to *Remote*.
- **Auto merge, fallback Local** — same merge attempt, falling back to *Local*.
- **Remote** — GitLab's version keeps the path; yours is saved as a conflict copy.
- **Local** — your version keeps the path and gets committed; GitLab's is saved as a conflict copy.

Either way, the conflict waits for you in the [conflict window](#resolving-conflicts).

A deletion that clashes with a change on the other side produces a Markdown conflict marker instead
of removing the file.

### Interface and diagnostics

- **Sync now** (top of the settings, once connected) — syncs right away and shows when this device
  last synced.
- **Show sidebar icon** — a one-tap sync button in the left ribbon.
- **Lock all notes before syncing** (with Enclave) — a manual sync locks every unlocked note first.
- **Resolve sync conflicts** (command) — opens the conflict window.
- **Log level** — `Off` by default. Use `Debug` only while diagnosing sync behavior.
- **Copy logs** / **Clean logs** — export or clear the plugin log.
- **Show GitLab sync status** (command) — base commit, pending local changes, last sync result.
- **Sync history** (bottom of the settings) — the latest 30 syncs on this device that changed
  something or failed. Each opens to the files pulled, pushed, merged, in conflict or held back.
- **Reset local sync state** — makes this device forget what it remembers about past syncs, as if it
  had never been connected. Use it when sync is stuck or keeps failing. No file is deleted and nothing
  changes on GitLab. Afterwards you connect again: files that match the repository are kept, settings
  files take the repository's version, and any other file that differs is kept in both versions.

### Device-specific settings

Envoy syncs the whole config folder (`.obsidian`), so all devices share one setup. Obsidian reports
no file changes there (nor for dot-files like `.gitignore`), so every sync checks those files itself,
reading only the ones whose modification time or size changed. When a device
should differ, say a phone with its own theme or fewer plugins, list the settings files it keeps for
itself under **This device → Device-specific settings**, one per line, relative to the config folder:

```gitignore
appearance.json         # theme, light or dark mode, font size, enabled CSS snippets
community-plugins.json  # which community plugins are turned on
```

Envoy never uploads a listed file from that device and never changes or deletes it there; the other
devices keep sharing theirs. Theme and plugin files themselves keep syncing, so every device has them
and each picks its own. A folder ends with a slash (`themes/`). The list is stored with Envoy's own
settings, which never sync, so each device has its own.

Taking a file off the list shares it again: on the next sync the repository's version replaces this
device's (restart Obsidian to load it), or, if the repository has none, this device's file is
uploaded. Keep Enclave's settings shared: they hold which folders stay locked.

## Limitations

- GitLab only, one project and one branch, REST API only.
- No local Git: no merge, rebase, force push, branch switching, Git LFS, submodules, symlinks,
  executable-bit changes, or multiple remotes.
- Seeding an empty repository pushes the whole vault in one commit (no chunking), so a very large
  vault is bounded by GitLab's request size limit.
- Automatic mobile sync depends on OS lifecycle events; background sync can be cut short by the
  system.
- Plugin runtime files and sync state are local-only and never committed.

## Security

The GitLab token is stored in Obsidian SecretStorage. It is never written to plugin data, logs,
conflict files, URLs, or GitLab commits. Logs redact credential-shaped fields such as
`PRIVATE-TOKEN`, `Authorization`, `token`, and `password`. All traffic is HTTPS — a non-HTTPS base
URL is rejected.

## Privacy

The plugin communicates only with the GitLab instance configured by the user. It does not collect
telemetry or analytics and does not send vault data to any other service. A GitLab account/project
and access token are required.

## Development

- Install dependencies: `pnpm install`.
- `pnpm build` type-checks (`tsc -noEmit -skipLibCheck`) and bundles the production plugin with
  esbuild to `main.js`.
- `pnpm test` runs the Vitest suite.
- `pnpm check` runs tests, type-check, lint, and build.
- `main.js` and `dist/` are git-ignored build artifacts and are never committed.

## Credits & License

Envoy is a fork of [GitLab Gitless Sync](https://github.com/TerekhinAO/obsidian-gitlab-sync) by
Alexander Terekhin, an independently maintained GitLab rewrite of
[GitHub Gitless Sync](https://github.com/silvanocerza/github-gitless-sync) by Silvano Cerza.
Enclave support, the conflict window, and related changes by Florian Wolf, 2026.

Licensed under **AGPL-3.0-only**. The upstream license and attribution are preserved — see
[`LICENSE`](../LICENSE) and [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).
