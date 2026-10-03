import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RegisteredSession } from './registry.js'

let root: string
const databases: Array<{ close(): void }> = []
beforeEach(() => {
  vi.resetModules()
  root = mkdtempSync(join(tmpdir(), 'harness-checkpoint-wal-'))
  for (const key of ['OPENCODE_DATA_DIR', 'KILO_DATA_DIR', 'HERMES_HOME', 'DEVIN_HOME']) vi.stubEnv(key, root)
})
afterEach(async () => {
  const { closeSqliteHandles } = await import('./sqliteRead.js')
  closeSqliteHandles()
  for (const database of databases.splice(0)) database.close()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

it.each(['opencode', 'kilo', 'hermes', 'devin'] as const)('backs up only the selected %s conversation while its real database has a live WAL', async engine => {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as any
  const path = join(root, engine === 'opencode' ? 'opencode.db' : engine === 'kilo' ? 'kilo.db' : engine === 'hermes' ? 'state.db' : 'sessions.db')
  const database = new DatabaseSync(path)
  databases.push(database)
  database.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;')
  if (engine === 'opencode' || engine === 'kilo') {
    database.exec(`CREATE TABLE session (id TEXT PRIMARY KEY); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, body TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, body TEXT);
      INSERT INTO session VALUES ('wanted'), ('other'); INSERT INTO message VALUES ('m1', 'wanted', 'history in WAL'), ('m2', 'other', 'unrelated private text');
      INSERT INTO part VALUES ('p1', 'm1', 'wanted attachment'), ('p2', 'm2', 'unrelated private text');`)
  } else {
    const table = engine === 'hermes' ? 'messages' : 'message_nodes'
    database.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE ${table} (id TEXT PRIMARY KEY, session_id TEXT, body TEXT);
      INSERT INTO sessions VALUES ('wanted'), ('other'); INSERT INTO ${table} VALUES ('m1', 'wanted', 'history in WAL'), ('m2', 'other', 'unrelated private text');`)
  }
  expect(readdirSync(root)).toContain(`${path.split('/').at(-1)}-wal`)
  const { SessionCheckpointStore } = await import('./sessionCheckpoint.js')
  const directory = join(root, 'backups')
  mkdirSync(directory, { mode: 0o700 })
  await new SessionCheckpointStore(directory).save({ agentId: 'fixture', sessionId: 'wanted', engine, hermesHome: root } as RegisteredSession)
  const manifest = JSON.parse(readFileSync(join(directory, readdirSync(directory).find(f => f.endsWith('.json'))!), 'utf8'))
  const backup = readFileSync(join(directory, manifest.file), 'utf8')
  expect(backup).toContain('history in WAL')
  expect(backup).not.toContain('unrelated private text')
  expect(database.prepare(`SELECT count(*) AS n FROM ${engine === 'opencode' || engine === 'kilo' ? 'session' : 'sessions'}`).get().n).toBe(2)
})
