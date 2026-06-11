# Obsidian Guardian

> **Review what changed in your vault, then accept or undo it — entirely inside
> Obsidian, on every device.** Obsidian Guardian remembers the last state you
> _blessed_ ("reviewed and trusted") and shows you a complete, honest diff of
> everything that has changed since: per-file, with inline diffs, one-click
> revert, and a checkpoint history you can roll back to. The guarantee is
> **complete visibility + clean undo**, not prevention.

It runs as a single Obsidian plugin on **desktop and Android**. There is no
server and no designated "main" device: each device keeps its own private change
history and the devices agree on what's been blessed through a few small synced
files.

---

## Why

If you let an AI agent (Claude and friends), a sync conflict, or just your
past-midnight self loose on an Obsidian vault, you want two things afterward:

1. **To see exactly what changed** since the last time you trusted the vault —
   not a vague "modified 12 files," but the actual lines, file by file.
2. **To undo cleanly** — revert a single bad file, or roll the whole vault back
   to a known-good point — without nuking the good changes alongside the bad.

Existing tools don't quite fit. Plain git means leaving Obsidian and learning a
CLI, and its history syncs to every device (or you fight `.gitignore`). A synced
"what changed" note can't actually _do_ anything — it's read-only. Obsidian
Guardian is the review-and-undo layer built _into_ the app, designed for a vault
that lives on several synced devices.

---

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

---

## How it works

**Each device runs its own git, and git never syncs.** The plugin keeps a
content-addressed git database for your vault in the device's app-data (desktop)
or in the browser's IndexedDB (mobile) — **outside** the synced vault tree. That
store is private to the device; it is never synced, so sync can never corrupt it.
Change detection, checkpoints, and rollback are all local git operations.

**Devices coordinate the _trust marker_, not git state.** When you bless, the
plugin writes a tiny JSON file into a synced folder in the vault
(`_OG/sync/bless-<deviceId>.json`) — a list of file paths and the **content hash**
each was blessed at. Your sync engine (the design target is **Syncthing**)
already carries the actual file bytes; the bless carries only hashes.

**Applying a bless is content-gated, per file.** When another device's bless
arrives, your device advances its baseline for a given file **only if your own
synced copy of that file already hashes to the blessed value**. That single
content check is the entire conflict-resolution story — no merge prompts, no
vector clocks. If sync hasn't caught up, or you have a newer local edit, that
file simply stays pending until things converge. The result is order-independent
and self-healing: every device ends up trusting the same _content_, even if their
internal histories differ.

**Reviewing is opt-in per device.** Installing the plugin does nothing on its
own — it never silently starts tracking. You explicitly **activate** review on
each device where you want it. (The existence of the local git store _is_ the
activation flag, and it doesn't sync, so a second device opening the same vault
won't start a competing history.)

---

## Use cases

- **Agent vault review.** Point an AI agent at your notes, then sit down later
  and review every change it made before trusting any of it.
- **Catch sync surprises.** See what a sync round actually changed, and undo a
  bad merge or a clobbered note.
- **Checkpoint before a big edit.** Snapshot the vault, do a sweeping refactor or
  bulk rename, and roll back cleanly if it goes wrong.
- **Mobile review.** Triage and bless changes from your phone — mobile is a
  full participant, not a read-only viewer.

---

## Install

Not yet in the community store — install by hand:

1. Build the plugin (or grab a built `dist/`): `pnpm install && pnpm --filter
   @obsidian-guardian/plugin build`.
2. Copy `manifest.json`, `main.js`, and `styles.css` into
   `<your-vault>/.obsidian/plugins/obsidian-guardian/`.
3. If you use Syncthing, it propagates the plugin to your other devices for you.
4. In Obsidian: **Settings → Community plugins**, enable **Obsidian Guardian**.
5. Run the command **Obsidian Guardian: Activate** (or click _Start reviewing on
   this device_ in the panel) on each device where you want review. The first
   activation establishes the baseline at the current vault state.

---

## Using it

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
the baseline marker name, extra ignore globs, and the bless author name/email.

### What's tracked vs. ignored

- `.obsidian` plugin and settings files **are** tracked by default (you usually
  want to review those too).
- Caches and `workspace*.json` are ignored.
- The synced review folder (`_OG/`) is ignored by git — it carries the
  cross-device signal files, which sync but are never committed into the local
  store.

Ignores are managed via the repo's `.git/info/exclude`, not a committed
`.gitignore` in your vault.

---

## Limitations

- **Visibility and undo, not prevention.** Guardian doesn't stop an agent (or
  anything else) from editing your vault — it makes every change reviewable and
  cleanly reversible after the fact.
- **The git store is per-device and local.** If you wipe a device's app data, that
  device rebuilds its store from the synced bless records (the trust marker
  survives) — but its local checkpoint history is device-local and not recovered.
- **Sync target is Syncthing.** The content gate assumes a sync engine that moves
  real files. Obsidian Sync and others should work in principle but aren't the
  tested path.
- **Platforms: desktop (Linux) + Android** are supported and the primary targets.
  **iOS is best-effort and untested.**
- **Conflict handling is deliberately minimal.** A file you've edited more
  recently than a peer's bless just stays pending until content converges — there
  are no merge dialogs.

---

## Development

This is a pnpm workspace monorepo with two packages: **`engine`** (a pure,
storage-injected TypeScript core with zero Obsidian imports) and **`plugin`**
(the Obsidian plugin — the product). Contributor orientation lives in
[`CLAUDE.md`](CLAUDE.md); the protocol design is in
[`plans/p2p-bless-protocol.md`](plans/p2p-bless-protocol.md); outstanding work is
in [`plans/future-plugin-work.md`](plans/future-plugin-work.md).

```sh
pnpm install
pnpm test          # unit tests (engine + plugin)
pnpm build         # build both packages
pnpm test:plugin   # live smoke in headless Obsidian (needs docker)
```

---

## License

See repository for license details.
