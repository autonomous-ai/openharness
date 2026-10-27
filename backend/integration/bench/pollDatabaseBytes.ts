import { setTimeout as sleep } from 'node:timers/promises'
import { AttemptCounter } from './attempts.js'
import { DRIVERS } from './bench.js'
import { parseArgs } from './config.js'
import type { Reader } from './driver.js'
import { machineId, seedAccounts } from './fixtures.js'
import { localDatabase } from './mongo.js'
import { plan } from './plan.js'
import { isolatedPolls } from './probe.js'
import { seedSwarm } from './seed.js'

/** Past the change reads' 30 s overlap (design section 3.3), so the next reads are idle. */
const QUIET_MS = 35_000

/**
 * What one up-to-date poll costs the database, idle and after one post (#1726; docs/performance/2026-10-26-swarm-state-results.md,
 * "What the server reads from MongoDB"). The load benchmark's isolated poll runs right after the load, inside that
 * overlap; this tells idle and active apart. It seeds the benchmark's Swarm on its own loopback replica set, polls once as
 * a Desktop window and as a host, waits with no writes, then polls idle twice and once after a post in a group with the
 * host's agent. Takes the benchmark's options (`--driver`, `--done-share`, `--seed`, …). From `backend/`:
 *
 *   NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
 *     DATABASE_URL=mongodb://127.0.0.1:1/bench-never-used npx tsx integration/bench/pollDatabaseBytes.ts
 */
async function main() {
  const { config, driver: driverName } = parseArgs(process.argv.slice(2))
  const database = await localDatabase()
  try {
    const people = await seedAccounts(database.db, config.machines)
    const driver = await DRIVERS[driverName]!(new AttemptCounter().wrap(database.db), () => people)
    const { swarm } = await seedSwarm(driver, config, plan(config), people)
    // Machine 1's host (machine 0 also runs the Lead), as the results doc measured it.
    const worker = swarm.workers.find(w => w.machine === 1) ?? swarm.workers[0]!
    const desktop = driver.desktopReader(swarm.tabId, people[0]!), hostReader = driver.hostReader(people[worker.machine]!, machineId(worker.machine))
    const poll = async (label: string, reader: Reader) => {
      const [measured] = await isolatedPolls(database.db, [reader])
      process.stdout.write(`${JSON.stringify({ label, ...measured })}\n`)
    }
    await poll('desktop first load', desktop)
    await poll('host form in full', hostReader)
    process.stdout.write(`${JSON.stringify({ state: await driver.stateSize(swarm.tabId) })}\n`)
    await sleep(QUIET_MS)
    await poll('desktop change read (resends what changed in the 30 s before the first load)', desktop)
    await poll('host form', hostReader)
    await poll('desktop change read, idle', desktop)
    await poll('host form, idle', hostReader)
    const { code } = await driver.execute(swarm.tabId, people[0]!, `bench-${config.seed}-probe-post`,
      { type: 'message.send', conversationId: worker.group, text: 'One post.', replyTo: null, recipientIds: [] })
    if (code) throw new Error(`The post failed: ${code}`)
    await poll('desktop change read, after one post', desktop)
    await poll('host form, after one post in a group with its agent', hostReader)
    await driver.close()
  } finally {
    await database.stop()
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
