import { describe, expect, it, vi } from 'vitest'
import {
  windowsOpenFiles,
  windowsOpenFilesRows,
  WINDOWS_FILES_MAX_BUFFER,
  WINDOWS_FILES_MAX_PER_PID,
  WINDOWS_FILES_TIMEOUT_MS,
  WINDOWS_PATH_MAX_UNITS,
} from './openFiles.js'
import type { WindowsPsRun } from './processTable.js'

const BINARY = () => 'C:\\h\\harness-pty.exe'
const ROLLOUT = 'C:\\Users\\someone\\.codex\\sessions\\2026\\11\\27\\rollout-2026-11-27T09-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000.jsonl'
const DAEMON = { pid: 421, startMarker: 'w:134087000000040000', cwd: 'C:\\work\\dial', files: [ROLLOUT] }
const TUI = { pid: 430, startMarker: 'w:134087000000050000', files: [] }

const printing = (stdout: string) => vi.fn<WindowsPsRun>((_file, _args, _options, done) => done(null, stdout, ''))

describe('windowsOpenFiles', () => {
  it('runs harness-pty files --json for the pids asked, hidden, within 3 s and 4 MiB', async () => {
    const run = printing(JSON.stringify({ rows: [DAEMON, TUI] }))
    const read = await windowsOpenFiles([421, 430, 421], { binary: BINARY, run })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(
      'C:\\h\\harness-pty.exe',
      ['files', '--json', '421', '430'],
      expect.objectContaining({ timeout: WINDOWS_FILES_TIMEOUT_MS, maxBuffer: WINDOWS_FILES_MAX_BUFFER, windowsHide: true }),
      expect.any(Function),
    )
    expect(WINDOWS_FILES_TIMEOUT_MS).toBe(3_000)
    expect(WINDOWS_FILES_MAX_BUFFER).toBe(4 * 1024 * 1024)
    expect(read).toEqual(new Map([
      [421, { startMarker: DAEMON.startMarker, cwd: 'C:\\work\\dial', files: [ROLLOUT] }],
      [430, { startMarker: TUI.startMarker, files: [] }],
    ]))
  })

  it('a pid absent from the rows is absent from the map, and empty rows are an empty map', async () => {
    const one = await windowsOpenFiles([421, 430], { binary: BINARY, run: printing(JSON.stringify({ rows: [DAEMON] })) })
    expect([...one!.keys()]).toEqual([421])
    expect(await windowsOpenFiles([421], { binary: BINARY, run: printing('{"rows":[]}') })).toEqual(new Map())
  })

  it('no pids: an empty map, nothing run; more than 32: null, nothing run', async () => {
    const never = vi.fn<WindowsPsRun>()
    expect(await windowsOpenFiles([], { binary: BINARY, run: never })).toEqual(new Map())
    expect(await windowsOpenFiles(Array.from({ length: 33 }, (_, i) => i + 1), { binary: BINARY, run: never })).toBeNull()
    expect(never).not.toHaveBeenCalled()
    // 32 distinct pids, some asked twice, are within the bound.
    const run = printing('{"rows":[]}')
    const pids = [...Array.from({ length: 32 }, (_, i) => i + 1), 1, 2]
    expect(await windowsOpenFiles(pids, { binary: BINARY, run })).toEqual(new Map())
    expect(run.mock.calls[0]![1]).toHaveLength(2 + 32)
  })

  it('null when there is no binary, it fails, it prints something else, or it throws', async () => {
    const never = vi.fn<WindowsPsRun>()
    expect(await windowsOpenFiles([421], { binary: () => null, run: never })).toBeNull()
    expect(await windowsOpenFiles([421], { binary: () => { throw new Error('no runtime dir') }, run: never })).toBeNull()
    expect(never).not.toHaveBeenCalled()
    const failing: WindowsPsRun = (_f, _a, _o, done) => done(Object.assign(new Error('exit 1'), { code: 1 }), JSON.stringify({ rows: [DAEMON] }), 'read failed')
    expect(await windowsOpenFiles([421], { binary: BINARY, run: failing })).toBeNull()
    expect(await windowsOpenFiles([421], { binary: BINARY, run: printing('not json') })).toBeNull()
    expect(await windowsOpenFiles([421], { binary: BINARY, run: printing('{"unsupported":true}') })).toBeNull()
    expect(await windowsOpenFiles([421], { binary: BINARY, run: printing('{"rows":"x"}') })).toBeNull()
    const throwing: WindowsPsRun = () => { throw new Error('spawn EACCES') }
    expect(await windowsOpenFiles([421], { binary: BINARY, run: throwing })).toBeNull()
  })

  it('a run that timed out is null, even with output', async () => {
    const timedOut: WindowsPsRun = (_f, _a, _o, done) =>
      done(Object.assign(new Error('Command failed: harness-pty files'), { killed: true, signal: 'SIGTERM' as const }), '{"rows":[]}', '')
    expect(await windowsOpenFiles([421], { binary: BINARY, run: timedOut })).toBeNull()
  })

  it('runs it for real when no runner is given: a binary that is not there is null', async () => {
    expect(await windowsOpenFiles([421], { binary: () => '/nonexistent/harness-pty' })).toBeNull()
  })
})

