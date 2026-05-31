import type { Status } from '@obsidian-guardian/engine'
import {
  type App,
  ButtonComponent,
  ItemView,
  Modal,
  Setting,
  type WorkspaceLeaf,
} from 'obsidian'
import { describeStatus, shortMarker } from './format'

/** The Obsidian view-type id for the vault-review panel (opened as a main tab). */
export const VIEW_TYPE_REVIEW = 'obsidian-guardian-review'

/**
 * Per-machine activation state. `loading` = engine still initialising;
 * `inactive` = this machine has never been activated (no local history yet),
 * so we render an explicit opt-in and touch nothing; `active` = onboarded here
 * and reviewing normally.
 */
export type ActivationState = 'loading' | 'inactive' | 'active'

/**
 * What the panel needs from the plugin. Keeps the view decoupled from the
 * concrete `Plugin` (and trivially fakeable in tests).
 */
export interface ReviewController {
  /** Whether this machine is loading / not-yet-activated / actively reviewing. */
  getActivationState(): ActivationState
  /** Explicitly begin reviewing on this machine (onboard the local history). */
  activate(): Promise<void>
  /** The latest computed status, or null before the engine has initialised. */
  getStatus(): Status | null
  /** Recompute status + rewrite the review note. */
  refresh(): Promise<void>
  /** Advance the baseline marker to the current state. */
  bless(): Promise<void>
  /** Reset the whole work-tree back to the baseline. */
  rollback(): Promise<void>
  /** Open a vault note by its vault-relative path. */
  openNote(path: string): Promise<void>
}

/** A vault-wide review panel: header + per-file change list + bless/rollback. */
export class ReviewView extends ItemView {
  private readonly controller: ReviewController

  constructor(leaf: WorkspaceLeaf, controller: ReviewController) {
    super(leaf)
    this.controller = controller
  }

  getViewType(): string {
    return VIEW_TYPE_REVIEW
  }

  getDisplayText(): string {
    return 'Vault review'
  }

  getIcon(): string {
    return 'shield-check'
  }

  override async onOpen(): Promise<void> {
    this.render()
  }

  /** Re-render from the controller's latest status (called after every refresh). */
  update(): void {
    this.render()
  }

  private render(): void {
    const root = this.contentEl
    root.empty()
    root.addClass('og-review')

    if (this.controller.getActivationState() === 'inactive') {
      this.renderInactive(root)
      return
    }

    const status = this.controller.getStatus()

    this.renderHeader(root, status)
    this.renderActions(root, status)

    if (status === null) {
      root.createDiv({ cls: 'og-review__empty', text: 'Initialising…' })
      return
    }
    if (status.clean) {
      root.createDiv({
        cls: 'og-review__empty',
        text: 'Clean — nothing pending since the last blessed baseline.',
      })
      return
    }
    this.renderList(root, status)
  }

  /**
   * The not-yet-activated state. Reviewing is opt-in *per machine* so that two
   * desktops syncing the same vault don't both silently spin up a git history
   * and emit competing review notes. Until the user clicks Activate, the plugin
   * writes nothing.
   */
  private renderInactive(root: HTMLElement): void {
    const header = root.createDiv({ cls: 'og-review__header' })
    header.createEl('h2', { text: 'Vault review' })
    header.createSpan({
      cls: 'og-review__meta',
      text: 'not active on this machine',
    })

    root.createDiv({
      cls: 'og-review__empty',
      text:
        'This machine isn’t reviewing this vault yet. Activating creates a ' +
        'local change-history stored outside the vault, on this device only, ' +
        'and starts tracking changes here. Other devices are unaffected — each ' +
        'reviews independently.',
    })

    const actions = root.createDiv({ cls: 'og-review__actions' })
    new ButtonComponent(actions)
      .setButtonText('Start reviewing on this machine')
      .setIcon('shield-check')
      .setCta()
      .onClick(() => {
        void this.controller.activate()
      })
  }

  private renderHeader(root: HTMLElement, status: Status | null): void {
    const header = root.createDiv({ cls: 'og-review__header' })
    header.createEl('h2', { text: 'Vault review' })
    if (!status) return
    const count = status.changes.length
    const summary = status.clean
      ? 'clean'
      : `${count} change${count === 1 ? '' : 's'} pending`
    header.createSpan({
      cls: 'og-review__meta',
      text: `${summary} · baseline ${shortMarker(status.marker)}`,
    })
  }

  private renderActions(root: HTMLElement, status: Status | null): void {
    const actions = root.createDiv({ cls: 'og-review__actions' })

    new ButtonComponent(actions)
      .setButtonText('Refresh')
      .setIcon('refresh-cw')
      .onClick(() => {
        void this.controller.refresh()
      })

    const bless = new ButtonComponent(actions)
      .setButtonText('Bless')
      .setIcon('check-check')
      .setCta()
      .onClick(() => {
        void this.controller.bless()
      })

    const rollback = new ButtonComponent(actions)
      .setButtonText('Roll back')
      .setIcon('rotate-ccw')
      .setWarning()
      .onClick(() => {
        new ConfirmModal(this.app, {
          title: 'Roll back to baseline?',
          body: 'This restores every file in the vault to the last blessed baseline and discards all pending changes. This cannot be undone from here.',
          cta: 'Roll back',
          onConfirm: () => {
            void this.controller.rollback()
          },
        }).open()
      })

    // Nothing to bless or roll back when clean / not yet initialised.
    const disabled = status === null || status.clean
    bless.setDisabled(disabled)
    rollback.setDisabled(disabled)
  }

  private renderList(root: HTMLElement, status: Status): void {
    const list = root.createEl('ul', { cls: 'og-review__list' })
    for (const row of describeStatus(status)) {
      const li = list.createEl('li', { cls: 'og-review__row' })
      li.createSpan({
        cls: `og-review__kind og-review__kind--${row.kind}`,
        text: row.kind,
      })
      const path = li.createSpan({ cls: 'og-review__path' })
      if (row.markdown) {
        const link = path.createEl('a', { text: row.path, href: '#' })
        link.addEventListener('click', (evt) => {
          evt.preventDefault()
          void this.controller.openNote(row.path)
        })
      } else {
        path.setText(row.path)
      }
      if (row.from) {
        path.createSpan({
          cls: 'og-review__meta',
          text: `  (from ${row.from})`,
        })
      }
      li.createSpan({ cls: 'og-review__stats', text: row.stats })
    }
  }
}

/** A minimal yes/no confirmation dialog. */
export class ConfirmModal extends Modal {
  private readonly opts: {
    title: string
    body: string
    cta: string
    onConfirm: () => void
  }

  constructor(
    app: App,
    opts: { title: string; body: string; cta: string; onConfirm: () => void },
  ) {
    super(app)
    this.opts = opts
  }

  override onOpen(): void {
    const { contentEl } = this
    contentEl.createEl('h3', { text: this.opts.title })
    contentEl.createEl('p', { text: this.opts.body })
    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText('Cancel').onClick(() => this.close()),
      )
      .addButton((btn) =>
        btn
          .setButtonText(this.opts.cta)
          .setWarning()
          .onClick(() => {
            this.close()
            this.opts.onConfirm()
          }),
      )
  }

  override onClose(): void {
    this.contentEl.empty()
  }
}
