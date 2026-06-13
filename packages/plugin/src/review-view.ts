import type { FileDiff } from '@obsidian-guardian/engine'
import {
  type App,
  ItemView,
  Modal,
  setIcon,
  type WorkspaceLeaf,
} from 'obsidian'
import { type FileRow, type PanelData, reverseFileRow } from './format'

/** The Obsidian view-type id for the vault-review panel (opened as a main tab). */
export const VIEW_TYPE_REVIEW = 'obsidian-guardian-review'

/** Collapse-state / file-row key for the single baseline entry in the timeline. */
const BASELINE_KEY = '__baseline__'

/**
 * A unified History timeline entry: either a device-local checkpoint or the
 * baseline marker. `changes` is the diff to the *current* working tree (what
 * restoring this entry would change); empty means it equals the current state.
 */
interface HistoryEntry {
  when: string | null
  isBaseline: boolean
  /** Restore target: the checkpoint commit oid (unused for the baseline). */
  oid: string
  shortHash: string
  changes: FileRow[]
}

/** Build stamp inlined by tsdown's `define` (`build-YYYYMMDD-HHMM`); falls back
 * to `dev` when running un-bundled (tests, where the global is undefined). */
declare const __OG_BUILD__: string | undefined
const BUILD_ID =
  typeof __OG_BUILD__ === 'string' && __OG_BUILD__ ? __OG_BUILD__ : 'dev'

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
  /**
   * Compute one file's line diff (base = baseline, or a checkpoint oid). Pass
   * `reverse` for the restore direction (working tree → fromRef) used by History.
   */
  fileDiff(path: string, fromRef?: string, reverse?: boolean): Promise<FileDiff>
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

/** True when two file diffs are line-for-line identical (skip a needless re-render). */
function sameDiff(a: FileDiff, b: FileDiff): boolean {
  if (a.binary !== b.binary || a.lines.length !== b.lines.length) return false
  for (let i = 0; i < a.lines.length; i++) {
    const x = a.lines[i]
    const y = b.lines[i]
    if (x?.sign !== y?.sign || x?.text !== y?.text) return false
  }
  return true
}

