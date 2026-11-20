import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { chmodSync, copyFileSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { builtinSqlite, closeSqliteHandles } from '../../lib/sqliteBuiltin.js'
import { enableOffThreadSqlite, resetOffThreadSqlite } from '../../lib/sqliteThread.js'
import { sqliteReadAll } from '../../lib/sqliteRead.js'
import { nativeFileKey } from '../kit/nativePaths.js'
import { exportDatabase } from './checkpoint.js'
import type { ExportSource } from '../worker/storageProtocol.js'

// Reproduce coarse stat stamps only in SQLite's cache. Native ownership proofs still see real filesystem facts.
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, statSync: (...args: Parameters<typeof fs.statSync>) => {
    const stat = fs.statSync(...args)
    return stat && String(args[0]).endsWith('state.db') ? Object.assign(stat, { mtimeMs: 1, ctimeMs: 1 }) : stat
  } }
})
vi.mock('../../lib/sqliteRead.js', async original => {
  const actual = await original<typeof import('../../lib/sqliteRead.js')>()
  return { ...actual, sqliteReadAll: vi.fn(actual.sqliteReadAll) }
})

let root: string, source: ExportSource
const session = { sessionId: 'wanted' }
const writeRows = (body: string) => {
  const Database = builtinSqlite()!, writer = new Database(source.path, { readOnly: false })
  try { writer.exec(`UPDATE messages SET body='${body}' WHERE id='m1'`) } finally { writer.close() }
}
const exported = async (name = 'second.history') => {
  const path = join(root, name); writeFileSync(path, '', { mode: 0o600 })
  await exportDatabase('hermes', session, { path, key: nativeFileKey(lstatSync(path, { bigint: true })) }, source)
  return readFileSync(path, 'utf8')
}
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'checkpoint-fresh-')))
  const database = join(root, 'state.db'), Database = builtinSqlite()!
  const writer = new Database(database, { readOnly: false })
  writer.exec(`PRAGMA journal_mode=WAL; CREATE TABLE sessions(id TEXT PRIMARY KEY);
    CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT, body TEXT);
    INSERT INTO sessions VALUES('wanted'); INSERT INTO messages VALUES('m1','wanted','original rows');`)
  writer.close(); chmodSync(database, 0o600)
  source = { path: database, key: nativeFileKey(lstatSync(database, { bigint: true })), database }
  await exported('first.history')
  vi.mocked(sqliteReadAll).mockClear()
})
afterEach(async () => { await resetOffThreadSqlite(); closeSqliteHandles(); rmSync(root, { recursive: true, force: true }) })

it('exports current rows despite a same-size write and identical coarse cache timestamps', async () => {
  const size = lstatSync(source.path).size
  writeRows('modified rows')
  expect(lstatSync(source.path).size).toBe(size)
  expect(await exported()).toContain('modified rows')
})

it('honors a fresh statement even when an immutable handle has the same stat stamps', async () => {
  writeRows('modified rows')
  expect(await sqliteReadAll(source.path, 'SELECT body FROM messages', [], { fresh: true }))
    .toMatchObject({ ok: true, rows: [{ body: 'modified rows' }] })
})

it('requires fresh reads for singleton, schema and page queries in the old inline composition', async () => {
  writeRows('modified rows')
  enableOffThreadSqlite()
  expect(await exported()).toContain('modified rows')
  const calls = vi.mocked(sqliteReadAll).mock.calls
  expect(calls.some(([, sql]) => sql.startsWith('SELECT *'))).toBe(true)
  expect(calls.some(([, sql]) => sql.includes('pragma_table_xinfo'))).toBe(true)
  expect(calls.some(([, sql]) => sql.startsWith('WITH RECURSIVE'))).toBe(true)
  expect(calls.every(([, , , options]) => options?.fresh === true)).toBe(true)
})

it.each(['live sibling', 'leftover'] as const)('keeps the %s WAL intact through fresh statements and checkpoint exports', async kind => {
  const Database = builtinSqlite()!, writer = new Database(source.path, { readOnly: false })
  try {
    writer.exec("PRAGMA wal_autocheckpoint=0; UPDATE messages SET body='modified rows' WHERE id='m1'")
    if (kind === 'leftover') {
      const path = join(root, 'leftover.db')
      copyFileSync(source.path, path); copyFileSync(source.path + '-wal', path + '-wal')
      source = { path, key: nativeFileKey(lstatSync(path, { bigint: true })), database: path }
    }
    const version = (path: string) => {
      const s = lstatSync(path, { bigint: true })
      return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink, s.mode]
    }
    const before = ['', '-wal'].map(suffix => version(source.path + suffix)), wal = readFileSync(source.path + '-wal')
    const verify = () => {
      expect(['', '-wal'].map(suffix => version(source.path + suffix))).toEqual(before)
      expect(readFileSync(source.path + '-wal')).toEqual(wal)
    }
    expect(await sqliteReadAll(source.path, 'SELECT body FROM messages', [], { fresh: true }))
      .toMatchObject({ ok: true, rows: [{ body: 'modified rows' }] })
    verify()
    expect(await exported()).toContain('modified rows'); verify()
    enableOffThreadSqlite()
    expect(await exported('inline.history')).toContain('modified rows'); verify()
  } finally { writer.close() }
})
