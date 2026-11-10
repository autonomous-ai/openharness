import 'dotenv/config'
import { closeBus, pub, redisSwarmStamps } from './lib/bus.js'
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
import { prisma, prismaSecondary } from './lib/prisma.js'
import { startQueryStats } from './lib/queryStats.js'
import { startRetryStats } from './superTabs/retryStats.js'
import { releaseSchema } from './lib/db/schemaRelease.js'
import { startSwarmSweeps } from './superTabs/sweeps.js'
import { startLegacyDrop } from './superTabs/migration/dropLegacyJob.js'
import { startAccountNames } from './superTabs/migration/accountNamesJob.js'
import { startDeliverySettle } from './superTabs/deliverySettle.js'
import { startDeliveryRepush } from './superTabs/deliveryRepush.js'
import { startDeliveryCompaction } from './superTabs/deliveryCompaction.js'
import { startThreadBackfill } from './superTabs/threadBackfill.js'
import { markFeedIds } from './superTabs/read/feedIds.js'
import { startTimeChecks } from './superTabs/timeChecks.js'
import { SuperTabStore } from './superTabs/store.js'
import { announceSwarmDeliveries, announceSwarmTerminal } from './lib/swarmDeliveryPushes.js'
import { announceSwarmHostChanges } from './lib/swarmHostPushes.js'
import { announceSwarmChanges } from './lib/swarmClientPushes.js'
import { env } from './config/env.js'
import { phoneSendersFromEnv, sendPhoneNotices } from './push/send.js'
import { redisRingMemory } from './push/rings.js'
import { machineBillingWorkerService } from './services/MachineBillingWorkerService.js'
import { productUsagePeopleRollupService } from './services/ProductUsagePeopleRollupService.js'
import { startReceiptSweep } from './lib/productUsageReceiptSweep.js'
import { startReadMarkSweep } from './superTabs/readMarks.js'
import { startPendingUploadSweep } from './lib/pendingUploadSweep.js'
import { startSwarmPurge } from './superTabs/purge.js'
import { startAttachmentSweepFrom } from './lib/attachmentSweep.js'
import { attachmentsFromEnv } from './superTabs/attachments.js'
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
  const schema = await releaseSchema()
  // Likewise the Tasks feed's column (read/feedIds.ts): a person's older tasks show once it is set.
  await markFeedIds(prisma).then(count => logger.info('[swarm] Tasks feed ids set on older conversations', { count }), error =>
    logger.error('[swarm] Tasks feed ids not set on older conversations: their tasks stay out of people\'s Tasks feeds until the next worker start sets them',
      { error: error instanceof Error ? error.message : String(error) }))
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
  let stopAccountNames = (): void => {}
  let stopTimeChecks = (): void => {}
  let stopDeliveries = (): void => {}
  let stopRepush = (): void => {}
  let stopCompaction = (): void => {}
  let stopThreadBackfill = (): void => {}
  let stopReceiptSweep = (): void => {}
  let stopReadMarkSweep = (): void => {}
  let stopPendingUploads = (): void => {}
  let stopSwarmPurge = (): void => {}
  let stopAttachmentSweep = (): void => {}
  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, stopping backend worker...`)
    const hardExit = setTimeout(() => process.exit(0), 5000)
    hardExit.unref()
    machineBillingWorkerService.stop()
    productUsagePeopleRollupService.stop()
    stopSweeps()
    stopLegacyDrop()
    stopAccountNames()
    stopTimeChecks()
    stopDeliveries()
    stopRepush()
    stopCompaction()
    stopReceiptSweep()
    stopReadMarkSweep()
    stopPendingUploads()
    stopSwarmPurge()
    stopAttachmentSweep()
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
  // Read marks untouched for 180 days, where the database refused their index expiry, a chunk every 30 s (superTabs/readMarks.ts).
  stopReadMarkSweep = startReadMarkSweep(prisma, schema.readMarkExpirySet)
  // Uploads begun on a link and never finished go an hour after the link expired, with what they stored (lib/pendingUploadSweep.ts).
  stopPendingUploads = startPendingUploadSweep(prisma, env)
  // Deleted Swarms past their 7 days go with their records and stored files (superTabs/purge.ts).
  stopSwarmPurge = startSwarmPurge(prisma, env)
  // Swarm uploads nobody sent within a day, row and stored file, once an hour (lib/attachmentSweep.ts). It logs whether it
  // is on; settings it cannot read turn off only the sweep.
  stopAttachmentSweep = startAttachmentSweepFrom(prisma, () => attachmentsFromEnv(env))
  // The worker's sweeps and archive write Swarms: they bump the stamps the API processes read by. It reads too little to keep a cache.
  configureSwarmStamps(redisSwarmStamps(), { reads: false })
  // What the worker's store writes reaches messages too: their recipients' hosts hear of them at once, and of the groups
  // they changed.
  // Their tags reach the tagged person's phones too (push/send.ts, task #2905).
  const phones = phoneSendersFromEnv(env)
  const rings = redisRingMemory(pub)
  const swarms = new SuperTabStore(prisma, Date.now, null, { deliveriesWaiting: announceSwarmDeliveries, terminalWaiting: announceSwarmTerminal, hostsChanged: announceSwarmHostChanges,
    swarmChanged: announceSwarmChanges, phoneNotices: notices => { void sendPhoneNotices(prisma, phones, notices, rings) } })
  stopSweeps = startSwarmSweeps(prisma)
  // The collections of what Swarm v4 removed, the Leads conversations through the store's own write, and the dead old state of
  // migrated Swarms, go by themselves, a few rows at a time (superTabs/migration/dropLegacyJob.ts).
  stopLegacyDrop = startLegacyDrop(prisma, swarms)
  // Once after this release: each Swarm's people take their accounts' names (superTabs/migration/accountNamesJob.ts).
  stopAccountNames = startAccountNames(prisma, swarms)
  // Every 30 s, each active Swarm's time checks: v4's jobs only (superTabs/timeChecks.ts). Swarm v4 (anh Dee, 2026-11-09) runs
  // no v1-v3 job: no decisions, task archive, pull request watch, release steps, merge train, routing reflection or scorecards.
  stopTimeChecks = startTimeChecks(prisma, swarms)
  // A delivery that can no longer move ends as Not sent, instead of waiting for good (superTabs/deliverySettle.ts).
  stopDeliveries = startDeliverySettle(prisma, swarms)
  // Every 15 s, the machine of each agent with a delivery still queued after 10 s is told again, in case its push was lost:
  // hosts read an idle worker's list only when told (superTabs/deliveryRepush.ts, task #2800).
  stopRepush = startDeliveryRepush(prisma, announceSwarmDeliveries)
  // Every hour, finished deliveries 14 days old move into their messages' receipts, kept forever (superTabs/deliveryCompaction.ts).
  stopCompaction = startDeliveryCompaction(prisma, env.SWARM_DELIVERY_COMPACTION)
  // Every 15 minutes, thread summaries for replies no write summed up: all of a Swarm's at first, then only what changed
  // (superTabs/threadBackfill.ts). Pages read the summaries once a Swarm is backfilled.
  stopThreadBackfill = startThreadBackfill(prisma)
  // PM2 wait_ready gates the singleton worker's "online" state on schema/catalog/backfill startup.
  // Plain node/tsx runs do not provide process.send and simply continue.
  process.send?.('ready')
  logger.info('backend worker started')
}

start().catch((err) => {
  logger.error('Failed to start backend worker', err)
  process.exit(1)
})