/** The vault-wide review panel, rendered from the host {@link ReviewController}. */
export class ReviewView extends ItemView {
  private readonly controller: ReviewController
  /**
   * Expanded checkpoint oids (collapsed by default).
   *
   * NB: must NOT be named `open` — a field called `open` on an `ItemView`
   * subclass collides with Obsidian's view machinery and silently prevents the
   * view from loading (`onOpen` never fires; the tab renders blank). This cost a
   * long debugging session; keep this name distinct from `open`.
   */
  private readonly openCheckpoints = new Set<string>()
  /** Expanded file rows, keyed `${fromRefKey}:${path}`. */
  private readonly openFiles = new Set<string>()
  /** Lazily fetched per-file diffs, keyed like {@link openFiles}. Kept across
   * reloads and re-validated in place, so refreshing never flashes "Loading…". */
  private readonly diffs = new Map<string, FileDiff>()
  /** Keys with an in-flight fileDiff fetch (so we don't double-request). */
  private readonly fetching = new Set<string>()
  /** Fetch params for each expandable row in the last render, keyed like
   * {@link openFiles} — lets {@link revalidateOpenDiffs} re-fetch open diffs. */
  private readonly fileMeta = new Map<
    string,
    { path: string; fromRef: string | undefined; reverse: boolean }
  >()

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
    // Re-render synchronously from the cached diffs first (so an open diff never
    // flashes back to "Loading…"), then quietly re-validate any expanded diffs
    // against the moved tree, re-rendering only if a *shown* diff actually
    // changed. This removes the refresh flicker when diff details are open.
    this.render()
    void this.revalidateOpenDiffs()
  }

  /** Re-fetch open diffs; swap + re-render only those whose content changed. */
  private async revalidateOpenDiffs(): Promise<void> {
    let dirty = false
    for (const key of this.openFiles) {
      if (this.fetching.has(key)) continue
      const meta = this.fileMeta.get(key)
      if (!meta) continue
      const fresh = await this.controller.fileDiff(
        meta.path,
        meta.fromRef,
        meta.reverse,
      )
      const prev = this.diffs.get(key)
      if (!prev || !sameDiff(prev, fresh)) {
        this.diffs.set(key, fresh)
        dirty = true
      }
    }
    if (dirty) this.render()
  }

  private render(): void {
    const data = this.controller.getData()
    const root = this.contentEl
    root.empty()
    this.fileMeta.clear()
    root.addClass('og')
    this.renderHeader(root, data)

    if (!data.active) {
      this.renderInactive(root)
      this.renderFooter(root)
      return
    }

    this.renderToolbar(root)
    this.renderCurrent(root, data)
    this.renderHistory(root, data)
    this.renderFooter(root)
  }

  /**
   * Render the History section: checkpoints and the baseline marker merged into
   * one timeline, newest first. A checkpoint whose content equals the baseline IS
   * the baseline, so it is collapsed into the baseline marker (not shown twice).
   *
   * Every entry shows the diff *relative to the current working tree* — what
   * restoring it would change — and the most recent entry identical to the current
   * tree is tagged "Live" (its Restore is disabled; there's nothing to restore).
   */
  private renderHistory(root: HTMLElement, data: PanelData): void {
    const { baseline } = data
    const checkpoints = baseline?.tree
      ? data.checkpoints.filter((cp) => cp.tree !== baseline.tree)
      : data.checkpoints
    if (checkpoints.length === 0 && !baseline) return

    root.createDiv({ cls: 'og-history-label', text: 'History' })
    const list = root.createDiv({ cls: 'og-timeline' })

    const entries: HistoryEntry[] = checkpoints.map((cp) => ({
      when: cp.when,
      isBaseline: false,
      oid: cp.oid,
      shortHash: cp.shortHash,
      // cp.changes is the checkpoint → working-tree diff (what restoring it does).
      changes: cp.changes,
    }))
    if (baseline) {
      entries.push({
        when: baseline.when,
        isBaseline: true,
        oid: baseline.shortHash,
        shortHash: baseline.shortHash,
        // Restoring the baseline discards the pending changes, i.e. `current`.
        changes: data.current,
      })
    }
    // Newest first; ISO-8601 UTC strings sort lexicographically.
    entries.sort((a, b) => (b.when ?? '').localeCompare(a.when ?? ''))

    // "Live" = the most recent entry whose content equals the working tree (empty
    // restore diff). Only one entry is tagged, so a stale older twin stays plain.
    const liveIdx = entries.findIndex((e) => e.changes.length === 0)
    for (const [i, entry] of entries.entries()) {
      this.renderEntry(list, entry, /* live */ i === liveIdx)
    }
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

  // --- current: live state, flat (no card), always expanded -----------------

  private renderCurrent(parent: HTMLElement, data: PanelData): void {
    const changed = data.current.length > 0
    const section = parent.createDiv({ cls: 'og-current' })
    const title = section.createDiv({ cls: 'og-current__title' })
    title.createSpan({ cls: 'og-kind og-kind--current', text: 'Current State' })
    title.createSpan({
      cls: 'og-current__status',
      text: ` — ${changed ? 'changed' : 'no changes'}`,
    })

    if (!changed) {
      section.createDiv({
        cls: 'og-compare',
        text: 'Nothing pending — the working tree matches the baseline.',
      })
      return
    }
    this.renderCompare(
      section,
      'baseline..current',
      `${data.current.length} file${data.current.length === 1 ? '' : 's'} changed`,
    )
    for (const change of data.current) {
      this.renderFileRow(section, change, 'current', undefined, true)
    }

    const actions = section.createDiv({ cls: 'og-entry__actions' })
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
        this.confirm({
          title: 'Discard all pending changes?',
          body: 'Every changed file is restored to the baseline. Edits made since the baseline are lost — your checkpoints are kept, so you can still restore from them.',
          confirmText: 'Discard changes',
          onConfirm: () => void this.controller.rollback(),
        })
      },
      'warn',
    )
  }

  /** Open a confirm dialog; runs `onConfirm` only if the user proceeds. */
  private confirm(opts: {
    title: string
    body: string
    confirmText: string
    onConfirm: () => void
  }): void {
    new ConfirmModal(this.app, opts).open()
  }

  // --- history entry: a checkpoint OR the baseline marker, collapsible -------

  /**
   * Render one timeline entry — a device-local checkpoint or the baseline marker.
   * Both show the diff to the current working tree (what restoring would change)
   * and a Restore action; the baseline restores via `rollback`, a checkpoint via
   * `restoreCheckpoint`. The `live` entry (identical to current) shows no diff and
   * a disabled Restore.
   */
  private renderEntry(
    parent: HTMLElement,
    entry: HistoryEntry,
    live: boolean,
  ): void {
    const collapseKey = entry.isBaseline ? BASELINE_KEY : entry.oid
    const isOpen = this.openCheckpoints.has(collapseKey)
    const card = parent.createDiv({
      cls: `og-entry ${entry.isBaseline ? 'og-entry--baseline' : 'og-entry--history'}`,
    })
    const head = card.createDiv({ cls: 'og-entry__head' })
    setIcon(
      head.createSpan({ cls: 'og-entry__caret' }),
      isOpen ? 'chevron-down' : 'chevron-right',
    )
    this.renderTitle(
      head,
      entry.isBaseline ? 'Baseline' : 'Checkpoint',
      entry.isBaseline ? 'baseline' : 'checkpoint',
      formatWhen(entry.when),
    )
    if (live) head.createSpan({ cls: 'og-badge og-badge--live', text: 'LIVE' })
    head.createSpan({ cls: 'og-entry__hash', text: entry.shortHash })
    head.addEventListener('click', () => this.toggle(collapseKey))
    if (!isOpen) return

    const body = card.createDiv({ cls: 'og-entry__body' })
    if (entry.changes.length === 0) {
      body.createDiv({
        cls: 'og-compare',
        text: 'Identical to the current state — nothing to restore.',
      })
    } else {
      // History entries describe a *restore*: the diff direction is
      // `current → this entry` (what restoring would apply), so the range reads
      // `current..<hash>` and each row is reversed (an add since the snapshot is a
      // delete on restore, etc.).
      this.renderCompare(
        body,
        `current..${entry.shortHash}`,
        'Restore applies these changes',
      )
      // Checkpoints diff from their own commit; the baseline diffs from the marker
      // (default fromRef = undefined). Key file rows distinctly so diffs don't mix.
      const fromRef = entry.isBaseline ? undefined : entry.oid
      const fromRefKey = entry.isBaseline ? BASELINE_KEY : entry.oid
      for (const change of entry.changes) {
        this.renderFileRow(
          body,
          reverseFileRow(change),
          fromRefKey,
          fromRef,
          false,
          /* reverse */ true,
        )
      }
    }

    const actions = body.createDiv({ cls: 'og-entry__actions' })
    this.button(
      actions,
      'rotate-ccw',
      entry.isBaseline ? 'Restore baseline' : 'Restore this checkpoint',
      () => this.confirmRestore(entry),
      'warn',
      /* disabled */ live,
    )
  }

  /** Open the confirm dialog for restoring a history entry (baseline or checkpoint). */
  private confirmRestore(entry: HistoryEntry): void {
    if (entry.isBaseline) {
      this.confirm({
        title: 'Discard all pending changes?',
        body: 'Every changed file is restored to the baseline. Edits made since the baseline are lost — your checkpoints are kept, so you can still restore from them.',
        confirmText: 'Discard changes',
        onConfirm: () => void this.controller.rollback(),
      })
    } else {
      this.confirm({
        title: 'Restore this checkpoint?',
        body: `The working tree is overwritten with checkpoint ${entry.shortHash}. Changes made since it are lost (the baseline is unchanged).`,
        confirmText: 'Restore',
        onConfirm: () => void this.controller.restoreCheckpoint(entry.oid),
      })
    }
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
    fromRefKey: string,
    fromRef: string | undefined,
    revertable: boolean,
    reverse = false,
  ): void {
    const key = `${fromRefKey}:${change.path}`
    const expandable = !change.binary
    const isOpen = expandable && this.openFiles.has(key)
    if (expandable)
      this.fileMeta.set(key, { path: change.path, fromRef, reverse })

    const wrap = parent.createDiv({ cls: 'og-file' })
    const row = wrap.createDiv({ cls: 'og-file__row' })
    if (expandable) {
      setIcon(
        row.createSpan({ cls: 'og-file__caret' }),
        isOpen ? 'chevron-down' : 'chevron-right',
      )
      row.addClass('og-file__row--expandable')
      row.addEventListener('click', () => this.toggleFile(key))
    } else {
      row.createSpan({ cls: 'og-file__caret og-file__caret--none' })
    }

    row.createSpan({
      cls: `og-badge og-badge--${change.kind}`,
      text: KIND_ABBR[change.kind],
    })

    const path = row.createSpan({ cls: 'og-file__path' })
    if (change.dir) path.createSpan({ cls: 'og-file__dir', text: change.dir })
    const name = path.createSpan({ cls: 'og-file__name', text: change.name })
    // A deleted file no longer exists in the working tree — opening it would
    // create a new empty note, so don't make it a link.
    if (change.markdown && change.kind !== 'delete') {
      name.addClass('og-file__name--link')
      name.addEventListener('click', (e) => {
        e.stopPropagation() // don't also toggle the diff
        this.controller.openFile(change.path)
      })
    }

    const stats = row.createSpan({ cls: 'og-file__stats' })
    if (change.binary) {
      stats.createSpan({ text: 'binary' })
    } else {
      if (change.added > 0) {
        stats.createSpan({ cls: 'og-stat-add', text: `+${change.added}` })
      }
      if (change.removed > 0) {
        stats.createSpan({ cls: 'og-stat-del', text: `−${change.removed}` })
      }
    }

    if (revertable) {
      const revert = row.createSpan({
        cls: 'og-file__revert',
        attr: { 'aria-label': 'Revert this file to baseline' },
      })
      setIcon(revert, 'undo-2')
      revert.addEventListener('click', (e) => {
        e.stopPropagation()
        void this.controller.revert(change.path)
      })
    }

    if (isOpen) this.renderDiff(wrap, key, change.path, fromRef, reverse)
  }

  /** Render the expanded inline diff for a file row (lazy-fetched + cached). */
  private renderDiff(
    wrap: HTMLElement,
    key: string,
    path: string,
    fromRef: string | undefined,
    reverse: boolean,
  ): void {
    const box = wrap.createDiv({ cls: 'og-diff' })
    const ctx = (text: string): void => {
      box.createDiv({ cls: 'og-diff__line og-diff__line--ctx', text })
    }
    const diff = this.diffs.get(key)
    if (!diff) {
      ctx('Loading diff…')
      this.fetchDiff(key, path, fromRef, reverse)
      return
    }
    if (diff.binary) {
      ctx('Binary file — no line diff.')
      return
    }
    if (diff.lines.length === 0) {
      ctx('No textual changes.')
      return
    }
    for (const line of diff.lines) {
      const kind = line.sign === '+' ? 'add' : line.sign === '-' ? 'del' : 'ctx'
      box.createDiv({
        cls: `og-diff__line og-diff__line--${kind}`,
        text: `${line.sign} ${line.text}`,
      })
    }
  }

  private toggleFile(key: string): void {
    if (this.openFiles.has(key)) this.openFiles.delete(key)
    else this.openFiles.add(key)
    this.render()
  }

  /** Fetch one file's diff (once), cache it, and re-render if still expanded. */
  private fetchDiff(
    key: string,
    path: string,
    fromRef: string | undefined,
    reverse: boolean,
  ): void {
    if (this.fetching.has(key) || this.diffs.has(key)) return
    this.fetching.add(key)
    void this.controller
      .fileDiff(path, fromRef, reverse)
      .then((diff) => {
        this.diffs.set(key, diff)
        if (this.openFiles.has(key)) this.render()
      })
      .finally(() => this.fetching.delete(key))
  }

  private renderFooter(root: HTMLElement): void {
    const footer = root.createDiv({ cls: 'og-footer' })
    footer.createDiv({
      text: 'Checkpoints are stored on this device only and never synced. Blessing the baseline is coordinated across your devices.',
    })
    footer.createDiv({ cls: 'og-footer__build', text: BUILD_ID })
  }

  private toggle(key: string): void {
    if (this.openCheckpoints.has(key)) this.openCheckpoints.delete(key)
    else this.openCheckpoints.add(key)
    this.render()
  }

  private button(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick?: () => void,
    variant?: 'cta' | 'warn',
    disabled = false,
  ): void {
    const btn = parent.createEl('button', {
      cls: `og-btn${variant ? ` og-btn--${variant}` : ''}`,
    })
    setIcon(btn.createSpan({ cls: 'og-btn__icon' }), icon)
    btn.createSpan({ text: label })
    if (disabled) {
      btn.disabled = true
      btn.addClass('og-btn--disabled')
    } else if (onClick) {
      btn.addEventListener('click', onClick)
    }
  }
}

/** A small Cancel/Confirm dialog gating a destructive action (rollback/restore). */
class ConfirmModal extends Modal {
  private readonly opts: {
    title: string
    body: string
    confirmText: string
    onConfirm: () => void
  }

  constructor(
    app: App,
    opts: {
      title: string
      body: string
      confirmText: string
      onConfirm: () => void
    },
  ) {
    super(app)
    this.opts = opts
  }

  override onOpen(): void {
    const { contentEl } = this
    contentEl.addClass('og-confirm')
    contentEl.createEl('h3', { text: this.opts.title })
    contentEl.createEl('p', { text: this.opts.body })
    const actions = contentEl.createDiv({ cls: 'og-confirm__actions' })
    const cancel = actions.createEl('button', { text: 'Cancel' })
    cancel.addEventListener('click', () => this.close())
    const confirm = actions.createEl('button', {
      cls: 'mod-warning',
      text: this.opts.confirmText,
    })
    confirm.addEventListener('click', () => {
      this.close()
      this.opts.onConfirm()
    })
  }

  override onClose(): void {
    this.contentEl.empty()
  }
}
