/**
 * The migration's local dry run (docs/design/2026-10-26-swarm-state-parts.md 6.5): synthetic production-shaped Swarms on
 * a loopback replica set this script starts itself (never DATABASE_URL or a remote host), each step timed:
 * seed → migrate → verify (migrate again: nothing to do) → read by parts → write in parts → roll back → old read.
 * Also bytes per poll, before (old full-state reads) and after (first load, changes, host form).
 *
 *   NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=<test key, as the suites use> node --import tsx scripts/swarm-parts/dry-run.ts [--out artifacts]
 */
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../../src/lib/ssoAuth.js'
import { SuperTabStore } from '../../src/superTabs/store.js'
import { visibleState, type Conversation, type SuperTabState } from '../../src/superTabs/model.js'
import * as parts from '../../src/superTabs/parts/index.js'
import { guardedWrite } from '../../src/superTabs/parts/write.js'
import { migrateAll } from '../../src/superTabs/migration/job.js'
import { rollbackFromParts, rollbackLegacy } from '../../src/superTabs/migration/rollback.js'
import { stateDifference } from '../../src/superTabs/migration/verify.js'
import { SwarmReads } from '../../src/superTabs/read/service.js'
import { HostReads } from '../../src/superTabs/read/host.js'
import { writeLegacySwarm } from './legacy.js'
import { buildSwarm, personId, PRODUCTION_SHAPED } from './shape.js'

const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1]! : 'artifacts'
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const timings: Record<string, number> = {}
async function step<T>(name: string, body: () => Promise<T>): Promise<T> {
  const started = performance.now()
  const result = await body()
  timings[name] = Math.round(performance.now() - started)
  console.log(`${name}: ${timings[name]} ms`)
  return result
}

const replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
  replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
const uri = replica.getUri('swarm_parts_dry_run')
const db = new PrismaClient({ datasources: { db: { url: uri } } })
try {
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], { env: { ...process.env, DATABASE_URL: uri }, timeout: 120_000 })
  const now = Date.now()
  const seeded = PRODUCTION_SHAPED.map((spec, index) => ({ spec, index, ...buildSwarm(spec, index, now) }))
  await step('1 seed', async () => {
    for (const s of seeded) {
      await writeLegacySwarm(db, s)
      if (s.attempts.length) await db.superTabAttempt.createMany({ data: s.attempts.map(a => ({ ...a, tabId: s.state.id, snapshot: a.snapshot as never })) })
      await db.user.createMany({ data: s.state.people.map(p => ({ id: p.id, externalId: `dry-run-${p.id}`, email: p.email, autonomousEnv: 'prod' })) })
      await db.machine.create({ data: { machineId: s.state.machines![0]!.machineId, userId: s.state.ownerId, apiKey: 'dry-run', managerId: 'dry-run', autonomousEnv: 'prod', authMode: 'remote' } })
    }
  })
  const migration = await step('2 migrate', () => migrateAll(db, { waitMs: 2_000 }))
  const again = await step('3 verify: migrate again', () => migrateAll(db, { waitMs: 0 }))

  const store = new SuperTabStore(db)
  // Readers poll in steady state: a minute after the migration, past the 30 s overlap that resends recent changes.
  let clock = Date.now() + 60_000
  const reads = new SwarmReads(db, store, { now: () => clock }), hosts = new HostReads(db, store, { now: () => clock })
  const owner = (s: typeof seeded[number]): AuthUser => ({ sub: s.state.ownerId, email: s.state.people[0]!.email, autonomousEnv: 'prod', role: 'user' })
  const polls = await step('4 read by parts', async () => Promise.all(seeded.map(async s => {
    const first = await reads.firstLoad(owner(s), s.state.id)
    const machineId = s.state.machines![0]!.machineId
    const hostFull = await hosts.changes(owner(s), machineId, { full: true })
    return { s, first, machineId, hostFull }
  })).then(loads => { clock += 3_000; return Promise.all(loads.map(async ({ s, first, machineId, hostFull }) => {
    const idle = await reads.changes(owner(s), s.state.id, first.cursor)
    const hostIdle = await hosts.changes(owner(s), machineId, { cursor: hostFull.cursor })
    return { name: s.spec.name, cursor: first.cursor, machineId,
      // Today's Desktop poll: GET /:tabId, the reader's whole visible state, every 3 s.
      oldDesktopPoll: bytes({ revision: s.revision, state: visibleState(s.state, { kind: 'person', userId: s.state.ownerId, email: s.state.people[0]!.email }, now) }),
      firstLoad: bytes(first), idleChanges: bytes(idle), hostFull: bytes(hostFull), hostIdle: bytes(hostIdle) }
  }))}))
  const big = seeded[0]!
  const written = await step('5 write in parts (one group) and poll', async () => {
    const group = big.state.conversations.find(c => c.assignment?.status === 'working')!
    await db.$transaction(async tx => {
      const current = (await parts.loadActive(tx, big.state.id, { groupIds: [group.id] })).groups.find(g => g.key === group.id)!
      await guardedWrite(tx, big.state.id, { op: 'update', kind: 'group', key: group.id, seen: current.version,
        data: { ...(current.data as Conversation), title: `${group.title} (renamed)` } }, clock + 1_000)
    })
    const poll = polls[0]!
    const hostCursor = (await hosts.changes(owner(big), poll.machineId, { full: true })).cursor
    clock += 3_000
    const changes = await reads.changes(owner(big), big.state.id, poll.cursor)
    // The host wakes for it only if the group concerns this machine (one of its agents, or its execution).
    const host = await hosts.changes(owner(big), poll.machineId, { cursor: hostCursor })
    return { changesAfterOneWrite: bytes(changes), groupsSent: 'groups' in changes ? changes.groups.length : null, hostAfterTheWrite: bytes(host),
      hostTabsSent: host.tabs.length }
  })
  const rollbacks = await step('6 roll back', async () => [await rollbackFromParts(db, big.state.id),
    ...await Promise.all(seeded.slice(1).map(s => rollbackLegacy(db, s.state.id)))])
  const oldReads = await step('7 old read of every Swarm', async () => Promise.all(seeded.map(async s => {
    const row = (await db.superTab.findUnique({ where: { id: s.state.id } }))!
    const state = row.state as unknown as SuperTabState
    visibleState(state, { kind: 'person', userId: state.ownerId, email: s.state.people[0]!.email }, now)
    return { name: s.spec.name, format: row.format, version: state.version,
      unchanged: s === big ? null : stateDifference(s.state, state) === null }
  })))

  const report = { at: new Date(now).toISOString(), timings, migration: migration.reports.map(r => ({ ...r, name: seeded.find(s => s.state.id === r.tabId)?.spec.name })),
    totals: migration.totals, again: again.totals, polls: polls.map(({ cursor: _c, machineId: _m, ...p }) => p), written, rollbacks, oldReads }
  mkdirSync(out, { recursive: true })
  const file = join(out, `swarm-parts-migration-${report.at.slice(0, 10)}.json`)
  writeFileSync(file, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ totals: report.totals, again: report.again, timings, polls: report.polls.slice(0, 2), written, rolledBack: rollbacks.every(r => r.ok),
    oldReads: oldReads.every(r => r.format === 1 && r.version === 1 && r.unchanged !== false) }, null, 2))
  console.log(`report: ${file}`)
  void personId
} finally {
  await db.$disconnect()
  await replica.stop()
}
