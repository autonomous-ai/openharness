import { performance } from 'node:perf_hooks'
import { SuperTabStore } from '../../src/superTabs/store.js'
import { AttemptCounter } from './attempts.js'
import { DRIVERS } from './bench.js'
import { parseArgs } from './config.js'
import { machineId, seedAccounts } from './fixtures.js'
import { localDatabase } from './mongo.js'
import { plan } from './plan.js'
import { bytesOut } from './probe.js'
import { seedSwarm } from './seed.js'

const RUNS = 30

/**
 * What one machine's report (store.ts observeMachine, every 15 s per machine) costs on the benchmark's Swarm, alone: the
 * median time and what MongoDB sent the backend for it (#876). A report runs the Swarm's time checks at most every 30 s
 * per server, so both are measured: a store that has just run them, and a fresh store each time, which runs them. Takes
 * the benchmark's options. From `backend/`:
 *
 *   NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
 *     DATABASE_URL=mongodb://127.0.0.1:1/bench-never-used npx tsx integration/bench/observeReads.ts
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
    const owner = people[0]!
    const runningHarnessIds = (await new SuperTabStore(db).read(owner, swarm.tabId)).state.agents
      .filter(a => a.machineId === machineId(0)).map(a => a.harnessId)
    const report = (store: SuperTabStore, n: number) => store.observeMachine(owner, swarm.tabId, machineId(0), {
      generation: swarm.generations[0]!, quotas: [], tools: {}, runningHarnessIds, stoppedHarnessIds: [],
      resources: { cpuPercent: 10 + n % 50, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9, diskTotalBytes: 500e9,
        projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Bench', os: 'macOS', gpuPercent: null } })
    const before = await bytesOut(db)
    const ownReply = await bytesOut(db) - before
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
    const kept = new SuperTabStore(db)
    await report(kept, 0)
    for (const [label, store] of [['report', () => kept], ['report with time checks', () => new SuperTabStore(db)]] as const) {
      const ms: number[] = [], bytes: number[] = []
      for (let i = 0; i < RUNS; i++) {
        const each = store()
        const start = await bytesOut(db), started = performance.now()
        await report(each, i + 1)
        ms.push(performance.now() - started)
        bytes.push(Math.max(0, await bytesOut(db) - start - ownReply))
      }
      process.stdout.write(`${JSON.stringify({ read: label, runs: RUNS, medianMs: Number(median(ms).toFixed(2)),
        medianDatabaseKB: Number((median(bytes) / 1024).toFixed(1)) })}\n`)
    }
  } finally {
    await database.stop()
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
