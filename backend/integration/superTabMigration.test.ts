import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import * as parts from '../src/superTabs/parts/index.js'
import { migrateSwarm } from '../src/superTabs/migration/migrate.js'
import { normalize } from '../src/superTabs/migration/normalize.js'
import { stateDifference } from '../src/superTabs/migration/verify.js'
import type { Author, SuperTabState } from '../src/superTabs/model.js'
import { writeLegacySwarm, type LegacyMessage } from '../scripts/swarm-parts/legacy.js'
import { NOW, richSwarm } from '../src/superTabs/read/fixture.test-support.js'

// A fresh loopback replica set, created here. This suite never reads DATABASE_URL or an existing database.
let replica: MongoMemoryReplSet
let db: PrismaClient
const R = 500
const DAY = 86_400_000
const PR = 'https://github.com/autonomous-ai/openharness/pull/1726'

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_migration_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** A legacy Swarm at revision R: a finished group quiet for two days, a link only its history holds, some messages. */
async function legacySwarm(edit: (state: SuperTabState) => void = () => {}) {
  const s = richSwarm()
  const tabId = `tab-${randomUUID()}`
  const state = structuredClone(s.state)
  state.id = tabId
  const web = state.conversations.find(c => c.id === s.web)!
  web.assignment = { ...web.assignment!, status: 'done' }
  delete web.pullRequestUrls
  web.lastMessageSequence = 30
  state.conversations.find(c => c.id === 'lead')!.lastMessageSequence = 40
  edit(state)
  const author: Author = { kind: 'person', id: 'owner', name: 'owner@example.com', membershipGeneration: 'tab' }
  const message = (conversationId: string, sequence: number, text: string, at: number): LegacyMessage =>
    ({ id: `${tabId}-${sequence}`, conversationId, sequence, text, author, createdAt: new Date(at) })
  const messages = [message(s.web, 10, 'Starting', NOW - 3 * DAY), message(s.web, 30, `Opened ${PR}`, NOW - 2 * DAY),
    message('lead', 40, 'Thanks', NOW - 1_000)]
  await writeLegacySwarm(db, { state, revision: R, messages })
  return { s, tabId, state, messages }
}
const partCount = (tabId: string) => db.swarmHead.count({ where: { tabId } })

describe('migrating one Swarm to parts (design 6.1.2)', () => {
  it('splits a legacy Swarm into parts that reassemble into its state, fences the row and keeps the old state', async () => {
    const { s, tabId, state } = await legacySwarm()
    const report = await migrateSwarm(db, tabId, { now: () => NOW })
    expect(report).toMatchObject({ tabId, ok: true, groups: state.conversations.length, dormant: 1, messages: 3 })

    const row = (await db.superTab.findUnique({ where: { id: tabId } }))!
    expect(row).toMatchObject({ format: 2, revision: R + 1, state: { version: 2 }, migratedAt: new Date(NOW) })
    expect(row.legacyState).toEqual(JSON.parse(JSON.stringify(state)))

    const stored = await db.$transaction(tx => parts.loadAll(tx, tabId))
    expect(stored).toMatchObject({ sequenceBase: R, visibilityEpoch: 1 })
    const web = stored.groups.find(g => g.key === s.web)!
    expect(web).toMatchObject({ version: R, dormant: true, data: { messageSeq: R, pullRequestUrls: [PR], lastActivityAt: new Date(NOW - 2 * DAY).toISOString() } })
    const expected = normalize({ ...state, conversations: state.conversations.map(c => ({ ...c, pullRequestUrls: c.pullRequestUrls ?? (c.id === s.web ? [PR] : []) })) },
      { now: NOW, lastActivity: new Map([[s.web, NOW - 2 * DAY], ['lead', NOW - 1_000]]) })
    expect(stateDifference(parts.toLegacyState(expected), parts.toLegacyState(parts.reassemble(stored)))).toBeNull()
    expect(await db.superTabMessage.findMany({ where: { tabId }, orderBy: { sequence: 'asc' }, select: { sequence: true } }))
      .toEqual([{ sequence: 10 }, { sequence: 30 }, { sequence: 40 }])
  })

  it('skips a Swarm that is already in parts, changing nothing', async () => {
    const { tabId } = await legacySwarm()
    await migrateSwarm(db, tabId, { now: () => NOW })
    const before = await db.superTab.findUnique({ where: { id: tabId } })
    expect(await migrateSwarm(db, tabId, { now: () => NOW + 1 })).toMatchObject({ tabId, ok: true, skipped: true })
    expect(await db.superTab.findUnique({ where: { id: tabId } })).toEqual(before)
  })

  it('writes nothing and names the first difference when the parts would not reassemble into the old state', async () => {
    // Report progress past every group's last message cannot be told apart from the groups; the Swarm stays as it was.
    const { tabId } = await legacySwarm(state => {
      state.projects![0]!.progress = { dirtyRevision: 45, summarizedRevision: 0, since: 1, requestedRevision: 0 }
    })
    const report = await migrateSwarm(db, tabId, { now: () => NOW })
    expect(report).toMatchObject({ tabId, ok: false })
    expect(report.error).toContain('projects[0].progress.dirtyRevision: 45 ≠ 30')
    expect(await db.superTab.findUnique({ where: { id: tabId } })).toMatchObject({ format: 1, revision: R, legacyState: null })
    expect(await partCount(tabId)).toBe(0)
  })

  it('refuses to migrate a Swarm with a message whose conversation it does not have', async () => {
    const { tabId } = await legacySwarm()
    await db.superTabMessage.create({ data: { id: `${tabId}-orphan`, tabId, conversationId: 'gone', sequence: 7, author: {}, text: 'lost',
      recipientIds: [], mentions: [] } })
    const report = await migrateSwarm(db, tabId, { now: () => NOW })
    expect(report).toMatchObject({ ok: false })
    expect(report.error).toContain('1 message in a conversation it does not have: gone')
    expect(await partCount(tabId)).toBe(0)
  })
})
