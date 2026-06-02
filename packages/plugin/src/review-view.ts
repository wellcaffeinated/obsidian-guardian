import { ItemView, setIcon, type WorkspaceLeaf } from 'obsidian'
import type { CheckpointRow, FileRow, PanelData } from './format'

/** The Obsidian view-type id for the vault-review panel (opened as a main tab). */
export const VIEW_TYPE_REVIEW = 'obsidian-guardian-review'

/**
 * What the {@link ReviewView} needs from its host (the plugin): the current
 * panel data plus the mutating actions. Kept as an interface so the view never
 * imports the plugin (no cycle) and stays driven by plain data.
 */
export interface ReviewController {
  /** The current panel view-model (recomputed by the host after each action). */
  getData(): PanelData
  /** Activate reviewing on this device (first-time onboard). */
  activate(): Promise<void>
  /** Recompute the timeline and re-render. */
  refresh(): Promise<void>
  /** Freeze the working tree into a device-local checkpoint. */
  checkpoint(): Promise<void>
  /** Approve the working tree as the new baseline (publishes a bless). */
  bless(): Promise<void>
  /** Discard all pending changes, restoring the working tree to the baseline. */
  rollback(): Promise<void>
  /** Restore a single path to its baseline content. */
  revert(path: string): Promise<void>
  /** Restore the whole working tree to a checkpoint commit. */
  restoreCheckpoint(oid: string): Promise<void>
  /** Open a vault file in a new pane. */
  openFile(path: string): void
}

const KIND_ABBR: Record<FileRow['kind'], string> = {
  add: 'ADD',
  modify: 'MOD',
  delete: 'DEL',
  rename: 'REN',
}

/** Format an ISO time as a short, human local string (best-effort). */
function formatWhen(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** The vault-wide review panel, rendered from the host {@link ReviewController}. */
export class ReviewView extends ItemView {
  private readonly controller: ReviewController
  /** Expanded checkpoint oids (collapsed by default). */
  private readonly open = new Set<string>()

  constructor(leaf: WorkspaceLeaf, controller: ReviewController) {
    super(leaf)
    this.controller = controller
  }

  getViewType(): string {
    return VIEW_TYPE_REVIEW
  }

  getDisplayText(): string {
    return 'Guardian'
  }

  getIcon(): string {
    return 'shield-check'
  }

  override async onOpen(): Promise<void> {
    this.render()
  }

  /** Re-render from the host's current data. Called by the plugin after actions. */
  update(): void {
    this.render()
  }

  private render(): void {
    const data = this.controller.getData()
    const root = this.contentEl
    root.empty()
    root.addClass('og')
    this.renderHeader(root, data)

    if (!data.active) {
      this.renderInactive(root)
      this.renderFooter(root)
      return
    }

    this.renderToolbar(root)
    this.renderCurrent(root, data)

    if (data.checkpoints.length || data.baseline) {
      root.createDiv({ cls: 'og-history-label', text: 'History' })
      const list = root.createDiv({ cls: 'og-timeline' })
      for (const cp of data.checkpoints) this.renderCheckpoint(list, cp)
      if (data.baseline) this.renderBaseline(list, data.baseline)
    }
    this.renderFooter(root)
  }

  private renderHeader(root: HTMLElement, data: PanelData): void {
    const header = root.createDiv({ cls: 'og-header' })
    const title = header.createDiv({ cls: 'og-title' })
    setIcon(title.createSpan({ cls: 'og-title__icon' }), 'shield-check')
    title.createSpan({ cls: 'og-title__text', text: 'Vault review' })
    if (data.peers && data.peers.count > 0) {
      header.createDiv({
        cls: 'og-peers',
        text: `${data.peers.count} ${data.peers.count === 1 ? 'device' : 'devices'} · updated ${formatWhen(data.peers.updatedAt)}`,
      })
    }
  }

  private renderInactive(root: HTMLElement): void {
    const card = root.createDiv({ cls: 'og-entry og-entry--current' })
    const body = card.createDiv({ cls: 'og-entry__body' })
    body.createDiv({
      cls: 'og-compare',
      text: 'Reviewing is not active on this device yet.',
    })
    body.createDiv({
      cls: 'og-footer',
      text: 'Activating starts a private, device-local change history (stored outside the vault, never synced). You can then review, checkpoint, and bless changes here.',
    })
    const actions = body.createDiv({ cls: 'og-entry__actions' })
    this.button(
      actions,
      'play',
      'Start reviewing on this device',
      () => {
        void this.controller.activate()
      },
      'cta',
    )
  }

  private renderToolbar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: 'og-toolbar' })
    this.button(bar, 'refresh-cw', 'Refresh', () => {
      void this.controller.refresh()
    })
    this.button(bar, 'camera', 'Checkpoint', () => {
      void this.controller.checkpoint()
    })
  }

  // --- current: live state, no hash, always expanded ------------------------

  private renderCurrent(parent: HTMLElement, data: PanelData): void {
    const card = parent.createDiv({ cls: 'og-entry og-entry--current' })
    const head = card.createDiv({
      cls: 'og-entry__head og-entry__head--static',
    })
    this.renderTitle(head, 'Current', 'current', 'live')

    const body = card.createDiv({ cls: 'og-entry__body' })
    if (data.current.length === 0) {
      body.createDiv({
        cls: 'og-compare',
        text: 'Nothing pending — the working tree matches the baseline.',
      })
      return
    }
    this.renderCompare(
      body,
      'baseline..current',
      `${data.current.length} file${data.current.length === 1 ? '' : 's'} changed`,
    )
    for (const change of data.current) this.renderFileRow(body, change, true)

    const actions = body.createDiv({ cls: 'og-entry__actions' })
    this.button(
      actions,
      'check-check',
      'Accept as Baseline',
      () => {
        void this.controller.bless()
      },
      'cta',
    )
    this.button(
      actions,
      'undo-2',
      'Undo these changes',
      () => {
        void this.controller.rollback()
      },
      'warn',
    )
  }

  // --- checkpoint: frozen snapshot, collapsible -----------------------------

  private renderCheckpoint(parent: HTMLElement, cp: CheckpointRow): void {
    const isOpen = this.open.has(cp.oid)
    const card = parent.createDiv({ cls: 'og-entry og-entry--history' })
    const head = card.createDiv({ cls: 'og-entry__head' })
    setIcon(
      head.createSpan({ cls: 'og-entry__caret' }),
      isOpen ? 'chevron-down' : 'chevron-right',
    )
    this.renderTitle(head, 'Checkpoint', 'checkpoint', formatWhen(cp.when))
    head.createSpan({ cls: 'og-entry__hash', text: cp.shortHash })
    head.addEventListener('click', () => this.toggle(cp.oid))
    if (!isOpen) return

    const body = card.createDiv({ cls: 'og-entry__body' })
    if (cp.changes.length === 0) {
      body.createDiv({
        cls: 'og-compare',
        text: 'No changes since this checkpoint — identical to current.',
      })
      return
    }
    this.renderCompare(
      body,
      `${cp.shortHash}..current`,
      'Restore reverts these files',
    )
    for (const change of cp.changes) this.renderFileRow(body, change, false)
    const actions = body.createDiv({ cls: 'og-entry__actions' })
    this.button(
      actions,
      'rotate-ccw',
      'Restore this checkpoint',
      () => {
        void this.controller.restoreCheckpoint(cp.oid)
      },
      'warn',
    )
  }

  // --- baseline: slim, non-expandable time marker ---------------------------

  private renderBaseline(
    parent: HTMLElement,
    baseline: NonNullable<PanelData['baseline']>,
  ): void {
    const marker = parent.createDiv({ cls: 'og-marker' })
    marker.createSpan({ cls: 'og-kind og-kind--baseline', text: 'Baseline' })
    marker.createSpan({
      cls: 'og-marker__when',
      text: `— ${formatWhen(baseline.when)}`,
    })
    marker.createSpan({ cls: 'og-marker__hash', text: baseline.shortHash })
    marker.createDiv({ cls: 'og-marker__rule' })
  }

  // --- shared bits ----------------------------------------------------------

  private renderTitle(
    head: HTMLElement,
    kind: string,
    kindCls: string,
    when: string,
  ): void {
    const title = head.createSpan({ cls: 'og-entry__title' })
    title.createSpan({ cls: `og-kind og-kind--${kindCls}`, text: kind })
    if (when) title.createSpan({ cls: 'og-entry__when', text: ` — ${when}` })
  }

  private renderCompare(
    parent: HTMLElement,
    range: string,
    note: string,
  ): void {
    const row = parent.createDiv({ cls: 'og-compare' })
    row.createSpan({ cls: 'og-compare__range', text: range })
    row.createSpan({ cls: 'og-compare__note', text: `· ${note}` })
  }

  private renderFileRow(
    parent: HTMLElement,
    change: FileRow,
    revertable: boolean,
  ): void {
    const wrap = parent.createDiv({ cls: 'og-file' })
    const row = wrap.createDiv({ cls: 'og-file__row' })
    row.createSpan({ cls: 'og-file__caret og-file__caret--none' })
    row.createSpan({
      cls: `og-badge og-badge--${change.kind}`,
      text: KIND_ABBR[change.kind],
    })

    const path = row.createSpan({ cls: 'og-file__path' })
    if (change.dir) path.createSpan({ cls: 'og-file__dir', text: change.dir })
    path.createSpan({ cls: 'og-file__name', text: change.name })
    if (change.markdown) {
      path.addClass('og-file__path--link')
      path.addEventListener('click', () =>
        this.controller.openFile(change.path),
      )
    }

    const stats = row.createSpan({ cls: 'og-file__stats', text: change.stats })

    if (revertable) {
      const revert = row.createSpan({
        cls: 'og-file__revert',
        attr: { 'aria-label': 'Revert this file to baseline' },
      })
      setIcon(revert, 'undo-2')
      revert.addEventListener('click', () => {
        void this.controller.revert(change.path)
      })
    }
    void stats
  }

  private renderFooter(root: HTMLElement): void {
    root.createDiv({
      cls: 'og-footer',
      text: 'Checkpoints are stored on this device only and never synced. Blessing the baseline is coordinated across your devices.',
    })
  }

  private toggle(key: string): void {
    if (this.open.has(key)) this.open.delete(key)
    else this.open.add(key)
    this.render()
  }

  private button(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick?: () => void,
    variant?: 'cta' | 'warn',
  ): void {
    const btn = parent.createEl('button', {
      cls: `og-btn${variant ? ` og-btn--${variant}` : ''}`,
    })
    setIcon(btn.createSpan({ cls: 'og-btn__icon' }), icon)
    btn.createSpan({ text: label })
    if (onClick) btn.addEventListener('click', onClick)
  }
}
