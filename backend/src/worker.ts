import 'dotenv/config'
import { closeBus } from './lib/bus.js'
import { reconcileCommunityLikeCounts } from './lib/db/communityLikeCounts.js'
import { backfillMachineFreeEntitlements } from './lib/db/freeEntitlement.js'
import {
  backfillMachineAuthMode,
  backfillMachinePresenceTurnsStarted,
  ensureSchema,
  migrateAutonomousEnvironment,
  migrateMachineRename,
  migrateUserIdentityByEmail,
  migrateUserPresencePerMachine,
  pruneLegacyDeviceBindings,
} from './lib/db/migrate.js'
import { ensurePlans } from './lib/db/seed.js'
import { prisma } from './lib/prisma.js'
import { ensureProductUsageExpiry } from './lib/productUsage.js'
import { ensureTerminalExpiry } from './superTabs/terminal.js'
import { ensureMentionExpiry } from './superTabs/mentions.js'
import { ensurePartExpiry, startSwarmSweeps } from './superTabs/sweeps.js'
import { appPullRequests, markFinishedGroups, startSwarmArchive, unknownPullRequests } from './superTabs/archive.js'
import { SuperTabStore } from './superTabs/store.js'
import { announceSwarmDeliveries } from './lib/swarmDeliveryPushes.js'
import { GitHubApp, githubAppConfig } from './github/app.js'
import { env } from './config/env.js'
import { machineBillingWorkerService } from './services/MachineBillingWorkerService.js'
import { productUsagePeopleRollupService } from './services/ProductUsagePeopleRollupService.js'
import { logger } from './utils/logger.js'

// Singleton background process. HTTP/WS server.ts runs as a PM2 cluster and must never own schema
// writes, catalog syncs, migrations or periodic jobs; otherwise every live server worker races them.
async function start(): Promise<void> {
  // Existing production data was created against staging upstreams. Stamp it before Prisma swaps
  // the old global unique indexes for their per-environment replacements.
  await migrateAutonomousEnvironment()
  await migrateUserIdentityByEmail()
  // Same reason: the old (user, day) unique must be gone before the push installs its replacement.
  await migrateUserPresencePerMachine()
  ensureSchema()
  await ensureProductUsageExpiry()
  await ensureTerminalExpiry(prisma)
  await ensureMentionExpiry(prisma)
  await ensurePartExpiry(prisma)
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
  let stopArchive = (): void => {}
  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, stopping backend worker...`)
    const hardExit = setTimeout(() => process.exit(0), 5000)
    hardExit.unref()
    machineBillingWorkerService.stop()
    productUsagePeopleRollupService.stop()
    stopSweeps()
    stopArchive()
    void Promise.allSettled([prisma.$disconnect(), closeBus()]).finally(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  machineBillingWorkerService.start()
  productUsagePeopleRollupService.start()
  // Archive notes and Workspace removals write messages too: their recipients' hosts hear of them at once.
  const swarms = new SuperTabStore(prisma, Date.now, null, { deliveriesWaiting: announceSwarmDeliveries })
  stopSweeps = startSwarmSweeps(prisma, undefined, () => swarms.workspaces.finishRemovals())
  // Finished groups archive once GitHub says their pull requests are merged or closed; without the app, only groups that
  // link none do (superTabs/archive.ts).
  const githubConfig = githubAppConfig(env), githubApp = githubConfig ? new GitHubApp(githubConfig) : null
  stopArchive = startSwarmArchive(prisma, swarms, () => githubApp ? appPullRequests(githubApp) : unknownPullRequests)
  // PM2 wait_ready gates the singleton worker's "online" state on schema/catalog/backfill startup.
  // Plain node/tsx runs do not provide process.send and simply continue.
  process.send?.('ready')
  logger.info('backend worker started')
}

start().catch((err) => {
  logger.error('Failed to start backend worker', err)
  process.exit(1)
})
