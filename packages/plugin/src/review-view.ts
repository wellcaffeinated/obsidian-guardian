import { ItemView, setIcon } from 'obsidian'

/** The Obsidian view-type id for the vault-review panel (opened as a main tab). */
export const VIEW_TYPE_REVIEW = 'obsidian-guardian-review'

// ---------------------------------------------------------------------------
// MOCK DATA — Phase G stub. Detached from the engine.
//
// Model: one time-ordered timeline (newest first).
//   • CURRENT = live vault, no hash; diff "baseline..current"; Accept / Undo.
//     The Checkpoint button freezes current into a hashed checkpoint inserted
//     right below the current row (current itself never changes).
//   • CHECKPOINT = frozen snapshot; expand → diff "<hash>..current"; Restore.
//   • BASELINE = last blessed checkpoint, a non-expandable time marker.
// ---------------------------------------------------------------------------

type ChangeKind = 'add' | 'modify' | 'delete'

interface FileChange {
  kind: ChangeKind
  path: string
  added: number
  removed: number
  diff?: Array<{ sign: ' ' | '+' | '-'; text: string }>
}

type Entry =
  | { type: 'current'; when: string; changes: FileChange[] }
  | { type: 'checkpoint'; when: string; hash: string; since: FileChange[] }
  | { type: 'baseline'; when: string; hash: string }

const INITIAL: Entry[] = [
  {
    type: 'current',
    when: 'Today, 14:42',
    changes: [
      {
        kind: 'modify',
        path: 'Projects/Roastery.md',
        added: 12,
        removed: 3,
        diff: [
          { sign: ' ', text: '## Roadmap' },
          { sign: '-', text: '- [ ] pick a grinder' },
          { sign: '+', text: '- [x] pick a grinder (Niche Zero)' },
          { sign: '+', text: '- [ ] dial in espresso' },
          { sign: ' ', text: '' },
          { sign: '+', text: 'See [[p2p-bless]] for the sync model.' },
        ],
      },
      { kind: 'add', path: 'Daily/2026-06-01.md', added: 40, removed: 0 },
      { kind: 'modify', path: 'Ideas/p2p-bless.md', added: 5, removed: 5 },
      {
        kind: 'modify',
        path: 'attachments/diagram.canvas',
        added: 1,
        removed: 1,
      },
      { kind: 'delete', path: 'Archive/old-note.md', added: 0, removed: 88 },
    ],
  },
  {
    type: 'checkpoint',
    when: 'Today, 14:30',
    hash: '9f3a1c2',
    since: [
      { kind: 'modify', path: 'Projects/Roastery.md', added: 1, removed: 0 },
      { kind: 'modify', path: 'Daily/2026-06-01.md', added: 12, removed: 0 },
    ],
  },
  { type: 'baseline', when: 'Today, 14:15', hash: '7e2b8d1' },
  {
    type: 'checkpoint',
    when: 'Yesterday, 22:10',
    hash: '3c4c845',
    since: [
      { kind: 'modify', path: 'Projects/Roastery.md', added: 12, removed: 3 },
      { kind: 'add', path: 'Daily/2026-06-01.md', added: 40, removed: 0 },
      { kind: 'modify', path: 'Ideas/p2p-bless.md', added: 5, removed: 5 },
      { kind: 'delete', path: 'Archive/old-note.md', added: 0, removed: 88 },
    ],
  },
]

const MOCK = { peers: 2, updatedAgo: '2 min ago' }

const KIND_ABBR: Record<ChangeKind, string> = {
  add: 'ADD',
  modify: 'MOD',
  delete: 'DEL',
}

/** A vault-wide review panel (Phase G design stub, mock data only). */
export class ReviewView extends ItemView {
  private timeline: Entry[] = INITIAL.map((e) => ({ ...e }))
  private readonly open = new Set<string>(['9f3a1c2'])

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

  update(): void {
    this.render()
  }

  private render(): void {
    const root = this.contentEl
    root.empty()
    root.addClass('og')
    this.renderHeader(root)
    this.renderToolbar(root)

    // Current is always first; everything after it is "history".
    const [current, ...history] = this.timeline
    if (current && current.type === 'current') this.renderCurrent(root, current)

    if (history.length) {
      root.createDiv({ cls: 'og-history-label', text: 'History' })
      const list = root.createDiv({ cls: 'og-timeline' })
      for (const entry of history) {
        if (entry.type === 'baseline') this.renderBaseline(list, entry)
        else if (entry.type === 'checkpoint') this.renderCheckpoint(list, entry)
      }
    }
    this.renderFooter(root)
  }

  private renderHeader(root: HTMLElement): void {
    const header = root.createDiv({ cls: 'og-header' })
    const title = header.createDiv({ cls: 'og-title' })
    setIcon(title.createSpan({ cls: 'og-title__icon' }), 'shield-check')
    title.createSpan({ cls: 'og-title__text', text: 'Vault review' })
    header.createDiv({
      cls: 'og-peers',
      text: `${MOCK.peers} peers · updated ${MOCK.updatedAgo}`,
    })
  }

