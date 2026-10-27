import { execFileSync } from 'node:child_process'
import { arch, cpus, platform, release, totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../../src/lib/ssoAuth.js'
import { AttemptCounter } from './attempts.js'
import { activeCount, type BenchConfig } from './config.js'
import type { SwarmDriver } from './driver.js'
import { seedAccounts } from './fixtures.js'
import { legacyDriver } from './legacyDriver.js'
import { partsDriver } from './drivers/parts.js'
import { runLoad } from './load.js'
import { plan, planDigest } from './plan.js'
import { isolatedPolls } from './probe.js'
import type { BenchReport } from './report.js'
import { seedSwarm } from './seed.js'

/** Each store version's clients. The parts store (#1726 groups 2–3) adds its driver here; the scenario stays as it is. */
export const DRIVERS: Record<string, (db: PrismaClient, users: () => readonly AuthUser[]) => Promise<SwarmDriver>> = { legacy: legacyDriver, parts: partsDriver }

function commit(): BenchReport['commit'] {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain', '--', '.'], { encoding: 'utf8' }).trim() !== ''
    return { sha, dirty }
  } catch { return null }
}

async function mongoVersion(db: PrismaClient): Promise<string> {
  return String((await db.$runCommandRaw({ buildInfo: 1 }) as { version?: unknown }).version ?? 'unknown')
}

/** Seeds a Swarm on [db] (a fresh local database), runs the load, and measures. */
export async function runBench(config: BenchConfig, driverName: string, db: PrismaClient): Promise<BenchReport> {
  const make = DRIVERS[driverName] ?? (() => { throw new Error(`Unknown driver ${driverName}; known: ${Object.keys(DRIVERS).join(', ')}`) })()
  const startedAt = new Date().toISOString()
  const counter = new AttemptCounter()
  const people = await seedAccounts(db, config.machines)
  const driver = await make(counter.wrap(db), () => people)
  try {
    const p = plan(config)
    const setupStart = performance.now()
    const { swarm, calls } = await seedSwarm(driver, config, p, people)
    const setupMs = performance.now() - setupStart
    const afterSetup = await driver.stateSize(swarm.tabId)
    const load = await runLoad(driver, counter, config, p, swarm)
    const afterLoad = await driver.stateSize(swarm.tabId)
    const polls = await isolatedPolls(db, load.readers)
    const readerLabels = new Set(load.readers.map(r => r.label))
    return {
      benchmark: 'swarm-state', version: 1, driver: driver.name, startedAt, commit: commit(),
      machine: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? 'unknown', cpus: cpus().length,
        memoryGb: Math.round(totalmem() / 2 ** 30), node: process.versions.node, mongo: await mongoVersion(db) },
      config, planDigest: planDigest(p),
      setup: { ms: setupMs, calls, workers: p.workers.length, activeGroups: activeCount(config), doneGroups: p.doneGroups.length },
      load: { plannedMs: config.durationMs, actualMs: load.actualMs, skipped: load.skipped, ops: load.recorder.byOp(), writerKinds: load.recorder.byWriterKind(),
        writers: load.recorder.byWriter().filter(w => !readerLabels.has(w.key)), readers: load.recorder.byWriter().filter(w => readerLabels.has(w.key)) },
      state: { afterSetup, afterLoad },
      isolatedPolls: polls,
    }
  } finally {
    await driver.close()
  }
}
