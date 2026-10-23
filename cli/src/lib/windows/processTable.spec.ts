import { describe, expect, it, vi } from 'vitest'
import type { PtyHostClient } from '../ptyHost/client.js'
import { windowsProcessRow, windowsProcessRows, windowsProcessTable, WINDOWS_PS_TIMEOUT_MS, type WindowsPsRun } from './processTable.js'

const CLAUDE = { pid: 900, parentPid: 4, executable: 'claude.exe', startMarker: 'w:133', args: 'claude.exe --resume x', nativeArgv: ['claude.exe', '--resume', 'x'] }
const SYSTEM = { pid: 4, parentPid: 0, executable: 'System', startMarker: '', args: '', nativeArgv: [] }

const clientReplying = (reply: unknown) => ({ call: vi.fn(async () => reply) }) as unknown as PtyHostClient

describe('windowsProcessRows', () => {
  it('maps host rows and drops unidentifiable ones', async () => {
    const client = clientReplying({ state: 'ok', value: { rows: [SYSTEM, CLAUDE] } })
    expect(await windowsProcessRows(client)).toEqual([CLAUDE])
    expect(client.call).toHaveBeenCalledWith({ op: 'processes' })
  })

  it('returns null, not [], when the read fails', async () => {
    expect(await windowsProcessRows(clientReplying({ state: 'unknown', dispatch: 'possibly_executed', reason: 't' }))).toBeNull()
    const throwing = { call: async () => { throw new Error('closed') } } as unknown as PtyHostClient
    expect(await windowsProcessRows(throwing)).toBeNull()
  })

  it('returns null for a table that names nobody it can identify', async () => {
    expect(await windowsProcessRows(clientReplying({ state: 'ok', value: { rows: [SYSTEM] } }))).toBeNull()
    expect(await windowsProcessRows(clientReplying({ state: 'ok', value: {} }))).toBeNull()
  })

  it('without a connection, runs `harness-pty ps --json` within 3 s', async () => {
    const run = vi.fn<WindowsPsRun>((_file, _args, _options, done) => done(null, JSON.stringify({ rows: [CLAUDE] }), ''))
    expect(await windowsProcessRows(null, { binary: () => 'C:\\h\\harness-pty.exe', run })).toEqual([CLAUDE])
    expect(run).toHaveBeenCalledWith('C:\\h\\harness-pty.exe', ['ps', '--json'], expect.objectContaining({ timeout: WINDOWS_PS_TIMEOUT_MS }), expect.any(Function))
  })

  it('without a connection, null when there is no binary, it fails, or it prints something else', async () => {
    const never = vi.fn<WindowsPsRun>()
    expect(await windowsProcessRows(null, { binary: () => null, run: never })).toBeNull()
    expect(await windowsProcessRows(null, { binary: () => { throw new Error('no runtime dir') }, run: never })).toBeNull()
    expect(never).not.toHaveBeenCalled()
    const failing: WindowsPsRun = (_f, _a, _o, done) => done(Object.assign(new Error('exit 1'), { code: 1 }), '', 'scan failed')
    expect(await windowsProcessRows(null, { binary: () => 'x', run: failing })).toBeNull()
    const garbled: WindowsPsRun = (_f, _a, _o, done) => done(null, 'not json', '')
    expect(await windowsProcessRows(null, { binary: () => 'x', run: garbled })).toBeNull()
    const unsupported: WindowsPsRun = (_f, _a, _o, done) => done(null, '{"unsupported":true}', '')
    expect(await windowsProcessRows(null, { binary: () => 'x', run: unsupported })).toBeNull()
    const throwing: WindowsPsRun = () => { throw new Error('spawn EACCES') }
    expect(await windowsProcessRows(null, { binary: () => 'x', run: throwing })).toBeNull()
  })

  it('runs it for real when no runner is given: a binary that is not there is null', async () => {
    expect(await windowsProcessRows(null, { binary: () => '/nonexistent/harness-pty' })).toBeNull()
  })

  it('finds the binary as the host launcher does when none is given', async () => {
    const previous = process.env.HARNESS_PTY_BIN
    process.env.HARNESS_PTY_BIN = '/opt/harness-pty'
    try {
      const run = vi.fn<WindowsPsRun>((_f, _a, _o, done) => done(null, JSON.stringify({ rows: [CLAUDE] }), ''))
      expect(await windowsProcessRows(null, { run })).toEqual([CLAUDE])
      expect(run.mock.calls[0]![0]).toBe('/opt/harness-pty')
    } finally {
      if (previous === undefined) delete process.env.HARNESS_PTY_BIN
      else process.env.HARNESS_PTY_BIN = previous
    }
  })
})

describe('windowsProcessRow', () => {
  it('keeps the image path and argv when the host gives them', () => {
    expect(windowsProcessRow({ ...CLAUDE, imagePath: 'C:\\bin\\claude.exe' })).toEqual({ ...CLAUDE, imagePath: 'C:\\bin\\claude.exe' })
    const { nativeArgv: _argv, ...bare } = CLAUDE
    expect(windowsProcessRow({ ...CLAUDE, nativeArgv: [1], imagePath: '' })).toEqual(bare)
  })

  it.each([
    ['nothing', null],
    ['a string', 'row'],
    ['no pid', { ...CLAUDE, pid: undefined }],
    ['pid 0', { ...CLAUDE, pid: 0 }],
    ['a fractional pid', { ...CLAUDE, pid: 1.5 }],
    ['a negative parent', { ...CLAUDE, parentPid: -1 }],
    ['no executable', { ...CLAUDE, executable: 3 }],
    ['no args', { ...CLAUDE, args: null }],
    ['no marker', { ...CLAUDE, startMarker: undefined }],
    ['an empty marker', { ...CLAUDE, startMarker: '' }],
  ])('drops a row with %s', (_case, row) => {
    expect(windowsProcessRow(row)).toBeNull()
  })

  it('reads a table that is not one as null', () => {
    expect(windowsProcessTable(null)).toBeNull()
    expect(windowsProcessTable({ rows: 'x' })).toBeNull()
  })
})
