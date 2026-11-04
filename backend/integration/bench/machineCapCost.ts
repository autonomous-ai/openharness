import { setTimeout as sleep } from 'node:timers/promises'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../../src/lib/ssoAuth.js'
import type { Changes } from '../../src/superTabs/read/contract.js'
import { readDelta } from '../../src/superTabs/cachedReads.js'
import { listGroupIndexes } from '../../src/superTabs/parts/indexed.js'
import { parseArgs } from './config.js'
import { partsDriver } from './drivers/parts.js'
import type { Reader, Reply } from './driver.js'
import { machineId, seedAccounts } from './fixtures.js'
import { storeRoutes } from './legacyDriver.js'
import { localDatabase } from './mongo.js'
import { plan } from './plan.js'
import { PROFILE_STAGES, profileEntry, startProfiling, type ProfileEntry } from './profile.js'
import { seedSwarm } from './seed.js'
import { benchStamps } from './stamps.js'

/** Past the change reads' 30 s overlap, so the polls after it resend nothing they sent before. */
const QUIET_MS = 35_000
/** Readers of each kind, the same at every size, so a reader's cost compares across sizes. */
const READERS = 10

/**
 * What a Swarm's machine count costs once the Swarm-wide 32 is gone (task #2637, plan 2026-11-04 Task 4). Seeds a Swarm of
 * `--machines` machines, each its own person's with its own host, then rounds where every host polls its form (with held
 * etags, as the CLI does between its full reads) and READERS app windows poll changes, old and `machines=light`: after
 * nothing, after every machine's reading, and after one post. Per round: database operations and bytes on SwarmMachine
 * (the host signature's and readMachines' collection) and on everything, and reply bytes, per poll. Then the whole Swarm's
 * machine parts in bytes, which is what readMachines loads on a miss. Hosts' clocks hold still, so no host reads in full
 * during the rounds: a full read is its own row. From `backend/`:
 *
 *   NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
 *     DATABASE_URL=mongodb://127.0.0.1:1/bench-never-used npx tsx integration/bench/machineCapCost.ts --machines 36 [--rounds 3]
 */
