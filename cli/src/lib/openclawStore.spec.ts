import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { builtinSqlite, closeSqliteHandles } from './sqliteBuiltin.js'
import type { WindowsFilesRead } from './windows/openFiles.js'
import { nativeOpenFiles } from './nativeConversation.js'
import { selectEngineProcess, type ProcessRow } from './processTable.js'
import { openclawStateDir, openclawUserRowSince, stateDirOfOpenFiles } from './openclawStore.js'

afterEach(() => { vi.restoreAllMocks() })

it('says once that a TUI\'s open files cannot be read, by the kind of failure, never its words', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const unreadable = async (): Promise<string[]> => { throw Object.assign(new Error('lsof: /Users/someone/.openclaw-work: permission denied'), { code: 'EACCES' }) }
  expect(await openclawStateDir(4321, unreadable)).toBeNull()
  expect(await openclawStateDir(4321, unreadable)).toBeNull()
  expect(warn.mock.calls).toEqual([['[openclaw] open files of 4321 unreadable · EACCES']])
})

describe('a Windows TUI\'s state folder, from the files harness-pty reads it holds', () => {
  const database = 'C:\\Users\\u\\.openclaw-dev\\state\\openclaw.sqlite'
  const at = (pid: number, parentPid: number, started: number, args = 'node.exe'): ProcessRow =>
    ({ pid, parentPid, executable: 'node.exe', startMarker: `w:${133_700_000_000_000_000n + BigInt(started)}`, args })
  const tableOf = (...rows: ProcessRow[]) => async () => rows
  const held = (row: ProcessRow, files: string[]) => [row.pid, { startMarker: row.startMarker, files }] as const

  it('is the folder above its state database', async () => {
    const asked: (readonly number[])[] = []
    const tui = at(4242, 1, 0)
    const read: WindowsFilesRead = async (pids) => {
      asked.push(pids)
      return new Map([held(tui, ['C:\\Windows\\System32\\en-US\\kernel32.dll.mui', database])])
    }
    expect(stateDirOfOpenFiles(await nativeOpenFiles(4242, 'win32', read, tableOf(tui)), 'win32')).toBe('C:\\Users\\u\\.openclaw-dev')
    expect(asked).toEqual([[4242]])
  })

  // engines/openclaw/__fixtures__/ps-win32.txt, a TUI Harness launched: the launcher respawns itself with
  // --stack-size=8192 and its child is the TUI, which holds the database; discovery names the launcher, the shallowest.
  const NODE = 'C:\\work\\node\\node.exe'
  const SCRIPT = 'C:\\work\\npm\\node_modules\\openclaw\\openclaw.mjs'
  const host = { ...at(9900, 7968, 0, 'harness-pty.exe serve'), executable: 'harness-pty.exe' }
  const launcher = at(10104, 9900, 10, `${NODE} ${SCRIPT} tui --session harness-a1`)
  const child = at(5340, 10104, 20, `${NODE} --stack-size=8192 ${SCRIPT} tui --session harness-a1`)

  it('is the one the TUI holds, the child of the launcher discovery names', async () => {
    expect(selectEngineProcess([host, launcher, child], 9900, 'openclaw')?.pid).toBe(10104)
    const asked: (readonly number[])[] = []
    const read: WindowsFilesRead = async (pids) => { asked.push(pids); return new Map([held(launcher, []), held(child, [database])]) }
    expect(stateDirOfOpenFiles(await nativeOpenFiles(10104, 'win32', read, tableOf(host, launcher, child)), 'win32'))
      .toBe('C:\\Users\\u\\.openclaw-dev')
    expect(asked).toEqual([[10104, 5340]])
  })

  it('never reads a process that only reuses a pid: an earlier process\'s orphan, or one started between the reads', async () => {
    // Windows never re-parents a process and reuses pids: a row naming the launcher's pid as its parent, started before
    // it, is the orphan of an earlier process of that pid.
    const orphan = at(6000, 10104, 5)
    const asked: (readonly number[])[] = []
    const read: WindowsFilesRead = async (pids) => { asked.push(pids); return new Map([held(launcher, []), held(orphan, [database])]) }
    expect(await nativeOpenFiles(10104, 'win32', read, tableOf(launcher, orphan))).toEqual([])
    expect(asked).toEqual([[10104]])
    const reused: WindowsFilesRead = async () => new Map([held(launcher, []), held({ ...child, startMarker: 'w:133700000000000030' }, [database])])
    await expect(nativeOpenFiles(10104, 'win32', reused, tableOf(launcher, child))).rejects.toThrow()
  })

  it('is unknown, never "holds nothing", when the files could not be read or the pid was left out', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const asked: (readonly number[])[] = []
    const failed: WindowsFilesRead = async (pids) => { asked.push(pids); return null }
    const leftOut: WindowsFilesRead = async (pids) => { asked.push(pids); return new Map() }
    const table = tableOf(at(4243, 1, 0), at(4244, 1, 0), at(4245, 1, 0), launcher, child)
    await expect(nativeOpenFiles(4243, 'win32', failed, table)).rejects.toThrow()
    await expect(nativeOpenFiles(4244, 'win32', leftOut, table)).rejects.toThrow()
    expect(await openclawStateDir(4245, (pid) => nativeOpenFiles(pid, 'win32', failed, table))).toBeNull()
    // The TUI's child left out is unknown too: it is the one that would hold the database.
    await expect(nativeOpenFiles(10104, 'win32', async () => new Map([held(launcher, [])]), table)).rejects.toThrow()
    expect(asked).toEqual([[4243], [4244], [4245]])
    // A process gone from the table, or a table that could not be read: unknown, and no files are asked for.
    await expect(nativeOpenFiles(4246, 'win32', failed, table)).rejects.toThrow()
    await expect(nativeOpenFiles(4243, 'win32', failed, async () => null)).rejects.toThrow()
    // Past harness-pty's 32 processes a run, some would go unread: unknown, and none are asked for.
    const brood = Array.from({ length: 32 }, (_, n) => at(20_000 + n, 10104, 30 + n))
    await expect(nativeOpenFiles(10104, 'win32', failed, tableOf(launcher, ...brood))).rejects.toThrow()
    expect(asked).toEqual([[4243], [4244], [4245]])
  })
})

