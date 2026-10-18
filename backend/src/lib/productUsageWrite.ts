import type { Prisma } from '@prisma/client'

export interface UsageIncrement { dayUtc: Date; metric: string; value: number }

/** One database round trip for a report's counters and separate margins. Called only inside the
 * receipt transaction: October's sequential upserts held shared daily totals long enough for
 * overlapping uploads to exhaust retries. No report body or identity becomes a stored document. */
export async function incrementUsageTotals(tx: Pick<Prisma.TransactionClient, '$runCommandRaw'>, increments: UsageIncrement[]): Promise<void> {
  if (!increments.length) return
  const result = await tx.$runCommandRaw({
    update: 'product_usage_totals', ordered: true,
    updates: increments.map(({ dayUtc, metric, value }) => ({
      q: { dayUtc: { $date: dayUtc.toISOString() }, metric },
      u: { $inc: { value } }, upsert: true,
    })),
  })
  // A command can return ok:1 with writeErrors. Never commit its receipt after a partial write.
  const errors = result.writeErrors
  if (result.ok !== 1 || result.n !== increments.length || result.writeConcernError
    || (Array.isArray(errors) && errors.length)) {
    const first = Array.isArray(errors) ? errors[0] as { code?: number } | undefined : undefined
    throw Object.assign(new Error('Product usage write unavailable'), {
      code: first?.code === 112 ? 'P2034' : first?.code === 11000 ? 'P2002' : 'USAGE_WRITE_FAILED',
    })
  }
}
