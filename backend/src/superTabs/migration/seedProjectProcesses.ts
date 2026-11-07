/** Explicit operator entry point, dry-run by default. Production application needs the release owner's authorization.
 * From backend/: node --import tsx src/superTabs/migration/seedProjectProcesses.ts [--apply]
 * DATABASE_URL is supplied by the operator's environment; never print it. */
import { parseArgs } from 'node:util'
import { PrismaClient } from '@prisma/client'
import { seedProjectProcesses } from './projectProcesses.js'
import { SuperTabError } from '../model.js'

let apply = false
try {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' } }, strict: true, allowPositionals: false })
  apply = !!values.apply
  if (!process.env.DATABASE_URL) throw new Error('missing database')
} catch {
  console.error('Supply DATABASE_URL in the environment. Usage: node --import tsx src/superTabs/migration/seedProjectProcesses.ts [--apply]')
  process.exit(2)
}
const db = new PrismaClient()
try {
  const report = await seedProjectProcesses(db, { apply })
  console.log(JSON.stringify(report, null, 2))
  if (report.held.length) process.exitCode = 1
} catch (error) {
  console.error(error instanceof SuperTabError ? `${error.code}: ${error.message}` : 'PROCESS_SEED_FAILED: database write failed; no seed changes were committed. Read the dry run before trying again.')
  process.exitCode = 1
} finally {
  await db.$disconnect()
}
