/**
 * Approves once the GitHub repositories Swarm projects use now, before every Swarm needs an approval for App tokens
 * (src/github/currentApprovals.ts, task #1694). A dry run unless --apply: it prints the count and each (Swarm, project,
 * repository) pair it would approve, and writes nothing. Production --apply only with the owner's go, after its dry run was
 * read; the PM runs the production dry run with the read-only login. A second run finds nothing to do.
 *
 *   DATABASE_URL=… node --import tsx scripts/swarm-github-approvals/approve-current.ts [--apply]
 */
import { parseArgs } from 'node:util'
import { PrismaClient } from '@prisma/client'
import { approveCurrentPairs } from '../../src/github/currentApprovals.js'

const USAGE = 'Usage: DATABASE_URL=… node --import tsx scripts/swarm-github-approvals/approve-current.ts [--apply]'
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
  const report = await approveCurrentPairs(db, { apply: parsed.apply })
  console.log(JSON.stringify(report, null, 2))
  if (!report.apply) console.log(`Dry run: ${report.pairs.length} pairs would be approved. Nothing was written; add --apply to write them.`)
  if (report.failed.length) process.exitCode = 1
} finally {
  await db.$disconnect()
}
