/**
 * Removes the old state every migrated Swarm still keeps beside its parts (Stability 2.1; src/superTabs/migration/dropLegacy.ts).
 * It first checks that every Swarm is in parts and refuses otherwise. By default it only counts: how many Swarms keep an old
 * state and how large it is. It prints counts and sizes only. Removing needs a database backup first, and both flags:
 *
 *   DATABASE_URL=… node --import tsx scripts/swarm-parts/drop-legacy-state.ts                                # count only
 *   DATABASE_URL=… node --import tsx scripts/swarm-parts/drop-legacy-state.ts --apply --backup-confirmed [--batch 100]
 */
import { PrismaClient } from '@prisma/client'
import { dropLegacyStates, dropOptions } from '../../src/superTabs/migration/dropLegacy.js'

async function main() {
  const options = dropOptions(process.argv.slice(2))
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the database to clean up.')
  const db = new PrismaClient()
  try {
    const report = await dropLegacyStates(db, options)
    console.log(JSON.stringify({ mode: options.apply ? 'apply' : 'dry run', ...report, keptMB: Number((report.keptBytes / 1_048_576).toFixed(1)) }))
    if (!report.ok) {
      console.error(`Refused: ${report.unmigrated} of ${report.swarms} Swarms are not in parts yet. Nothing was removed.`)
      process.exitCode = 1
    } else if (!options.apply) console.log('Dry run: nothing was removed. After a backup, add --apply --backup-confirmed to remove them.')
  } finally {
    await db.$disconnect()
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
