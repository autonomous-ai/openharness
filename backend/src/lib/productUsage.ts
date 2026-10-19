import { healthBreakdowns } from '../analytics/productHealth.js'
import type { ProductUsageContext } from '../types/productHealthContract.js'
import { createHmac } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Prisma } from '@prisma/client'
import { env } from '../config/env.js'
import { prisma } from './prisma.js'
import { PRODUCT_USAGE_DAYS, type ProductUsageChoice, type ProductUsageReport } from '../types/productUsage.js'
import { ACTIVITY_DAYS, type ActivitySurface } from '../types/productUsageActivity.js'
import { incrementUsageTotals, type UsageIncrement } from './productUsageWrite.js'
import { createUsageAdmission } from './productUsageAdmission.js'

const DAY = 86_400_000
const writeUsage = createUsageAdmission()
type Db = Pick<Prisma.TransactionClient, 'productUsagePreference' | 'analyticsMachineState'>

/** A pre-existing off choice wins over the new default. Never cache an enabled answer. */
export async function productUsageChoice(userId: string, db: Db = prisma): Promise<ProductUsageChoice> {
  const saved = await db.productUsagePreference.findUnique({ where: { userId }, select: { enabled: true, revision: true } })
  if (saved) return saved
  const off = await db.analyticsMachineState.findFirst({ where: { userId, consent: 'off' }, select: { id: true } })
  return { enabled: !off, revision: 0 }
}

export async function setProductUsageChoice(userId: string, enabled: boolean): Promise<ProductUsageChoice> {
  // Every explicit save advances the generation. A queue prepared before an off/on cycle is refused.
  const choice = await prisma.productUsagePreference.upsert({
    where: { userId }, create: { userId, enabled, revision: 1 },
    update: { enabled, revision: { increment: 1 } }, select: { enabled: true, revision: true },
  })
  if (!enabled) await deleteActivity(userId)
  return choice
}

function validDay(day: string, now: Date): boolean {
  const stamp = Date.parse(day + 'T00:00:00.000Z')
  const today = Math.floor(now.getTime() / DAY) * DAY
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === day
    && stamp <= today && stamp > today - PRODUCT_USAGE_DAYS * DAY
}

/** Identity is used for permission only. Neither it nor the report body reaches analytics storage. */
export async function ingestProductUsage(userId: string, report: ProductUsageReport, now = new Date()) {
  if (!validDay(report.day, now)) return { accepted: false, reason: 'EXPIRED' }
  return ingestCounters(report, userId, now)
}

export interface SetupUsageReport { id: string; day: string; counters: Record<string, number> }
/** Only the dedicated signed-out routes' narrow schemas (setup, Hub) may call this. No account/authentication lookup. */
export async function ingestSetupUsage(report: SetupUsageReport, now = new Date()) {
  const age = Math.floor(now.getTime() / DAY) * DAY - Date.parse(report.day + 'T00:00:00Z')
  if (!validDay(report.day, now) || age > DAY) return { accepted: false, reason: 'EXPIRED' }
  return ingestCounters(report)
}

async function ingestCounters(report: SetupUsageReport & { revision?: number; context?: ProductUsageContext }, userId?: string, now = new Date()) {
  if (report.context?.channel === 'development') return { accepted: true, reason: 'DEVELOPMENT' }
  const increments: UsageIncrement[] = []
  for (const [metric, value] of Object.entries(report.counters)) {
    if (!value) continue
    for (const name of [metric, ...healthBreakdowns(report.context, metric)]) {
      increments.push({ dayUtc: new Date(report.day), metric: name, value })
    }
  }
  if (report.context && report.day < now.toISOString().slice(0, 10)) {
    increments.push({ dayUtc: new Date(Math.floor(now.getTime() / DAY) * DAY),
      metric: `health_${report.context.surface}_report_late`, value: 1 })
  }
  // October's delivery audit found aggregate write conflicts. Retry the entire transaction,
  // including permission, without extending a slow request or waiting a full client interval.
  // At most four attempts; only fast conflicts may start another within the first second.
  return writeUsage(async () => {
    const started = performance.now()
    for (let attempt = 0; ; attempt++) {
      try {
        return await prisma.$transaction(async tx => {
          if (userId) {
            const choice = await productUsageChoice(userId, tx)
            if (!choice.enabled || choice.revision !== report.revision) return { accepted: false, reason: 'CHOICE_CHANGED', ...choice }
          }
          // Receipt and increments commit together; a lost HTTP response can be retried with the same id.
          await tx.productUsageReceipt.create({ data: {
            id: report.id, expiresAt: new Date(Date.parse(report.day) + (PRODUCT_USAGE_DAYS + 1) * DAY),
          } })
          await incrementUsageTotals(tx, increments)
          return { accepted: true }
        })
      } catch (error) {
        // A competing first writer of a daily total is not a duplicate unless its receipt committed.
        const code = (error as { code?: string } | null)?.code
        if (code === 'P2002'
            && await prisma.productUsageReceipt.findUnique({ where: { id: report.id }, select: { id: true } })) return { accepted: true }
        const pause = 25 * 2 ** attempt + Math.floor(Math.random() * 50)
        if ((code !== 'P2034' && code !== 'P2002') || attempt >= 3
            || performance.now() - started + pause >= 1000) throw error
        await delay(pause)
        if (performance.now() - started >= 1000) throw error
      }
    }
  })
}

