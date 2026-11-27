import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { builtinSqlite, closeSqliteHandles } from './sqliteBuiltin.js'
import type { WindowsFilesRead } from './windows/openFiles.js'
import { nativeOpenFiles } from './nativeConversation.js'
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

  it('is the folder above its state database', async () => {
    const asked: (readonly number[])[] = []
    const read: WindowsFilesRead = async (pids) => {
      asked.push(pids)
      return new Map([[4242, { startMarker: 'w:133700000000000000', files: ['C:\\Windows\\System32\\en-US\\kernel32.dll.mui', database] }]])
    }
    expect(stateDirOfOpenFiles(await nativeOpenFiles(4242, 'win32', read), 'win32')).toBe('C:\\Users\\u\\.openclaw-dev')
    expect(asked).toEqual([[4242]])
  })

  it('is unknown, never "holds nothing", when the files could not be read or the pid was left out', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const asked: (readonly number[])[] = []
    const failed: WindowsFilesRead = async (pids) => { asked.push(pids); return null }
    const leftOut: WindowsFilesRead = async (pids) => { asked.push(pids); return new Map() }
    await expect(nativeOpenFiles(4243, 'win32', failed)).rejects.toThrow()
    await expect(nativeOpenFiles(4244, 'win32', leftOut)).rejects.toThrow()
    expect(await openclawStateDir(4245, (pid) => nativeOpenFiles(pid, 'win32', failed))).toBeNull()
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
