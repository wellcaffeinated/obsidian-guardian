import LightningFS from '@isomorphic-git/lightning-fs'
import {
  createRoutingFs,
  type FileDiff,
  ReviewEngine,
  readDeviceStates,
  syncDirPath,
  type Timeline,
} from '@obsidian-guardian/engine'
import { Buffer as BufferPolyfill } from 'buffer'
import {
  FileSystemAdapter,
  Notice,
  Platform,
  Plugin,
  type TAbstractFile,
  type WorkspaceLeaf,
} from 'obsidian'
import { createAdapterFs } from './adapter-fs'
import {
  DEFAULT_SETTINGS,
  type PluginSettings,
  type ResolvedConfig,
  resolvePluginConfig,
} from './config'
import { defaultGitDir, desktopFs } from './desktop-env'
import {
  buildPanelData,
  type FileRow,
  type PanelData,
  type PanelStatus,
  toFileRow,
} from './format'
import {
  type ReviewController,
  ReviewView,
  VIEW_TYPE_REVIEW,
} from './review-view'
import { GuardianSettingTab, type SettingsHost } from './settings'
import { createDebouncer, type Debouncer, shouldIgnorePath } from './watcher'

// isomorphic-git (and its safe-buffer dep) reference a `Buffer` global. Desktop's
// Electron Node provides one; the mobile WKWebView does not, so the first git op
// would throw `Buffer is not defined`. Install the bundled feross polyfill (the
// `buffer` import is aliased to it in tsdown.config.ts) before any engine work.
// `??=` leaves desktop's native Buffer untouched — this only fills the mobile gap.
globalThis.Buffer ??= BufferPolyfill

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

/** The composite (worktree + gitdir) fs the engine runs on — typed via
 * `createRoutingFs` so we needn't import isomorphic-git's `PromiseFsClient`. */
type RoutingFs = ReturnType<typeof createRoutingFs>
/** A single fs backend (one half of the router). */
type FsBackend = Parameters<typeof createRoutingFs>[0]['gitDirFs']

/**
 * The Obsidian plugin adapter: drives the pure {@link ReviewEngine} from vault
 * events, hosts the review panel ({@link ReviewView}), and coordinates blesses
 * across devices via the synced signal folder. Runs on desktop (node:fs) and
 * mobile (vault adapter for the working tree + IndexedDB for the object store);
 * the per-platform backends are assembled in {@link resolveEnv}.
 */
export default class ObsidianGuardianPlugin
  extends Plugin
  implements ReviewController, SettingsHost
{
  settings: PluginSettings = { ...DEFAULT_SETTINGS }
  private engine: ReviewEngine | null = null
  private config: ResolvedConfig | null = null
  /** The engine's composite fs; reused to read peer signals on the worktree. */
  private fs: RoutingFs | null = null
  private active = false
  /** Panel lifecycle for legible UI: starts `loading` until init() resolves. */
  private status: PanelStatus = 'loading'
  /** Last failure message, surfaced in the error panel (cleared on success). */
  private lastError: string | null = null
  /**
   * Tail of the serial operation queue. Every engine-touching path
   * ({@link init}/{@link activate}/{@link refresh}/{@link run}/{@link flushEdits}/
   * {@link runIngest}/{@link firstBless}) runs through {@link enqueue} so a
   * debounced auto-refresh, a user action, and startup never overlap or race —
   * engine ops are multi-await and not atomic across awaits.
   */
  private opChain: Promise<unknown> = Promise.resolve()
  private timeline: Timeline | null = null
  private peers: PanelData['peers'] = null
  private refreshDebouncer: Debouncer | null = null
  private ingestDebouncer: Debouncer | null = null
  private statusBarEl: HTMLElement | null = null
  /** Paths edited since the last flush, fed to engine.touch() before re-rendering. */
  private readonly pendingTouches = new Set<string>()

  /**
   * Run `task` after all previously-enqueued operations settle (success or
   * failure), so engine work is strictly serialized. A failing task never breaks
   * the chain for the next one. Top-level entry points enqueue; internal helpers
   * they call (e.g. {@link reloadTimeline}) must NOT, or they would deadlock.
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(task, task)
    this.opChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Move to the error state: record the message, notify, and re-render. */
  private setError(action: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    this.status = 'error'
    this.lastError = `Couldn’t ${action}: ${message}`
    this.fail(action, err)
    this.updateViews()
  }

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
  private init(): Promise<void> {
    return this.enqueue(async () => {
      this.status = 'loading'
      this.lastError = null
      this.updateViews()
      if (!(await this.buildEngine()) || !this.engine) {
        this.setError('initialise', this.lastError ?? 'engine setup failed')
        return
      }
      const engine = this.engine
      try {
        this.active = await engine.isOnboarded()
        if (this.active) {
          await engine.onboard() // idempotent on an existing baseline
          await engine.recover() // re-apply synced blesses, republish state
          this.status = 'ready'
          await this.reloadTimeline()
        } else {
          this.status = 'inactive'
          this.updateViews()
        }
      } catch (err) {
        this.setError('initialise', err)
      }
    })
  }

  /** Resolve config + construct the engine (no side effects on the repo). */
  private async buildEngine(): Promise<boolean> {
    try {
      const env = await this.resolveEnv()
      if (!env) return false
      this.config = env.config
      this.fs = env.fs
      this.engine = new ReviewEngine({ ...env.config, fs: env.fs })
      return true
    } catch (err) {
      this.fail('configure', err)
      return false
    }
  }

  /**
   * Build the per-platform engine config + composite (worktree + gitdir) fs.
   * The router lets the engine run unchanged while the two filesystems differ:
   * - **Mobile:** worktree on the vault adapter ({@link createAdapterFs}), gitdir
   *   on IndexedDB ({@link LightningFS}). A synthetic `vaultPath` (`/vault`, the
   *   adapter-fs base) + a virtual gitdir (`/git`) inside a per-vault IndexedDB
   *   store.
   * - **Desktop:** real `node:fs` for both, via `desktop-env.desktopFs()` —
   *   which pulls `node:fs` through a runtime `require` only when called here, so
   *   the builtin never evaluates at module load on mobile.
   */
  private async resolveEnv(): Promise<{
    config: ResolvedConfig
    fs: RoutingFs
  } | null> {
    const { adapter } = this.app.vault
    const vaultName = this.app.vault.getName()

    if (Platform.isMobileApp) {
      const vaultPath = '/vault'
      const gitDir = '/git'
      const config = resolvePluginConfig({
        vaultPath,
        gitDir,
        settings: this.settings,
      })
      const fs = createRoutingFs({
        gitDir,
        gitDirFs: new LightningFS(
          `obsidian-guardian-${vaultName}`,
        ) as unknown as FsBackend,
        workTreeFs: createAdapterFs({
          adapter,
          base: vaultPath,
        }) as unknown as FsBackend,
      })
      return { config, fs }
    }

    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice('Obsidian Guardian needs a desktop (filesystem) vault.')
      return null
    }
    const nodeFs = desktopFs() as unknown as FsBackend
    const vaultPath = adapter.getBasePath()
    const gitDir =
      this.settings.gitDir.trim() || defaultGitDir(vaultPath, vaultName)
    const config = resolvePluginConfig({
      vaultPath,
      gitDir,
      settings: this.settings,
    })
    const fs = createRoutingFs({
      gitDir,
      gitDirFs: nodeFs,
      workTreeFs: nodeFs,
    })
    return { config, fs }
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
  private flushEdits(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.active || !this.engine) return
      const paths = [...this.pendingTouches]
      this.pendingTouches.clear()
      try {
        for (const path of paths) await this.engine.touch(path)
        await this.reloadTimeline()
      } catch (err) {
        this.fail('refresh', err)
      }
    })
  }

  // --- ReviewController ------------------------------------------------------

  getData(): PanelData {
    return buildPanelData({
      active: this.active,
      timeline: this.timeline,
      peers: this.peers,
      status: this.status,
      error: this.lastError,
    })
  }

  /** Re-run initialisation after an error (rebuild the engine + resume). */
  retry(): Promise<void> {
    this.engine = null
    this.config = null
    this.fs = null
    return this.init()
  }

  activate(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.engine && !(await this.buildEngine())) return
      const engine = this.engine
      if (!engine) return
      try {
        const fresh = await engine.onboard()
        this.active = true
        await engine.recover()
        this.status = 'ready'
        await this.reloadTimeline()
        if (fresh) {
          // Let the host settle its own config writes, then bless once.
          window.setTimeout(() => void this.firstBless(), FIRST_BLESS_DELAY_MS)
        }
        new Notice('Obsidian Guardian: reviewing activated on this device.')
      } catch (err) {
        this.setError('activate', err)
      }
    })
  }

  refresh(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.active || !this.engine) return
      try {
        // Explicit refresh = authoritative reconcile (catches any missed events).
        this.pendingTouches.clear()
        await this.engine.rescan()
        await this.reloadTimeline()
      } catch (err) {
        this.fail('refresh', err)
      }
    })
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

  async fileDiff(
    path: string,
    fromRef?: string,
    reverse?: boolean,
  ): Promise<FileDiff> {
    if (!this.engine) return { binary: false, lines: [] }
    return this.engine.fileDiff(
      path,
      fromRef,
      reverse,
      this.settings.diffContext,
    )
  }

  async checkpointChanges(oid: string): Promise<FileRow[]> {
    if (!this.engine) return []
    const changes = await this.engine.checkpointDiff(oid)
    return changes.map(toFileRow)
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
    this.fs = null
    await this.init()
  }

  // --- internals -------------------------------------------------------------

  /** First-activation bless: advance the baseline past host startup self-writes. */
  private firstBless(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.active || !this.engine) return
      try {
        await this.engine.bless()
        await this.reloadTimeline()
      } catch (err) {
        this.fail('settle baseline', err)
      }
    })
  }

  private runIngest(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.active || !this.engine) return
      try {
        await this.engine.ingest()
        await this.reloadTimeline()
      } catch (err) {
        this.fail('ingest', err)
      }
    })
  }

  /** Run a mutating engine action, then reload + re-render. Serialized so it
   * never overlaps a debounced refresh, another action, or startup. */
  private run(
    label: string,
    fn: (engine: ReviewEngine) => Promise<void>,
  ): Promise<void> {
    return this.enqueue(async () => {
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
    })
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
    if (!this.config || !this.fs) return null
    try {
      const syncDir = syncDirPath(
        this.config.vaultPath,
        this.config.reviewFolder,
      )
      // Read through the engine's worktree fs (node:fs on desktop, the vault
      // adapter on mobile) — the synced signals live in the working tree.
      const states = await readDeviceStates(this.fs, syncDir)
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
      if (view instanceof ReviewView) {
        view.update()
      } else if (leaf.isDeferred) {
        // On mobile, a panel restored from the saved layout is *deferred*: its
        // ReviewView isn't constructed yet, so the instanceof above misses it and
        // the post-init refresh would be silently dropped (the panel stays on its
        // stale/loading body until the user taps it). Materialise it now — its
        // onOpen pulls fresh getData(). Runs at most once per leaf (it's no longer
        // deferred afterwards).
        void leaf.loadIfDeferred()
      }
    }
  }

  /** Reflect lifecycle + pending count in the clickable status-bar item. */
  private renderStatusBar(): void {
    if (!this.statusBarEl) return
    if (this.status === 'loading') {
      this.statusBarEl.setText('OG: loading…')
      return
    }
    if (this.status === 'error') {
      this.statusBarEl.setText('OG: error')
      return
    }
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
    await workspace.revealLeaf(leaf)
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
