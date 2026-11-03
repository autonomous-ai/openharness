/**
 * What a machine's full report leaves for the next one (DB roadmap 2.5, docs/superpowers/specs/
 * 2026-10-30-machine-reports-fast-path-design.md): a heartbeat whose decisions cannot differ stores its reading without
 * loading the Swarm, from what the last full report recorded here. Also the Swarm's sweep clock, one for every server, and
 * this server's count of fast and full reports, logged each minute.
 */
import { z } from 'zod'
import { INSTANCE_ID } from '../lib/instance.js'
import { logger } from '../utils/logger.js'
import { SWEEP_EVERY_MS } from './liveness.js'

/** A record is read again only within this long of its Swarm's last full report. */
export const RECORD_TTL_MS = 120_000
/** The latest a fast report may follow its full one, whatever its workers' leases say. */
export const DEADLINE_CAP_MS = 300_000

/** What a full report saw, for the machine's next reports. */
export interface ReportRecord {
  /** The Swarm's `main` stamp read before the full report loaded it. */
  stamp: number
  /** This machine's agents Lent counts for the next report (leaderboard/lent.ts lentAgents). */
  lentCount: number
  /** Whether any machine of the Swarm was being removed (machines.ts expireRemovals). */
  removals: boolean
  /** The earliest a worker here may lose its task to time (liveness.ts nextLossAt), at most DEADLINE_CAP_MS on. */
  deadline: number
  /** Whether the Swarm's record says the machine is a Team account's (store.ts teamByRecord). */
  team: boolean
  /** Who is told of a reading (parts/commit.ts membersToTell): the Swarm's people. */
  members: string[]
  /** The starts this machine may say it is preparing (machines.ts preparableStart). */
  preparable: string[]
  /** When the full report ran. */
  at: number
}

export interface ReportMemory {
  get(tabId: string, machineId: string): Promise<ReportRecord | undefined>
  set(tabId: string, machineId: string, record: ReportRecord): Promise<void>
  /** Whether a report now runs the Swarm's time checks: yes at most once per SWEEP_EVERY_MS, whichever server asks. */
  sweepDue(tabId: string, now: number): Promise<boolean>
}

/** The Redis commands the memory needs: the bus' fail-fast connection (lib/bus.ts `pub`) in production. */
export interface ReportRedis {
  hget(key: string, field: string): Promise<string | null>
  hset(key: string, field: string, value: string): Promise<unknown>
  pexpire(key: string, ms: number): Promise<unknown>
  set(key: string, value: string, px: 'PX', ms: number, nx: 'NX'): Promise<string | null>
}

const record = z.object({ stamp: z.number().finite(), lentCount: z.number().int().nonnegative(), removals: z.boolean(), deadline: z.number().finite(),
  team: z.boolean(), members: z.array(z.string()), preparable: z.array(z.string()), at: z.number().finite() })

function parse(value: string | null): ReportRecord | undefined {
  if (value === null) return undefined
  try {
    const read = record.safeParse(JSON.parse(value))
    return read.success ? read.data : undefined
  } catch {
    return undefined
  }
}

/** One server's memory: the default, and the sweep clock while Redis fails. */
export function localReportMemory(now: () => number = Date.now): ReportMemory {
  const records = new Map<string, { until: number; machines: Map<string, ReportRecord> }>()
  const swept = new Map<string, number>()
  return {
    async get(tabId, machineId) {
      const held = records.get(tabId)
      if (!held || held.until <= now()) return undefined
      return held.machines.get(machineId)
    },
    async set(tabId, machineId, value) {
      const held = records.get(tabId)
      const machines = held && held.until > now() ? held.machines : new Map<string, ReportRecord>()
      records.set(tabId, { until: now() + RECORD_TTL_MS, machines: machines.set(machineId, value) })
      for (const [id, entry] of records) if (entry.until <= now()) records.delete(id)
    },
    async sweepDue(tabId, at) {
      const last = swept.get(tabId)
      if (last !== undefined && at - last < SWEEP_EVERY_MS) return false
      swept.set(tabId, at)
      for (const [id, when] of swept) if (at - when >= SWEEP_EVERY_MS) swept.delete(id)
      return true
    },
  }
}

/**
 * The memory every server shares, in Redis: `swarm:machine-full:{tabId}` holds one field per machine and expires
 * RECORD_TTL_MS after its last write; `swarm:swept:{tabId}` is the sweep clock. A record Redis cannot give reads as missing
 * (that report runs in full); a sweep clock Redis cannot keep is kept by this server alone, as before.
 */
export function redisReportMemory(redis: ReportRedis, now: () => number = Date.now): ReportMemory {
  const local = localReportMemory(now)
  const key = (tabId: string) => `swarm:machine-full:${tabId}`
  let failing = false
  const failed = (what: string, error: unknown) => {
    if (!failing) logger.warn('[machine-reports] Redis failed; reports run in full and sweeps are timed here until it answers', { what, error: String(error) })
    failing = true
  }
  return {
    async get(tabId, machineId) {
      try {
        const found = parse(await redis.hget(key(tabId), machineId))
        failing = false
        return found
      } catch (error) {
        failed('get', error)
        return undefined
      }
    },
    async set(tabId, machineId, value) {
      try {
        await redis.hset(key(tabId), machineId, JSON.stringify(value))
        await redis.pexpire(key(tabId), RECORD_TTL_MS)
      } catch (error) {
        failed('set', error)
      }
    },
    async sweepDue(tabId, at) {
      try {
        return await redis.set(`swarm:swept:${tabId}`, String(at), 'PX', SWEEP_EVERY_MS, 'NX') === 'OK'
      } catch (error) {
        failed('sweep', error)
        return local.sweepDue(tabId, at)
      }
    },
  }
}

const counts = { fast: 0, full: 0 }

/** One machine reading stored, by which path. */
export function countReport(path: 'fast' | 'full'): void {
  counts[path]++
}

/** This server's counts since the last line, reset. */
export function machineReportLine(windowMs: number): { pod: string; windowMs: number; fast: number; full: number } {
  const line = { pod: INSTANCE_ID, windowMs, ...counts }
  counts.fast = 0
  counts.full = 0
  return line
}

/** Logs `machine reports` every `intervalMs` while there were any; the stop logs the last partial window. */
export function startMachineReportLog(intervalMs = 60_000): () => void {
  const flush = () => { if (counts.fast || counts.full) logger.info('machine reports', machineReportLine(intervalMs)) }
  const timer = setInterval(flush, intervalMs)
  timer.unref()
  return () => { clearInterval(timer); flush() }
}
