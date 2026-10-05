/**
 * pair/protocol.ts — the helpers every layer shares: the daemon-id shape (the same one the roster
 * generator enforces), the status-line text clamp, and the bounded string read.
 */
import { describe, expect, it } from 'vitest'
import { DAEMON_IN_TYPES, DAEMON_OUT_TYPES, isDenyClass, isPairDaemonId, statusText, str } from './protocol.js'
import { PAIR_ROSTER } from './roster.g.js'

describe('isPairDaemonId', () => {
  it('accepts every id the roster ships', () => {
    for (const daemon of PAIR_ROSTER.daemons) expect(isPairDaemonId(daemon.id)).toBe(true)
  })

  it('accepts a lowercase id of 1..16 characters that starts with a letter', () => {
    expect(isPairDaemonId('a')).toBe(true)
    expect(isPairDaemonId('a-b-9')).toBe(true)
    expect(isPairDaemonId('a'.repeat(16))).toBe(true)
  })

  it('refuses anything else: not a string, too long, a digit or dash first, upper case, a path, a newline', () => {
    for (const bad of [undefined, null, 7, {}, ['tim'], '', 'a'.repeat(17), '9lives', '-tim', 'Tim', 'tim/../x', 'tim\n', 'ti m', 'tïm']) {
      expect(isPairDaemonId(bad)).toBe(false)
    }
  })
})

describe('statusText', () => {
  it('flattens to one printable ASCII line and collapses runs of space', () => {
    expect(statusText('  a\r\nb\t\tc   d \u001b[31m eé ', 50)).toBe('a b c d [31m e')
  })

  it('cuts past max with a marker, keeping the whole within max', () => {
    const out = statusText('x'.repeat(100), 20)
    expect(out).toBe(`${'x'.repeat(17)}...`)
    expect(out.length).toBe(20)
  })

  it('never goes negative on a tiny max', () => {
    expect(statusText('abcdef', 2)).toBe('...')
    expect(statusText('abc', 3)).toBe('abc')
  })
})

describe('str', () => {
  it('reads a string, bounded; anything else is empty', () => {
    expect(str('hello', 3)).toBe('hel')
    expect(str('x'.repeat(300))).toHaveLength(200)
    expect(str(42)).toBe('')
    expect(str(null)).toBe('')
    expect(str({ toString: () => 'no' })).toBe('')
  })
})

describe('the frame sets', () => {
  it('keep what the daemon sends locally apart from what it takes locally', () => {
    for (const type of DAEMON_OUT_TYPES) expect(DAEMON_IN_TYPES.has(type)).toBe(false)
    expect([...DAEMON_IN_TYPES].every((type) => type.startsWith('daemon_'))).toBe(true)
    expect([...DAEMON_OUT_TYPES].every((type) => type.startsWith('daemon_'))).toBe(true)
  })

  it('re-exports the one deny-class rule', () => {
    expect(isDenyClass('Bash command\n\n  git push origin main\n\nDo you want to proceed?', ['Yes', 'No'])).toBe(true)
  })
})
