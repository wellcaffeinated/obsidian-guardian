import { describe, expect, it } from 'vitest'
import { DEFAULT_REVIEW_FOLDER, resolveConfig } from '../src/config'

describe('resolveConfig', () => {
  it('defaults the git-dir to a sibling of the vault', () => {
    const c = resolveConfig({ vault: '/home/me/vault' }, {}, '/cwd')
    expect(c.vaultPath).toBe('/home/me/vault')
    expect(c.gitDir).toBe('/home/me/vault.gitdir')
    expect(c.reviewFolder).toBe(DEFAULT_REVIEW_FOLDER)
  })

  it('resolves relative paths against the cwd', () => {
    const c = resolveConfig({ vault: 'notes' }, {}, '/work')
    expect(c.vaultPath).toBe('/work/notes')
  })

  it('prefers flags over env over defaults', () => {
    const env = { OG_VAULT: '/env/vault', OG_GIT_DIR: '/env/git' }
    const c = resolveConfig({ gitDir: '/flag/git' }, env, '/cwd')
    expect(c.vaultPath).toBe('/env/vault')
    expect(c.gitDir).toBe('/flag/git')
  })

  it('rejects a git-dir inside the vault', () => {
    expect(() =>
      resolveConfig({ vault: '/v', gitDir: '/v/.git' }, {}, '/cwd'),
    ).toThrow(/outside the vault/)
  })
})