  private renderToolbar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: 'og-toolbar' })
    this.button(bar, 'refresh-cw', 'Refresh', () => this.update())
    this.button(bar, 'camera', 'Checkpoint', () => this.doCheckpoint())
  }

  /** Freeze current into a hashed checkpoint inserted right below current. */
  private doCheckpoint(): void {
    const hash = Math.random().toString(16).slice(2, 9)
    this.timeline.splice(1, 0, {
      type: 'checkpoint',
      when: 'Today, 14:42',
      hash,
      since: [],
    })
    this.render()
  }

  // --- current: live state, no hash, always expanded ------------------------

  private renderCurrent(
    parent: HTMLElement,
    entry: Extract<Entry, { type: 'current' }>,
  ): void {
    const card = parent.createDiv({ cls: 'og-entry og-entry--current' })
    const head = card.createDiv({
      cls: 'og-entry__head og-entry__head--static',
    })
    this.renderTitle(head, 'Current', 'current', entry.when)

    const body = card.createDiv({ cls: 'og-entry__body' })
    this.renderCompare(
      body,
      'baseline..current',
      `${entry.changes.length} files changed`,
    )
    for (const change of entry.changes) this.renderFileRow(body, change, true)

    const actions = body.createDiv({ cls: 'og-entry__actions' })
    this.button(actions, 'check-check', 'Accept as Baseline', undefined, 'cta')
    this.button(actions, 'undo-2', 'Undo these changes', undefined, 'warn')
  }

  // --- checkpoint: frozen snapshot, collapsible -----------------------------

  private renderCheckpoint(
    parent: HTMLElement,
    entry: Extract<Entry, { type: 'checkpoint' }>,
  ): void {
    const isOpen = this.open.has(entry.hash)
    const card = parent.createDiv({ cls: 'og-entry og-entry--history' })
    const head = card.createDiv({ cls: 'og-entry__head' })
    setIcon(
      head.createSpan({ cls: 'og-entry__caret' }),
      isOpen ? 'chevron-down' : 'chevron-right',
    )
    this.renderTitle(head, 'Checkpoint', 'checkpoint', entry.when)
    head.createSpan({ cls: 'og-entry__hash', text: entry.hash })
    head.addEventListener('click', () => this.toggle(entry.hash))
    if (!isOpen) return

    const body = card.createDiv({ cls: 'og-entry__body' })
    if (entry.since.length === 0) {
      body.createDiv({
        cls: 'og-compare',
        text: 'No changes since this checkpoint — identical to current.',
      })
      return
    }
    this.renderCompare(
      body,
      `${entry.hash}..current`,
      'Restore reverts these files',
    )
    for (const change of entry.since) this.renderFileRow(body, change, false)
    const actions = body.createDiv({ cls: 'og-entry__actions' })
    this.button(
      actions,
      'rotate-ccw',
      'Restore this checkpoint',
      undefined,
      'warn',
    )
  }

  // --- baseline: slim, non-expandable time marker ---------------------------

  private renderBaseline(
    parent: HTMLElement,
    entry: Extract<Entry, { type: 'baseline' }>,
  ): void {
    const marker = parent.createDiv({ cls: 'og-marker' })
    marker.createSpan({ cls: 'og-kind og-kind--baseline', text: 'Baseline' })
    marker.createSpan({ cls: 'og-marker__when', text: `— ${entry.when}` })
    marker.createSpan({ cls: 'og-marker__hash', text: entry.hash })
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
    title.createSpan({ cls: 'og-entry__when', text: ` — ${when}` })
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
    change: FileChange,
    revertable: boolean,
  ): void {
    const wrap = parent.createDiv({ cls: 'og-file' })
    const row = wrap.createDiv({ cls: 'og-file__row' })

    if (change.diff) {
      setIcon(row.createSpan({ cls: 'og-file__caret' }), 'chevron-down')
    } else {
      row.createSpan({ cls: 'og-file__caret og-file__caret--none' })
    }

    row.createSpan({
      cls: `og-badge og-badge--${change.kind}`,
      text: KIND_ABBR[change.kind],
    })

    const path = row.createSpan({ cls: 'og-file__path' })
    const parts = change.path.split('/')
    const name = parts.pop() ?? change.path
    if (parts.length) {
      path.createSpan({ cls: 'og-file__dir', text: `${parts.join('/')}/` })
    }
    path.createSpan({ cls: 'og-file__name', text: name })

    const stats = row.createSpan({ cls: 'og-file__stats' })
    if (change.added)
      stats.createSpan({ cls: 'og-stat-add', text: `+${change.added}` })
    if (change.removed)
      stats.createSpan({ cls: 'og-stat-del', text: `−${change.removed}` })

    if (revertable) {
      const revert = row.createSpan({
        cls: 'og-file__revert',
        attr: { 'aria-label': 'Revert this file to baseline' },
      })
      setIcon(revert, 'undo-2')
    }

    if (change.diff) {
      const diff = wrap.createDiv({ cls: 'og-diff' })
      for (const line of change.diff) {
        diff.createDiv({
          cls: `og-diff__line og-diff__line--${line.sign === '+' ? 'add' : line.sign === '-' ? 'del' : 'ctx'}`,
          text: `${line.sign} ${line.text}`,
        })
      }
    }
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
