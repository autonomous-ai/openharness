import { dailyProductHealth } from './analytics/productHealth.js'
/** Aggregate-only daily report. Run with a read-only database identity; never prints identifiers. */
import { PrismaClient } from '@prisma/client'
import { DAILY_PRODUCT_METRICS, dailyProductUsage } from './analytics/dailyProductUsage.js'
import { dailyProductReview } from './analytics/dailyProductReview.js'
import { dailyProductPeople } from './analytics/dailyProductPeople.js'
import { PEOPLE_METRICS } from './analytics/peopleCounters.js'
import { dailyHubUsage } from './analytics/dailyHubUsage.js'
import { HUB_METRICS } from './lib/hubMetricsContract.js'
const days = Number(process.argv[2] ?? 14)
if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('Choose 1–90 days')
const db = new PrismaClient()
try {
  const today = Math.floor(Date.now() / 86400000) * 86400000
  const metrics = [...DAILY_PRODUCT_METRICS, ...PEOPLE_METRICS, ...HUB_METRICS]
  const rows = await db.productUsageTotal.findMany({
    // Four-week cohorts need their full follow-up; calendar-month comparisons need both prior months.
    where: { dayUtc: { gte: new Date(today - 92 * 86400000), lt: new Date(today + 86400000) }, metric: { in: metrics } },
    select: { dayUtc: true, metric: true, value: true }, orderBy: [{ dayUtc: 'asc' }, { metric: 'asc' }], take: 93 * metrics.length,
  })
  const breakdowns = await db.productUsageTotal.findMany({
    where: { dayUtc: { gte: new Date(today - (days - 1) * 86400000), lt: new Date(today + 86400000) }, metric: { startsWith: 'breakdown:' } },
    select: { dayUtc: true, metric: true, value: true }, orderBy: [{ dayUtc: 'desc' }, { metric: 'asc' }], take: 50000,
  })
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), timezone: 'UTC',
    definitions: {
      population: 'Daemon counts cover participating signed-in installations, including staff and both service environments. App flows and optional signed-out setup counts are separate populations, never unique people.',
      active: 'An attached desktop/terminal window or a reported agent turn; background presence can count.',
      working: 'At least one new observed agent turn; human and automated work are combined.',
      first: 'First measured work since the current preference generation, not account signup or task success.',
      activation: 'No signup-to-value activation rate is inferred from first measured work. This report has no unique signup denominator; task outcomes are optional self-reports, not an objective success measure.',
      weekly: 'Monday–Sunday UTC; compare weekly_returning_installations in a complete week with weekly_working_installations in the preceding complete week.',
      outcomes: 'Matched observed turn ends and interruptions, not task success. Missing or interrupted telemetry is not a failed task.',
      relay: 'Legacy relay event totals are separate; never add them to the client counters.',
      hub: 'Anonymous Hub visits and clicks from browsers are a separate population again; never add them to app, daemon or people counts.',
      coverage: 'New local counters need updated clients. Delayed/offline reports and privacy changes can affect counts; today is incomplete.',
    }, ...dailyProductUsage(rows, days, new Date()), review: dailyProductReview(rows, new Date()), people: dailyProductPeople(rows, days, new Date()), hub: dailyHubUsage(rows, days, new Date()), health: { ...dailyProductHealth([...rows, ...breakdowns], new Date()), breakdownReadLimitReached: breakdowns.length === 50000 } }, null, 2))
} catch { console.error('Could not read aggregate product usage. Check the read-only connection and schema.'); process.exitCode = 1 }
finally { await db.$disconnect() }
