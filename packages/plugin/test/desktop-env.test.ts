import { isAbsolute } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultGitDir } from '../src/desktop-env'

const VAULT = '/home/me/vaults/notes'

describe('defaultGitDir (desktop)', () => {
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
