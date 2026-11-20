import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeSqliteHandles } from './sqliteBuiltin.js'
import { openclawStateDir, openclawUserRowSince } from './openclawStore.js'

afterEach(() => { vi.restoreAllMocks() })

it('says once that a TUI\'s open files cannot be read, by the kind of failure, never its words', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const unreadable = async (): Promise<string[]> => { throw Object.assign(new Error('lsof: /Users/someone/.openclaw-work: permission denied'), { code: 'EACCES' }) }
  expect(await openclawStateDir(4321, unreadable)).toBeNull()
  expect(await openclawStateDir(4321, unreadable)).toBeNull()
  expect(warn.mock.calls).toEqual([['[openclaw] open files of 4321 unreadable · EACCES']])
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
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
    const db = new DatabaseSync(database())
    db.exec(readFileSync(join(fixtures, 'schema.sql'), 'utf8'))
    db.exec(readFileSync(join(fixtures, 'plain.sql'), 'utf8'))
    db.close()
  }

  it('holds its key\'s user row since before it was written, and none since it was written', async () => {
    plainStore()
    expect(await openclawUserRowSince('agent:main:plain', pane(), 0)).toBe(true)
    expect(await openclawUserRowSince('agent:main:plain', pane(), userRowAt)).toBe(false)
  })

  it('holds none for another key', async () => {
    plainStore()
    expect(await openclawUserRowSince('agent:main:other', pane(), 0)).toBe(false)
  })

  it('holds none when the store does not exist yet', async () => {
    emptyStateDir()
    expect(await openclawUserRowSince('agent:main:plain', pane(), 0)).toBe(false)
  })

  it('cannot say for a file that is not SQLite, or for what is not a key', async () => {
    emptyStateDir()
    writeFileSync(database(), 'not a database')
    expect(await openclawUserRowSince('agent:main:plain', pane(), 0)).toBeNull()
    expect(await openclawUserRowSince('main', pane(), 0)).toBeNull()
  })
})