async function main() {
  const argv = process.argv.slice(2)
  const at = argv.indexOf('--rounds'), rounds = at < 0 ? 3 : Number(argv[at + 1])
  const { config } = parseArgs(argv.filter((arg, i) => arg !== '--rounds' && argv[i - 1] !== '--rounds'))
  config.desktopReaders = Math.min(config.desktopReaders, config.machines)
  config.hostReaders = Math.min(config.hostReaders, config.machines)
  const database = await localDatabase()
  await listGroupIndexes(database.db)
  const stamps = await benchStamps('memory', readDelta(database.db))
  let clock = Date.now()
  try {
    const people = await seedAccounts(database.db, config.machines)
    const driver = await partsDriver(database.db, () => people, { now: () => clock })
    const { call, close } = await storeRoutes(database.db, () => people)
    const { swarm } = await seedSwarm(driver, config, plan(config), people)
    const window = (user: AuthUser, light: boolean): Reader => {
      let cursor: string | null = null
      return { label: light ? 'light' : 'old', async poll() {
        if (cursor === null) {
          const reply = await call<{ cursor: string }>(user, 'GET', `/api/super-tabs/${swarm.tabId}/parts`)
          cursor = reply.data?.cursor ?? null
          return reply
        }
        const reply = await call<Changes>(user, 'GET', `/api/super-tabs/${swarm.tabId}/changes?cursor=${cursor}${light ? '&machines=light' : ''}`)
        if (reply.data?.reload) throw new Error('A window was told to reload')
        if (reply.data) cursor = reply.data.cursor
        if (reply.data) fields(light ? 'light' : 'old', reply.data)
        return reply
      } }
    }
    const kinds: Record<string, Reader[]> = {
      host: people.map((person, m) => driver.hostReader(person, machineId(m))),
      old: Array.from({ length: READERS }, (_, i) => window(people[i % people.length]!, false)),
      light: Array.from({ length: READERS }, (_, i) => window(people[i % people.length]!, true)),
    }
    const all = Object.values(kinds).flat()
    // What a window's reply holds, by field, in the round's last poll of each kind.
    const lastFields: Record<string, string> = {}
    function fields(kind: string, data: Changes) {
      lastFields[kind] = Object.entries(data as unknown as Record<string, unknown>).map(([k, v]) => [k, JSON.stringify(v ?? null).length] as const)
        .filter(([, bytes]) => bytes > 200).sort((a, b) => b[1] - a[1]).map(([k, bytes]) => `${k} ${(bytes / 1024).toFixed(1)} KB`).join(', ')
    }
    let n = 0
    const reading = (machine: number): Promise<unknown> => driver.observeMachine(swarm.tabId, people[machine]!, machineId(machine), {
      generation: swarm.generations[machine]!, quotas: [], tools: {}, runningHarnessIds: machine === 0 ? ['bench-lead'] : [], stoppedHarnessIds: [],
      resources: { cpuPercent: 10 + (n++ % 50), memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9, diskTotalBytes: 500e9,
        projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Bench', os: 'macOS', gpuPercent: null } })
    const post = () => driver.execute(swarm.tabId, people[0]!, `cap-cost-${n++}`,
      { type: 'message.send', conversationId: swarm.workers[0]!.group, text: 'One post.', replyTo: null, recipientIds: [] })
    for (const r of all) await r.poll()
    // A first reading after the seed changes more than the reading (its content): done before the quiet wait, so the rounds'
    // readings are readings only, as a running machine's are.
    await Promise.all(people.map((_, m) => reading(m)))
    await sleep(QUIET_MS)
    clock = Date.now()
    for (const r of all) await r.poll()

    const machineBytes = await partBytes(database.db, swarm.tabId)
    process.stdout.write(`${config.machines} machines (${people.length} people, one host each), ${config.groups} groups; ${READERS} old and ` +
      `${READERS} light windows; whole machine parts ${(machineBytes.total / 1024).toFixed(1)} KB (${(machineBytes.total / machineBytes.n / 1024).toFixed(2)} KB each)\n\n`)
    process.stdout.write('| Before each round | Reader | Polls | SwarmMachine ops/poll | SwarmMachine KB/poll | All ops/poll | All DB KB/poll | Reply KB/poll |\n' +
      '|---|---|---|---|---|---|---|---|\n')
    const details: string[] = []
    const phases: Array<[string, () => Promise<unknown>]> = [['nothing', async () => {}],
      ['every machine reading', () => Promise.all(people.map((_, m) => reading(m)))], ['one post', post]]
    for (const [label, before] of phases) {
      const sums = Object.fromEntries(Object.keys(kinds).map(k => [k, { polls: 0, machineOps: 0, machineBytes: 0, ops: 0, bytes: 0, reply: 0 }]))
      for (let r = 0; r < rounds; r++) {
        await before()
        await sleep(200)
        // Each kind alone, so the profiler's operations are that kind's.
        for (const [kind, readers] of Object.entries(kinds)) {
          await startProfiling(database.db)
          const replies = await Promise.all(readers.map(p => p.poll()))
          const entries = await profiled(database.db)
          check(kind, replies)
          const s = sums[kind]!
          s.polls += readers.length
          s.reply += replies.reduce((sum, reply) => sum + reply.bytes, 0)
          s.ops += entries.length
          s.bytes += entries.reduce((sum, e) => sum + e.responseLength, 0)
          const machines = entries.filter(e => e.ns.endsWith('.SwarmMachine'))
          s.machineOps += machines.length
          s.machineBytes += machines.reduce((sum, e) => sum + e.responseLength, 0)
        }
        await sleep(3_000)
      }
      details.push(`${label}: old window ${lastFields.old}; light window ${lastFields.light}`)
      for (const [kind, s] of Object.entries(sums)) {
        process.stdout.write(`| ${label} | ${kind} | ${s.polls} | ${(s.machineOps / s.polls).toFixed(2)} | ${(s.machineBytes / s.polls / 1024).toFixed(2)} | ` +
          `${(s.ops / s.polls).toFixed(2)} | ${(s.bytes / s.polls / 1024).toFixed(2)} | ${(s.reply / s.polls / 1024).toFixed(2)} |\n`)
      }
    }
    // Every host's full read, which each host makes once a minute (cli/src/superTabs/hostFeed.ts HOST_FULL_MS).
    clock += 61_000
    await startProfiling(database.db)
    const replies = await Promise.all(kinds.host!.map(p => p.poll()))
    const entries = await profiled(database.db), machines = entries.filter(e => e.ns.endsWith('.SwarmMachine'))
    check('host', replies)
    const polls = kinds.host!.length
    process.stdout.write(`| full read (once a minute) | host | ${polls} | ${(machines.length / polls).toFixed(2)} | ` +
      `${(machines.reduce((sum, e) => sum + e.responseLength, 0) / polls / 1024).toFixed(2)} | ${(entries.length / polls).toFixed(2)} | ` +
      `${(entries.reduce((sum, e) => sum + e.responseLength, 0) / polls / 1024).toFixed(2)} | ${(replies.reduce((sum, r) => sum + r.bytes, 0) / polls / 1024).toFixed(2)} |\n`)
    process.stdout.write(`\nA window's reply by field (fields over 200 bytes):\n${details.map(d => `- ${d}`).join('\n')}\n`)
    await close()
    await driver.close()
  } finally {
    await stamps.close()
    await database.stop()
  }
}

function check(kind: string, replies: Reply[]) {
  const failed = replies.find(reply => reply.code)
  if (failed) throw new Error(`${kind}: ${failed.code}`)
}

/** The Swarm's live machine parts: how many, and their BSON bytes together. */
async function partBytes(db: PrismaClient, tabId: string): Promise<{ n: number; total: number }> {
  const rows = await db.swarmMachine.aggregateRaw({ pipeline: [{ $match: { tabId, deleted: false } },
    { $group: { _id: null, n: { $sum: 1 }, total: { $sum: { $bsonSize: '$$ROOT' } } } }] }) as unknown as Array<{ n: number; total: number }>
  return rows[0] ?? { n: 0, total: 0 }
}

/** Every operation profiled since startProfiling, the profiler's own reads left out (changesPollCost.ts profiled). */
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
