import { healthBreakdowns } from '../analytics/productHealth.js'
import type { ProductUsageContext } from '../types/productHealthContract.js'
import { createHmac } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Prisma, PrismaClient } from '@prisma/client'
import { env } from '../config/env.js'
import { prisma } from './prisma.js'
import { ensureIndex } from './db/indexes.js'
import { PRODUCT_USAGE_DAYS, type ProductUsageChoice, type ProductUsageReport } from '../types/productUsage.js'
import { ACTIVITY_DAYS, type ActivitySurface } from '../types/productUsageActivity.js'
import { PRODUCT_USAGE_RECEIPT_DAYS, PRODUCT_USAGE_RECEIPT_EXPIRY_DAYS } from '../types/productUsageReceipt.js'
import { incrementUsageTotals, type UsageIncrement } from './productUsageWrite.js'
import { createUsageBatch } from './productUsageBatch.js'
import { createRelayTotals } from './productUsageRelay.js'

const DAY = 86_400_000
type Db = Pick<Prisma.TransactionClient, 'productUsagePreference' | 'analyticsMachineState'>

/** A pre-existing off choice wins over the new default. Never cache an enabled answer: every caller reads it live.
 * The one cache is `relayEnabled`'s, for counting connects, and it keeps only an off answer. */
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
  dropRelayChoice(userId)
  if (!enabled) await deleteActivity(userId)
  return choice
}

function validDay(day: string, now: Date): boolean {
  const stamp = Date.parse(day + 'T00:00:00.000Z')
  const today = Math.floor(now.getTime() / DAY) * DAY
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === day
    && stamp <= today && stamp > today - PRODUCT_USAGE_RECEIPT_DAYS * DAY
}

/** [productUsageChoice] for several accounts at once, in two reads: a batch's permission checks. */
async function productUsageChoices(userIds: string[], db: Db): Promise<Map<string, ProductUsageChoice>> {
  const choices = new Map<string, ProductUsageChoice>()
  if (!userIds.length) return choices
  for (const saved of await db.productUsagePreference.findMany({ where: { userId: { in: userIds } },
    select: { userId: true, enabled: true, revision: true } })) choices.set(saved.userId, { enabled: saved.enabled, revision: saved.revision })
  const unsaved = userIds.filter(id => !choices.has(id))
  const off = new Set(unsaved.length ? (await db.analyticsMachineState.findMany({ where: { userId: { in: unsaved }, consent: 'off' },
    select: { userId: true } })).map(row => row.userId) : [])
  for (const id of unsaved) choices.set(id, { enabled: !off.has(id), revision: 0 })
  return choices
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

// Which accounts are the team's, by id, as [apartPrefix] last read them: an email does not change under its
// id, and a report a minute from every app should not cost a lookup each. Bounded; cleared when full.
const staffAccounts = new Map<string, boolean>()
const STAFF_ACCOUNTS_MAX = 10_000

/**
 * The prefix a report's totals are kept under, apart from the ones every review reads (`usage:daily` asks for
 * none of these): `testing:` for a tester's build (the phone from TestFlight, `context.channel: 'testing'`),
 * `staff:` for the team's own accounts (`@autonomous.ai`, as activity marks already flag them). On 16–19 October
 * 2026 the team was 8–30% of the phone's people each day, and a TestFlight build's counts were the App Store's.
 * Kept, not dropped, so either can still be read on its own. Signed-out setup reports have no account to ask.
 *
 * Read inside the batch's transaction, beside the permission check, one read for the accounts not seen yet.
 */
async function apartPrefixes(tx: Pick<Prisma.TransactionClient, 'user'>, reports: QueuedReport[]): Promise<string[]> {
  const unknown = [...new Set(reports.filter(r => r.context?.channel !== 'testing' && r.userId && !staffAccounts.has(r.userId))
    .map(r => r.userId!))]
  if (unknown.length) {
    const emails = new Map((await tx.user.findMany({ where: { id: { in: unknown } }, select: { id: true, email: true } }))
      .map(user => [user.id, user.email]))
    if (staffAccounts.size + unknown.length > STAFF_ACCOUNTS_MAX) staffAccounts.clear()
    for (const id of unknown) staffAccounts.set(id, !!emails.get(id)?.toLowerCase().endsWith(STAFF_EMAIL))
  }
  return reports.map(r => r.context?.channel === 'testing' ? 'testing:' : r.userId && staffAccounts.get(r.userId) ? 'staff:' : '')
}
export function resetStaffAccountsForTests(): void { staffAccounts.clear() }

interface QueuedReport { id: string; day: string; revision?: number; context?: ProductUsageContext; userId?: string
  increments: UsageIncrement[] }
type IngestResult = { accepted: true } | ({ accepted: false; reason: 'CHOICE_CHANGED' } & ProductUsageChoice)

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
  return writeUsage({ id: report.id, day: report.day, revision: report.revision, context: report.context, userId, increments })
}

