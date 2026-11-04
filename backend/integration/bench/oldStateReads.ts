import { performance } from 'node:perf_hooks'
import { SuperTabStore } from '../../src/superTabs/store.js'
import { SWEEP_EVERY_MS } from '../../src/superTabs/liveness.js'
import * as parts from '../../src/superTabs/parts/index.js'
import { AttemptCounter } from './attempts.js'
import { DRIVERS } from './bench.js'
import { parseArgs } from './config.js'
import { seedAccounts } from './fixtures.js'
import { localDatabase } from './mongo.js'
import { plan } from './plan.js'
import { bytesOut } from './probe.js'
import { seedSwarm } from './seed.js'

/** A migrated production Swarm keeps its whole old state beside its parts, about 1 MB (roadmap, Stability 2.1). */
const OLD_STATE_BYTES = 1_000_000
const RUNS = 30

/**
 * What an up-to-date read of a migrated Swarm costs while its row still keeps the old state from before parts (design
 * 6.1: `SuperTab.legacyState`), and once that state is gone. Seeds the benchmark's Swarm on its own loopback replica set,
 * gives its row a 1 MB old state built from copies of its own state, then times each read alone, RUNS times, as the store
 * serves it: the Lead's status, a host's full delivery poll with nothing waiting (the empty read), and one post. Prints
 * the median time and what MongoDB sent the backend per read. Takes the benchmark's options. From `backend/`:
 *
 *   NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
 *     DATABASE_URL=mongodb://127.0.0.1:1/bench-never-used npx tsx integration/bench/oldStateReads.ts
 */
async function main() {
  const { config, driver: driverName } = parseArgs(process.argv.slice(2))
  const database = await localDatabase()
  const { db } = database
  try {
    const people = await seedAccounts(db, config.machines)
    const driver = await DRIVERS[driverName]!(new AttemptCounter().wrap(db), () => people)
    const { swarm } = await seedSwarm(driver, config, plan(config), people)
    await driver.close()
    // Each delivery poll is a full one: the store answers a poll repeated within SWEEP_EVERY_MS from one indexed read.
    let now = Date.now()
    const store = new SuperTabStore(db, () => now)
    const lead = people[0]!, worker = swarm.workers[0]!, host = people[worker.machine]!
    const state = parts.toLegacyState(parts.reassemble(await db.$transaction(tx => parts.loadAll(tx, swarm.tabId))))
    const copies = Math.ceil(OLD_STATE_BYTES / JSON.stringify(state).length)
    const oldState = JSON.parse(JSON.stringify({ copies: Array.from({ length: copies }, () => state) }))
    const before = await bytesOut(db)
    const ownReply = await bytesOut(db) - before
    let posts = 0
    const reads: Array<[string, () => Promise<unknown>]> = [
      ['Lead status', () => store.read(lead, swarm.tabId, swarm.leadId)],
      ['empty read: delivery poll, nothing waiting', () => { now += SWEEP_EVERY_MS; return store.deliveries(host, swarm.tabId, worker.id) }],
      ['one post', () => store.execute(lead, swarm.tabId, { operationId: `old-state-post-${++posts}`,
        command: { type: 'message.send', conversationId: worker.group, text: 'One post.', replyTo: null, recipientIds: [] } })],
    ]
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
    for (const [kept, legacyState] of [['old state kept', oldState], ['old state removed', null]] as const) {
      await db.superTab.update({ where: { id: swarm.tabId }, data: { legacyState } })
      for (const [label, read] of reads) {
        await read()
        const ms: number[] = [], bytes: number[] = []
        for (let i = 0; i < RUNS; i++) {
          const start = await bytesOut(db), started = performance.now()
          await read()
          ms.push(performance.now() - started)
          bytes.push(Math.max(0, await bytesOut(db) - start - ownReply))
        }
        process.stdout.write(`${JSON.stringify({ kept, read: label, oldStateBytes: legacyState ? JSON.stringify(legacyState).length : 0,
          medianMs: Number(median(ms).toFixed(2)), medianDatabaseKB: Number((median(bytes) / 1024).toFixed(1)) })}\n`)
      }
    }
  } finally {
    await database.stop()
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