export type RelayUsageMetric = 'relay_desktop_opens' | 'relay_tui_opens' | 'relay_mobile_opens' | 'relay_web_opens'
  | 'relay_harness-os_opens' | 'relay_harness-os-pi_opens'
  | 'relay_device_connections' | 'relay_machine_connections' | 'relay_remote_sessions' | 'relay_turns_started'

let warnedAt = 0
/** Older clients still contribute totals. These are events, never distinct users or installations. */
export async function recordRelayUsage(userId: string, now: Date, metric: RelayUsageMetric): Promise<void> {
  try {
    if (!(await productUsageChoice(userId)).enabled) return
    const dayUtc = new Date(Math.floor(now.getTime() / DAY) * DAY)
    const where = { dayUtc_metric: { dayUtc, metric } }
    try {
      await prisma.productUsageTotal.upsert({ where, create: { dayUtc, metric, value: 1 }, update: { value: { increment: 1 } } })
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error
      await prisma.productUsageTotal.update({ where, data: { value: { increment: 1 } } })
    }
  } catch {
    // Do not let analytics break a session or reach callers that log the account/agent and DB error.
    if (Date.now() - warnedAt >= 60_000) {
      warnedAt = Date.now()
      console.warn('[product-usage] Some aggregate counts are unavailable.')
    }
  }
}

const STAFF_EMAIL = '@autonomous.ai'

/** A keyed pseudonym: the same person maps to the same subject; the id never reaches the marks. */
export function activitySubject(userId: string, key: string): string {
  return createHmac('sha256', key).update(userId).digest('hex').slice(0, 32)
}

// This process's marks already written today: a person costs a few writes a day, not one per ping.
const marked = new Set<string>()
let markedDay = ''
export function resetActivityMarksForTests(): void { marked.clear(); markedDay = '' }
let activityWarnedAt = 0

/** Fire-and-forget from the relay touch points; never awaited by a socket, never throws. */
export async function markActivity(userId: string, now: Date, mark: { surface?: ActivitySurface; worked?: boolean },
  key: string = env.PRODUCT_USAGE_SUBJECT_KEY): Promise<void> {
  if (!key || (!mark.surface && !mark.worked)) return
  try {
    const dayUtc = new Date(Math.floor(now.getTime() / DAY) * DAY)
    const day = dayUtc.toISOString().slice(0, 10)
    if (day !== markedDay) { marked.clear(); markedDay = day }
    const subject = activitySubject(userId, key)
    const seen = `${subject}|${mark.surface ?? ''}|${mark.worked ? 'w' : ''}`
    if (marked.has(seen)) return
    if (!(await productUsageChoice(userId)).enabled) return
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true, email: true } })
    if (!user) return
    const where = { subject_dayUtc: { subject, dayUtc } }
    const update = { ...(mark.surface ? { surfaces: { push: mark.surface } } : {}), ...(mark.worked ? { worked: true } : {}) }
    try {
      await prisma.productUsageActivity.upsert({ where, update, create: {
        subject, dayUtc, surfaces: mark.surface ? [mark.surface] : [], worked: mark.worked === true,
        signupDay: new Date(Math.floor(user.createdAt.getTime() / DAY) * DAY),
        staff: user.email.toLowerCase().endsWith(STAFF_EMAIL),
        expiresAt: new Date(dayUtc.getTime() + ACTIVITY_DAYS * DAY),
      } })
    } catch (error) {
      // Another server process inserted this person's first mark of the day first.
      if ((error as { code?: string }).code !== 'P2002') throw error
      await prisma.productUsageActivity.update({ where, data: update })
    }
    // Sharing may have been turned off (and the marks deleted) while this write was in flight.
    if (!(await productUsageChoice(userId)).enabled) {
      await prisma.productUsageActivity.deleteMany({ where: { subject } })
      return
    }
    marked.add(seen)
  } catch {
    if (Date.now() - activityWarnedAt >= 60_000) {
      activityWarnedAt = Date.now()
      console.warn('[product-usage] Some activity marks are unavailable.')
    }
  }
}

