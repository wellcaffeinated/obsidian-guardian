import { createHash, randomUUID } from 'node:crypto'
import { randomId, sha256Hex } from '@obsidian-guardian/engine'
import { describe, expect, it } from 'vitest'

/** node:crypto reference — what `replicaHash` produced before going mobile-safe. */
const nodeSha = (s: string): string =>
  createHash('sha256').update(s).digest('hex')

describe('sha256Hex', () => {
  it('matches node:crypto for known inputs', () => {
    // Empty string, the protocol fixtures, unicode, and a long string.
    const cases = [
      '',
      'a',
      'abc',
      'fixed-replica',
      'changes-022f99d6983a',
      'café — naïve façade 🔒',
      'x'.repeat(1000),
    ]
    for (const input of cases) {
      expect(sha256Hex(input)).toBe(nodeSha(input))
    }
  })

  it('matches node:crypto across random strings and lengths', () => {
    // Exercise every residue of the 64-byte block boundary (the padding path).
    for (let len = 0; len < 200; len++) {
      let s = ''
      for (let i = 0; i < len; i++) {
        s += String.fromCharCode(32 + Math.floor(Math.random() * 94))
      }
      expect(sha256Hex(s)).toBe(nodeSha(s))
    }
  })
})

describe('randomId', () => {
  it('returns a v4 UUID and is (practically) unique', () => {
    const a = randomId()
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    const ids = new Set(Array.from({ length: 1000 }, () => randomId()))
    expect(ids.size).toBe(1000)
    expect(a).not.toBe(randomUUID()) // distinct call, distinct value
  })
})
