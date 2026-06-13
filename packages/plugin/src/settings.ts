import { type Plugin, PluginSettingTab, Setting } from 'obsidian'
import type { PluginSettings } from './config'

/** Host the plugin must satisfy for the settings tab (avoids importing main.ts). */
export interface SettingsHost {
  settings: PluginSettings
  /** Persist settings and rebuild the engine with the new config. */
  saveAndReload(): Promise<void>
}

/**
 * The plugin's settings tab. Edits the persisted {@link PluginSettings}; on
 * `hide()` (panel closed) it persists and rebuilds the engine so changes to
 * paths/ignores/author take effect without a reload.
 */
export class GuardianSettingTab extends PluginSettingTab {
  private readonly host: SettingsHost

  constructor(plugin: Plugin & SettingsHost) {
    super(plugin.app, plugin)
    this.host = plugin
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()
    const s = this.host.settings

    new Setting(containerEl)
      .setName('Git database folder')
      .setDesc(
        'Where the device-local git history lives. Must be OUTSIDE the vault (it must never sync). Empty = a per-machine app-data folder.',
      )
      .addText((t) =>
        t
          .setPlaceholder('(app-data default)')
          .setValue(s.gitDir)
          .onChange((v) => {
            s.gitDir = v
          }),
      )

    new Setting(containerEl)
      .setName('Review folder')
      .setDesc('Vault-relative folder for sync signals (git-ignored).')
      .addText((t) =>
        t.setValue(s.reviewFolder).onChange((v) => {
          s.reviewFolder = v
        }),
      )

    new Setting(containerEl)
      .setName('Baseline marker')
      .setDesc('Branch name used as the advanceable "last blessed" marker.')
      .addText((t) =>
        t.setValue(s.markerRef).onChange((v) => {
          s.markerRef = v
        }),
      )

    new Setting(containerEl)
      .setName('Extra ignore globs')
      .setDesc(
        'One per line (or comma-separated). Added to the managed ignores.',
      )
      .addTextArea((t) =>
        t.setValue(s.ignore).onChange((v) => {
          s.ignore = v
        }),
      )

    new Setting(containerEl)
      .setName('Bless author name')
      .setDesc('Recorded on baseline commits. Empty = engine default.')
      .addText((t) =>
        t.setValue(s.authorName).onChange((v) => {
          s.authorName = v
        }),
      )

    new Setting(containerEl).setName('Bless author email').addText((t) =>
      t.setValue(s.authorEmail).onChange((v) => {
        s.authorEmail = v
      }),
    )
  }

  override hide(): void {
    void this.host.saveAndReload()
  }
}
