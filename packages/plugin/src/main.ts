import * as nodeFs from 'node:fs'
import {
  createRoutingFs,
  type FileDiff,
  ReviewEngine,
  readDeviceStates,
  syncDirPath,
  type Timeline,
} from '@obsidian-guardian/engine'
import {
  FileSystemAdapter,
  Notice,
  Plugin,
  requireApiVersion,
  type TAbstractFile,
  type WorkspaceLeaf,
} from 'obsidian'
import {
  DEFAULT_SETTINGS,
  type PluginSettings,
  type ResolvedConfig,
  resolvePluginConfig,
} from './config'
import { buildPanelData, type PanelData } from './format'
import {
  type ReviewController,
  ReviewView,
  VIEW_TYPE_REVIEW,
} from './review-view'
import { GuardianSettingTab, type SettingsHost } from './settings'
import { createDebouncer, type Debouncer, shouldIgnorePath } from './watcher'

/** Debounce for re-hashing the timeline after vault edits. */
const REFRESH_DEBOUNCE_MS = 600
/** Debounce for ingesting peer blesses after the sync folder settles. */
const INGEST_DEBOUNCE_MS = 1500
/**
 * After a fresh activation, wait for the host app to finish its own startup
 * writes (`.obsidian/community-plugins.json`, etc.) then advance the baseline
 * once, so those self-writes don't show as pending forever.
 */
const FIRST_BLESS_DELAY_MS = 3000

/**
 * The Obsidian plugin adapter: drives the pure {@link ReviewEngine} from vault
 * events, hosts the review panel ({@link ReviewView}), and coordinates blesses
 * across devices via the synced signal folder. Desktop-only (the engine's node
 * builtins resolve to Electron's Node); mobile support is a later phase.
 */
