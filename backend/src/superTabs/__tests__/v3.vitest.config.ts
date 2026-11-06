import { defineConfig } from 'vitest/config'

// Real-store release acceptance is explicit, never part of the unit suite.
export default defineConfig({ test: {
  include: ['src/superTabs/__tests__/swarmV3.acceptance.ts'],
  setupFiles: ['integration/noDefaultDigest.test-support.ts', 'integration/cacheOn.test-support.ts', 'src/lib/noRedis.test-support.ts'],
  hookTimeout: 120000, testTimeout: 60000, fileParallelism: false,
  env: { NODE_ENV: 'test', HARNESS_CREDENTIAL_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
} })
