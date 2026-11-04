import { PrismaClient, type Prisma } from '@prisma/client'
import { env } from '../config/env.js'
import { POOL_DEFAULTS, secondaryReadsUrl, withPoolDefaults } from './databaseUrl.js'
import { withQueryStats } from './queryStats.js'
import { metrics } from './metrics.js'

// The Prisma CLI (db push) reads env("DATABASE_URL"); keep it in sync for any manual run.
process.env.DATABASE_URL ??= env.DATABASE_URL

// Every query is timed for the per-minute `db by shape` log (lib/queryStats.ts, DB roadmap Phase 1) and into
// prisma_query_duration_seconds (lib/metrics.ts).
export const prisma = withQueryStats(new PrismaClient({
  datasources: { db: { url: withPoolDefaults(env.DATABASE_URL, POOL_DEFAULTS) } },
}), undefined, undefined, metrics.observeQuery)

/** The client for reads that tolerate a few seconds of lag, on [url] with the secondary options (databaseUrl.ts
 *  secondaryReadsUrl) and the pool defaults, its queries logged as `secondary:` in `db by shape`; [primary] itself when
 *  [reads] is off. Only reads go through it, never inside a transaction (a transaction reads the primary). */
export function readReplica(primary: PrismaClient, url: string, reads: 'on' | 'off',
  make: (url: string) => PrismaClient = url => new PrismaClient({ datasources: { db: { url } } })): PrismaClient {
  if (reads === 'off') return primary
  return withQueryStats(make(withPoolDefaults(secondaryReadsUrl(url), POOL_DEFAULTS)), undefined, undefined, metrics.observeQuery, 'secondary')
}

/** Older history pages, costs, search, leaderboard names and usage totals (task #2970). It connects on its first query. On a
 *  failover `secondaryPreferred` reads the primary by itself. */
export const prismaSecondary = readReplica(prisma, env.DATABASE_URL, env.DATABASE_SECONDARY_READS)

/** "Not soft-deleted" filter for Machine findMany where-clauses. Mongo-Prisma gotcha: legacy
 *  rows have NO `deletedAt` field and `{deletedAt: null}` matches only an explicit null, so the
 *  filter must accept both null and absent. `findUnique` can't take this — post-check
 *  `binding.deletedAt` instead. */
export const machineAlive: Prisma.MachineWhereInput = { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] }

/* Second Mongo-Prisma gotcha, sibling of the one above: an atomic `{ increment: n }` on a document
 * that LACKS the field stores `null` (it is a pipeline `$add`, and missing + n = null), and stays
 * null on every later increment — no error, and reads still return the schema default. So a numeric
 * counter added to an existing collection needs a one-time raw `$set` backfill for legacy rows
 * before any code increments it (see lib/db/migrate.ts backfillMachinePresenceTurnsStarted). */

// No signal handler here: each entry point disconnects in its own shutdown, the API only after its drain (server.ts),
// so requests it still serves while draining keep their database.
