import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MARKER,
  DEFAULT_REVIEW_FOLDER,
  DEFAULT_SETTINGS,
  type PluginSettings,
  resolvePluginConfig,
} from '../src/config'

const VAULT = '/home/me/vaults/notes'
const GITDIR = '/home/me/.local/share/obsidian-guardian/notes-abc123'

function settings(overrides: Partial<PluginSettings> = {}): PluginSettings {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

describe('resolvePluginConfig', () => {
  it('uses the given gitDir and engine defaults when settings are empty', () => {
    const cfg = resolvePluginConfig({
      vaultPath: VAULT,
      gitDir: GITDIR,
      settings: settings(),
    })
    expect(cfg.vaultPath).toBe(VAULT)
    expect(cfg.gitDir).toBe(GITDIR)
    expect(cfg.reviewFolder).toBe(DEFAULT_REVIEW_FOLDER)
    expect(cfg.markerRef).toBe(DEFAULT_MARKER)
    expect(cfg.ignore).toBeUndefined()
    expect(cfg.author).toBeUndefined()
    expect(cfg.replicaId).toBeUndefined()
  })

  it('applies explicit setting overrides', () => {
    const cfg = resolvePluginConfig({
      vaultPath: VAULT,
      gitDir: '/elsewhere/db',
      settings: settings({
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

  it('accepts the mobile synthetic paths (/vault worktree + /git store)', () => {
    const cfg = resolvePluginConfig({
      vaultPath: '/vault',
      gitDir: '/git',
      settings: settings(),
    })
    expect(cfg.vaultPath).toBe('/vault')
    expect(cfg.gitDir).toBe('/git')
  })

  it('throws when the gitDir would sit inside the vault', () => {
    expect(() =>
      resolvePluginConfig({
        vaultPath: VAULT,
        gitDir: `${VAULT}/.git`,
        settings: settings(),
      }),
    ).toThrow(/must live outside the vault/)
  })
})
