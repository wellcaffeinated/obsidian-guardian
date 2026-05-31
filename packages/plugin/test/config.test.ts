import { isAbsolute } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MARKER,
  DEFAULT_REVIEW_FOLDER,
  DEFAULT_SETTINGS,
  defaultGitDir,
  type PluginSettings,
  resolvePluginConfig,
} from '../src/config'

const VAULT = '/home/me/vaults/notes'

function settings(overrides: Partial<PluginSettings> = {}): PluginSettings {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

describe('defaultGitDir', () => {
  it('lives outside the vault, is absolute, and is stable per vault path', () => {
    const a = defaultGitDir(VAULT, 'notes')
    const b = defaultGitDir(VAULT, 'notes')
    expect(a).toBe(b)
    expect(isAbsolute(a)).toBe(true)
    expect(a.startsWith(`${VAULT}/`)).toBe(false)
    expect(a).toContain('obsidian-guardian')
    expect(a).toContain('notes-')
  })

  it('differs between two vaults', () => {
    expect(defaultGitDir('/a/one', 'one')).not.toBe(
      defaultGitDir('/b/two', 'two'),
    )
  })
})

describe('resolvePluginConfig', () => {
  it('derives an app-data gitDir and engine defaults when settings are empty', () => {
    const cfg = resolvePluginConfig({
      vaultPath: VAULT,
      vaultName: 'notes',
      settings: settings(),
    })
    expect(cfg.vaultPath).toBe(VAULT)
    expect(cfg.reviewFolder).toBe(DEFAULT_REVIEW_FOLDER)
    expect(cfg.markerRef).toBe(DEFAULT_MARKER)
    expect(cfg.gitDir).toBe(defaultGitDir(VAULT, 'notes'))
    expect(cfg.ignore).toBeUndefined()
    expect(cfg.author).toBeUndefined()
    expect(cfg.replicaId).toBeUndefined()
  })

  it('applies explicit overrides', () => {
    const cfg = resolvePluginConfig({
      vaultPath: VAULT,
      vaultName: 'notes',
      settings: settings({
        gitDir: '/elsewhere/db',
        reviewFolder: 'Review',
        markerRef: 'blessed',
        ignore: 'drafts/\n*.tmp, scratch/',
        authorName: 'Agent',
        authorEmail: 'agent@example.com',
      }),
    })
    expect(cfg.gitDir).toBe('/elsewhere/db')
    expect(cfg.reviewFolder).toBe('Review')
    expect(cfg.markerRef).toBe('blessed')
    expect(cfg.ignore).toEqual(['drafts/', '*.tmp', 'scratch/'])
    expect(cfg.author).toEqual({ name: 'Agent', email: 'agent@example.com' })
    // The plugin never sets replicaId (it would sync and collide); the engine's
    // own per-gitDir persisted id provides per-machine isolation instead.
    expect(cfg.replicaId).toBeUndefined()
  })

  it('throws when the gitDir would sit inside the vault', () => {
    expect(() =>
      resolvePluginConfig({
        vaultPath: VAULT,
        vaultName: 'notes',
        settings: settings({ gitDir: `${VAULT}/.git` }),
      }),
    ).toThrow(/must live outside the vault/)
  })
})
