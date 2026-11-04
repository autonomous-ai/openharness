import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
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
import { bytesOut } from './probe.js'
import { PROFILE_STAGES, profileEntry, startProfiling, type ProfileEntry } from './profile.js'
import { seedSwarm } from './seed.js'
import { benchStamps } from './stamps.js'

/** Past the change reads' 30 s overlap, so the polls after it resend nothing they sent before. */
const QUIET_MS = 35_000
const PARTS = new Set(['SwarmHead', 'SwarmMember', 'SwarmGroup', 'SwarmAgent', 'SwarmMachine', 'SwarmStart', 'SwarmProgress'])

interface Poller { label: string; poll(): Promise<{ bytes: number; code: string | null }> }

/**
 * What one `GET changes` poll costs MongoDB with many pollers on one backend process (task #2783): the benchmark's seeded
 * Swarm, every person's windows and every worker agent polling as clients do, then rounds where all of them poll at once,
 * after nothing, after one machine's reading, after every machine's and after one post. Per poll: database operations
 * (all, and part reads), what MongoDB sent (`serverStatus` bytes out), the profiler's database time, wall time and reply
 * size; per round, operations and bytes by collection. `--light` polls with `machines=light` as the 17:30 CLI does;
 * POLL_COST_SHAPES=1 prints each part read's command. Takes the benchmark's options too. From `backend/`:
 *
 *   NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
 *     DATABASE_URL=mongodb://127.0.0.1:1/bench-never-used npx tsx integration/bench/changesPollCost.ts [--windows 3] [--rounds 5] [--light]
 */
