import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { env } from '../../config/env.js'
import { builtinSqlite, closeSqliteHandles } from '../../lib/sqliteBuiltin.js'
import { forgetHermesHomes } from '../hermes/home.js'
import { hermesBackground, otherStorageRequests } from './storageRequests.js'
import { STORAGE_BACKGROUND } from '../worker/storageProtocol.js'

let root: string, previous: string
const sessionId = '20261112_100000_bbbbbb'
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'hermes-storage-')); previous = env.HERMES_HOME; env.HERMES_HOME = root; forgetHermesHomes() })
afterEach(async () => { env.HERMES_HOME = previous; forgetHermesHomes(); closeSqliteHandles(); await rm(root, { recursive: true, force: true }) })
async function home(path: string, holds = true) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const Database = builtinSqlite()!, db = new Database(join(path, 'state.db'), { readOnly: false })
  try {
    db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY, parent_session_id TEXT);')
    if (holds) db.exec(`INSERT INTO sessions VALUES ('${sessionId}', NULL);`)
  } finally { db.close() }
  await writeFile(join(path, 'processes.json'), JSON.stringify([{ session_key: sessionId }, { session_key: 'another' }]))
}
it('reads a captured private profile, then discovers the correct profile without writing registry state', async () => {
  await home(root, false)
  const profile = join(root, 'profiles', 'named'); await home(profile)
  expect(await hermesBackground({ sessionId, hermesHome: profile })).toBe(1)
  expect(await hermesBackground({ sessionId })).toBe(1)
  const requests = otherStorageRequests()
  const results = await Promise.all(Array.from({ length: 4 }, () => requests[STORAGE_BACKGROUND](
    { version: 1, engine: 'hermes', session: { sessionId } }, { owner: true, local: true })))
  expect(results).toEqual(Array.from({ length: 4 }, () => ({ version: 1, answer: 1 })))
})
it('keeps a missing session or an unreadable store unknown, including default-home reads', async () => {
  await home(root)
  expect(await hermesBackground({ sessionId })).toBe(1)
  expect(await hermesBackground({ sessionId: '20261112_100000_cccccc' })).toBeNull()
  closeSqliteHandles()
  await writeFile(join(root, 'state.db'), 'not sqlite')
  expect(await hermesBackground({ sessionId })).toBeNull()
  expect(await hermesBackground({ sessionId, hermesHome: join(root, 'missing') })).toBeNull()
})
