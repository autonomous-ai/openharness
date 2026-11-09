import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuthUser } from '../../lib/ssoAuth.js'
import { fail } from '../model.js'
import { retryTransient } from '../retry.js'
import { membersOf } from './access.js'
import { MAX_RANGE_WEEKS, SETTLE_SLACK_MS, WEEK_CAP, WEEKS_KEPT, type ReportBody, type ShippingReported } from './contract.js'
import { none, PRIORITIES, WEIGHT, type Shipped } from './score.js'
import { WEEK_MS, weekStart } from './week.js'

/** One row: `week` 0 is an agent's all-time row. */
const rowId = (tabId: string, agentId: string, week: number): string => `${tabId}:${agentId}:${week}`

const counts = (shipped: Shipped): number[] => PRIORITIES.map(priority => shipped[priority])
const sameCounts = (a: Shipped, b: Shipped): boolean => PRIORITIES.every(priority => a[priority] === b[priority])
const nothing = (shipped: Shipped): boolean => PRIORITIES.every(priority => shipped[priority] === 0)
/** The label `builder:<name>` matches whatever its case, and width variants of a letter are one letter. */
const sameName = (a: string, b: string): boolean => a.normalize('NFKC').toLowerCase() === b.normalize('NFKC').toLowerCase()

/** Counts as a row has them, whatever order or shape an older row gave them in. */
const shippedOf = (stored: unknown): Shipped => {
  const list = Array.isArray(stored) ? stored : []
  return Object.fromEntries(PRIORITIES.map((priority, i) => [priority, Number(list[i] ?? 0)])) as Shipped
}

interface Stored { shipped: Shipped; settled: number; name?: string; failed: boolean }
const storedOf = (raw: Record<string, unknown>): Stored => ({ shipped: shippedOf(raw.shipped), settled: Number(raw.settled ?? 0),
  ...typeof raw.name === 'string' ? { name: raw.name } : {}, failed: typeof raw.failed === 'string' })

const BY_WEIGHT = [...PRIORITIES].sort((a, b) => WEIGHT[b] - WEIGHT[a])
/** A week's counts within WEEK_CAP, the highest priorities kept first. */
function withinCap(reported: Shipped): Shipped {
  let room = WEEK_CAP
  const kept = none()
  for (const priority of BY_WEIGHT) {
    kept[priority] = Math.min(reported[priority], Math.floor(room / WEIGHT[priority]))
    room -= kept[priority] * WEIGHT[priority]
  }
  return kept
}

/**
 * A daemon's report of what its person's agents shipped (docs/plans/2026-11-09-swarm-v4-leaderboard.md). For each agent it is
 * everything shipped from `from` to now, so a week it leaves out is zero (a revert took its issues back), and it is applied as
 * a set: sent twice, or in an older copy after a newer one, it ends as the last one sent. Only the sender's own agents on that
 * machine are taken; the others are skipped, never refused, so one agent that was removed does not stop the rest.
 *
 * What stays in the all-time row: every week's count (the only place weeks older than the five kept are), and `settled`, the
 * first week still open to a revert (a week ends, then 7 days pass, then an hour for a reading that began before them). Weeks
 * before it are final: a report that reaches back further changes nothing there, so a long backfill is counted once. A rename
 * settles every week before the current one, whose issues carry the old name. A failure keeps the numbers and says why.
 */
export async function applyReport(db: PrismaClient, user: AuthUser, machineId: string, body: ReportBody, now: number): Promise<ShippingReported> {
  const current = weekStart(now)
  for (const entry of body.agents) {
    if (!('weeks' in entry)) continue
    if (entry.from > current || entry.from < current - MAX_RANGE_WEEKS * WEEK_MS) fail('INVALID_REPORT', `A reading starts at most ${MAX_RANGE_WEEKS} weeks back, and never in the future.`, 400)
    if (entry.weeks.some(({ week }) => week < entry.from || week > current)) fail('INVALID_REPORT', 'A week of a reading lies between where it starts and this week.', 400)
  }
  await membersOf(db, user, body.tabId)
  return retryTransient(() => db.$transaction(tx => write(tx, user, machineId, body, now), { maxWait: 5_000, timeout: 15_000 }))
}

