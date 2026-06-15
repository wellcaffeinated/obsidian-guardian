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
      .setName('Review folder')
      .setDesc('Vault-relative folder for sync signals (git-ignored).')
      .addText((t) =>
        t.setValue(s.reviewFolder).onChange((v) => {
          s.reviewFolder = v
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
      .setName('Diff context lines')
      .setDesc(
        'Lines of unchanged context shown above and below each changed hunk in inline diffs. Hunks separated by at most twice this many unchanged lines are shown without a break.',
      )
      .addText((t) =>
        t
          .setPlaceholder('3')
          .setValue(String(s.diffContext))
          .onChange((v) => {
            const n = parseInt(v, 10)
            if (!Number.isNaN(n) && n >= 0) s.diffContext = n
          }),
      )
  }

  override hide(): void {
    void this.host.saveAndReload()
  }
}
