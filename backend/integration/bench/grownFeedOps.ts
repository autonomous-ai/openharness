import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../../src/lib/ssoAuth.js'
import type { Changes } from '../../src/superTabs/read/contract.js'
import { readDelta } from '../../src/superTabs/cachedReads.js'
import { listGroupIndexes } from '../../src/superTabs/parts/indexed.js'
import { parseArgs } from './config.js'
import { partsDriver } from './drivers/parts.js'
import { machineId, seedAccounts } from './fixtures.js'
import { storeRoutes } from './legacyDriver.js'
import { localDatabase } from './mongo.js'
import { plan } from './plan.js'
import { startProfiling } from './profile.js'
import { seedSwarm } from './seed.js'
import { benchStamps } from './stamps.js'

/**
 * Database operations per call once a Swarm's starts and quiet conversations have grown (task #2839: Atlas ops per request
 * rose 38% at flat traffic, with SwarmStart and SwarmGroup getMores growing). The benchmark's seeded Swarm gets `--starts`
 * finished starts (kept 7 days) and `--dormant` quiet conversations of its Lead, written as rows; then each call runs once
 * after a post, the way production runs them after any change, and the profiler counts its commands and getMores by
 * collection. From `backend/`:
 *
 *   NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
 *     DATABASE_URL=mongodb://127.0.0.1:1/bench-never-used npx tsx integration/bench/grownFeedOps.ts [--starts 3000] [--dormant 1500]
 */
async function main() {
  const argv = process.argv.slice(2)
  const flag = (name: string, fallback: number) => { const i = argv.indexOf(name); return i < 0 ? fallback : Number(argv[i + 1]) }
  const starts = flag('--starts', 3000), dormant = flag('--dormant', 1500)
  const { config } = parseArgs(argv.filter((arg, i) => !['--starts', '--dormant'].includes(arg) && !['--starts', '--dormant'].includes(argv[i - 1]!)))
  const database = await localDatabase()
  await listGroupIndexes(database.db)
  const stamps = await benchStamps('memory', readDelta(database.db))
  try {
    const people = await seedAccounts(database.db, config.machines)
    const driver = await partsDriver(database.db, () => people)
    const { call, close } = await storeRoutes(database.db, () => people)
    const { swarm } = await seedSwarm(driver, config, plan(config), people)
    await grow(database.db, swarm.tabId, swarm.leadId, starts, dormant)
    const owner = people[0]!, host = people[1]!
    const worker = swarm.workers.find(w => w.machine === 1) ?? swarm.workers[0]!
    let cursor = (await call<{ cursor: string }>(owner, 'GET', `/api/super-tabs/${swarm.tabId}/parts`)).data!.cursor
    const hostReader = driver.hostReader(host, machineId(1))
    await hostReader.poll()
    let n = 0
    const post = async () => {
      const { code } = await driver.execute(swarm.tabId, owner, `grown-${n++}`, { type: 'message.send', conversationId: worker.group, text: 'One post.', replyTo: null, recipientIds: [] })
      if (code) throw new Error(`post: ${code}`)
    }
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['GET changes (Desktop poll)', async () => {
        const reply = await call<Changes>(owner, 'GET', `/api/super-tabs/${swarm.tabId}/changes?cursor=${cursor}`)
        if (!reply.data || 'reload' in reply.data && reply.data.reload) throw new Error(`changes: ${reply.code ?? 'reload'}`)
        cursor = (reply.data as { cursor: string }).cursor
      }],
      ['host poll (its rows by change)', () => hostReader.poll()],
      ['GET parts (first load)', () => call(owner, 'GET', `/api/super-tabs/${swarm.tabId}/parts`)],
      ['GET deliveries (the Lead)', () => driver.deliveries(swarm.tabId, owner, swarm.leadId)],
      ['GET lead messages', () => call(owner, 'GET', `/api/super-tabs/${swarm.tabId}/conversations/lead/messages`)],
      ['POST commands (message.send)', post],
    ]
    process.stdout.write(`Grown Swarm: ${starts} finished starts, ${dormant} quiet Lead conversations, ${config.groups} groups\n\n`)
    process.stdout.write('| Call, after one post | Commands | getMores | Docs returned | KB from MongoDB | SwarmStart (cmd+getMore) | SwarmGroup (cmd+getMore) |\n|---|---|---|---|---|---|---|\n')
    for (const [label, run] of calls) {
      for (let i = 0; i < 2; i++) { await post(); await run() } // warm the cache as production's is
      await post()
      await startProfiling(database.db)
      await run()
      const rows = await profiled(database.db)
      const kind = (name: string) => rows.filter(r => r.collection === name)
      const ops = (list: Row[]) => `${list.filter(r => r.op !== 'getmore').length}+${list.filter(r => r.op === 'getmore').length}`
      process.stdout.write(`| ${label} | ${rows.filter(r => r.op !== 'getmore').length} | ${rows.filter(r => r.op === 'getmore').length} | ` +
        `${rows.reduce((s, r) => s + r.returned, 0)} | ${(rows.reduce((s, r) => s + r.bytes, 0) / 1024).toFixed(1)} | ${ops(kind('SwarmStart'))} | ${ops(kind('SwarmGroup'))} |\n`)
      if (process.env.GROWN_SHAPES) for (const r of rows.filter(r => r.collection.startsWith('Swarm') && r.returned > 50)) process.stdout.write(`  ${r.collection} ${r.op} n=${r.returned} ${r.plan}\n`)
    }
    await close()
    await driver.close()
  } finally {
    await stamps.close()
    await database.stop()
  }
}

