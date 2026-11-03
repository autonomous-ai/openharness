/**
 * Gives every project from before instructions its document (src/superTabs/migration/instructions.ts,
 * docs/plans/2026-10-30-project-instructions-design.md, Migration). A dry run unless --apply: it prints each document it
 * would write, with its project, origin and size, and writes nothing. It prints no document's text, which holds its team's
 * private role texts and rules (review of phase 2), unless --text names that one Swarm. Run after the backend that knows
 * instructions is deployed; production only with the owner's go. A second run finds nothing to do; a Swarm that failed
 * (a command changed it meanwhile) is listed and taken again by the next run.
 *
 *   DATABASE_URL=… node --import tsx scripts/swarm-instructions/migrate.ts [--apply] [--text TAB_ID]
 */
import { parseArgs } from 'node:util'
import { PrismaClient } from '@prisma/client'
import { migrateInstructions, printableReport } from '../../src/superTabs/migration/instructions.js'

const USAGE = 'Usage: DATABASE_URL=… node --import tsx scripts/swarm-instructions/migrate.ts [--apply] [--text TAB_ID]'
/** The options, or null for anything else: an unknown flag, a positional, or --text without a Swarm. */
function options(): { apply: boolean; text?: string } | null {
  try {
    const { values } = parseArgs({ options: { apply: { type: 'boolean' }, text: { type: 'string' } }, strict: true, allowPositionals: false })
    return values.text === '' ? null : { apply: !!values.apply, text: values.text }
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
  const report = await migrateInstructions(db, { apply: parsed.apply })
  console.log(JSON.stringify(printableReport(report, { textOf: parsed.text }), null, 2))
  if (!report.apply) console.log(`Dry run: ${report.documents.length} documents would be written. Nothing was written; add --apply to write them.`)
  if (report.failed.length) process.exitCode = 1
} finally {
  await db.$disconnect()
}
