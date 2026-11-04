import { setTimeout as sleep } from 'node:timers/promises'
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
import { seedSwarm } from './seed.js'
import { benchStamps } from './stamps.js'

/** Past the change reads' 30 s overlap, so the polls after it resend nothing they sent before. */
const QUIET_MS = 35_000
/** Windows of each kind, the same at every size, so a window's cost compares across sizes. */
const READERS = 10

/**
 * What an app window's change poll costs with and without the summary etag (task #2906), on Wren13's machine-count
 * harness (machineCapCost.ts, PR #2909): a Swarm of `--machines` machines, each its own person's, and READERS windows of
 * each kind polling changes. `old` sends no etag, as every released client; `etag` echoes the `derivedEtag` of its last
 * read, as this release's Desktop, web and phone do. Rounds as there: after nothing, after every machine's reading, after
 * one post. Per round, reply KB per poll, the `derived` KB in it, and how many replies left the summary out. From
 * `backend/`:
 *
 *   NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
 *     DATABASE_URL=mongodb://127.0.0.1:1/bench-never-used npx tsx integration/bench/derivedEtagCost.ts --machines 36 [--rounds 3]
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
    const derivedBytes = new Map<Reader, number>(), unchanged = new Map<Reader, boolean>()
    const window = (user: AuthUser, echoes: boolean): Reader => {
      let cursor: string | null = null, etag: string | null = null
      const reader: Reader = { label: echoes ? 'etag' : 'old', async poll() {
        const reply = cursor === null
          ? await call<{ cursor: string; derivedEtag?: string; derived: unknown }>(user, 'GET', `/api/super-tabs/${swarm.tabId}/parts`)
          : await call<Changes>(user, 'GET', `/api/super-tabs/${swarm.tabId}/changes?cursor=${cursor}${echoes && etag ? `&derivedEtag=${etag}` : ''}`)
        const data = reply.data as { reload?: boolean; cursor: string; derivedEtag?: string; derived: unknown; derivedUnchanged?: true } | null
        if (data?.reload) throw new Error('A window was told to reload')
        if (data) {
          cursor = data.cursor
          etag = data.derivedEtag ?? null
          derivedBytes.set(reader, JSON.stringify(data.derived ?? null).length)
          unchanged.set(reader, data.derivedUnchanged === true)
        }
        return reply
      } }
      return reader
    }
    const kinds: Record<string, Reader[]> = {
      old: Array.from({ length: READERS }, (_, i) => window(people[i % people.length]!, false)),
      etag: Array.from({ length: READERS }, (_, i) => window(people[i % people.length]!, true)),
    }
    const all = Object.values(kinds).flat()
    let n = 0
    const reading = (machine: number): Promise<unknown> => driver.observeMachine(swarm.tabId, people[machine]!, machineId(machine), {
      generation: swarm.generations[machine]!, quotas: [], tools: {}, runningHarnessIds: machine === 0 ? ['bench-lead'] : [], stoppedHarnessIds: [],
      resources: { cpuPercent: 10 + (n++ % 50), memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9, diskTotalBytes: 500e9,
        projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Bench', os: 'macOS', gpuPercent: null } })
    const post = () => driver.execute(swarm.tabId, people[0]!, `etag-cost-${n++}`,
      { type: 'message.send', conversationId: swarm.workers[0]!.group, text: 'One post.', replyTo: null, recipientIds: [] })
    for (const r of all) await r.poll()
    // A first reading after the seed changes more than the reading: done before the quiet wait, as machineCapCost.ts does.
    await Promise.all(people.map((_, m) => reading(m)))
    await sleep(QUIET_MS)
    clock = Date.now()
    for (const r of all) await r.poll()

    process.stdout.write(`${config.machines} machines (${people.length} people), ${config.groups} groups; ${READERS} windows of each kind\n\n`)
    process.stdout.write('| Before each round | Window | Polls | Reply KB/poll | `derived` KB/poll | Summary left out |\n|---|---|---|---|---|---|\n')
    const phases: Array<[string, () => Promise<unknown>]> = [['nothing', async () => {}],
      ['every machine reading', () => Promise.all(people.map((_, m) => reading(m)))], ['one post', post]]
    for (const [label, before] of phases) {
      const sums = Object.fromEntries(Object.keys(kinds).map(k => [k, { polls: 0, reply: 0, derived: 0, unchanged: 0 }]))
      for (let r = 0; r < rounds; r++) {
        await before()
        await sleep(200)
        for (const [kind, readers] of Object.entries(kinds)) {
          const replies = await Promise.all(readers.map(p => p.poll()))
          check(kind, replies)
          const s = sums[kind]!
          s.polls += readers.length
          s.reply += replies.reduce((sum, reply) => sum + reply.bytes, 0)
          s.derived += readers.reduce((sum, p) => sum + (derivedBytes.get(p) ?? 0), 0)
          s.unchanged += readers.filter(p => unchanged.get(p)).length
        }
        await sleep(3_000)
      }
      for (const [kind, s] of Object.entries(sums)) {
        process.stdout.write(`| ${label} | ${kind} | ${s.polls} | ${(s.reply / s.polls / 1024).toFixed(2)} | ${(s.derived / s.polls / 1024).toFixed(2)} | ` +
          `${s.unchanged} of ${s.polls} |\n`)
      }
    }
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

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
