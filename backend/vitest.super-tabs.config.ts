import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { include: ['integration/superTabs.test.ts', 'integration/superTabSharing.test.ts', 'integration/superTabGithub.test.ts', 'integration/superTabTeam.test.ts', 'integration/superTabWorkspaces.test.ts',
    'integration/superTabRead.test.ts', 'integration/superTabReadMarks.test.ts', 'integration/superTabInbox.test.ts', 'integration/superTabLeaderboard.test.ts', 'integration/superTabMigration.test.ts', 'integration/superTabLiveness.test.ts',
    'integration/superTabTidy.test.ts', 'integration/superTabProfile.test.ts', 'integration/superTabLegacyDrop.test.ts', 'integration/shareRaces.test.ts', 'integration/superTabIndexes.test.ts', 'integration/superTabRouteDecisions.test.ts',
    'integration/superTabHotReads.test.ts', 'integration/swarmSweepStarts.test.ts', 'integration/superTabGroupPlans.test.ts', 'integration/superTabInvitationPlans.test.ts', 'integration/superTabCache.test.ts',
    'integration/superTabObserver.test.ts', 'integration/productUsageConflicts.test.ts', 'integration/productUsageReceipts.test.ts', 'integration/schemaRelease.test.ts', 'integration/superTabBuddies.test.ts', 'integration/superTabNotAvailable.test.ts',
    'integration/superTabBuddyProbes.test.ts', 'integration/superTabCosts.test.ts', 'integration/harnessSharesList.test.ts', 'integration/atlasSnapshot.test.ts', 'integration/queryStats.test.ts',
    'integration/superTabEvidence.test.ts', 'integration/superTabAttemptModels.test.ts', 'integration/superTabNamedReads.test.ts', 'integration/swarmSweepPlans.test.ts', 'integration/workerIndexPlans.test.ts', 'integration/superTabReflection.test.ts'], hookTimeout: 120000, testTimeout: 30000, setupFiles: ['integration/cacheOn.test-support.ts'],
  fileParallelism: false, env: { NODE_ENV: 'test', HARNESS_CREDENTIAL_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } } })
