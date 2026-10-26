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
import { rollbackFromParts, rollbackLegacy } from '../src/superTabs/migration/rollback.js'
import { migrateAll } from '../src/superTabs/migration/job.js'
import { guardedWrite } from '../src/superTabs/parts/write.js'
import { normalize } from '../src/superTabs/migration/normalize.js'
import { stateDifference } from '../src/superTabs/migration/verify.js'
import { visibleState, type Author, type SuperTabState } from '../src/superTabs/model.js'
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
async function legacySwarm(edit: (state: SuperTabState, s: ReturnType<typeof richSwarm>) => void = () => {}) {
  const s = richSwarm()
  const tabId = `tab-${randomUUID()}`
  const state = structuredClone(s.state)
  state.id = tabId
  const web = state.conversations.find(c => c.id === s.web)!
  web.assignment = { ...web.assignment!, status: 'done' }
  delete web.pullRequestUrls
  web.lastMessageSequence = 30
  state.conversations.find(c => c.id === 'lead')!.lastMessageSequence = 40
  edit(state, s)
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

describe('link lists rebuilt from history (moved from the store, design R8)', () => {
  const link = (n: number) => `https://github.com/autonomous-ai/openharness/pull/${n}`
  const links = async (tabId: string, group: string) => (await db.$transaction(tx => parts.loadAll(tx, tabId))).groups.find(g => g.key === group)!.data!.pullRequestUrls

  /** The done group from before link lists. */
  const legacyDone = (state: SuperTabState, s: ReturnType<typeof richSwarm>) => { delete state.conversations.find(c => c.id === s.done)!.pullRequestUrls }

  it('finds a link in a message older than the latest page of 100', async () => {
    const { s, tabId } = await legacySwarm(legacyDone)
    const author: Author = { kind: 'person', id: 'owner', name: 'owner@example.com', membershipGeneration: 'tab' }
    await db.superTabMessage.createMany({ data: Array.from({ length: 150 }, (_, i) => ({ id: `${tabId}-page-${i}`, tabId, conversationId: s.done,
      sequence: 100 + i, author: author as never, text: i === 0 ? `First PR ${link(11)}` : `Update ${i}`, recipientIds: [], mentions: [] })) })
    await migrateSwarm(db, tabId, { now: () => NOW })
    expect(await links(tabId, s.done)).toEqual([link(11)])
  })

  it('finds links in check evidence and in a work result', async () => {
    const { s, tabId } = await legacySwarm((state, s) => {
      legacyDone(state, s)
      const done = state.conversations.find(c => c.id === s.done)!
      done.checks = [{ id: 'c1', description: 'Works', independent: false, evidence: `Ran it in ${link(21)}`, passedBy: 'agent' }]
      done.assignment = { ...state.conversations.find(c => c.id === s.web)!.assignment!, id: 'w2', status: 'done', result: `Merged ${link(22)}` }
    })
    await migrateSwarm(db, tabId, { now: () => NOW })
    expect(await links(tabId, s.done)).toEqual([link(21), link(22)])
  })

  it('finds links in earlier attempts of the group', async () => {
    const { s, tabId } = await legacySwarm(legacyDone)
    await db.superTabAttempt.create({ data: { id: `${tabId}-attempt`, tabId, conversationId: s.done,
      snapshot: { checks: [{ evidence: `Tried ${link(31)}` }], assignment: { result: `Abandoned ${link(32)}` } } } })
    await migrateSwarm(db, tabId, { now: () => NOW })
    expect(await links(tabId, s.done)).toEqual([link(31), link(32)])
  })
})

describe('rolling back (design 6.4)', () => {
  it('before any new write, puts the old state back unchanged and drops the Swarm\'s parts', async () => {
    const { tabId, state } = await legacySwarm()
    await migrateSwarm(db, tabId, { now: () => NOW })
    expect(await rollbackLegacy(db, tabId)).toMatchObject({ tabId, ok: true })
    expect(await db.superTab.findUnique({ where: { id: tabId } })).toMatchObject({ format: 1, revision: R + 1, migratedAt: null, legacyState: null,
      state: JSON.parse(JSON.stringify(state)) })
    expect(await partCount(tabId)).toBe(0)
    // And it migrates again from there.
    expect(await migrateSwarm(db, tabId, { now: () => NOW })).toMatchObject({ ok: true })
  })

  it('refuses the plain rollback once parts were written after the migration, since it would lose them', async () => {
    const { s, tabId } = await legacySwarm()
    await migrateSwarm(db, tabId, { now: () => NOW })
    await db.$transaction(async tx => {
      const lead = (await parts.loadActive(tx, tabId)).groups.find(g => g.key === 'lead')!
      await guardedWrite(tx, tabId, { op: 'update', kind: 'group', key: 'lead', seen: lead.version, data: { ...lead.data!, title: 'Changed' } }, NOW + 1)
    })
    void s
    expect(await rollbackLegacy(db, tabId)).toMatchObject({ ok: false, error: expect.stringContaining('written since') })
    expect(await db.superTab.findUnique({ where: { id: tabId } })).toMatchObject({ format: 2 })
  })

  it('after new writes, rebuilds the old state from the parts, numbering past every sequence and number used since', async () => {
    const { s, tabId } = await legacySwarm()
    await migrateSwarm(db, tabId, { now: () => NOW })
    await db.$transaction(async tx => {
      const loaded = await parts.loadActive(tx, tabId)
      const lead = loaded.groups.find(g => g.key === 'lead')!
      await guardedWrite(tx, tabId, { op: 'update', kind: 'group', key: 'lead', seen: lead.version,
        data: { ...lead.data!, title: 'Changed', messageSeq: R + 3, lastMessageSequence: R + 3 } }, NOW + 1)
      await guardedWrite(tx, tabId, { op: 'update', kind: 'head', key: 'head', seen: loaded.head.version, data: loaded.head.data,
        head: { groupCounter: 9, visibilityEpoch: 1, sequenceBase: R } }, NOW + 1)
    })
    await db.superTabMessage.create({ data: { id: `${tabId}-new`, tabId, conversationId: 'lead', sequence: R + 3, author: {}, text: 'New', recipientIds: [], mentions: [] } })
    expect(await rollbackFromParts(db, tabId)).toMatchObject({ tabId, ok: true })
    const row = (await db.superTab.findUnique({ where: { id: tabId } }))!
    expect(row).toMatchObject({ format: 1, revision: R + 4, migratedAt: null })
    const state = row.state as unknown as SuperTabState
    expect(state.version).toBe(1)
    expect(state.conversations.find(c => c.id === 'lead')).toMatchObject({ title: 'Changed', lastMessageSequence: R + 3 })
    expect(state.conversations.find(c => c.id === 'lead')).not.toHaveProperty('messageSeq')
    expect(state).not.toHaveProperty('groupCounter')
    expect(state.retiredConversationNumber).toBe(9)
    expect(state.conversations.find(c => c.id === s.web)!.pullRequestUrls).toEqual([PR])
    // The previous release reads it as it read any Swarm.
    expect(() => visibleState(state, { kind: 'person', userId: state.ownerId, email: 'owner@example.com' }, NOW)).not.toThrow()
  })
})

describe('the migration job (design 6.1.1)', () => {
  const instant = async () => {}

  it('refuses to start while a writer is still running', async () => {
    const { tabId } = await legacySwarm()
    const sleep = async () => { await db.superTabMessage.create({ data: { id: `${tabId}-late`, tabId, conversationId: 'lead', sequence: R, author: {},
      text: 'Still here', recipientIds: [], mentions: [] } }) }
    await expect(migrateAll(db, { now: () => NOW, sleep })).rejects.toThrow('a writer is still running')
    expect(await db.superTab.findUnique({ where: { id: tabId } })).toMatchObject({ format: 1 })
  })

  it('migrates every Swarm still in one row once writers are quiet, and reports each one', async () => {
    const [a, b] = [await legacySwarm(), await legacySwarm()]
    const run = await migrateAll(db, { now: () => NOW, sleep: instant })
    expect(run.reports.map(r => r.tabId)).toEqual(expect.arrayContaining([a.tabId, b.tabId]))
    expect(run.reports.find(r => r.tabId === a.tabId)).toMatchObject({ ok: true, groups: a.state.conversations.length })
    expect(run.totals).toMatchObject({ swarms: run.reports.length, failed: run.reports.filter(r => !r.ok).length })
    expect(await db.superTab.count({ where: { id: { in: [a.tabId, b.tabId] }, format: 2 } })).toBe(2)
  })
})
