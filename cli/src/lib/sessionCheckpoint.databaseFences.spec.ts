import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RegisteredSession } from './registry.js'
import type { DatabaseCheckpointProof } from './databaseCheckpoint.js'

const boundary = vi.hoisted(() => ({
  screen: undefined as (() => void) | undefined,
  history: undefined as (() => void) | undefined,
  evidence: undefined as (() => void) | undefined,
}))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      fs.renameSync(...args)
      if (String(args[1]).endsWith('.screen.json')) boundary.screen?.()
    },
    linkSync: (...args: Parameters<typeof fs.linkSync>) => {
      fs.linkSync(...args)
      if (String(args[1]).endsWith('.history')) boundary.history?.()
    },
  }
})
vi.mock('./databaseCheckpoint.js', async original => {
  const actual = await original<typeof import('./databaseCheckpoint.js')>()
  return { ...actual, databaseCheckpointEvidence: async (...args: Parameters<typeof actual.databaseCheckpointEvidence>) => {
    const proof = await actual.databaseCheckpointEvidence(...args)
    boundary.evidence?.()
    return proof
  } }
})

let root: string, database: string, directory: string, row: RegisteredSession
let store: import('./sessionCheckpoint.js').SessionCheckpointStore
let closeReaders: () => void
let manifest: string, previous: string
beforeEach(async () => {
  vi.resetModules()
  Object.assign(boundary, { screen: undefined, history: undefined, evidence: undefined })
  root = mkdtempSync(join(tmpdir(), 'checkpoint-database-fences-'))
  database = join(root, 'state.db'); directory = join(root, 'checkpoints')
  const { builtinSqlite, closeSqliteHandles } = await import('./sqliteBuiltin.js')
  closeReaders = closeSqliteHandles
  const db = new (builtinSqlite()!)(database, { readOnly: false })
  try {
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, body TEXT);"
      + "INSERT INTO sessions VALUES ('conversation'); INSERT INTO messages VALUES ('turn', 'conversation', 'retained history');")
  } finally { db.close() }
  row = { agentId: 'fixture', engine: 'hermes', sessionId: 'conversation', hermesHome: root, transcriptPath: null } as RegisteredSession
  const { SessionCheckpointStore } = await import('./sessionCheckpoint.js')
  const { exportDatabase } = await import('../engines/others/checkpoint.js')
  store = new SessionCheckpointStore(directory, { exportDatabase: async (session, source, reservation) => {
    const ownership = await reservation.acquire(process.pid)
    const receipt = await exportDatabase('hermes', { sessionId: session.sessionId, hermesHome: root }, ownership.stage, source)
    await ownership.settled()
    return receipt
  } })
  await store.save(row, { screen: 'retained draft' })
  manifest = join(directory, readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name))!)
  previous = readFileSync(manifest, 'utf8')
})
afterEach(() => { closeReaders(); rmSync(root, { recursive: true, force: true }) })

async function proof(): Promise<DatabaseCheckpointProof> {
  return (await (await import('./databaseCheckpoint.js')).databaseCheckpointEvidence(row))!
}
function changeDatabase(): void {
  writeFileSync(database, Buffer.concat([readFileSync(database), Buffer.from('changed')]))
}
function previousHistoryKept(): void {
  expect(readFileSync(manifest, 'utf8')).toBe(previous)
  const saved = JSON.parse(previous)
  expect(readFileSync(join(directory, saved.file), 'utf8')).toContain('retained history')
  expect(readdirSync(directory).filter(name => name.endsWith('.history'))).toEqual([saved.file])
  expect(readdirSync(join(directory, '.stages'))).toEqual([])
}

it('refuses a source changed during the screen write before replacing the manifest', async () => {
  const selected = await proof()
  boundary.screen = changeDatabase
  await expect(store.save(row, { screen: 'new draft', databaseProof: selected })).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  previousHistoryKept()
  const screen = readdirSync(directory).find(name => name.endsWith('.screen.json'))!
  // Screen replacement already happened; its complete draft remains, while history publication refuses.
  expect(JSON.parse(readFileSync(join(directory, screen), 'utf8')).screen).toBe('new draft')
})

it.each([false, true])('rechecks a source changed after history publication with a screen=%s', async screen => {
  const selected = await proof()
  boundary.history = () => queueMicrotask(changeDatabase)
  await expect(store.save(row, { ...(screen ? { screen: 'new draft' } : {}), databaseProof: selected }))
    .rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  previousHistoryKept()
  const retainedScreen = readdirSync(directory).find(name => name.endsWith('.screen.json'))!
  expect(JSON.parse(readFileSync(join(directory, retainedScreen), 'utf8')).screen).toBe('retained draft')
})

it('preserves cancellation after history publication when there is no screen to write', async () => {
  let current = true
  const selected = await proof()
  boundary.history = () => queueMicrotask(() => { current = false })
  await expect(store.save(row, { current: () => current, databaseProof: selected })).rejects.toMatchObject({
    code: 'HISTORY_NOT_SAVED', message: 'The session changed while saving. Its previous checkpoint is kept.',
  })
  previousHistoryKept()
})

it('checks the source again after awaited evidence discovery before allocating a stage', async () => {
  boundary.evidence = changeDatabase
  await expect(store.save(row)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  previousHistoryKept()
})
