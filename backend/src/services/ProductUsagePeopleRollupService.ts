import { peopleCounters } from '../analytics/peopleCounters.js'
import { ACTIVITY_DAYS } from '../types/productUsageActivity.js'
import { prisma } from '../lib/prisma.js'
import { setUsageTotals } from '../lib/productUsageWrite.js'
import { logger } from '../utils/logger.js'

const DAY = 86_400_000
const INTERVAL_MS = 60 * 60_000

/** Recompute people totals for every ended day whose marks still live. Idempotent ($set). */
export async function rollupPeople(now = new Date()): Promise<number> {
  const today = Math.floor(now.getTime() / DAY) * DAY
  // Days peopleCounters still writes (it skips days whose marks may be expiring) and the days after them.
  // ponytail: reads every mark in that window (≤ people × 9 days); use an aggregation pipeline past ~100k rows.
  const marks = await prisma.productUsageActivity.findMany({
    where: { dayUtc: { gte: new Date(today - (ACTIVITY_DAYS - 1) * DAY) } },
    select: { subject: true, dayUtc: true, surfaces: true, worked: true, hosting: true, signupDay: true, staff: true },
  })
  const counters = peopleCounters(marks, now)
  await setUsageTotals(prisma, counters.map(({ day, metric, value }) => ({ dayUtc: new Date(day), metric, value })))
  return counters.length
}

class ProductUsagePeopleRollupService {
  private timer: NodeJS.Timeout | undefined
  start(): void {
    if (this.timer) return
    const tick = () => void rollupPeople().catch(err => logger.warn('people rollup failed; retrying next hour', { error: String(err) }))
    tick()
    this.timer = setInterval(tick, INTERVAL_MS)
    this.timer.unref?.()
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }
}
export const productUsagePeopleRollupService = new ProductUsagePeopleRollupService()
