import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { include: ['integration/superTabs.test.ts', 'integration/superTabSharing.test.ts', 'integration/superTabTeam.test.ts'], hookTimeout: 120000, testTimeout: 30000,
  fileParallelism: false, env: { NODE_ENV: 'test', HARNESS_CREDENTIAL_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } } })
