import { ReviewEngine, type Status } from '@obsidian-guardian/engine'
import { FileSystemAdapter, Notice, Plugin, TFile } from 'obsidian'
import {
  DEFAULT_SETTINGS,
  type PluginSettings,
  resolvePluginConfig,
} from './config'
import {
  ConfirmModal,
  type ReviewController,
  ReviewView,
  VIEW_TYPE_REVIEW,
} from './review-view'
import { type GuardianSettingsHost, GuardianSettingTab } from './settings'
import {
  createDebouncer,
  createSerializedRefresh,
  type Debouncer,
  shouldIgnorePath,
} from './watcher'

/**
 * Obsidian adapter over the pure `ReviewEngine`. Desktop-only: the engine reads
 * the vault via Node `fs` (Electron) and keeps its git database under OS
 * app-data, outside the synced tree.
 */
export default class ObsidianGuardianPlugin
  extends Plugin
  implements ReviewController, GuardianSettingsHost
{
  settings: PluginSettings = { ...DEFAULT_SETTINGS }

  private engine: ReviewEngine | null = null
  private lastStatus: Status | null = null
  private reviewFolder = DEFAULT_SETTINGS.reviewFolder
  private statusBarEl: HTMLElement | null = null
  private debouncer: Debouncer | null = null
  private readonly serializedRefresh = createSerializedRefresh(() =>
    this.doRefresh(),
  )

  override async onload(): Promise<void> {
    await this.loadSettings()

    this.registerView(VIEW_TYPE_REVIEW, (leaf) => new ReviewView(leaf, this))

    this.addRibbonIcon(
      'shield-check',
      'Obsidian Guardian: vault review',
      () => {
        void this.activateView()
      },
    )

    this.statusBarEl = this.addStatusBarItem()
    this.statusBarEl.addClass('mod-clickable')
    this.statusBarEl.addEventListener('click', () => {
      void this.activateView()
    })
    this.renderStatusBar()

    this.addCommand({
      id: 'open-review-panel',
      name: 'Open vault review',
      callback: () => {
        void this.activateView()
      },
    })
    this.addCommand({
      id: 'refresh',
      name: 'Refresh review',
      callback: () => {
        void this.refresh()
      },
    })
    this.addCommand({
      id: 'bless',
      name: 'Bless baseline',
      callback: () => {
        void this.bless()
      },
    })
    this.addCommand({
      id: 'rollback',
      name: 'Roll back to baseline',
      callback: () => {
        this.confirmRollback()
      },
    })

    this.addSettingTab(new GuardianSettingTab(this.app, this))

    // Keep the panel live: debounced refresh on vault changes, ignoring our own
    // review-note writes (ported from packages/cli/src/watch.ts).
    this.debouncer = createDebouncer(() => {
      void this.refresh()
    }, 300)
    this.registerEvent(
      this.app.vault.on('modify', (f) => this.onVaultEvent(f.path)),
    )
    this.registerEvent(
      this.app.vault.on('create', (f) => this.onVaultEvent(f.path)),
    )
    this.registerEvent(
      this.app.vault.on('delete', (f) => this.onVaultEvent(f.path)),
    )
    this.registerEvent(
      this.app.vault.on('rename', (f) => this.onVaultEvent(f.path)),
    )

    // Defer engine init until the workspace is ready (vault fully loaded).
    this.app.workspace.onLayoutReady(() => {
      void this.initEngine()
    })
  }

  override onunload(): void {
    this.debouncer?.cancel()
  }

  // --- ReviewController -----------------------------------------------------

  getStatus(): Status | null {
    return this.lastStatus
  }

  refresh(): Promise<void> {
    return this.serializedRefresh()
  }

  async bless(): Promise<void> {
    if (!this.engine) return
    try {
      await this.engine.bless()
      new Notice('Obsidian Guardian: baseline blessed.')
      await this.refresh()
    } catch (err) {
      this.reportError('Bless failed', err)
    }
  }

  async rollback(): Promise<void> {
    if (!this.engine) return
    try {
      await this.engine.rollback()
      new Notice('Obsidian Guardian: rolled back to baseline.')
      await this.refresh()
    } catch (err) {
      this.reportError('Rollback failed', err)
    }
  }

  async openNote(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path)
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file)
    }
  }

  // --- GuardianSettingsHost -------------------------------------------------

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  async reinit(): Promise<void> {
    await this.initEngine()
  }

  // --- internals ------------------------------------------------------------

  private async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) }
  }

  private async initEngine(): Promise<void> {
    const adapter = this.app.vault.adapter
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice('Obsidian Guardian requires a desktop vault.')
      return
    }
    try {
      const config = resolvePluginConfig({
        vaultPath: adapter.getBasePath(),
        vaultName: this.app.vault.getName(),
        settings: this.settings,
      })
      this.reviewFolder = config.reviewFolder
      const engine = new ReviewEngine(config)
      await engine.onboard()
      this.engine = engine
      await this.refresh()
    } catch (err) {
      this.engine = null
      this.reportError('Initialisation failed', err)
    }
  }

  private async doRefresh(): Promise<void> {
    if (!this.engine) return
    this.lastStatus = await this.engine.refresh()
    this.updateViews()
    this.renderStatusBar()
  }

  private onVaultEvent(path: string): void {
    if (!this.engine) return
    if (shouldIgnorePath(path, this.reviewFolder)) return
    this.debouncer?.schedule()
  }

  private confirmRollback(): void {
    if (!this.engine) return
    new ConfirmModal(this.app, {
      title: 'Roll back to baseline?',
      body: 'This restores every file in the vault to the last blessed baseline and discards all pending changes. This cannot be undone from here.',
      cta: 'Roll back',
      onConfirm: () => {
        void this.rollback()
      },
    }).open()
  }

  private async activateView(): Promise<void> {
    const { workspace } = this.app
    const existing = workspace.getLeavesOfType(VIEW_TYPE_REVIEW)
    if (existing.length > 0 && existing[0]) {
      workspace.revealLeaf(existing[0])
      return
    }
    const leaf = workspace.getLeaf(true) // a new main-area tab (vault-wide review)
    await leaf.setViewState({ type: VIEW_TYPE_REVIEW, active: true })
    workspace.revealLeaf(leaf)
  }

  private updateViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_REVIEW)) {
      const view = leaf.view
      if (view instanceof ReviewView) view.update()
    }
  }

  private renderStatusBar(): void {
    if (!this.statusBarEl) return
    const status = this.lastStatus
    if (!status) {
      this.statusBarEl.setText('OG: —')
      return
    }
    const n = status.changes.length
    this.statusBarEl.setText(status.clean ? 'OG: clean' : `OG: ${n} pending`)
  }

  private reportError(context: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[obsidian-guardian] ${context}:`, err)
    new Notice(`Obsidian Guardian: ${context} — ${message}`)
  }
}
