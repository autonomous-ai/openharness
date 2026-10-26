/**
 * The migration's local dry run (docs/design/2026-10-26-swarm-state-parts.md 6.5): synthetic production-shaped Swarms on
 * a loopback replica set this script starts itself (never DATABASE_URL or a remote host), each step timed:
 * seed → migrate → verify (migrate again: nothing to do) → read by parts → commands through the store → roll back → old read.
 * Also bytes per poll, before (old full-state reads) and after (first load, changes, host form).
 *
 *   NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=<test key, as the suites use> node --import tsx scripts/swarm-parts/dry-run.ts [--out artifacts]
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../../src/lib/ssoAuth.js'
import type { Command } from '../../src/superTabs/commands.js'
import { SuperTabStore } from '../../src/superTabs/store.js'
import { visibleState, type SuperTabState } from '../../src/superTabs/model.js'
import { migrateAll } from '../../src/superTabs/migration/job.js'
import { rollbackFromParts, rollbackLegacy } from '../../src/superTabs/migration/rollback.js'
import { stateDifference } from '../../src/superTabs/migration/verify.js'
import { SwarmReads } from '../../src/superTabs/read/service.js'
import { HostReads } from '../../src/superTabs/read/host.js'
import { writeLegacySwarm } from './legacy.js'
import { buildSwarm, PRODUCTION_SHAPED } from './shape.js'

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
      await db.machine.createMany({ data: s.state.machines!.map(m => ({ machineId: m.machineId, userId: s.state.ownerId, apiKey: 'dry-run', managerId: 'dry-run', autonomousEnv: 'prod', authMode: 'remote' })) })
    }
  })
  // Dated two minutes back, so readers on the real clock (as the store stamps commands) poll past the 30 s overlap.
  const migration = await step('2 migrate', () => migrateAll(db, { waitMs: 2_000, now: () => Date.now() - 120_000 }))
  const again = await step('3 verify: migrate again', () => migrateAll(db, { waitMs: 0 }))

  const store = new SuperTabStore(db)
  const reads = new SwarmReads(store), hosts = new HostReads(store)
  const owner = (s: typeof seeded[number]): AuthUser => ({ sub: s.state.ownerId, email: s.state.people[0]!.email, autonomousEnv: 'prod', role: 'user' })
  const polls = await step('4 read by parts', async () => Promise.all(seeded.map(async s => {
    const first = await reads.firstLoad(owner(s), s.state.id)
    const machineId = s.state.machines![0]!.machineId
    const hostFull = await hosts.changes(owner(s), machineId, { full: true })
    return { s, first, machineId, hostFull }
  })).then(loads => Promise.all(loads.map(async ({ s, first, machineId, hostFull }) => {
    const idle = await reads.changes(owner(s), s.state.id, first.cursor)
    const hostIdle = await hosts.changes(owner(s), machineId, { cursor: hostFull.cursor })
    return { name: s.spec.name, cursor: first.cursor, machineId,
      // Today's Desktop poll: GET /:tabId, the reader's whole visible state, every 3 s.
      oldDesktopPoll: bytes({ revision: s.revision, state: visibleState(s.state, { kind: 'person', userId: s.state.ownerId, email: s.state.people[0]!.email }, now) }),
      firstLoad: bytes(first), idleChanges: bytes(idle), hostFull: bytes(hostFull), hostIdle: bytes(hostIdle) }
  }))))
  const [big, medium] = [seeded[0]!, seeded[1]!]
  const written = await step('5 commands through the store by parts, then poll', async () => {
    const poll = polls[0]!
    const working = big.state.conversations.find(c => c.assignment?.status === 'working')!
    const runsIt = working.assignment!.execution.machineId
    const [hostCursor, runnerCursor] = [(await hosts.changes(owner(big), poll.machineId, { full: true })).cursor,
      (await hosts.changes(owner(big), runsIt, { full: true })).cursor]
    const results = []
    for (const s of [big, medium]) {
      const group = s.state.conversations.find(c => c.assignment?.status === 'working')!
      const run = (command: Command) => store.execute(owner(s), s.state.id, { operationId: randomUUID(), command })
      results.push(await run({ type: 'conversation.rename', conversationId: group.id, title: `${group.title} (renamed)` }),
        await run({ type: 'message.send', conversationId: group.id, text: 'Posted after the migration.', replyTo: null, recipientIds: [] }))
    }
    const changes = await reads.changes(owner(big), big.state.id, poll.cursor)
    // A host none of whose agents is in the group sleeps through it; the one running its work wakes for that Swarm alone.
    const [host, runner] = [await hosts.changes(owner(big), poll.machineId, { cursor: hostCursor }), await hosts.changes(owner(big), runsIt, { cursor: runnerCursor })]
    return { commands: results.length, partsWritten: results.map(r => r.parts.length), changesAfterTwoCommands: bytes(changes),
      groupsSent: 'groups' in changes ? changes.groups.length : null, otherHost: { bytes: bytes(host), tabs: host.tabs.length },
      runningHost: { bytes: bytes(runner), tabs: runner.tabs.map(t => t.tabId === big.state.id ? 'big' : t.tabId) } }
  })
  // Written in parts since the migration: rebuilt from the parts. The others go back to their old state unchanged.
  const rollbacks = await step('6 roll back', async () => [await rollbackFromParts(db, big.state.id), await rollbackFromParts(db, medium.state.id),
    ...await Promise.all(seeded.slice(2).map(s => rollbackLegacy(db, s.state.id)))])
  const oldReads = await step('7 old read of every Swarm', async () => Promise.all(seeded.map(async s => {
    const row = (await db.superTab.findUnique({ where: { id: s.state.id } }))!
    const state = row.state as unknown as SuperTabState
    visibleState(state, { kind: 'person', userId: state.ownerId, email: s.state.people[0]!.email }, now)
    const newest = (await db.superTabMessage.findFirst({ where: { tabId: s.state.id }, orderBy: { sequence: 'desc' }, select: { sequence: true } }))?.sequence ?? 0
    return { name: s.spec.name, format: row.format, version: state.version, revisionAboveEverySequence: row.revision > newest,
      unchanged: s === big || s === medium ? null : stateDifference(s.state, state) === null }
  })))

  const report = { at: new Date(now).toISOString(), timings, migration: migration.reports.map(r => ({ ...r, name: seeded.find(s => s.state.id === r.tabId)?.spec.name })),
    totals: migration.totals, again: again.totals, polls: polls.map(({ cursor: _c, machineId: _m, ...p }) => p), written, rollbacks, oldReads }
  mkdirSync(out, { recursive: true })
  const file = join(out, `swarm-parts-migration-${report.at.slice(0, 10)}.json`)
  writeFileSync(file, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ totals: report.totals, again: report.again, timings, polls: report.polls.slice(0, 2), written, rolledBack: rollbacks.every(r => r.ok),
    oldReads: oldReads.every(r => r.format === 1 && r.version === 1 && r.revisionAboveEverySequence && r.unchanged !== false) }, null, 2))
  console.log(`report: ${file}`)
} finally {
  await db.$disconnect()
  await replica.stop()
}