async function write(tx: Prisma.TransactionClient, user: AuthUser, machineId: string, body: ReportBody, now: number): Promise<ShippingReported> {
  const { tabId } = body, current = weekStart(now), oldest = current - (WEEKS_KEPT - 1) * WEEK_MS
  // The agents this person runs on this machine, live: nobody reports another's, or one from another computer.
  const mine = new Set((await tx.swarmAgent.aggregateRaw({ pipeline: [{ $match: { tabId, machineId, machineOwnerId: user.sub, deleted: false } }, { $project: { key: 1 } }] }) as unknown as
    Array<{ key: string }>).map(agent => agent.key))
  const entries = body.agents.filter(entry => mine.has(entry.agentId))
  const skipped = body.agents.length - entries.length
  if (!entries.length) return { applied: 0, skipped, capped: 0 }
  const weeksFrom = (from: number): number[] => Array.from({ length: (current - from) / WEEK_MS + 1 }, (_, i) => from + i * WEEK_MS)
  const ids = entries.flatMap(entry => [rowId(tabId, entry.agentId, 0), ...'weeks' in entry ? weeksFrom(entry.from).map(week => rowId(tabId, entry.agentId, week)) : []])
  const stored = new Map((await tx.swarmShipping.aggregateRaw({ pipeline: [{ $match: { _id: { $in: ids } } }] }) as unknown as Array<Record<string, unknown>>)
    .map(row => [String(row._id), storedOf(row)]))
  let capped = 0

  for (const entry of entries) {
    const totalId = rowId(tabId, entry.agentId, 0), total = stored.get(totalId)
    if (!('weeks' in entry)) {
      await tx.swarmShipping.upsert({ where: { id: totalId },
        create: { id: totalId, tabId, agentId: entry.agentId, week: 0, personId: user.sub, shipped: counts(none()), settled: 0, failed: entry.failed, failedMachineId: machineId },
        update: { failed: entry.failed, failedMachineId: machineId } })
      continue
    }
    const renamed = total?.name !== undefined && !sameName(total.name, entry.name)
    const settled = Math.max(total?.settled ?? 0, renamed ? current : 0)
    const sum = { ...total?.shipped ?? none() }
    const reported = new Map(entry.weeks.map(({ week, ...given }) => [week, shippedOf(PRIORITIES.map(priority => given[priority] ?? 0))]))
    for (const week of weeksFrom(Math.max(entry.from, settled))) {
      const asked = reported.get(week) ?? none(), after = withinCap(asked)
      if (!sameCounts(asked, after)) capped++
      const id = rowId(tabId, entry.agentId, week), before = stored.get(id)?.shipped ?? none()
      if (sameCounts(before, after)) continue
      for (const priority of PRIORITIES) sum[priority] = Math.max(0, sum[priority] + after[priority] - before[priority])
      if (nothing(after) || week < oldest) {
        if (stored.has(id)) await tx.swarmShipping.delete({ where: { id } })
      } else {
        await tx.swarmShipping.upsert({ where: { id }, create: { id, tabId, agentId: entry.agentId, week, personId: user.sub, shipped: counts(after) },
          update: { personId: user.sub, shipped: counts(after) } })
      }
    }
    const open = Math.max(settled, weekStart(now - SETTLE_SLACK_MS) - WEEK_MS)
    if (!total || total.failed || open !== total.settled || total.name !== entry.name || !sameCounts(sum, total.shipped)) {
      await tx.swarmShipping.upsert({ where: { id: totalId },
        create: { id: totalId, tabId, agentId: entry.agentId, week: 0, personId: user.sub, shipped: counts(sum), settled: open, name: entry.name },
        update: { personId: user.sub, shipped: counts(sum), settled: open, name: entry.name, failed: null, failedMachineId: null } })
    }
  }
  // The weeks past the five kept go with the next report that comes: delete on write, so nothing needs a sweep.
  await tx.swarmShipping.deleteMany({ where: { tabId, week: { gt: 0, lt: oldest } } })
  return { applied: entries.length, skipped, capped }
}