const writeUsage = createUsageBatch(commitReports)

/** One transaction for a batch: each report's permission, its receipt and the batch's summed totals commit together;
 * a lost HTTP response can be retried with the same id, and a receipt already committed counts once. Write conflicts
 * now come only from another process's batch: the whole batch is retried, permission included, at most four
 * attempts, and only fast conflicts may start another within the first second. */
async function commitReports(reports: QueuedReport[]): Promise<IngestResult[]> {
  const started = performance.now()
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async tx => {
        const choices = await productUsageChoices([...new Set(reports.flatMap(r => r.userId ? [r.userId] : []))], tx)
        const results: IngestResult[] = reports.map(r => {
          const choice = r.userId ? choices.get(r.userId)! : null
          return !choice || (choice.enabled && choice.revision === r.revision) ? { accepted: true }
            : { accepted: false, reason: 'CHOICE_CHANGED', ...choice }
        })
        const permitted = reports.filter((_, i) => results[i].accepted)
        const received = new Set((await tx.productUsageReceipt.findMany({
          where: { id: { in: [...new Set(permitted.map(r => r.id))] } }, select: { id: true } })).map(r => r.id))
        // A report sent again while its first copy is in this same batch counts once too.
        const fresh: QueuedReport[] = []
        for (const r of permitted) if (!received.has(r.id)) { received.add(r.id); fresh.push(r) }
        if (!fresh.length) return results
        await tx.productUsageReceipt.createMany({ data: fresh.map(r => ({
          // [life]: once the receipt sweep's rule is installed, a server that does not write it cannot count (productUsageReceiptSweep.ts).
          id: r.id, expiresAt: new Date(Date.parse(r.day) + PRODUCT_USAGE_RECEIPT_EXPIRY_DAYS * DAY), life: PRODUCT_USAGE_RECEIPT_EXPIRY_DAYS })) })
        const apart = await apartPrefixes(tx, fresh)
        await incrementUsageTotals(tx, summed(fresh.flatMap((r, i) =>
          apart[i] ? r.increments.map(inc => ({ ...inc, metric: apart[i] + inc.metric })) : r.increments)))
        return results
      })
    } catch (error) {
      await pauseForConflict(error, attempt, started)
    }
  }
}

/** Waits before another attempt after a write conflict from another process's batch, or throws [error]: any other
 * failure, a fourth attempt, or a wait that would pass a second. */
async function pauseForConflict(error: unknown, attempt: number, started: number): Promise<void> {
  const code = (error as { code?: string } | null)?.code
  const pause = 25 * 2 ** attempt + Math.floor(Math.random() * 50)
  // A Mongo lock wait comes without a Prisma code, labelled transient, as Swarm's do (superTabs/store.ts).
  const transient = error instanceof Error && error.message.includes('TransientTransactionError')
  if ((code !== 'P2034' && code !== 'P2002' && !transient) || attempt >= 3
    || performance.now() - started + pause >= 1000) throw error
  await delay(pause)
  if (performance.now() - started >= 1000) throw error
}

/** One update per day and name, whichever reports added to it. */
function summed(increments: UsageIncrement[]): UsageIncrement[] {
  const totals = new Map<string, UsageIncrement>()
  for (const inc of increments) {
    const key = `${inc.dayUtc.toISOString()}|${inc.metric}`
    const seen = totals.get(key)
    if (seen) seen.value += inc.value
    else totals.set(key, { ...inc })
  }
  return [...totals.values()]
}

export type RelayUsageMetric = 'relay_desktop_opens' | 'relay_tui_opens' | 'relay_mobile_opens' | 'relay_web_opens'
  | 'relay_harness-os_opens' | 'relay_harness-os-pi_opens'
  | 'relay_device_connections' | 'relay_machine_connections' | 'relay_remote_sessions' | 'relay_turns_started'
  // The phone's opens again, apart (`dailyTracking.ts` mobileOpenMetrics): from a debug or simulator build, and by release.
  | 'relay_mobile_debug_opens' | `breakdown:release:phone:${string}:relay_mobile_opens`

let warnedAt = 0
// A person who turned sharing off still opens sockets, so a process keeps that off answer a few seconds and skips the
// read. An on answer is never kept: sharing turned off anywhere stops the next connect here at once (a burst of
// connects that arrive while one read is under way share it). The cost is on the safe side: when a person turns
// sharing back on elsewhere, this process goes on not counting for up to the TTL. Only counting uses it: the
// activity marks are about a person and always read the preference itself. A change in this process drops the entry
// at once, and a read that began before the change is not kept.
const RELAY_CHOICE_TTL_MS = 5_000
const RELAY_CHOICE_MAX = 10_000
const relayOff = new Map<string, number>()
const relayReads = new Map<string, Promise<boolean>>()
let relayChoiceEpoch = 0

