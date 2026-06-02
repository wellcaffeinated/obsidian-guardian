import { Plugin } from 'obsidian'
import { ReviewView, VIEW_TYPE_REVIEW } from './review-view'

/**
 * Phase G stub: registers the review panel and opens it. The panel renders the
 * envisioned design from mock data — no engine, no git, no coordination yet.
 * Commands mirror the names the screenshot/smoke harness drives
 * (`open-review-panel`, `activate`, `refresh`).
 */
export default class ObsidianGuardianPlugin extends Plugin {
  override async onload(): Promise<void> {
    this.registerView(VIEW_TYPE_REVIEW, (leaf) => new ReviewView(leaf))

    this.addRibbonIcon(
      'shield-check',
      'Obsidian Guardian: vault review',
      () => {
        void this.openPanel()
      },
    )

    this.addCommand({
      id: 'open-review-panel',
      name: 'Open vault review',
      callback: () => {
        void this.openPanel()
      },
    })
    this.addCommand({
      id: 'activate',
      name: 'Start reviewing on this device',
      callback: () => {
        void this.openPanel()
      },
    })
    this.addCommand({
      id: 'refresh',
      name: 'Refresh review',
      callback: () => {
        this.rerender()
      },
    })
  }

  private async openPanel(): Promise<void> {
    const { workspace } = this.app
    const existing = workspace.getLeavesOfType(VIEW_TYPE_REVIEW)
    if (existing.length > 0 && existing[0]) {
      workspace.revealLeaf(existing[0])
      return
    }
    const leaf = workspace.getLeaf(true)
    await leaf.setViewState({ type: VIEW_TYPE_REVIEW, active: true })
    workspace.revealLeaf(leaf)
  }

  private rerender(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_REVIEW)) {
      const view = leaf.view
      if (view instanceof ReviewView) view.update()
    }
  }
}
