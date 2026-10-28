import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { include: ['integration/superTabs.test.ts', 'integration/superTabSharing.test.ts', 'integration/superTabGithub.test.ts', 'integration/superTabTeam.test.ts', 'integration/superTabWorkspaces.test.ts',
  'integration/superTabRead.test.ts', 'integration/superTabLeaderboard.test.ts', 'integration/superTabMigration.test.ts', 'integration/superTabLiveness.test.ts', 'integration/superTabTidy.test.ts',
  'integration/superTabProfile.test.ts', 'integration/superTabLegacyDrop.test.ts', 'integration/shareRaces.test.ts', 'integration/superTabHotReads.test.ts'], hookTimeout: 120000, testTimeout: 30000,
  fileParallelism: false, env: { NODE_ENV: 'test', HARNESS_CREDENTIAL_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } } })
