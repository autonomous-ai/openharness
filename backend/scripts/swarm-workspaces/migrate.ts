/**
 * Puts today's Swarms into Workspaces, or takes the Workspaces away again (src/superTabs/migration/workspaces.ts,
 * docs/plans/2026-10-27-swarm-workspaces.md). A dry run unless --apply: it prints what it would do and the anomalies to read
 * first (owners missing from their Swarms, people in several Workspaces, machines that would serve two Workspaces). Production
 * only with the owner's go, after the backend that knows Workspaces is deployed; turn on SWARM_WORKSPACES_REQUIRED only afterwards.
 *
 *   DATABASE_URL=… node --import tsx scripts/swarm-workspaces/migrate.ts [--apply]
 *   DATABASE_URL=… node --import tsx scripts/swarm-workspaces/migrate.ts --rollback [--apply]
 */
import { PrismaClient } from '@prisma/client'
import { migrateWorkspaces, rollbackWorkspaces } from '../../src/superTabs/migration/workspaces.js'

const args = new Set(process.argv.slice(2))
const unknown = [...args].filter(arg => !['--apply', '--rollback'].includes(arg))
if (unknown.length || !process.env.DATABASE_URL) {
  console.error('Usage: DATABASE_URL=… node --import tsx scripts/swarm-workspaces/migrate.ts [--rollback] [--apply]')
  process.exit(2)
}
const db = new PrismaClient()
try {
  const apply = args.has('--apply')
  const report = args.has('--rollback') ? await rollbackWorkspaces(db, { apply }) : await migrateWorkspaces(db, { apply })
  console.log(JSON.stringify(report, null, 2))
  if (report.failed.length) process.exitCode = 1
} finally {
  await db.$disconnect()
}
