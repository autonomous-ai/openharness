import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../config/env.js'
import { builtinSqlite, closeSqliteHandles, overrideBuiltinSqlite } from '../../lib/sqliteBuiltin.js'
import { openclawUserRowSince, otherStorageRequests } from './storageRequests.js'

import { STORAGE_EXPORT, STORAGE_LIFETIME, STORAGE_USER_ROW_SINCE } from '../worker/storageProtocol.js'
import * as sqlite from '../../lib/sqliteRead.js'
import { access } from 'node:fs/promises'
vi.mock('node:fs/promises', async real => {
  const original = await real<typeof import('node:fs/promises')>()
  return { ...original, access: vi.fn(original.access) }
})
describe('whether OpenClaw\'s store holds a user row for a key', () => {
  const fixtures = join(import.meta.dirname, '..', 'openclaw', '__fixtures__')
  // The one user row of `plain.sql` was written at this time.
  const userRowAt = 1794299445770
  let stateDir = ''
  let lock: ChildProcess | undefined
  let lockClosed: Promise<unknown> | undefined
  const database = () => join(stateDir, 'agents', 'main', 'agent', 'openclaw-agent.sqlite')
  const pane = () => ({ pid: 0, stateDir })

  afterEach(async () => {
    lock?.kill('SIGKILL')
    await lockClosed
    lock = undefined
    lockClosed = undefined
    vi.restoreAllMocks()
    closeSqliteHandles()
    overrideBuiltinSqlite(undefined)
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
  it('keeps an invalid location config unknown instead of borrowing the default empty store', async () => {
    emptyStateDir()
    writeFileSync(join(stateDir, 'openclaw.json'), '{invalid')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await openclawUserRowSince('agent:main:plain', pane(), 0)).toBeNull()
  })

  it('refuses a user-row answer if its config changes during the query', async () => {
    plainStore()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(sqlite, 'sqliteReadAll').mockImplementationOnce(async () => {
      writeFileSync(join(stateDir, 'openclaw.json'), '{}')
      return { ok: true, rows: [], via: 'cli' }
    })
    expect(await openclawUserRowSince('agent:main:plain', pane(), 0)).toBeNull()
  })

  it('does not mistake an inaccessible store for a missing one', async () => {
    emptyStateDir()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(access).mockRejectedValueOnce(Object.assign(new Error('private path'), { code: 'EACCES' }))
    expect(await openclawUserRowSince('agent:main:plain', pane(), 0)).toBeNull()
    expect(console.error).toHaveBeenCalledWith('[engine-others] STORAGE_USER_ROW_UNAVAILABLE · EACCES')
  })

  it.each([true, false])('an unconfirmed default store is unknown even when it exists with a user row: %s', async hasRow => {
    plainStore()
    const previous = env.OPENCLAW_STATE_DIR
    env.OPENCLAW_STATE_DIR = stateDir
    try {
      expect(await openclawUserRowSince(hasRow ? 'agent:main:plain' : 'agent:main:other', { pid: 0 }, 0)).toBeNull()
    } finally { env.OPENCLAW_STATE_DIR = previous }
  })

  it.each(['builtin', 'cli'] as const)('a locked %s read stays unknown and leaves an ongoing export alive', async via => {
    plainStore()
    // A separate process owns the lock: opening/closing the same file here can release this process's POSIX locks.
    lock = spawn(process.execPath, ['--no-warnings', '-e',
      "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN EXCLUSIVE'); process.stdout.write('locked'); process.stdin.resume(); process.stdin.on('end', () => { db.exec('ROLLBACK'); db.close() });", database()],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, timeout: 10_000, killSignal: 'SIGKILL', env: {} })
    lockClosed = new Promise(resolve => lock!.once('close', resolve))
    await new Promise<void>((resolve, reject) => {
      lock!.once('error', reject)
      lock!.once('close', () => reject(new Error('lock fixture closed before readiness')))
      lock!.stdout!.once('data', data => data.toString() === 'locked' ? resolve() : reject(new Error('invalid lock readiness')))
    })
    if (via === 'cli') overrideBuiltinSqlite(null)
    const query = vi.spyOn(sqlite, 'sqliteReadAll')
    const recycle = vi.fn()
    let finish!: (value: { bytes: number; sha256: string }) => void
    let exportCurrent!: () => boolean
    let entered!: () => void
    const exporting = new Promise<void>(resolve => { entered = resolve })
    const requests = otherStorageRequests({ recycle, export: async (_engine, _session, _stage, _source, current) => {
      exportCurrent = current!
      entered()
      return new Promise(resolve => { finish = resolve })
    } })
    const core = { owner: true, local: true }
    const session = { sessionId: 'agent:main:plain', pid: 0, openclawStateDir: stateDir }
    const lifetime = (await requests[STORAGE_LIFETIME]({ version: 1, engine: 'openclaw' }, core)).answer
    const pending = requests[STORAGE_EXPORT]({ version: 1, engine: 'openclaw', session, lifetime,
      source: { path: '/private/db', key: '2:3', database: '/private/db' },
      stage: { path: '/private/stage', key: '1:2' } }, core)
    await exporting
    try {
      expect(await requests[STORAGE_USER_ROW_SINCE]({ version: 1, engine: 'openclaw', session, since: 0, until: userRowAt }, core))
        .toEqual({ version: 1, answer: null })
      expect(query).toHaveBeenCalledWith(database(), expect.any(String), [0, userRowAt, 'agent:main:plain'],
        { timeoutMs: 1_000, busyTimeoutMs: 250, maxBuffer: 1024 })
      expect(recycle).not.toHaveBeenCalled()
      expect(exportCurrent()).toBe(true)
    } finally {
      lock.stdin!.end()
      await lockClosed
      finish({ bytes: 1, sha256: 'a'.repeat(64) })
    }
    expect(await pending).toEqual({ version: 1, answer: { bytes: 1, sha256: 'a'.repeat(64) } })
    expect(recycle).not.toHaveBeenCalled()
  })

})
