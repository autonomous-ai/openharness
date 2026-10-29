import type { PrismaClient } from '@prisma/client'
import { incrementUsageTotals } from '../src/lib/productUsageWrite.js'

const DAY = 86_400_000

/**
 * A server released before receipts lived 4 days (main at 3571a6cef, src/lib/productUsage.ts ingestProductUsage and
 * commitReports): it accepts a report up to 35 days old and, in one transaction, looks its receipt up, writes it as
 * `{ _id, expiresAt: day + 36 }` with no life, and adds its totals. [afterLookup] holds it between the lookup and the write.
 */
export async function oldServerIngest(db: PrismaClient, report: { id: string; day: string; counters: Record<string, number> },
  now: Date, afterLookup?: () => Promise<void>): Promise<{ accepted: boolean; reason?: string }> {
  const stamp = Date.parse(report.day), today = Math.floor(now.getTime() / DAY) * DAY
  if (!(stamp <= today && stamp > today - 35 * DAY)) return { accepted: false, reason: 'EXPIRED' }
  await db.$transaction(async tx => {
    if (await tx.productUsageReceipt.findFirst({ where: { id: report.id }, select: { id: true } })) return
    await afterLookup?.()
    // The released call, word for word: this Prisma client writes no `life` when given none, as the released one could not.
    await tx.productUsageReceipt.createMany({ data: [{ id: report.id, expiresAt: new Date(stamp + 36 * DAY) }] })
    await incrementUsageTotals(tx, Object.entries(report.counters).map(([metric, value]) => ({ dayUtc: new Date(report.day), metric, value })))
  })
  return { accepted: true }
}
