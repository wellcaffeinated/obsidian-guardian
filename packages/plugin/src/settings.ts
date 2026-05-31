import { type App, type Plugin, PluginSettingTab, Setting } from 'obsidian'
import type { PluginSettings } from './config'

/** What the settings tab needs from the plugin. */
export interface GuardianSettingsHost {
  settings: PluginSettings
  /** Persist the current settings (cheap; called on every edit). */
  saveSettings(): Promise<void>
  /** Rebuild the engine + refresh from the current settings (called on close). */
  reinit(): Promise<void>
}

/** Settings tab: configure ignores, marker, author, review folder, and gitDir. */
export class GuardianSettingTab extends PluginSettingTab {
  private readonly host: GuardianSettingsHost

  constructor(app: App, plugin: Plugin & GuardianSettingsHost) {
    super(app, plugin)
    this.host = plugin
  }

  display(): void {
    const { containerEl } = this
    const { settings } = this.host
    containerEl.empty()

    const persist = (mutate: () => void): void => {
      mutate()
      void this.host.saveSettings()
    }

    new Setting(containerEl)
      .setName('Review folder')
      .setDesc(
        'Vault-relative folder for the generated changes note. Git-ignored, sync-synced.',
      )
      .addText((text) =>
        text
          .setPlaceholder('_OG')
          .setValue(settings.reviewFolder)
          .onChange((value) => persist(() => (settings.reviewFolder = value))),
      )

    new Setting(containerEl)
      .setName('Baseline marker')
      .setDesc(
        'Branch name used as the advanceable "last blessed state" marker.',
      )
      .addText((text) =>
        text
          .setPlaceholder('baseline')
          .setValue(settings.markerRef)
          .onChange((value) => persist(() => (settings.markerRef = value))),
      )

    new Setting(containerEl)
      .setName('Git database path')
      .setDesc(
        'Where the git history lives — must be OUTSIDE the vault. Leave empty to use a per-vault folder under your OS app-data.',
      )
      .addText((text) =>
        text
          .setPlaceholder('auto (app-data)')
          .setValue(settings.gitDir)
          .onChange((value) => persist(() => (settings.gitDir = value))),
      )

    new Setting(containerEl)
      .setName('Extra ignore globs')
      .setDesc(
        'One glob per line (or comma-separated), appended to the managed ignore list.',
      )
      .addTextArea((area) =>
        area
          .setPlaceholder('drafts/\n*.tmp')
          .setValue(settings.ignore)
          .onChange((value) => persist(() => (settings.ignore = value))),
      )

    new Setting(containerEl)
      .setName('Commit author name')
      .setDesc(
        'Recorded when the baseline is blessed. Leave empty for the default.',
      )
      .addText((text) =>
        text
          .setValue(settings.authorName)
          .onChange((value) => persist(() => (settings.authorName = value))),
      )

    new Setting(containerEl)
      .setName('Commit author email')
      .addText((text) =>
        text
          .setValue(settings.authorEmail)
          .onChange((value) => persist(() => (settings.authorEmail = value))),
      )

    new Setting(containerEl)
      .setName('Replica id')
      .setDesc(
        'Advanced: overrides the per-replica review-note filename. Leave empty to use the id persisted in the git database.',
      )
      .addText((text) =>
        text
          .setPlaceholder('auto')
          .setValue(settings.replicaId)
          .onChange((value) => persist(() => (settings.replicaId = value))),
      )
  }

  override hide(): void {
    // Rebuild the engine once, when the user leaves the settings tab, rather
    // than on every keystroke.
    void this.host.reinit()
  }
}
