# Future plugin work

> Outstanding items for the Obsidian Guardian plugin, extracted from the rewrite
> build log. None of these block the core review→bless→rollback loop, which is
> built, green, and verified live on desktop. Intent spec:
> [`p2p-bless-protocol.md`](p2p-bless-protocol.md); how we got here:
> [`build-history.md`](build-history.md).

## Mobile (Android) — verification

The engine is mobile-_clean_ (no Node builtins at module-load except `node:path`)
and the real mobile backends exist behind `createRoutingFs` (vault adapter +
IndexedDB), with `isDesktopOnly: false`. What's left is **proof on a real
browser runtime**:

- [ ] **Headless-Chromium smoke (no device, no Docker).** Run the engine spike
      (adapter-fs + live IndexedDB + Buffer polyfill, no Node) in a real Chromium
      via **Vitest browser mode** or a small **Playwright** script, to verify
      load-safety + browser-runtime correctness. Android's WebView is Chromium, so
      this covers it. Caveats: one-time ~150 MB Chromium download + headless launch
      need the sandbox bypass. Does **not** cover Obsidian's real mobile loader /
      `CapacitorAdapter` quirks.
- [ ] **Sideload + Syncthing round-trip across the user's real devices.** The user
      tests on Android directly for now. Copy `dist/` into
      `<vault>/.obsidian/plugins/obsidian-guardian/` and confirm activate → bless →
      ingest converges across desktop ⇄ Android over Syncthing.
- iOS / WKWebView is best-effort, low-priority, and untested (can't be
  containerised; Apple-only).

## Coordination correctness (engine)

Both are deferred because, per the protocol spec, **pruning/recovery never breaks
the content-gate correctness** — they harden the edges.

- [ ] **Retention / GC.** Keep last-N blessed states (the baseline first-parent
      chain) + an unblessed-checkpoint window; prune the rest. `pending` is already
      pruned by the freshness window. Prerequisite for the auto-checkpoint feature
      below (so an auto-snapshot timeline doesn't grow unbounded).
- [ ] **Crash-republish gap.** `recover()` re-applies received blesses but does
      not yet re-derive + republish _our own_ `bless-<id>.json` from the baseline's
      parent→baseline diff if that signal file went missing (spec §recovery
      step 3). Until then, a device that loses its synced bless file (but keeps its
      gitDir) won't re-announce its own blessed deltas to peers.

## Auto-checkpointing (designed, not built)

A **locked design decision** but unimplemented. The manual `Checkpoint` command +
the engine `checkpoint()` / `restoreCheckpoint()` / `listCheckpoints()` primitives
already exist, so this is an additive trigger, not new core.

- [ ] A **toggleable setting** (off by default) with a **configurable frequency**
      that creates periodic snapshot commits — a revertable timeline — **without
      advancing the `baseline`** (no auto-bless; advancing trust on a timer would
      silently absorb unreviewed changes). Depends on retention/GC to prune old
      auto-checkpoints.

## Panel / UX polish

- [ ] **Richer peer / divergence UI.** Surface per-peer presence and where a
      device's blessed content diverges from ours, beyond today's presence header.
- [ ] **Persist the `workIndex` across reloads.** Today it cold-primes once per
      session on the first `touch`/`rescan`; persisting it skips the first full
      hash on load.
- [ ] **Diff context capping for very large files** in the inline per-file diff.

## Test coverage

- [ ] **Broader live (headless-container) assertions:** restore-checkpoint, and a
      **multi-device ingest** scenario (two engines over a shared synced `_OG/sync/`,
      asserting content-gate convergence) — today only single-device activate →
      bless → edit is asserted live.

## Packaging

- [ ] **Community-store packaging** (low priority — the user self-installs via
      `dist/` + Syncthing). Would need release automation, a versioned
      `manifest.json` + `versions.json`, and store submission. `manifest.json` is
      currently `version: 0.0.0`.
