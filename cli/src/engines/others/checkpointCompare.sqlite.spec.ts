import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { chmodSync, copyFileSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { builtinSqlite, closeSqliteHandles } from '../../lib/sqliteBuiltin.js'
import { enableOffThreadSqlite, resetOffThreadSqlite } from '../../lib/sqliteThread.js'
import { sqliteReadAll } from '../../lib/sqliteRead.js'
import { nativeFileKey } from '../kit/nativePaths.js'
import { compareDatabase, exportDatabase } from './checkpoint.js'
import type { ExportSource, SavedCheckpoint } from '../worker/storageProtocol.js'

// Reproduce coarse stat stamps only in SQLite's cache. Native ownership proofs still see real filesystem facts.
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, statSync: (...args: Parameters<typeof fs.statSync>) => {
    const stat = fs.statSync(...args)
    return stat && String(args[0]).endsWith('state.db') ? Object.assign(stat, { mtimeMs: 1, ctimeMs: 1 }) : stat
  } }
})

let root: string, source: ExportSource, saved: SavedCheckpoint
const session = { sessionId: 'wanted' }
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'checkpoint-real-compare-')))
  const database = join(root, 'state.db'), path = join(root, 'saved.history'), Database = builtinSqlite()!
  const writer = new Database(database, { readOnly: false })
  writer.exec(`PRAGMA journal_mode=WAL; CREATE TABLE sessions(id TEXT PRIMARY KEY);
    CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT, body TEXT);
    INSERT INTO sessions VALUES('wanted'); INSERT INTO messages VALUES('m1','wanted','original rows');`)
  writer.close(); chmodSync(database, 0o600)
  source = { path: database, key: nativeFileKey(lstatSync(database, { bigint: true })), database }
  writeFileSync(path, '', { mode: 0o600 })
  saved = { path, key: nativeFileKey(lstatSync(path, { bigint: true })), bytes: 0 }
  saved.bytes = (await exportDatabase('hermes', session, saved, source)).bytes
})
afterEach(async () => { await resetOffThreadSqlite(); closeSqliteHandles(); rmSync(root, { recursive: true, force: true }) })

it('reads real post-exit rows despite an immutable handle with identical coarse timestamps', async () => {
  const size = lstatSync(source.path).size, Database = builtinSqlite()!
  const writer = new Database(source.path, { readOnly: false })
  writer.exec("UPDATE messages SET body='modified rows' WHERE id='m1'"); writer.close()
  expect(lstatSync(source.path).size).toBe(size)
  expect(readdirSync(root)).toEqual(['saved.history', 'state.db'])
  expect(await compareDatabase('hermes', session, saved, source)).toBe(false)
  expect(readdirSync(root)).toEqual(['saved.history', 'state.db'])
})

it('uses normal export when inline read-thread caches cannot be invalidated synchronously', async () => {
  enableOffThreadSqlite()
  expect(await compareDatabase('hermes', session, saved, source)).toBeNull()
})

it('also exports fresh rows when comparison is skipped', async () => {
  const Database = builtinSqlite()!, writer = new Database(source.path, { readOnly: false })
  writer.exec("UPDATE messages SET body='modified rows' WHERE id='m1'"); writer.close()
  const path = join(root, 'second.history'); writeFileSync(path, '', { mode: 0o600 })
  await exportDatabase('hermes', session, { path, key: nativeFileKey(lstatSync(path, { bigint: true })) }, source)
  expect(readFileSync(path, 'utf8')).toContain('modified rows')
})

it('honors a fresh statement even when an immutable handle has the same stat stamps', async () => {
  const Database = builtinSqlite()!, writer = new Database(source.path, { readOnly: false })
  writer.exec("UPDATE messages SET body='modified rows' WHERE id='m1'"); writer.close()
  expect(await sqliteReadAll(source.path, 'SELECT body FROM messages', [], { fresh: true }))
    .toMatchObject({ ok: true, rows: [{ body: 'modified rows' }] })
})

it.each(['live sibling', 'leftover'] as const)('does not change the %s WAL while reopening for comparison', async kind => {
  const Database = builtinSqlite()!, writer = new Database(source.path, { readOnly: false })
  try {
    writer.exec("PRAGMA wal_autocheckpoint=0; UPDATE messages SET body='modified rows' WHERE id='m1'")
    if (kind === 'leftover') {
      const path = join(root, 'leftover.db')
      copyFileSync(source.path, path); copyFileSync(source.path + '-wal', path + '-wal')
      source = { path, key: nativeFileKey(lstatSync(path, { bigint: true })), database: path }
    }
    writeFileSync(saved.path, '')
    saved.bytes = (await exportDatabase('hermes', session, saved, source)).bytes
    const version = (path: string) => {
      const s = lstatSync(path, { bigint: true })
      return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink, s.mode]
    }
    const before = ['', '-wal'].map(suffix => version(source.path + suffix))
    const wal = readFileSync(source.path + '-wal')
    expect(await compareDatabase('hermes', session, saved, source)).toBe(true)
    expect(['', '-wal'].map(suffix => version(source.path + suffix))).toEqual(before)
    expect(readFileSync(source.path + '-wal')).toEqual(wal)
  } finally { writer.close() }
})
