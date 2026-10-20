First release of Envoy, a fork of GitLab Gitless Sync with Enclave support and a conflict window.

- Works with Enclave: notes Enclave encrypts are only ever uploaded locked. Unlocked notes are held back until they lock, and changes from other devices wait instead of overwriting them.
- Optionally locks every note before a manual sync (setting shown when Enclave is enabled).
- Conflict window: parts changed on one side only are filled in; for the rest, choose this device's version, GitLab's, or both. Locked notes are merged through Enclave, in memory only.
- Conflict copies hold the other version as is, instead of a report.

Requires Enclave 1.5.0 or later for the Enclave features.