function dropRelayChoice(userId: string): void {
  relayChoiceEpoch++
  relayOff.delete(userId)
  relayReads.delete(userId)
}

async function relayEnabled(userId: string): Promise<boolean> {
  const until = relayOff.get(userId)
  if (until !== undefined && until > Date.now()) return false
  const reading = relayReads.get(userId)
  if (reading) return reading
  const epoch = relayChoiceEpoch
  const read = productUsageChoice(userId).then(({ enabled }) => {
    if (!enabled && epoch === relayChoiceEpoch) {
      if (relayOff.size >= RELAY_CHOICE_MAX) relayOff.clear()
      relayOff.set(userId, Date.now() + RELAY_CHOICE_TTL_MS)
    }
    return enabled
  }).finally(() => { if (relayReads.get(userId) === read) relayReads.delete(userId) })
  relayReads.set(userId, read)
  return read
}

/** A batch of connect totals and its receipt commit together; a batch seen again adds nothing. The receipt
 * outlives every retry (a held batch is dropped after five minutes). */
async function writeRelayBatch(id: string, increments: UsageIncrement[]): Promise<void> {
  const receipt = `relay:${id}`
  const started = performance.now()
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async tx => {
        if ((await tx.productUsageReceipt.findMany({ where: { id: { in: [receipt] } }, select: { id: true } })).length) return
        await tx.productUsageReceipt.createMany({ data: [{ id: receipt, expiresAt: new Date(Date.now() + 2 * DAY) }] })
        await incrementUsageTotals(tx, increments)
      })
    } catch (error) {
      await pauseForConflict(error, attempt, started)
    }
  }
}

const relayTotals = createRelayTotals({ write: writeRelayBatch })
export const flushRelayUsage = relayTotals.flush
/** Run in each process that takes connections. The stop it returns flushes what is waiting: call it on shutdown. */
export const startRelayUsageFlush = relayTotals.start
export function resetRelayUsageForTests(): void { relayOff.clear(); relayReads.clear(); relayChoiceEpoch++; relayTotals.reset() }

/** Older clients still contribute totals. These are events, never distinct users or installations.
 *  [also]: more totals the same event adds to, under the one preference read. Counted in memory and
 *  written once a minute (`createRelayTotals`). */
export async function recordRelayUsage(userId: string, now: Date, metric: RelayUsageMetric,
  also: readonly RelayUsageMetric[] = []): Promise<void> {
  try {
    if (!(await relayEnabled(userId))) return
    const dayUtc = new Date(Math.floor(now.getTime() / DAY) * DAY)
    for (const name of [metric, ...also]) relayTotals.add(dayUtc, name)
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

async function ensureProductUsageTotalKey(db: PrismaClient): Promise<void> {
  // The API can receive relay counts before the singleton's general schema push. That push may
  // also decline unrelated changes. Install this correctness boundary explicitly; do not rely on it.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await ensureIndex(db, 'product_usage_totals', { key: { dayUtc: 1, metric: 1 }, name: 'product_usage_totals_dayUtc_metric_key', unique: true })
      return
    } catch (error) {
      const failure = error as { meta?: { code?: string | number; message?: string } }
      if (String(failure.meta?.code) !== '11000' && !failure.meta?.message?.includes('E11000')) throw error
    }
    // Repair only duplicate aggregate keys, never account data. A transaction preserves increments
    // from concurrent writers: a changed/deleted row conflicts and retries instead of losing counts.
    // Bound each pass; a large backlog fails worker startup and resumes safely on its next start.
    try {
      await db.$transaction(async tx => {
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
export async function ensureProductUsageExpiry(db: PrismaClient = prisma): Promise<void> {
  await ensureIndex(db, 'product_usage_preferences', { key: { userId: 1 }, name: 'product_usage_preferences_userId_key', unique: true })
  await ensureProductUsageTotalKey(db)
  for (const [collection, field, seconds] of [
    ['product_usage_receipts', 'expiresAt', 0],
    ['product_usage_totals', 'dayUtc', 396 * DAY / 1000],
    ...['user_daily_presence', 'user_daily_client_presence', 'user_daily_remote_usage', 'user_daily_device_presence',
      'machine_daily_presence', 'agent_daily_presence', 'analytics_daily_buckets', 'analytics_daily_machines']
      .map(name => [name, 'dayUtc', PRODUCT_USAGE_DAYS * DAY / 1000]),
    ['product_usage_activity', 'expiresAt', 0],
  ] as [string, string, number][]) {
    await ensureIndex(db, collection, { key: { [field]: 1 }, name: 'product_usage_expiry', expireAfterSeconds: seconds })
  }
  await ensureIndex(db, 'product_usage_activity', { key: { subject: 1, dayUtc: 1 }, name: 'product_usage_activity_subject_dayUtc_key', unique: true })
}
