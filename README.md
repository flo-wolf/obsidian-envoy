# Envoy

**Sync your Obsidian vault across all your devices: iPhone, Android, Mac, Windows and Linux. Free, private, and yours.**

Envoy keeps your notes in sync through a private project on [GitLab](https://gitlab.com), a
service for storing files with their full history that's free to use. You don't need to know Git
or install anything besides Envoy. Set it up once per device, and every device stays up to date.

## Why Envoy

- **Every device, one vault.** Envoy works the same in Obsidian on iPhone, Android, Mac, Windows
  and Linux.
- **Free and private.** Your notes live in your own private GitLab project, not on someone else's
  sync server. Envoy talks to GitLab and nothing else: no account with us, no tracking.
- **Every version kept.** Each sync is saved on GitLab, so you can look at or bring back any
  earlier version of a note.
- **Nothing gets lost.** When a note changed on two devices, Envoy combines the changes. If both
  changed the same lines, it keeps both versions and shows them side by side so you can pick.
- **Your setup on every device.** Settings, themes, snippets and plugins sync too. A phone can keep
  its own theme or plugins if you want it to.
- **See what happened.** The sync history in the settings lists every file each sync brought in,
  sent out or merged.

## Even better with Enclave

[Enclave](https://github.com/flo-wolf/obsidian-enclave) locks private notes with a password. Used
together, your private notes only ever reach GitLab encrypted:

- Envoy never uploads a note while it's unlocked. It waits until Enclave locks it again.
- The sync button can lock every open note first, so everything goes up in one go.
- When a locked note changed on two devices, you can still merge it. Enclave decrypts both versions
  in memory only and locks the result again.

## Get started

It takes about five minutes, most of it on GitLab.

1. **Install Envoy.** In Obsidian, open **Settings → Community plugins → Browse**, search for
   **Envoy**, then select **Install** and **Enable**.
2. **Create a private project.** Sign up at [gitlab.com](https://gitlab.com) for free and create a
   new, blank, private project for your vault, for example `vault-personal`.
3. **Create an access token** in GitLab under your user settings → **Access tokens**. Choose a
   fine-grained token, limit it to your vault project and give it these permissions:
   - **Projects:** Project → Read
   - **Repository:** Branch → Read, Repository → Read, Commit → Create

   Envoy's settings show this list too.
4. **Connect.** In **Settings → Envoy**, enter the project path (for example
   `yourname/vault-personal`), paste the token, add a name and email for the sync history on
   GitLab, and select **Connect to GitLab**. Envoy shows what it's about to do and waits for your
   OK.
5. **Repeat step 4 on your other devices.** Each device downloads the vault and syncs from then on.

**Using Obsidian Sync?** Turn it off under **Settings → Core plugins → Sync** before you connect.
Two sync services working on the same files get in each other's way. Envoy reminds you if it's on.

**Connecting a vault that already has notes?** Connecting deletes nothing. When a note differs from
the one on GitLab, both versions are kept; only Obsidian's settings take GitLab's version, so every
device shares one setup. Making a copy of the vault first is still a good habit.

## Day to day

- **Sync when you want:** use the sync button in the left sidebar or **Sync now** at the top of the
  settings.
- **Sync automatically:** Envoy syncs when Obsidian starts and, on phones, whenever you open the
  app. Under **Settings → Envoy → Sync** you can add syncing after you edit and on a timer.
- **Same file changed on two devices?** Run **Resolve sync conflicts** from the command palette, or
  just sync by hand, and pick what to keep.

## Learn more

The [Envoy guide](https://github.com/flo-wolf/obsidian-envoy/blob/main/docs/guide.md) covers
everything in detail: the access token, which files to leave out with a `.gitignore`, automatic
sync on desktop and mobile, conflicts, device-specific settings, how Envoy works with Enclave, and
its limits.

## Privacy and security

Envoy only talks to the GitLab server you set up (gitlab.com or your own) and sends nothing anywhere
else. There's no telemetry. The access token is kept in Obsidian's secret storage on each device;
it's never written to your vault, to logs or to GitLab.

## Credits and license

Envoy is a fork of [GitLab Gitless Sync](https://github.com/TerekhinAO/obsidian-gitlab-sync) by
Alexander Terekhin, itself based on
[GitHub Gitless Sync](https://github.com/silvanocerza/github-gitless-sync) by Silvano Cerza.
Licensed under AGPL-3.0-only; see
[`LICENSE`](https://github.com/flo-wolf/obsidian-envoy/blob/main/LICENSE) and
[`THIRD_PARTY_NOTICES.md`](https://github.com/flo-wolf/obsidian-envoy/blob/main/THIRD_PARTY_NOTICES.md).