export default class ObsidianGuardianPlugin
  extends Plugin
  implements ReviewController, SettingsHost
{
  settings: PluginSettings = { ...DEFAULT_SETTINGS }
  private engine: ReviewEngine | null = null
  private config: ResolvedConfig | null = null
  private active = false
  private timeline: Timeline | null = null
  private peers: PanelData['peers'] = null
  private refreshDebouncer: Debouncer | null = null
  private ingestDebouncer: Debouncer | null = null
  private statusBarEl: HTMLElement | null = null
  /** Paths edited since the last flush, fed to engine.touch() before re-rendering. */
  private readonly pendingTouches = new Set<string>()

  override async onload(): Promise<void> {
    await this.loadSettings()

    this.registerView(
      VIEW_TYPE_REVIEW,
      (leaf: WorkspaceLeaf) => new ReviewView(leaf, this),
    )
    this.addSettingTab(new GuardianSettingTab(this))

    this.addRibbonIcon(
      'shield-check',
      'Obsidian Guardian: vault review',
      () => {
        void this.openPanel()
      },
    )

    this.statusBarEl = this.addStatusBarItem()
    this.statusBarEl.addClass('mod-clickable')
    this.statusBarEl.addEventListener('click', () => void this.openPanel())
    this.renderStatusBar()

    this.addCommand({
      id: 'open-review-panel',
      name: 'Open vault review',
      callback: () => void this.openPanel(),
    })
    this.addCommand({
      id: 'activate',
      name: 'Start reviewing on this device',
      callback: () => void this.activate(),
    })
    this.addCommand({
      id: 'refresh',
      name: 'Refresh review',
      callback: () => void this.refresh(),
    })
    this.addCommand({
      id: 'checkpoint',
      name: 'Create checkpoint',
      callback: () => void this.checkpoint(),
    })
    this.addCommand({
      id: 'bless',
      name: 'Accept changes as baseline (bless)',
      callback: () => void this.bless(),
    })
    this.addCommand({
      id: 'rollback',
      name: 'Discard all pending changes (rollback)',
      callback: () => void this.rollback(),
    })

    this.refreshDebouncer = createDebouncer(() => {
      void this.flushEdits()
    }, REFRESH_DEBOUNCE_MS)
    this.ingestDebouncer = createDebouncer(() => {
      void this.runIngest()
    }, INGEST_DEBOUNCE_MS)

    this.registerVaultEvents()
    this.app.workspace.onLayoutReady(() => void this.init())
  }

  override onunload(): void {
    this.refreshDebouncer?.cancel()
    this.ingestDebouncer?.cancel()
  }

  // --- lifecycle ------------------------------------------------------------

  /** Build the engine and, if this device is already active, resume reviewing. */
  private async init(): Promise<void> {
    if (!this.buildEngine()) return
    const engine = this.engine
    if (!engine) return
    try {
      this.active = await engine.isOnboarded()
      if (this.active) {
        await engine.onboard() // idempotent on an existing baseline
        await engine.recover() // re-apply synced blesses, republish state
        await this.reloadTimeline()
      }
    } catch (err) {
      this.fail('initialise', err)
    }
    // Render any review tab restored from the saved workspace. Critical for
    // Obsidian's deferred views (1.7.2+): a custom-view tab restored as the
    // active tab stays a DeferredView until forced to load, so ReviewView.onOpen
    // never fires and the tab shows blank. Force-load ours, then push state.
    await this.renderOpenViews()
  }

  /**
   * Ensure every open review leaf is a live {@link ReviewView} and re-rendered.
   * `loadIfDeferred` un-defers a view restored from the workspace (constructing
   * it + running `onOpen`); used sparingly (only our own views) per the deferred
   * -views guidance. Then {@link updateViews} pushes current data + status bar.
   */
  private async renderOpenViews(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_REVIEW)) {
      if (requireApiVersion('1.7.2')) await leaf.loadIfDeferred()
    }
    this.updateViews()
  }

  /** Resolve config + construct the engine (no side effects on the repo). */
  private buildEngine(): boolean {
    const adapter = this.app.vault.adapter
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice('Obsidian Guardian needs a desktop (filesystem) vault.')
      return false
    }
    try {
      this.config = resolvePluginConfig({
        vaultPath: adapter.getBasePath(),
        vaultName: this.app.vault.getName(),
        settings: this.settings,
      })
      // Route the working tree and the device-local object store through one
      // composite fs. On desktop both backends are node:fs (a behaviour-neutral
      // seam); on mobile this is where the worktree (app.vault.adapter) and the
      // gitdir (IndexedDB) backends diverge without touching the engine.
      const fs = createRoutingFs({
        gitDir: this.config.gitDir,
        gitDirFs: nodeFs,
        workTreeFs: nodeFs,
      })
      this.engine = new ReviewEngine({ ...this.config, fs })
      return true
    } catch (err) {
      this.fail('configure', err)
      return false
    }
  }

  private registerVaultEvents(): void {
    const onChange = (file: TAbstractFile): void =>
      this.onVaultChange(file.path)
    this.registerEvent(this.app.vault.on('modify', onChange))
    this.registerEvent(this.app.vault.on('create', onChange))
    this.registerEvent(this.app.vault.on('delete', onChange))
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) =>
        this.onVaultChange(file.path, oldPath),
      ),
    )
  }

  private onVaultChange(path: string, oldPath?: string): void {
    if (!this.active || !this.config) return
    const syncDir = `${this.config.reviewFolder}/sync`
    if (path === syncDir || path.startsWith(`${syncDir}/`)) {
      this.ingestDebouncer?.schedule()
      return
    }
    // Queue the touched path(s); the debounced flush re-hashes only these.
    if (!shouldIgnorePath(path, this.config.reviewFolder)) {
      this.pendingTouches.add(path)
    }
    if (oldPath && !shouldIgnorePath(oldPath, this.config.reviewFolder)) {
      this.pendingTouches.add(oldPath)
    }
    if (this.pendingTouches.size > 0) this.refreshDebouncer?.schedule()
  }

  /** Apply queued per-path re-hashes, then recompute + re-render (the hot path). */
  private async flushEdits(): Promise<void> {
    if (!this.active || !this.engine) return
    const paths = [...this.pendingTouches]
    this.pendingTouches.clear()
    try {
      for (const path of paths) await this.engine.touch(path)
      await this.reloadTimeline()
    } catch (err) {
      this.fail('refresh', err)
    }
  }

  // --- ReviewController ------------------------------------------------------

  getData(): PanelData {
    return buildPanelData({
      active: this.active,
      timeline: this.timeline,
      peers: this.peers,
    })
  }

  async activate(): Promise<void> {
    if (!this.engine && !this.buildEngine()) return
    const engine = this.engine
    if (!engine) return
    try {
      const fresh = await engine.onboard()
      this.active = true
      await engine.recover()
      await this.reloadTimeline()
      if (fresh) {
        // Let the host settle its own config writes, then bless once.
        window.setTimeout(() => void this.firstBless(), FIRST_BLESS_DELAY_MS)
      }
      new Notice('Obsidian Guardian: reviewing activated on this device.')
    } catch (err) {
      this.fail('activate', err)
    }
  }

  async refresh(): Promise<void> {
    if (!this.active || !this.engine) return
    try {
      // Explicit refresh = authoritative reconcile (catches any missed events).
      this.pendingTouches.clear()
      await this.engine.rescan()
      await this.reloadTimeline()
    } catch (err) {
      this.fail('refresh', err)
    }
  }

  async checkpoint(): Promise<void> {
    await this.run('create checkpoint', async (engine) => {
      const { created } = await engine.checkpoint()
      new Notice(created ? 'Checkpoint created.' : 'Nothing to checkpoint.')
    })
  }

  async bless(): Promise<void> {
    await this.run('bless', async (engine) => {
      await engine.bless()
      new Notice('Baseline advanced — changes blessed.')
    })
  }

  async rollback(): Promise<void> {
    await this.run('rollback', async (engine) => {
      await engine.rollback()
      new Notice('Pending changes discarded.')
    })
  }

  async revert(path: string): Promise<void> {
    await this.run('revert file', async (engine) => {
      await engine.revert(path)
    })
  }

  async restoreCheckpoint(oid: string): Promise<void> {
    await this.run('restore checkpoint', async (engine) => {
      await engine.restoreCheckpoint(oid)
      new Notice('Working tree restored to checkpoint.')
    })
  }

  async fileDiff(path: string, fromRef?: string): Promise<FileDiff> {
    if (!this.engine) return { binary: false, lines: [] }
    return this.engine.fileDiff(path, fromRef)
  }

  openFile(path: string): void {
    void this.app.workspace.openLinkText(path, '', false)
  }

  // --- SettingsHost ----------------------------------------------------------

  async saveAndReload(): Promise<void> {
    await this.saveData(this.settings)
    // Rebuild the engine under the new config, then re-resume.
    this.engine = null
    this.config = null
    await this.init()
  }

  // --- internals -------------------------------------------------------------

  /** First-activation bless: advance the baseline past host startup self-writes. */
  private async firstBless(): Promise<void> {
    if (!this.active || !this.engine) return
    try {
      await this.engine.bless()
      await this.reloadTimeline()
    } catch (err) {
      this.fail('settle baseline', err)
    }
  }

  private async runIngest(): Promise<void> {
    if (!this.active || !this.engine) return
    try {
      await this.engine.ingest()
      await this.reloadTimeline()
    } catch (err) {
      this.fail('ingest', err)
    }
  }

  /** Run a mutating engine action, then reload + re-render. */
  private async run(
    label: string,
    fn: (engine: ReviewEngine) => Promise<void>,
  ): Promise<void> {
    if (!this.active || !this.engine) {
      new Notice('Activate reviewing on this device first.')
      return
    }
    try {
      await fn(this.engine)
      await this.reloadTimeline()
    } catch (err) {
      this.fail(label, err)
    }
  }

  /** Recompute the timeline + peer presence and re-render every open panel. */
  private async reloadTimeline(): Promise<void> {
    if (!this.engine || !this.config) return
    this.timeline = await this.engine.timeline()
    this.peers = await this.loadPeers()
    this.updateViews()
  }

  /** Read peer device-state files for the header presence summary. */
  private async loadPeers(): Promise<PanelData['peers']> {
    if (!this.config) return null
    try {
      const syncDir = syncDirPath(
        this.config.vaultPath,
        this.config.reviewFolder,
      )
      const states = await readDeviceStates(nodeFs, syncDir)
      if (states.length === 0) return null
      const updatedAt = states
        .map((s) => s.updatedAt)
        .sort()
        .at(-1)
      return { count: states.length, updatedAt: updatedAt ?? null }
    } catch {
      return null
    }
  }

  private updateViews(): void {
    this.renderStatusBar()
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_REVIEW)) {
      const view = leaf.view
      if (view instanceof ReviewView) view.update()
    }
  }

  /** Reflect activation + pending count in the clickable status-bar item. */
  private renderStatusBar(): void {
    if (!this.statusBarEl) return
    if (!this.active) {
      this.statusBarEl.setText('OG: inactive')
      return
    }
    if (!this.timeline) {
      this.statusBarEl.setText('OG: —')
      return
    }
    const n = this.timeline.current.length
    this.statusBarEl.setText(n === 0 ? 'OG: clean' : `OG: ${n} pending`)
  }

  private async openPanel(): Promise<void> {
    const { workspace } = this.app
    let leaf: WorkspaceLeaf | undefined =
      workspace.getLeavesOfType(VIEW_TYPE_REVIEW)[0]
    if (!leaf) {
      leaf = workspace.getLeaf(true)
      await leaf.setViewState({ type: VIEW_TYPE_REVIEW, active: true })
    }
    // Reveal first, then un-defer: a freshly-revealed leaf may still be a
    // DeferredView, so force it to load (running onOpen) before we render.
    await workspace.revealLeaf(leaf)
    if (requireApiVersion('1.7.2')) await leaf.loadIfDeferred()
    if (leaf.view instanceof ReviewView) leaf.view.update()
  }

  private async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) }
  }

  private fail(action: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    new Notice(`Obsidian Guardian: failed to ${action} — ${message}`)
    console.error(`[obsidian-guardian] ${action} failed:`, err)
  }
}