/** Remove a person's marks at once, here and in this process's de-duplication. */
export async function deleteActivity(userId: string, key: string = env.PRODUCT_USAGE_SUBJECT_KEY): Promise<void> {
  if (!key) return
  const subject = activitySubject(userId, key)
  for (const seen of [...marked]) if (seen.startsWith(subject + '|')) marked.delete(seen)
  await prisma.productUsageActivity.deleteMany({ where: { subject } })
}

/** These were individual histories, not anonymous totals. The existing delete control must cover them. */
export async function deleteLegacyProductUsage(userId: string): Promise<void> {
  await Promise.all([
    prisma.userDailyPresence.deleteMany({ where: { userId } }),
    prisma.userDailyClientPresence.deleteMany({ where: { userId } }),
    prisma.userDailyRemoteUsage.deleteMany({ where: { userId } }),
    prisma.userDailyDevicePresence.deleteMany({ where: { userId } }),
    prisma.machineDailyPresence.deleteMany({ where: { userId } }),
    prisma.agentDailyPresence.deleteMany({ where: { userId } }),
    deleteActivity(userId),
  ])
}

async function ensureProductUsageTotalKey(): Promise<void> {
  // The API can receive relay counts before the singleton's general schema push. That push may
  // also decline unrelated changes. Install this correctness boundary explicitly; do not rely on it.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await prisma.$runCommandRaw({ createIndexes: 'product_usage_totals', indexes: [{
        key: { dayUtc: 1, metric: 1 }, name: 'product_usage_totals_dayUtc_metric_key', unique: true,
      }] })
      return
    } catch (error) {
      const failure = error as { meta?: { code?: string | number; message?: string } }
      if (String(failure.meta?.code) !== '11000' && !failure.meta?.message?.includes('E11000')) throw error
    }
    // Repair only duplicate aggregate keys, never account data. A transaction preserves increments
    // from concurrent writers: a changed/deleted row conflicts and retries instead of losing counts.
    // Bound each pass; a large backlog fails worker startup and resumes safely on its next start.
    try {
      await prisma.$transaction(async tx => {
        const [group] = await tx.productUsageTotal.groupBy({
          by: ['dayUtc', 'metric'], having: { id: { _count: { gt: 1 } } },
          orderBy: [{ dayUtc: 'asc' }, { metric: 'asc' }], take: 1,
        })
        if (!group) return
        const rows = await tx.productUsageTotal.findMany({
          where: { dayUtc: group.dayUtc, metric: group.metric },
          select: { id: true, value: true }, orderBy: { id: 'asc' }, take: 128,
        })
        if (rows.length < 2) return
        const [keeper, ...duplicates] = rows
        await tx.productUsageTotal.update({ where: { id: keeper.id },
          data: { value: { increment: duplicates.reduce((sum, row) => sum + row.value, 0) } } })
        await tx.productUsageTotal.deleteMany({ where: { id: { in: duplicates.map(row => row.id) } } })
      })
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2034') throw error
    }
  }
  throw new Error('Product usage aggregate key is not ready')
}

/** Run only in the singleton worker. Required keys and expiry must survive a declined schema push. */
export async function ensureProductUsageExpiry(): Promise<void> {
  await prisma.$runCommandRaw({ createIndexes: 'product_usage_preferences', indexes: [{
    key: { userId: 1 }, name: 'product_usage_preferences_userId_key', unique: true,
  }] })
  await ensureProductUsageTotalKey()
  for (const [collection, field, seconds] of [
    ['product_usage_receipts', 'expiresAt', 0],
    ['product_usage_totals', 'dayUtc', 396 * DAY / 1000],
    ...['user_daily_presence', 'user_daily_client_presence', 'user_daily_remote_usage', 'user_daily_device_presence',
      'machine_daily_presence', 'agent_daily_presence', 'analytics_daily_buckets', 'analytics_daily_machines']
      .map(name => [name, 'dayUtc', PRODUCT_USAGE_DAYS * DAY / 1000]),
    ['product_usage_activity', 'expiresAt', 0],
  ] as [string, string, number][]) {
    await prisma.$runCommandRaw({ createIndexes: collection, indexes: [{ key: { [field]: 1 }, name: 'product_usage_expiry', expireAfterSeconds: seconds }] })
  }
  await prisma.$runCommandRaw({ createIndexes: 'product_usage_activity', indexes: [{
    key: { subject: 1, dayUtc: 1 }, name: 'product_usage_activity_subject_dayUtc_key', unique: true,
  }] })
}
