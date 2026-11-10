import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { DAY_MS, weekStart } from '../src/superTabs/leaderboard/week.js'
import { EVIDENCE_RETENTION_MS, readEvidence } from '../src/superTabs/evidence/store.js'
import { sweepSwarms } from '../src/superTabs/sweeps.js'

// Evidence routing (Ken, 2026-10-29): each Swarm keeps per model and kind of job what its attempts cost and how they went.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '300000000000000000000011', email: 'evidence-owner@example.com', autonomousEnv: 'prod', role: 'user' }
const T0 = Date.UTC(2026, 9, 6, 9)

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_evidence_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  await db.user.create({ data: { id: owner.sub, externalId: `fixture-${owner.sub}`, email: owner.email, autonomousEnv: owner.autonomousEnv } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm, and a read of its evidence since [since], a day before T0 unless given. */
async function swarm() {
  const store = new SuperTabStore(db, () => T0, null)
  const tab = (await store.create(owner, randomUUID(), 'Evidence', 'public')).id
  const evidence = (since = T0 - DAY_MS) => readEvidence(db, tab, since)
  return { tab, evidence }
}

describe('a Swarm\'s evidence per model and kind of job', () => {
  // Review of #2173: each row keeps its project, so the report can show a reader only the projects they see; Swarm-wide totals
  // are the sum over projects.
  it('sums every project by default, reads only the projects asked for, and merges their last ten by time', async () => {
    const f = await swarm(), week = weekStart(T0)
    const row = (projectId: string, attempts: number) => db.superTabModelEvidence.create({ data: { id: `${f.tab}-${projectId}`, tabId: f.tab, projectId,
      engine: 'claude', model: 'opus', kind: 'backend', week: new Date(week), attempts, shipped: attempts, updatedAt: new Date(T0) } })
    const recent = (projectId: string, results: Array<[number, boolean]>) => db.superTabModelRecent.create({ data: { id: `${f.tab}-r-${projectId}`, tabId: f.tab,
      projectId, engine: 'claude', model: 'opus', kind: 'backend', results: results.map(([at, passed], i) => ({ a: `${projectId}-${i}`, at, passed })), updatedAt: new Date(T0) } })
    await row('p1', 2)
    await row('p2', 5)
    await recent('p1', [[1, true], [3, true], [5, true], [7, true], [9, true], [11, true]])
    await recent('p2', [[2, false], [4, false], [6, false], [8, false], [10, false], [12, false]])
    const all = await f.evidence()
    expect(all.models.map(m => [m.attempts, m.shipped])).toEqual([[7, 7]])
    expect(all.models[0]!.recent).toEqual([true, false, true, false, true, false, true, false, true, false])
    expect(all.weeks.map(w => [w.projectId, w.attempts])).toEqual([['p1', 2], ['p2', 5]])
    const one = await readEvidence(db, f.tab, T0 - DAY_MS, ['p1'])
    expect(one.models.map(m => [m.attempts, m.recent.length])).toEqual([[2, 6]])
    expect(one.weeks.map(w => w.projectId)).toEqual(['p1'])
    expect((await readEvidence(db, f.tab, T0 - DAY_MS, [])).models).toEqual([])
  })

  it('prunes every Swarm\'s rows past 180 days in the hourly sweep, with no write in that Swarm', async () => {
    const f = await swarm(), other = await swarm(), now = T0 + 400 * DAY_MS
    const cut = weekStart(now - EVIDENCE_RETENTION_MS)
    for (const tabId of [f.tab, other.tab]) {
      for (const [name, week] of [['old', cut - 7 * DAY_MS], ['kept', cut]] as const) {
        await db.superTabModelEvidence.create({ data: { id: `${tabId}-sweep-${name}`, tabId, projectId: 'p1', engine: 'claude', model: 'opus', kind: 'docs',
          week: new Date(week), attempts: 1, updatedAt: new Date(week) } })
      }
      for (const [name, at] of [['old', now - EVIDENCE_RETENTION_MS - DAY_MS], ['kept', now - EVIDENCE_RETENTION_MS + DAY_MS]] as const) {
        await db.superTabModelRecent.create({ data: { id: `${tabId}-sweep-r-${name}`, tabId, projectId: 'p1', engine: 'claude', model: `opus-${name}`, kind: 'docs',
          results: [], updatedAt: new Date(at) } })
      }
    }
    const result = await sweepSwarms(db, now)
    expect(result.evidenceExpired).toBeGreaterThanOrEqual(4)
    for (const tabId of [f.tab, other.tab]) {
      expect((await db.superTabModelEvidence.findMany({ where: { tabId, id: { startsWith: `${tabId}-sweep` } } })).map(r => r.id)).toEqual([`${tabId}-sweep-kept`])
      expect((await db.superTabModelRecent.findMany({ where: { tabId, id: { startsWith: `${tabId}-sweep` } } })).map(r => r.id)).toEqual([`${tabId}-sweep-r-kept`])
    }
  })
})
