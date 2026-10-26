/**
 * The migration job (design 6.1.1, step 3 and 4): it starts only when no old writer is left, then migrates every Swarm
 * still in one row, one transaction each, and reports each one. A Swarm that fails is left as it was.
 */
import type { PrismaClient } from '@prisma/client'
import { migrateSwarm, type MigrationReport } from './migrate.js'

export const QUIET_WAIT_MS = 60_000
export interface JobOptions {
  now?: () => number
  /** How long the newest writes must stay unchanged. Hosts observe every 5–15 s and claim deliveries every second. */
  waitMs?: number
  sleep?: (ms: number) => Promise<void>
  log?: (report: MigrationReport) => void
}
export interface JobResult { reports: MigrationReport[]; totals: { swarms: number; ok: number; failed: number; skipped: number; ms: number } }

/** The newest write of each kind old writers make, with the row counts, so an insert dated in the past shows too. */
async function writeMarks(db: PrismaClient): Promise<string> {
  const [tab, message, delivery, messages, deliveries] = await Promise.all([
    db.superTab.findFirst({ orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
    db.superTabMessage.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    db.superTabDelivery.findFirst({ orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
    db.superTabMessage.count(), db.superTabDelivery.count(),
  ])
  return JSON.stringify([tab?.updatedAt, message?.createdAt, delivery?.updatedAt, messages, deliveries])
}

export async function writersQuiet(db: PrismaClient, waitMs = QUIET_WAIT_MS, sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))): Promise<boolean> {
  const before = await writeMarks(db)
  await sleep(waitMs)
  return before === await writeMarks(db)
}

export async function migrateAll(db: PrismaClient, { now = Date.now, waitMs, sleep, log = () => {} }: JobOptions = {}): Promise<JobResult> {
  const started = Date.now()
  if (!await writersQuiet(db, waitMs, sleep)) throw new Error('Stopped: a writer is still running. Stop every old backend process, then run this again.')
  const ids = (await db.superTab.findMany({ where: { format: 1 }, orderBy: { id: 'asc' }, select: { id: true } })).map(r => r.id)
  const reports: MigrationReport[] = []
  for (const id of ids) {
    const report = await migrateSwarm(db, id, { now })
    log(report)
    reports.push(report)
  }
  return { reports, totals: { swarms: reports.length, ok: reports.filter(r => r.ok && !r.skipped).length, failed: reports.filter(r => !r.ok).length,
    skipped: reports.filter(r => r.skipped).length, ms: Date.now() - started } }
}
