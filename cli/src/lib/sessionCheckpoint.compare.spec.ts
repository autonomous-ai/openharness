import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionCheckpointStore } from './sessionCheckpoint.js'
import { builtinSqlite, closeSqliteHandles } from './sqliteBuiltin.js'
import { compareDatabase, exportDatabase } from '../engines/others/checkpoint.js'
import { otherStorageRequests } from '../engines/others/storageRequests.js'
import { createEngineStorage } from '../core/engines/storage.js'
import { STORAGE_CAPABILITIES, STORAGE_COMPARE_BYTES } from '../engines/worker/storageProtocol.js'
import type { RegisteredSession } from './registry.js'

let root: string, directory: string, database: string, session: RegisteredSession, store: SessionCheckpointStore
let exported: number, compared: number, oldWorker: boolean
let afterComparison: (() => void) | undefined
const mutateRows = (body: string) => {
  const Database = builtinSqlite()!, writer = new Database(database, { readOnly: false })
  try { writer.exec(`UPDATE messages SET body='${body}' WHERE id='m1'`) } finally { writer.close() }
}
const saved = () => {
  const path = join(directory, readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name))!)
  const raw = readFileSync(path, 'utf8'), manifest = JSON.parse(raw)
  return { path, raw, manifest, history: join(directory, manifest.file) }
}
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'checkpoint-reuse-store-')))
  directory = join(root, 'checkpoints'); database = join(root, 'state.db')
  exported = 0; compared = 0; oldWorker = false; afterComparison = undefined
  const Database = builtinSqlite()!, writer = new Database(database, { readOnly: false })
  writer.exec(`PRAGMA journal_mode=WAL; CREATE TABLE sessions(id TEXT PRIMARY KEY);
    CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT, body TEXT);
    INSERT INTO sessions VALUES('wanted'); INSERT INTO messages VALUES('m1','wanted','original rows');`)
  writer.close(); chmodSync(database, 0o600)
  session = { agentId: 'fixture', sessionId: 'wanted', engine: 'hermes', hermesHome: root, codexHome: null } as RegisteredSession
  const requests = otherStorageRequests({
    export: async (...args) => { exported++; return exportDatabase(...args) },
    compare: async (...args) => { compared++; const answer = await compareDatabase(...args); afterComparison?.(); return answer },
  })
  const storage = createEngineStorage({ isolated: true, serviceProcess: async () => true, call: async (_service, method, payload) => {
    const answer = await requests[method](payload, { owner: true, local: true })
    if (oldWorker && method === STORAGE_CAPABILITIES) delete answer.storageCompare
    return answer
  } })
  storage.connected('engine-others')
  store = new SessionCheckpointStore(directory, { exportDatabase: storage.exportDatabase })
  await store.save(session)
})
afterEach(() => { closeSqliteHandles(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

it('keeps the completed copy and manifest through the actual worker comparison path', async () => {
  const before = saved()
  await store.save(session, { finalPass: true })
  expect(saved().raw).toBe(before.raw)
  expect(readFileSync(before.history, 'utf8')).toContain('original rows')
  expect(exported).toBe(1); expect(compared).toBe(1)
  expect(readdirSync(join(directory, '.stages'))).toEqual([])
})

it('exports the final flushed conversation after a late row mismatch', async () => {
  mutateRows('modified rows')
  const before = saved()
  await store.save(session, { finalPass: true })
  expect(saved().manifest.file).not.toBe(before.manifest.file)
  expect(readFileSync(saved().history, 'utf8')).toContain('modified rows')
  expect(exported).toBe(2); expect(compared).toBe(1)
})

it('requires the after-exit phase before offering a completed checkpoint for reuse', async () => {
  await store.save(session)
  expect(exported).toBe(2); expect(compared).toBe(0)
})

it.each(['missing history', 'wrong byte count', 'oversize', 'other session'] as const)('rebuilds a checkpoint with %s', async fault => {
  const before = saved()
  if (fault === 'missing history') rmSync(before.history)
  else {
    if (fault === 'wrong byte count') before.manifest.bytes++
    if (fault === 'oversize') before.manifest.bytes = STORAGE_COMPARE_BYTES + 1
    if (fault === 'other session') before.manifest.sessionId = 'other'
    writeFileSync(before.path, JSON.stringify(before.manifest))
  }
  await store.save(session, { finalPass: true })
  expect(readFileSync(saved().history, 'utf8')).toContain('original rows')
  expect(exported).toBe(2)
  expect(compared).toBe(fault === 'wrong byte count' ? 1 : 0)
})

it.each(['manifest', 'history'] as const)('rebuilds a changed saved %s after an equal worker reply', async target => {
  const before = saved()
  afterComparison = () => {
    if (target === 'manifest') writeFileSync(before.path, JSON.stringify({ ...before.manifest, savedAt: 1 }))
    else appendFileSync(before.history, '\n')
  }
  await store.save(session, { finalPass: true })
  expect(saved().manifest.file).not.toBe(before.manifest.file)
  expect(exported).toBe(2)
})

it('holds lost native authority after an equal reply and keeps the prior copy', async () => {
  const before = saved()
  afterComparison = () => mutateRows('modified rows')
  await expect(store.save(session, { finalPass: true })).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(saved().raw).toBe(before.raw)
  expect(exported).toBe(1)
})

it('holds cancelled caller authority after an equal reply', async () => {
  let current = true
  afterComparison = () => { current = false }
  const before = saved()
  await expect(store.save(session, { finalPass: true, current: () => current })).rejects.toMatchObject({ code: 'HISTORY_NOT_SAVED' })
  expect(saved().raw).toBe(before.raw)
  expect(exported).toBe(1)
})

it('saves a supplied terminal draft even when the history is reused', async () => {
  await store.save(session, { finalPass: true, screen: 'unsent draft' })
  const screen = readdirSync(directory).find(name => name.endsWith('.screen.json'))!
  expect(JSON.parse(readFileSync(join(directory, screen), 'utf8')).screen).toBe('unsent draft')
  expect(exported).toBe(1)
})

it('falls back through the real capability handler for a worker without comparison support', async () => {
  oldWorker = true
  await store.save(session, { finalPass: true })
  expect(exported).toBe(2); expect(compared).toBe(0)
})