describe('whether OpenClaw\'s store holds a user row for a key', () => {
  const fixtures = join(import.meta.dirname, '..', 'engines', 'openclaw', '__fixtures__')
  // The one user row of `plain.sql` was written at this time.
  const userRowAt = 1794299445770
  let stateDir = ''
  const database = () => join(stateDir, 'agents', 'main', 'agent', 'openclaw-agent.sqlite')
  const pane = () => ({ pid: 0, stateDir })

  afterEach(() => {
    closeSqliteHandles()
    rmSync(stateDir, { recursive: true, force: true })
  })

  function emptyStateDir(): void {
    stateDir = mkdtempSync(join(tmpdir(), 'openclaw-store-'))
    mkdirSync(dirname(database()), { recursive: true })
  }

  function plainStore(): void {
    emptyStateDir()
    const Database = builtinSqlite()!
    const db = new Database(database(), { readOnly: false })
    db.exec(readFileSync(join(fixtures, 'schema.sql'), 'utf8'))
    db.exec(readFileSync(join(fixtures, 'plain.sql'), 'utf8'))
    db.close()
  }

  it('holds its key\'s user row since before it was written, and none since it was written', async () => {
    plainStore()
    expect(await openclawUserRowSince('agent:main:plain', pane(), 0)).toBe(true)
    expect(await openclawUserRowSince('agent:main:plain', pane(), userRowAt)).toBe(false)
  })

  it('holds it up to a time at or after it was written, and none up to a time before', async () => {
    plainStore()
    expect(await openclawUserRowSince('agent:main:plain', pane(), 0, undefined, userRowAt)).toBe(true)
    expect(await openclawUserRowSince('agent:main:plain', pane(), 0, undefined, userRowAt - 1)).toBe(false)
  })

  it('holds none for another key', async () => {
    plainStore()
    expect(await openclawUserRowSince('agent:main:other', pane(), 0)).toBe(false)
  })

  it('holds none when the store does not exist yet', async () => {
    emptyStateDir()
    expect(await openclawUserRowSince('agent:main:plain', pane(), 0)).toBe(false)
  })

  it('holds none when the folder its TUI holds open has no store yet', async () => {
    emptyStateDir()
    const held = async (): Promise<string[]> => [join(stateDir, 'state', 'openclaw.sqlite')]
    expect(await openclawUserRowSince('agent:main:plain', { pid: 9101 }, 0, held)).toBe(false)
  })

  it('cannot say when its TUI\'s folder is unknown and OpenClaw\'s default folder has no store', async () => {
    emptyStateDir()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unreadable = async (): Promise<string[]> => { throw Object.assign(new Error('no lsof'), { code: 'ENOENT' }) }
    const fallback = env.OPENCLAW_STATE_DIR
    env.OPENCLAW_STATE_DIR = stateDir
    try {
      expect(await openclawUserRowSince('agent:main:plain', { pid: 0 }, 0)).toBeNull()
      expect(await openclawUserRowSince('agent:main:plain', { pid: 9102 }, 0, unreadable)).toBeNull()
    } finally {
      env.OPENCLAW_STATE_DIR = fallback
    }
  })

  it('cannot say for a file that is not SQLite, or for what is not a key', async () => {
    emptyStateDir()
    writeFileSync(database(), 'not a database')
    expect(await openclawUserRowSince('agent:main:plain', pane(), 0)).toBeNull()
    expect(await openclawUserRowSince('main', pane(), 0)).toBeNull()
  })
})
