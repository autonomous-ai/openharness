import { performance } from 'node:perf_hooks'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../../src/lib/ssoAuth.js'
import type { Reader, SwarmDriver } from './driver.js'
import { percentile } from './metrics.js'
import { count } from './probe.js'
import type { Swarm } from './seed.js'

/** The Stability Roadmap's numbers for one run (harness-stability-roadmap.md 2.2 and 2.6). */
export interface Kpis {
  load: LoadKpis
  /** One write and one up-to-date Desktop poll at a time, after the load, with nothing else running. */
  isolated: { writes: number; cpuMsPerWrite: number; mongoOpsPerWrite: number; polls: number; pollP50Ms: number; pollP95Ms: number; mongoOpsPerPoll: number }
}
export interface LoadKpis { mongoOpsPerSecond: number; cpuPercent: number; retriesPerMinute: number }

/** Every operation MongoDB served since it started: reads, writes and commands (a transaction's commit is one). */
export function mongoOperations(status: unknown): number {
  const counters = (status as { opcounters: Record<string, unknown> }).opcounters
  return ['insert', 'query', 'update', 'delete', 'getmore', 'command'].reduce((sum, key) => sum + count(counters[key]), 0)
}

export async function serverOperations(db: PrismaClient): Promise<number> {
  return mongoOperations(await db.$runCommandRaw({ serverStatus: 1 }))
}

/** This process's CPU time, user and system, in microseconds: the backend under test runs in it. */
export const cpuMicros = () => { const { user, system } = process.cpuUsage(); return user + system }

export function loadKpis(run: { ms: number; operations: number; cpuMicros: number; failedAttempts: number }): LoadKpis {
  const seconds = run.ms / 1000
  return { mongoOpsPerSecond: run.operations / seconds, cpuPercent: run.cpuMicros / 1000 / run.ms * 100, retriesPerMinute: run.failedAttempts / (seconds / 60) }
}

/**
 * Writes and polls one at a time: a worker's post in its own group, then an up-to-date Desktop window's poll. The status
 * calls' own operations are measured and taken off.
 */
export async function isolatedKpis(db: PrismaClient, driver: SwarmDriver, swarm: Swarm, reader: Reader, n = 40): Promise<Kpis['isolated']> {
  const before = await serverOperations(db)
  const ownCall = await serverOperations(db) - before
  const worker = swarm.workers[0]!, host: AuthUser = swarm.people[worker.machine]!
  let ops = await serverOperations(db), cpu = cpuMicros()
  for (let i = 0; i < n; i++) {
    const reply = await driver.execute(swarm.tabId, host, `bench-kpi-write-${i}`,
      { type: 'message.send', conversationId: worker.group, text: `KPI write ${i}`, replyTo: null, recipientIds: [] }, worker.id)
    if (reply.code) throw new Error(`KPI write failed: ${reply.code}`)
  }
  const cpuMsPerWrite = (cpuMicros() - cpu) / 1000 / n, mongoOpsPerWrite = (await serverOperations(db) - ops - ownCall) / n
  // Up to date: the first poll takes in the writes above.
  await reader.poll()
  const ms: number[] = []
  ops = await serverOperations(db)
  for (let i = 0; i < n; i++) {
    const started = performance.now()
    const reply = await reader.poll()
    ms.push(performance.now() - started)
    if (reply.code) throw new Error(`KPI poll failed: ${reply.code}`)
  }
  const mongoOpsPerPoll = (await serverOperations(db) - ops - ownCall) / n
  return { writes: n, cpuMsPerWrite, mongoOpsPerWrite, polls: n, pollP50Ms: percentile(ms, 50)!, pollP95Ms: percentile(ms, 95)!, mongoOpsPerPoll }
}