async function main() {
  const argv = process.argv.slice(2)
  const flag = (name: string, fallback: number) => { const i = argv.indexOf(name); return i < 0 ? fallback : Number(argv[i + 1]) }
  const windows = flag('--windows', 3), rounds = flag('--rounds', 5), light = argv.includes('--light')
  const rest = argv.filter((arg, i) => !['--windows', '--rounds', '--light'].includes(arg) && !['--windows', '--rounds'].includes(argv[i - 1]!))
  const { config } = parseArgs(rest)
  const database = await localDatabase()
  await listGroupIndexes(database.db)
  const stamps = await benchStamps('memory', readDelta(database.db))
  try {
    const people = await seedAccounts(database.db, config.machines)
    const driver = await partsDriver(database.db, () => people)
    const { call, close } = await storeRoutes(database.db, () => people)
    const { swarm } = await seedSwarm(driver, config, plan(config), people)
    const query = light ? '&machines=light' : ''
    const poller = (label: string, user: AuthUser, asAgentId?: string): Poller => {
      let cursor: string | null = null
      const as = asAgentId ? `asAgentId=${asAgentId}` : ''
      return { label, async poll() {
        if (cursor === null) {
          const reply = await call<{ cursor: string }>(user, 'GET', `/api/super-tabs/${swarm.tabId}/parts${as ? `?${as}` : ''}`)
          cursor = reply.data?.cursor ?? null
          return reply
        }
        const reply = await call<Changes>(user, 'GET', `/api/super-tabs/${swarm.tabId}/changes?cursor=${cursor}${as ? `&${as}` : ''}${query}`)
        if (reply.data?.reload) throw new Error(`${label} was told to reload`)
        if (reply.data) cursor = reply.data.cursor
        return reply
      } }
    }
    const pollers: Poller[] = [
      ...people.flatMap((person, n) => Array.from({ length: windows }, (_, w) => poller(`person ${n} window ${w}`, person))),
      ...swarm.workers.map(w => poller(`agent ${w.id}`, people[w.machine]!, w.id)),
    ]
    let n = 0
    const reading = (machine: number) => driver.observeMachine(swarm.tabId, people[machine]!, machineId(machine), {
      generation: swarm.generations[machine]!, quotas: [], tools: {}, runningHarnessIds: machine === 0 ? ['bench-lead'] : [], stoppedHarnessIds: [],
      resources: { cpuPercent: 10 + (n++ % 50), memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9, diskTotalBytes: 500e9,
        projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Bench', os: 'macOS', gpuPercent: null } })
    const post = () => driver.execute(swarm.tabId, people[0]!, `poll-cost-${n++}`,
      { type: 'message.send', conversationId: swarm.workers[0]!.group, text: 'One post.', replyTo: null, recipientIds: [] })
    for (const p of pollers) await p.poll()
    await sleep(QUIET_MS)
    for (const p of pollers) await p.poll()
    process.stdout.write(`${pollers.length} pollers (${people.length} people × ${windows} windows, ${swarm.workers.length} agents), ` +
      `${config.machines} machines, ${config.groups} groups${light ? ', machines=light' : ''}\n\n`)
    process.stdout.write('| Before each round | Ops/poll | Part reads/poll | DB KB/poll | DB ms/poll | Wall ms/poll (p50) | Reply KB/poll |\n|---|---|---|---|---|---|---|\n')
    const detail: string[] = []
    const phases: Array<[string, () => Promise<unknown>]> = [['nothing', async () => {}], ['one machine reading', () => reading(1)],
      ['every machine reading', () => Promise.all(people.map((_, m) => reading(m)))], ['one post', post]]
    for (const [label, before] of phases) {
      let ops = 0, partOps = 0, dbBytes = 0, dbMs = 0, replyBytes = 0
      const byCollection = new Map<string, { ops: number; ms: number; bytes: number }>()
      const walls: number[] = []
      for (let r = 0; r < rounds; r++) {
        await before()
        await sleep(200)
        await startProfiling(database.db)
        const start = await bytesOut(database.db)
        await Promise.all(pollers.map(async p => {
          const t = performance.now(), reply = await p.poll()
          walls.push(performance.now() - t)
          if (reply.code) throw new Error(`${p.label}: ${reply.code}`)
          replyBytes += reply.bytes
        }))
        dbBytes += await bytesOut(database.db) - start
        const entries = await profiled(database.db)
        ops += entries.length
        partOps += entries.filter(e => PARTS.has(e.ns.slice(e.ns.indexOf('.') + 1))).length
        dbMs += entries.reduce((sum, e) => sum + e.millis, 0)
        if (process.env.POLL_COST_SHAPES) for (const e of entries.filter(e => PARTS.has(e.ns.slice(e.ns.indexOf('.') + 1))))
          process.stdout.write(`${label} ${e.ns} n=${e.nreturned} bytes=${e.responseLength} ${JSON.stringify(e.command).slice(0, 400)}\n`)
        for (const e of entries) {
          const name = e.ns.slice(e.ns.indexOf('.') + 1), held = byCollection.get(name) ?? { ops: 0, ms: 0, bytes: 0 }
          byCollection.set(name, { ops: held.ops + 1, ms: held.ms + e.millis, bytes: held.bytes + (e.responseLength ?? 0) })
        }
        // Each round past the 30 s overlap is too slow; a round counts what moved since the round before, as a 3 s poll does.
        await sleep(3_000)
      }
      const polls = rounds * pollers.length, sorted = walls.sort((a, b) => a - b)
      process.stdout.write(`| ${label} | ${(ops / polls).toFixed(2)} | ${(partOps / polls).toFixed(2)} | ${(dbBytes / polls / 1024).toFixed(2)} | ` +
        `${(dbMs / polls).toFixed(2)} | ${sorted[Math.floor(sorted.length / 2)]!.toFixed(1)} | ${(replyBytes / polls / 1024).toFixed(2)} |\n`)
      detail.push(`${label}: ${[...byCollection].sort((a, b) => b[1].ops - a[1].ops).map(([name, c]) => `${name} ${(c.ops / rounds).toFixed(1)} (${(c.bytes / rounds / 1024).toFixed(1)} KB)`).join(', ')}`)
    }
    process.stdout.write(`\nDatabase operations per round (all ${pollers.length} pollers), by collection:\n${detail.map(d => `- ${d}`).join('\n')}\n`)
    await close()
    await driver.close()
  } finally {
    await stamps.close()
    await database.stop()
  }
}

/** Every operation profiled since startProfiling, the profiler's own reads left out. */
async function profiled(db: PrismaClient): Promise<Array<ProfileEntry & { responseLength: number }>> {
  await db.$runCommandRaw({ profile: 0 })
  const rows = (await db.$runCommandRaw({ aggregate: 'system.profile', pipeline: [{ $match: { ns: { $not: { $regex: String.raw`\.(system\.|\$cmd)` } } } },
    { $set: { keep: '$responseLength' } }, ...PROFILE_STAGES.map(stage => ({ $project: { ...stage.$project, responseLength: '$keep' } }))],
    cursor: { batchSize: 100_000 } }) as unknown as { cursor: { firstBatch?: Array<ProfileEntry & { responseLength?: unknown }> } }).cursor.firstBatch ?? []
  return rows.map(row => ({ ...profileEntry(row), responseLength: Number(row.responseLength ?? 0) })).filter(e => e.op !== 'command' || e.command?.aggregate || e.command?.find)
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
