import { defineConfig } from 'vitest/config'

// One file a line: a pull request that deletes a test deletes its line, and two such pull requests do not conflict.
export default defineConfig({ test: {
  include: [
    'integration/shareRaces.test.ts',
    'integration/productUsageConflicts.test.ts',
    'integration/productUsageReceipts.test.ts',
    'integration/schemaRelease.test.ts',
    'integration/harnessSharesIndexPlan.test.ts',
    'integration/atlasSnapshot.test.ts',
    'integration/queryStats.test.ts',
    'integration/workerIndexPlans.test.ts',
    'integration/communityReports.test.ts',
    'integration/prismaQueryTiming.test.ts',
    'integration/secondaryReads.test.ts',
    'integration/pushDevices.test.ts',
    'integration/swarmDataRemoval.test.ts',
  ],
  hookTimeout: 120000, testTimeout: 30000, setupFiles: ['src/lib/noRedis.test-support.ts'],
  fileParallelism: false, env: { NODE_ENV: 'test', HARNESS_CREDENTIAL_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } } })
