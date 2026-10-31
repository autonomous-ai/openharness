import 'dotenv/config'
import { closeBus, redisSwarmStamps } from './lib/bus.js'
import { configureSwarmStamps } from './superTabs/cache.js'
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
import { startRetryStats } from './superTabs/retryStats.js'
import { releaseSchema } from './lib/db/schemaRelease.js'
import { startSwarmSweeps } from './superTabs/sweeps.js'
import { startLegacyDrop } from './superTabs/migration/dropLegacyJob.js'
import { startDeliverySettle } from './superTabs/deliverySettle.js'
import { startDeliveryCompaction } from './superTabs/deliveryCompaction.js'
import { startThreadBackfill } from './superTabs/threadBackfill.js'
import { appPullRequests, markFinishedGroups, startSwarmArchive, unknownPullRequests } from './superTabs/archive.js'
import { SuperTabStore } from './superTabs/store.js'
import { announceSwarmDeliveries } from './lib/swarmDeliveryPushes.js'
import { announceSwarmHostChanges } from './lib/swarmHostPushes.js'
import { announceSwarmChanges } from './lib/swarmClientPushes.js'
import { GitHubApp, githubAppConfig } from './github/app.js'
import { env } from './config/env.js'
import { machineBillingWorkerService } from './services/MachineBillingWorkerService.js'
import { productUsagePeopleRollupService } from './services/ProductUsagePeopleRollupService.js'
import { startReceiptSweep } from './lib/productUsageReceiptSweep.js'
import { startPendingUploadSweep } from './lib/pendingUploadSweep.js'
import { startRoutingReflection } from './lib/routingReflection.js'
import { logger } from './utils/logger.js'

// Singleton background process. HTTP/WS server.ts runs as a PM2 cluster and must never own schema
// writes, catalog syncs, migrations or periodic jobs; otherwise every live server worker races them.
async function start(): Promise<void> {
  // Every minute, this process's queries by model.action and filter shape (lib/queryStats.ts, DB roadmap Phase 1); its
  // jobs and startup migrations count as background.
  const stopQueryStats = startQueryStats()
  // Every minute, how often Swarm transactions ran again and commands loaded twice (superTabs/retryStats.ts, DB 2.1).
  const stopRetryStats = startRetryStats()
  // Existing production data was created against staging upstreams. Stamp it before Prisma swaps
  // the old global unique indexes for their per-environment replacements.
  await migrateAutonomousEnvironment()
  await migrateUserIdentityByEmail()
  // Same reason: the old (user, day) unique must be gone before the push installs its replacement.
  await migrateUserPresencePerMachine()
  await releaseSchema()
  // After the push, which adds the finished mark: parts written before it are marked once, so the archive pass finds them.
  await markFinishedGroups(prisma)
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

  let stopSweeps = (): void => {}
  let stopLegacyDrop = (): void => {}
  let stopArchive = (): void => {}
  let stopDeliveries = (): void => {}
  let stopCompaction = (): void => {}
  let stopThreadBackfill = (): void => {}
  let stopReceiptSweep = (): void => {}
  let stopPendingUploads = (): void => {}
  let stopReflection = (): void => {}
  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, stopping backend worker...`)
    const hardExit = setTimeout(() => process.exit(0), 5000)
    hardExit.unref()
    machineBillingWorkerService.stop()
    productUsagePeopleRollupService.stop()
    stopSweeps()
    stopLegacyDrop()
    stopArchive()
    stopDeliveries()
    stopCompaction()
    stopReceiptSweep()
    stopPendingUploads()
    stopReflection()
    stopThreadBackfill()
    // The last partial minute, before the database closes.
    stopQueryStats()
    stopRetryStats()
    void Promise.allSettled([prisma.$disconnect(), closeBus()]).finally(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  machineBillingWorkerService.start()
  productUsagePeopleRollupService.start()
  // Usage receipts from when they lived 36 days, a few at a time until none are left (lib/productUsageReceiptSweep.ts).
  stopReceiptSweep = startReceiptSweep(prisma)
  // Uploads begun on a link and never finished go an hour after the link expired, with what they stored (lib/pendingUploadSweep.ts).
  stopPendingUploads = startPendingUploadSweep(prisma, env)
  // The worker's sweeps and archive write Swarms: they bump the stamps the API processes read by. It reads too little to keep a cache.
  configureSwarmStamps(redisSwarmStamps(), { reads: false })
  // Archive notes and Workspace removals write messages too: their recipients' hosts hear of them at once, and of the
  // groups they changed.
  const swarms = new SuperTabStore(prisma, Date.now, null, { deliveriesWaiting: announceSwarmDeliveries, hostsChanged: announceSwarmHostChanges,
    swarmChanged: announceSwarmChanges })
  stopSweeps = startSwarmSweeps(prisma, undefined, () => swarms.workspaces.finishRemovals())
  // The dead old state of migrated Swarms goes by itself, a few at a time (superTabs/migration/dropLegacyJob.ts).
  stopLegacyDrop = startLegacyDrop(prisma)
  // Finished groups archive once GitHub says their pull requests are merged or closed; without the app, only groups that
  // link none do (superTabs/archive.ts).
  const githubConfig = githubAppConfig(env), githubApp = githubConfig ? new GitHubApp(githubConfig) : null
  stopArchive = startSwarmArchive(prisma, swarms, () => githubApp ? appPullRequests(githubApp) : unknownPullRequests)
  // A delivery that can no longer move ends as Not sent, instead of waiting for good (superTabs/deliverySettle.ts).
  stopDeliveries = startDeliverySettle(prisma, swarms)
  // Every hour, finished deliveries 14 days old move into their messages' receipts, kept forever (superTabs/deliveryCompaction.ts).
  stopCompaction = startDeliveryCompaction(prisma, env.SWARM_DELIVERY_COMPACTION)
  // Every 15 minutes, thread summaries for replies no write summed up: all of a Swarm's at first, then only what changed
  // (superTabs/threadBackfill.ts). Pages read the summaries once a Swarm is backfilled.
  stopThreadBackfill = startThreadBackfill(prisma)
  // At 23:00 in each project's time zone, what its routed work cost and how it went, with routing changes asked of its owner
  // (lib/routingReflection.ts).
  stopReflection = startRoutingReflection(prisma, swarms)
  // PM2 wait_ready gates the singleton worker's "online" state on schema/catalog/backfill startup.
  // Plain node/tsx runs do not provide process.send and simply continue.
  process.send?.('ready')
  logger.info('backend worker started')
}

start().catch((err) => {
  logger.error('Failed to start backend worker', err)
  process.exit(1)
})