describe('windowsOpenFilesRows', () => {
  const asked = new Set([421, 430, 500])

  it('drops a malformed row and a row past a bound', () => {
    const long = 'C:\\' + 'a'.repeat(WINDOWS_PATH_MAX_UNITS)
    const bad = [
      null,
      'row',
      { ...TUI, pid: 0 },
      { ...TUI, pid: -1 },
      { ...TUI, pid: 1.5 },
      { ...TUI, pid: '430' },
      { ...TUI, pid: 999 },
      { ...TUI, startMarker: undefined },
      { ...TUI, startMarker: '' },
      { ...TUI, startMarker: '134087000000050000' },
      { ...TUI, startMarker: 'w:abc' },
      { ...TUI, files: undefined },
      { ...TUI, files: 'C:\\x' },
      { ...TUI, files: [1] },
      { ...TUI, files: Array.from({ length: WINDOWS_FILES_MAX_PER_PID + 1 }, (_, i) => `C:\\f${i}`) },
      { ...TUI, files: [long] },
      { ...TUI, cwd: 3 },
      { ...TUI, cwd: long },
    ]
    for (const row of bad) {
      expect(windowsOpenFilesRows({ rows: [row, DAEMON] }, asked), JSON.stringify(row)?.slice(0, 80)).toEqual(
        new Map([[421, { startMarker: DAEMON.startMarker, cwd: DAEMON.cwd, files: [ROLLOUT] }]]),
      )
    }
  })

  it('keeps a row at each bound', () => {
    const atBound = 'C:\\' + 'a'.repeat(WINDOWS_PATH_MAX_UNITS - 3)
    const files = Array.from({ length: WINDOWS_FILES_MAX_PER_PID }, (_, i) => `C:\\f${i}`)
    expect(windowsOpenFilesRows({ rows: [{ ...TUI, cwd: atBound, files: [...files.slice(1), atBound] }] }, asked)).toEqual(
      new Map([[430, { startMarker: TUI.startMarker, cwd: atBound, files: [...files.slice(1), atBound] }]]),
    )
  })

  it("a pid's first row wins", () => {
    const later = { ...DAEMON, startMarker: 'w:1', files: [] }
    expect(windowsOpenFilesRows({ rows: [DAEMON, later] }, asked)!.get(421)!.startMarker).toBe(DAEMON.startMarker)
  })

  it('null for output that is not rows', () => {
    expect(windowsOpenFilesRows(null, asked)).toBeNull()
    expect(windowsOpenFilesRows({}, asked)).toBeNull()
    expect(windowsOpenFilesRows({ unsupported: true }, asked)).toBeNull()
    expect(windowsOpenFilesRows({ rows: {} }, asked)).toBeNull()
  })
})
