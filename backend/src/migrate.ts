/**
 * The one-off job that moves every Swarm to parts (docs/design/2026-10-26-swarm-state-parts.md, section 6.1):
 * `node dist/migrate.js`, run with no old backend process left. Exits 1 when any Swarm failed (it is left as it was),
 * 2 when a writer is still running.
 */
import { prisma } from './lib/prisma.js'
import { logger } from './utils/logger.js'
import { migrateAll } from './superTabs/migration/job.js'

try {
  const { totals } = await migrateAll(prisma, { log: report => report.ok ? logger.info('[swarm-parts] migrated', { ...report })
    : logger.error('[swarm-parts] not migrated', undefined, { ...report }) })
  logger.info('[swarm-parts] migration finished', totals)
  process.exitCode = totals.failed ? 1 : 0
} catch (error) {
  logger.error('[swarm-parts] migration did not start', error)
  process.exitCode = 2
} finally {
  await prisma.$disconnect()
}
