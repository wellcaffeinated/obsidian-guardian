# Obsidian Guardian

> **WARNING:** Do not count on this as your only backup. This plugin is still being tested. It hasn't been tested on iOS.

**Review what changed in your vault, then accept or undo it — entirely inside
Obsidian, on every device.**

---

## Why

Letting agents (like Claude) modify Obsidian notes is very useful, but comes with the obvious risk: what if the agent misunderstood? Of course, you can keep backups (and SHOULD) but what if you don't notice what changed?

You could watch the agent edit your notes like an imposing manager checking every modification, and vetting every command. But this is a huge time sink. I wanted my agent to modify files autonomously but I wanted a way to review what changed.

So I created this plugin. It lets you review changes that were made to your vault and "bless" them (review and approve them). You can roll back the changes, see history and file diffs, and take snapshots.

## Features

- Track file changes from a baseline state.
- View file differences.
- Rollback changes.
- Capture checkpoints (snapshots) for easy rollback.
- History of approvals and checkpoints.
- No setup. No dependencies.
- Local first. Changes are tracked per-device.
- Cross-device: If you approve changes on one device, the other device will auto-approve the changes IF they exactly match.
- Sync agnostic. Bring your own sync strategy. (Obsidian sync, Syncthing, Git, Dropbox...)

## What this plugin does not do

This plugin DOES NOT:

- sync your vault. (It is compatible with a vault that is syncing. Bring your own sync.)
- backup your files. Snapshots of your vault are captured, but that isn't a backup. Always backup your data with an additional method.
- prevent edits to your files.

## But what about...

[Obsidian File Recovery](https://obsidian.md/help/plugins/file-recovery).

It's great. It's a built-in tool and it shows differences. But it only shows one file at a time and you need to know which file to look at.

[Obsidian Git](https://community.obsidian.md/plugins/obsidian-git)

If you use git for syncing (I don't) that could work. However, the plugin is "highly unstable" on mobile devices, and you need to mess around with git, which may or may not be for you.

## Usage

Open the panel from the ribbon icon, the status-bar item (`OG: clean` /
`OG: N pending`), or the command **Obsidian Guardian: Open review panel**.

**Commands** (all under the `Obsidian Guardian:` prefix):

- **Open review panel** · **Activate** review on this device
- **Refresh** — recompute pending from disk
- **Checkpoint** — snapshot the current state into history
- **Bless** — accept all pending changes (advance the baseline)
- **Rollback** — reset the vault to the baseline (gated by a confirm dialog)

In the panel you can also **revert a single file**, expand any file to see its
**inline colored diff**, click a filename to **open the note**, and
**roll back to an earlier checkpoint** (confirm-gated).

**Settings:** the git-database location, the synced review folder (default `_OG`),
the baseline marker name, and extra ignore globs.

### What's tracked vs. ignored

- `.obsidian` plugin and settings files **are** tracked by default (you usually
  want to review those too).
- Caches and `workspace*.json` are ignored.
- The synced review folder (`_OG/`) is ignored by git — it carries the
  cross-device signal files, which sync but are never committed into the local
  store.

Ignores are managed via the plugin settings not a committed
`.gitignore` in your vault.

## Core concepts

| Term | Meaning |
| --- | --- |
| **Baseline** | The last state you blessed — your "this is trusted" marker. |
| **Pending** | The diff from the baseline to your current working tree. |
| **Checkpoint** | A snapshot of the vault at a moment in time, saved so you can roll back to it. Made manually (the Checkpoint button) — a revertable point that does _not_ change what's trusted. |
| **Bless** | Advance the baseline: "I've reviewed everything pending, it's good." |
| **Revert** | Restore one file to its baseline content. |
| **Rollback** | Reset the whole working tree to the baseline (or to a chosen checkpoint). |

The review panel is a timeline: a **Current card** at the top (everything pending
right now, with Accept / Undo and per-file diffs + revert), then a collapsible
**History** of checkpoints, down to the **Baseline** marker.

## How it works

**Each device runs its own git, and git never syncs.** The plugin keeps a
content-addressed git database for your vault in the device's app-data (desktop)
or in the browser's IndexedDB (mobile) — **outside** the synced vault tree. That
store is private to the device; it is never synced, so sync can never corrupt it.
Change detection, checkpoints, and rollback are all local git operations.

**Devices coordinate the _trust marker_, not git state.** When you bless the changes, the
plugin writes a tiny JSON file into a synced folder in the vault
(`_OG/sync/bless-<deviceId>.json`) — a list of file paths and the **content hash**
each was blessed at.

**Applying a bless is content-gated, per file.** When another device's bless
arrives, your device advances its baseline for a given file **only if your own
synced copy of that file already hashes to the blessed value**. If sync hasn't caught up, or you have a newer local edit, that
file simply stays pending until things converge. The result is order-independent
and self-healing: every device ends up trusting the same _content_, even if their
internal histories differ.

**Reviewing is opt-in per device.** Installing the plugin does nothing on its
own — it never silently starts tracking. You explicitly **activate** review on
each device where you want it.

## License

See repository for license details.
