import { performance } from 'node:perf_hooks'
import { DEFAULT_CONFIG } from './config.js'
import type { Reply } from './driver.js'
import { partsDriver } from './drivers/parts.js'
import { machineId, seedAccounts } from './fixtures.js'
import { storeRoutes } from './legacyDriver.js'
import { localDatabase } from './mongo.js'
import { plan } from './plan.js'
import { seedSwarm } from './seed.js'
import { startSelfProfile } from '../../src/lib/selfProfile.js'

/**
 * What one call of each hot Swarm route costs the backend in CPU, alone, on the bench's seeded Swarm (#314: production
 * stayed at five pods after the v1 release). `process.cpuUsage` counts every thread of this process, so the in-process
 * query engine is included and MongoDB, which runs in its own process, is not. Multiply by production's per-route rate
 * to rank where the CPU goes.
 *
 *   NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
 *     DATABASE_URL=mongodb://127.0.0.1:1/bench-never-used npx tsx integration/bench/routeCost.ts [calls per route]
 */
async function main() {
  const calls = Number(process.argv[2] ?? 200)
  // CPU_SELF_PROFILE=1: the production self-profile on a short clock, to see its output under this load.
  const stopProfile = process.env.CPU_SELF_PROFILE === '1'
    ? startSelfProfile({ everyMs: 45_000, profileMs: 20_000, reportMs: 15_000, log: (m, c) => process.stdout.write(`${m} ${JSON.stringify(c, null, 1)}\n`) }) : () => {}
  const config = { ...DEFAULT_CONFIG }
  const database = await localDatabase()
  const people = await seedAccounts(database.db, config.machines)
  const driver = await partsDriver(database.db, () => people)
  const { call, close } = await storeRoutes(database.db, () => people)
  try {
    const { swarm } = await seedSwarm(driver, config, plan(config), people)
    const { tabId, workers, generations, leadId } = swarm, owner = people[0]!, w = workers[0]!, host = people[w.machine]!
    // Production's polls are mostly idle: an agent with nothing waiting, readers whose cursor is past the last 30 s that
    // every change read repeats (read/changes.ts). Take the worker's deliveries and wait out that window first.
    for (const { id } of (await driver.deliveries(tabId, host, w.id)).data ?? []) {
      await driver.delivery(tabId, host, w.id, id, { type: 'claim', claimId: `cost-${id}` })
      await driver.delivery(tabId, host, w.id, id, { type: 'ack', claimId: `cost-${id}`, receipt: `cost-${id}`, uncertain: false })
    }
    const desktop = driver.desktopReader(tabId, owner), hostReader = driver.hostReader(host, machineId(w.machine))
    await new Promise(resolve => setTimeout(resolve, 35_000))
    await desktop.poll()
    await hostReader.poll()
    let n = 0, previousEventId: string | null = null
    const routes: Record<string, () => Promise<Reply>> = {
      'GET deliveries (idle agent)': () => driver.deliveries(tabId, host, w.id),
      'POST hosts/:id/changes (host poll)': () => hostReader.poll(),
      'GET :tab/changes (Desktop poll)': () => desktop.poll(),
      'GET conversation messages': () => call(owner, 'GET', `/api/super-tabs/${tabId}/conversations/${w.group}/messages`),
      'GET lead messages': () => call(owner, 'GET', `/api/super-tabs/${tabId}/conversations/lead/messages`),
      'GET mentions': () => call(owner, 'GET', `/api/super-tabs/${tabId}/mentions?state=waiting`),
      'POST machines/:id (observation)': () => driver.observeMachine(tabId, owner, machineId(0), {
        generation: generations[0]!, quotas: [], tools: {}, runningHarnessIds: ['bench-lead'], stoppedHarnessIds: [],
        resources: { cpuPercent: 10 + (n++ % 50), memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9, diskTotalBytes: 500e9,
          projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Bench', os: 'macOS', gpuPercent: null } }),
      'POST hosts/:id/terminal': () => call(host, 'POST', `/api/super-tabs/hosts/${machineId(w.machine)}/terminal`),
      'POST commands (message.send)': () => driver.execute(tabId, owner, `cost-${n++}`,
        { type: 'message.send', conversationId: w.group, text: 'cost probe', replyTo: null, recipientIds: [] }, leadId),
      'POST native (terminal turn)': async () => {
        const reply = await driver.appendNative(tabId, host, w.contextId,
          { turnId: `cost-${n++}`, kind: 'prompt', previousEventId, text: 'cost probe', truncated: false, interrupted: false })
        previousEventId = reply.data?.eventId ?? previousEventId
        return reply
      },
    }
    process.stdout.write(`| Route | Calls | Failed | CPU ms/call | Wall ms/call | Mean KB |\n|---|---|---|---|---|---|\n`)
    for (const [label, run] of Object.entries(routes)) {
      for (let i = 0; i < 5; i++) await run() // warm up
      let failed = 0, bytes = 0
      const cpu = process.cpuUsage(), wall = performance.now()
      for (let i = 0; i < calls; i++) {
        const reply = await run()
        if (reply.code) failed++
        bytes += reply.bytes
      }
      const used = process.cpuUsage(cpu), ms = (used.user + used.system) / 1000
      process.stdout.write(`| ${label} | ${calls} | ${failed} | ${(ms / calls).toFixed(2)} | ${((performance.now() - wall) / calls).toFixed(2)} | ${(bytes / calls / 1024).toFixed(1)} |\n`)
    }
  } finally {
    stopProfile()
    await close()
    await driver.close()
    await database.stop()
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
