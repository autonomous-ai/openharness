import 'dotenv/config'
import { closeBus } from './lib/bus.js'
import { reconcileCommunityLikeCounts } from './lib/db/communityLikeCounts.js'
import { backfillMachineFreeEntitlements } from './lib/db/freeEntitlement.js'
import {
  backfillMachineAuthMode,
  backfillMachinePresenceTurnsStarted,
  migrateAutonomousEnvironment,
  migrateMachineRename,
  migrateUserIdentityByEmail,
  migrateUserPresencePerMachine,
  pruneLegacyDeviceBindings,
} from './lib/db/migrate.js'
import { ensurePlans } from './lib/db/seed.js'
import { prisma } from './lib/prisma.js'
import { startQueryStats } from './lib/queryStats.js'
import { releaseSchema } from './lib/db/schemaRelease.js'
import { startSwarmDataRemoval } from './lib/db/swarmDataRemoval.js'
import { env } from './config/env.js'
import { machineBillingWorkerService } from './services/MachineBillingWorkerService.js'
import { productUsagePeopleRollupService } from './services/ProductUsagePeopleRollupService.js'
import { startReceiptSweep } from './lib/productUsageReceiptSweep.js'
import { logger } from './utils/logger.js'

// Singleton background process. HTTP/WS server.ts runs as a PM2 cluster and must never own schema
// writes, catalog syncs, migrations or periodic jobs; otherwise every live server worker races them.
async function start(): Promise<void> {
  // Every minute, this process's queries by model.action and filter shape (lib/queryStats.ts, DB roadmap Phase 1); its
  // jobs and startup migrations count as background.
  const stopQueryStats = startQueryStats()
  // Existing production data was created against staging upstreams. Stamp it before Prisma swaps
  // the old global unique indexes for their per-environment replacements.
  await migrateAutonomousEnvironment()
  await migrateUserIdentityByEmail()
  // Same reason: the old (user, day) unique must be gone before the push installs its replacement.
  await migrateUserPresencePerMachine()
  await releaseSchema()
  // AFTER the push: it creates the new collections + their unique indexes, and the copy uses $merge
  // so those indexes survive. Copying first would leave the unique index build to fail silently.
  await migrateMachineRename()
  // The copy can materialize rows from a collection the first pass never saw — stamp those too.
  await migrateAutonomousEnvironment()
  await ensurePlans()
  await backfillMachineAuthMode()
  await pruneLegacyDeviceBindings()
  await backfillMachineFreeEntitlements()
  await backfillMachinePresenceTurnsStarted()
  await reconcileCommunityLikeCounts()

  let stopReceiptSweep = (): void => {}
  let stopSwarmDataRemoval = (): void => {}
  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, stopping backend worker...`)
    const hardExit = setTimeout(() => process.exit(0), 5000)
    hardExit.unref()
    machineBillingWorkerService.stop()
    productUsagePeopleRollupService.stop()
    stopReceiptSweep()
    stopSwarmDataRemoval()
    // The last partial minute, before the database closes.
    stopQueryStats()
    void Promise.allSettled([prisma.$disconnect(), closeBus()]).finally(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  machineBillingWorkerService.start()
  productUsagePeopleRollupService.start()
  // Usage receipts from when they lived 36 days, a few at a time until none are left (lib/productUsageReceiptSweep.ts).
  stopReceiptSweep = startReceiptSweep(prisma)
  // Once after the release that deleted the Swarm (anh Dee, 2026-11-14): everything it stored goes, its files, its shares and its
  // collections, and the job stops once a pass finds nothing left (lib/db/swarmDataRemoval.ts). Irreversible.
  stopSwarmDataRemoval = startSwarmDataRemoval(prisma, env)
  // PM2 wait_ready gates the singleton worker's "online" state on schema/catalog/backfill startup.
  // Plain node/tsx runs do not provide process.send and simply continue.
  process.send?.('ready')
  logger.info('backend worker started')
}

start().catch((err) => {
  logger.error('Failed to start backend worker', err)
  process.exit(1)
})
