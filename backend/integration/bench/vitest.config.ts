import { defineConfig } from 'vitest/config'

// The benchmark's own tests: its helpers, and one short run of the whole scenario on a local replica set.
export default defineConfig({ test: { include: ['integration/bench/**/*.test.ts'], hookTimeout: 120000, testTimeout: 180000,
  fileParallelism: false, env: { NODE_ENV: 'test', HARNESS_CREDENTIAL_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } } })
