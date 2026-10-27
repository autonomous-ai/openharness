/**
 * Puts today's Swarms into Teams, or takes the Teams away again (src/superTabs/migration/orgs.ts,
 * docs/plans/2026-10-27-swarm-teams.md). A dry run unless --apply: it prints what it would do and the anomalies to read
 * first (owners missing from their Swarms, people in several Teams, machines that would serve two Teams). Production
 * only with the owner's go, after the backend that knows Teams is deployed; turn on SWARM_TEAMS_REQUIRED only afterwards.
 *
 *   DATABASE_URL=… node --import tsx scripts/swarm-orgs/migrate.ts [--apply]
 *   DATABASE_URL=… node --import tsx scripts/swarm-orgs/migrate.ts --rollback [--apply]
 */
import { PrismaClient } from '@prisma/client'
import { migrateOrgs, rollbackOrgs } from '../../src/superTabs/migration/orgs.js'

const args = new Set(process.argv.slice(2))
const unknown = [...args].filter(arg => !['--apply', '--rollback'].includes(arg))
if (unknown.length || !process.env.DATABASE_URL) {
  console.error('Usage: DATABASE_URL=… node --import tsx scripts/swarm-orgs/migrate.ts [--rollback] [--apply]')
  process.exit(2)
}
const db = new PrismaClient()
try {
  const apply = args.has('--apply')
  const report = args.has('--rollback') ? await rollbackOrgs(db, { apply }) : await migrateOrgs(db, { apply })
  console.log(JSON.stringify(report, null, 2))
  if (report.failed.length) process.exitCode = 1
} finally {
  await db.$disconnect()
}