interface Row { collection: string; op: string; returned: number; bytes: number; plan: string }

/** Every operation profiled since startProfiling, the profiler's own and system collections left out. */
async function profiled(db: PrismaClient): Promise<Row[]> {
  await db.$runCommandRaw({ profile: 0 })
  const found = (await db.$runCommandRaw({ aggregate: 'system.profile', cursor: { batchSize: 100_000 }, pipeline: [
    { $match: { op: { $in: ['command', 'query', 'getmore'] }, ns: { $not: { $regex: String.raw`\.(system\.|\$cmd)` } } } },
    { $project: { _id: 0, ns: 1, op: 1, nreturned: 1, responseLength: 1, planSummary: 1, aggregate: '$command.aggregate', find: '$command.find' } }] }) as unknown as
    { cursor: { firstBatch: Array<{ ns: string; op: string; nreturned?: number; responseLength?: number; planSummary?: string; aggregate?: unknown; find?: unknown }> } }).cursor.firstBatch
  return found.filter(r => r.op !== 'command' || r.aggregate || r.find).map(r => ({ collection: r.ns.slice(r.ns.indexOf('.') + 1), op: r.op,
    returned: Number(r.nreturned ?? 0), bytes: Number(r.responseLength ?? 0), plan: r.planSummary ?? '' }))
}

/** Rows as the Swarm's own writes leave them: finished starts (each failed before it had a harness, finished within the last
 *  week) and quiet conversations of the Lead, copies of a seeded conversation. */
async function grow(db: PrismaClient, tabId: string, leadId: string, starts: number, dormant: number) {
  const now = Date.now(), template = (await db.swarmGroup.findFirst({ where: { tabId, dormant: false, kind: null } }))!
  const at = (i: number) => new Date(now - 3_600_000 - i * 60_000)
  for (let i = 0; i < starts; i += 500) {
    await db.swarmStart.createMany({ data: Array.from({ length: Math.min(500, starts - i) }, (_, j) => {
      const key = `grown-start-${i + j}`, conversationId = template.key
      return { id: `${tabId}:${key}`, tabId, key, version: 2, changedAt: at(i + j), deleted: false, ordinal: 1, machineId: machineId(1), conversationId,
        agentId: null, finishedAt: at(i + j), data: { id: key, creationId: key, actorKey: 'bench', contributorId: 'bench', membershipGeneration: 'bench',
          machineOwnerId: 'bench', hostGrant: null, harnessId: null, dispatched: false, error: 'bench: failed before a harness', requestedAt: at(i + j).getTime(),
          request: { conversationId, machineId: machineId(1), engine: 'codex', name: `Grown ${i + j}`, cwd: '/bench/repo', worktree: false,
            requirements: { memoryBytes: 1, diskBytes: 1, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } } } }
    }) })
  }
  const data = template.data as Record<string, unknown>
  for (let i = 0; i < dormant; i += 500) {
    await db.swarmGroup.createMany({ data: Array.from({ length: Math.min(500, dormant - i) }, (_, j) => {
      const key = `grown-group-${i + j}`
      const { id: _id, ...row } = template as Record<string, unknown> & { id: string }
      return { ...row, id: `${tabId}:${key}`, key, version: 2, changedAt: at(i + j), lastActivityAt: at(i + j), dormant: true, agentIds: [leadId],
        executionMachineId: null, data: { ...data, id: key, title: `Grown ${i + j}`, agentIds: [leadId], dormant: true, assignment: null } } as never
    }) })
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
