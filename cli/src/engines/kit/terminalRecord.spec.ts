/**
 * The record Hermes keeps per terminal (`hermes_cli/terminal_breadcrumbs.py`), read from real files in a throwaway
 * home, never the person's `~/.hermes`. A sandbox controls these files: whatever it puts there is read within the
 * limit or not at all.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HERMES_HISTORY_ID_RE } from '../hermes/contract.js'
import { readTerminalRecord, terminalRecordNames, terminalRecordStamp } from './terminalRecord.js'

vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, lstat: vi.fn(real.lstat) }
})

const rule = {
  directory: 'terminal-sessions', maxBytes: 4096, id: HERMES_HISTORY_ID_RE,
  names: [{ of: 'tty', prefix: 'tty-' }, { of: 'tmuxPane', prefix: 'tmux_pane-' }],
  unsafe: /[^A-Za-z0-9._-]/gu, keep: 120, session: 'session_id', time: 'ts',
} as const
const ID = '20261112_101500_a1b2c3', OLD = '20261111_090000_d4e5f6'

let home: string, dir: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'terminal-record-')); dir = join(home, 'terminal-sessions'); mkdirSync(dir) })
afterEach(() => { vi.mocked(lstat).mockReset(); rmSync(home, { recursive: true, force: true }) })
const write = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value))

it('names a terminal as Hermes does', () => {
  expect(terminalRecordNames(rule, { tty: '/dev/pts/3', tmuxPane: '%5' })).toEqual(['tty-dev-pts-3', 'tmux_pane--5'])
  expect(terminalRecordNames(rule, { tty: '/dev/ttys004', tmuxPane: null })).toEqual(['tty-dev-ttys004'])
  expect(terminalRecordNames(rule, { tty: ' /a b/ ', tmuxPane: null })).toEqual(['tty-a-b'])
  expect(terminalRecordNames(rule, { tty: '/' + 'x'.repeat(200), tmuxPane: null })[0]).toHaveLength(4 + 120)
  expect(terminalRecordNames(rule, { tty: null, tmuxPane: null })).toEqual([])
  // Hermes names no terminal by an empty tty or pane (`if name:`).
  expect(terminalRecordNames(rule, { tty: '', tmuxPane: '%5' })).toEqual(['tmux_pane--5'])
})

it('reads the record of this process', async () => {
  write('tty-dev-pts-3', { session_id: ID, cwd: '/work', ts: 1_000 })
  expect(await readTerminalRecord(rule, home, ['tty-dev-pts-3', 'tmux_pane--5'], 995_000)).toEqual({ state: 'record', sessionId: ID, at: 1_000_000 })
})

it('passes over a record an earlier process left in the same tty for the pane\'s own', async () => {
  write('tty-dev-pts-3', { session_id: OLD, ts: 900 }); write('tmux_pane--5', { session_id: ID, ts: 1_000 })
  expect(await readTerminalRecord(rule, home, ['tty-dev-pts-3', 'tmux_pane--5'], 995_000)).toEqual({ state: 'record', sessionId: ID, at: 1_000_000 })
  expect(await readTerminalRecord(rule, home, ['tty-dev-pts-3'], 995_000)).toEqual({ state: 'ignored', reason: 'stale' })
  write('tmux_pane--5', { session_id: ID })
  expect(await readTerminalRecord(rule, home, ['tty-dev-pts-3', 'tmux_pane--5'], 995_000)).toEqual({ state: 'ignored', reason: 'stale' })
})

const ignored: [string, () => void, string][] = [
  ['a symlink to another record', () => { write('other', { session_id: ID, ts: 1_000 }); symlinkSync(join(dir, 'other'), join(dir, 'tty-dev-pts-3')) }, 'not a regular file'],
  ['a folder', () => mkdirSync(join(dir, 'tty-dev-pts-3')), 'not a regular file'],
  ['a FIFO', () => execFileSync('mkfifo', [join(dir, 'tty-dev-pts-3')]), 'not a regular file'],
  ['more than 4 KB', () => writeFileSync(join(dir, 'tty-dev-pts-3'), JSON.stringify({ session_id: ID, ts: 1_000, pad: 'x'.repeat(5000) })), 'oversized'],
  ['not JSON', () => writeFileSync(join(dir, 'tty-dev-pts-3'), '{'), 'malformed'],
  ['not UTF-8', () => writeFileSync(join(dir, 'tty-dev-pts-3'), Buffer.from([0x7b, 0xff, 0x7d])), 'malformed'],
  ['an id no Hermes session has', () => write('tty-dev-pts-3', { session_id: '../../etc/passwd', ts: 1_000 }), 'malformed'],
  ['no time', () => write('tty-dev-pts-3', { session_id: ID }), 'malformed'],
  ['an endless time', () => writeFileSync(join(dir, 'tty-dev-pts-3'), `{"session_id":"${ID}","ts":1e999}`), 'malformed'],
  ['an array', () => writeFileSync(join(dir, 'tty-dev-pts-3'), '[]'), 'malformed'],
]
it.each(ignored.filter(([name]) => name !== 'a FIFO' || process.platform !== 'win32'))('ignores %s', async (_name, make, reason) => {
  make()
  expect(await readTerminalRecord(rule, home, ['tty-dev-pts-3'], 0)).toEqual({ state: 'ignored', reason })
})

it.each([
  // The open itself refuses a symlink, so one put there after the look is never followed.
  ['a symlink', (file: string) => { write('other', { session_id: ID, ts: 1_000 }); rmSync(file); symlinkSync(join(dir, 'other'), file) }, 'unreadable'],
  ['another file', (file: string) => { writeFileSync(`${file}.new`, JSON.stringify({ session_id: OLD, ts: 1_000 })); renameSync(`${file}.new`, file) }, 'not a regular file'],
  // Valid JSON still: only the bound on the read keeps it out.
  ['the same file grown past 4 KB', (file: string) => appendFileSync(file, ' '.repeat(5000)), 'oversized'],
])('judges the file it opened, not the one it looked at: %s put there in between', async (_name, swap, reason) => {
  const file = join(dir, 'tty-dev-pts-3')
  write('tty-dev-pts-3', { session_id: ID, ts: 1_000 })
  vi.mocked(lstat).mockImplementationOnce(async path => { const info = lstatSync(path); swap(file); return info })
  expect(await readTerminalRecord(rule, home, ['tty-dev-pts-3'], 0)).toEqual({ state: 'ignored', reason })
})

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('says a record it cannot open is unreadable', async () => {
  write('tty-dev-pts-3', { session_id: ID, ts: 1_000 })
  chmodSync(join(dir, 'tty-dev-pts-3'), 0o000)
  expect(await readTerminalRecord(rule, home, ['tty-dev-pts-3'], 0)).toEqual({ state: 'ignored', reason: 'unreadable' })
})

it('has nothing to say of a home with no record, and reads a byte-order mark as Hermes does', async () => {
  expect(await readTerminalRecord(rule, home, ['tty-dev-pts-3'], 0)).toEqual({ state: 'none' })
  writeFileSync(join(dir, 'tty-dev-pts-3'), '﻿' + JSON.stringify({ session_id: ID, ts: 1 }))
  expect(await readTerminalRecord(rule, home, ['tty-dev-pts-3'], 0)).toMatchObject({ state: 'record' })
})

it('has nothing to say of a home where Hermes could keep no record at all', async () => {
  rmSync(dir, { recursive: true })
  expect(await readTerminalRecord(rule, home, ['tty-dev-pts-3'], 0)).toEqual({ state: 'none' })
  // Hermes cannot make its folder where a file is: it writes nothing and says nothing.
  writeFileSync(dir, '')
  expect(await readTerminalRecord(rule, home, ['tty-dev-pts-3'], 0)).toEqual({ state: 'none' })
})

it('stamps what is there, and changes when Hermes replaces the file', async () => {
  expect(await terminalRecordStamp(rule, home, ['tty-dev-pts-3', 'tmux_pane--5'])).toBe('-|-')
  write('tty-dev-pts-3', { session_id: ID, ts: 1 }); const first = await terminalRecordStamp(rule, home, ['tty-dev-pts-3'])
  // As Hermes writes it (`atomic_json_write`): a new file renamed over the old, often of the same size and time.
  write('tty-dev-pts-3.tmp', { session_id: ID, ts: 2 }); renameSync(join(dir, 'tty-dev-pts-3.tmp'), join(dir, 'tty-dev-pts-3'))
  expect(await terminalRecordStamp(rule, home, ['tty-dev-pts-3'])).not.toBe(first)
})
