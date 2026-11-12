import { describe, expect, it } from 'vitest'
import {
  HERMES_INTERFACE, HERMES_RECORD_SINCE, HERMES_SANDBOX_HOLD, HERMES_TERMINAL_RECORD, HERMES_TERMINAL_SAID, HERMES_VERSION,
} from './contract.js'

describe('Hermes contract', () => {
  it('reads the three numbers of a Hermes version, and none of an unknown one', () => {
    expect(HERMES_VERSION.output.exec('Hermes Agent v0.23.1 (2026.11.11)')?.slice(1, 4)).toEqual(['0', '23', '1'])
    expect(HERMES_VERSION.output.exec('Hermes Agent v0.21.6 (2026.9.24) · upstream 1a2b3c4')?.slice(1, 4)).toEqual(['0', '21', '6'])
    expect(HERMES_VERSION.output.exec('Hermes Agent vunknown (2026.9.24)')).toBeNull()
    expect(HERMES_VERSION.output.exec('1.0.0')).toBeNull()
    expect(HERMES_RECORD_SINCE).toEqual([0, 21, 6])
  })

  it('declares the record Hermes keeps per terminal', () => {
    expect(HERMES_TERMINAL_RECORD).toMatchObject({ directory: 'terminal-sessions', maxBytes: 4096, keep: 120, session: 'session_id', time: 'ts' })
    expect(HERMES_TERMINAL_RECORD.names).toEqual([{ of: 'tty', prefix: 'tty-' }, { of: 'tmuxPane', prefix: 'tmux_pane-' }])
    expect('dev/pts/3'.replace(HERMES_TERMINAL_RECORD.unsafe, '-')).toBe('dev-pts-3')
    expect(HERMES_TERMINAL_RECORD.id.test('local-' + 'a'.repeat(64))).toBe(true)
  })

  it('declares where a home says which interface it starts', () => {
    expect(HERMES_INTERFACE).toEqual({ file: 'config.yaml', section: 'display', key: 'interface', tui: 'tui', maxBytes: 1 << 20 })
  })

  it('says what the spec says', () => {
    expect(HERMES_SANDBOX_HOLD).toBe('Hermes runs in a sandbox whose folder Harness cannot see')
    expect(HERMES_TERMINAL_SAID.sandbox).toBe('hermes runs in a sandbox · followed from its terminal record')
    expect(HERMES_TERMINAL_SAID.fallback).toBe('hermes keeps no terminal record · its session switches are not followed')
    expect(HERMES_TERMINAL_SAID.ignored('malformed')).toBe('hermes terminal record ignored · malformed')
  })
})
