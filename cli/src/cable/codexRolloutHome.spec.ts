import { describe, expect, it } from 'vitest'
import { rolloutHome, takesOwner } from './codexRolloutHome.js'

const dataDir = '/Users/a/.harness/cli/data'
const TAIL = '/sessions/2026/11/16/rollout-a.jsonl'

/** `/<home>` + TAIL in exactly [bytes] UTF-8 bytes, the home mostly two-byte letters, so its length in characters is
 *  far under its length in bytes. */
const pathOfBytes = (bytes: number): { home: string; path: string } => {
  const filler = bytes - 1 - Buffer.byteLength(TAIL)
  const home = `/${'à'.repeat(Math.floor(filler / 2))}${filler % 2 ? 'a' : ''}`
  return { home, path: `${home}${TAIL}` }
}

describe('a Codex home from a rollout path', () => {
  it('accepted', () => {
    expect(rolloutHome('/h/sessions/2026/11/16/rollout-a.jsonl', dataDir)).toBe('/h')
    // The home five levels up, never the first `sessions` on the way down.
    expect(rolloutHome('/Users/a/sessions/codex/sessions/2026/11/16/rollout-a.jsonl', dataDir)).toBe('/Users/a/sessions/codex')
    expect(rolloutHome('/Users/a/Library/Application Support/orca/codex/sessions/2026/11/16/rollout-a.jsonl', dataDir))
      .toBe('/Users/a/Library/Application Support/orca/codex')
    expect(rolloutHome('/Users/nhà/.codex/sessions/2026/11/16/rollout-a.jsonl', dataDir)).toBe('/Users/nhà/.codex')
    expect(rolloutHome('/h/sessions/2026/11/16/rollout-a.jsonl', '/h/x')).toBe('/h')
    const longest = pathOfBytes(1024)
    expect(Buffer.byteLength(longest.path)).toBe(1024)
    expect(rolloutHome(longest.path, dataDir)).toBe(longest.home)
  })

  it('rejected', () => {
    const tooLong = pathOfBytes(1025).path
    expect(Buffer.byteLength(tooLong)).toBe(1025)
    expect(tooLong.length).toBeLessThan(1024)
    for (const path of [
      'h/sessions/2026/11/16/rollout-a.jsonl',
      '/h/x/../sessions/2026/11/16/rollout-a.jsonl',
      '/h//sessions/2026/11/16/rollout-a.jsonl',
      '/h/sessions/2026/11/16/rollout-a.jsonl/.',
      '/h\n/sessions/2026/11/16/rollout-a.jsonl',
      '/h\x7f/sessions/2026/11/16/rollout-a.jsonl',
      // A control character past ASCII, as a list refuses it.
      '/h\u0085/sessions/2026/11/16/rollout-a.jsonl',
      tooLong,
      `${dataDir}/sessions/2026/11/16/rollout-a.jsonl`,
      `${dataDir}/codex/sessions/2026/11/16/rollout-a.jsonl`,
      '/sessions/2026/11/16/rollout-a.jsonl',
      '/h/archived_sessions/rollout-a.jsonl',
      '/h/archived_sessions/2026/11/16/rollout-a.jsonl',
      '/h/sessions/2026/11/rollout-a.jsonl',
      '/h/sessions/26/11/16/rollout-a.jsonl',
      '/h/sessions/2026/1/16/rollout-a.jsonl',
      '/h/sessions/2026/11/16/x/rollout-a.jsonl',
      '/h/sessions/2026/11/16/session-a.jsonl',
      '/h/sessions/2026/11/16/rollout-a.json',
      '/h/sessions/2026/11/16/rollout-a.jsonl.tmp',
    ]) expect(rolloutHome(path, dataDir), JSON.stringify(path)).toBeNull()
  })

  it('owners', () => {
    const record = '/h/sessions/2026/11/16/rollout-a.jsonl'
    expect(takesOwner({ engine: 'codex', record, tty: '/dev/ttys003' })).toBe(true)
    // Codex 0.167.1's app-server and codex-acp hold the rollout with no terminal.
    expect(takesOwner({ engine: 'codex', record, tty: null })).toBe(true)
    expect(takesOwner({ engine: 'codex', record, tty: '/dev/ttys003', harness: true })).toBe(false)
    expect(takesOwner({ engine: 'codex', record, tty: null, fromArgs: true })).toBe(false)
    expect(takesOwner({ engine: 'claude', record, tty: '/dev/ttys003' })).toBe(false)
  })
})
