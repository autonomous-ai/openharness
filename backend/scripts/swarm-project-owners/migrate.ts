/**
 * Gives every project from before ownerGeneration its owner's membership, and passes on each project whose owner already
 * left (src/superTabs/migration/projectOwners.ts, task #3073). A dry run unless --apply: it prints how many projects it
 * would fill and each handover (Swarm, project, old and new owner id; never a project's name), and writes nothing. Run
 * right after the backend that knows ownerGeneration is deployed; production only with the owner's go. A second run finds
 * nothing to do; a Swarm that failed (a command changed it meanwhile) is listed and taken again by the next run.
 *
 *   DATABASE_URL=… node --import tsx scripts/swarm-project-owners/migrate.ts [--apply]
 */
import { parseArgs } from 'node:util'
import { PrismaClient } from '@prisma/client'
import { migrateProjectOwners } from '../../src/superTabs/migration/projectOwners.js'

const USAGE = 'Usage: DATABASE_URL=… node --import tsx scripts/swarm-project-owners/migrate.ts [--apply]'
/** The options, or null for anything else: an unknown flag or a positional. */
function options(): { apply: boolean } | null {
  try {
    const { values } = parseArgs({ options: { apply: { type: 'boolean' } }, strict: true, allowPositionals: false })
    return { apply: !!values.apply }
  } catch {
    return null
  }
}
const parsed = options()
if (!parsed || !process.env.DATABASE_URL) {
  console.error(USAGE)
  process.exit(2)
}
const db = new PrismaClient()
try {
  const report = await migrateProjectOwners(db, { apply: parsed.apply })
  console.log(JSON.stringify(report, null, 2))
  if (!report.apply) console.log(`Dry run: ${report.filled} projects would be filled and ${report.handovers.length} passed on. Nothing was written; add --apply to write them.`)
  if (report.failed.length) process.exitCode = 1
} finally {
  await db.$disconnect()
}
