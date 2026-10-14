import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'
import { REAL_ENGINE_FOLDERS, realEnginePlan } from './src/testing/realEnginePolicy.js'

// Checked before globalSetup can build or a test can create a daemon. Direct vitest must not bypass
// the sanitized launcher, even if someone copied REAL_ENGINES=1 into their normal environment.
realEnginePlan(process.env)
const root = process.env.REAL_ENGINE_RUN_ROOT
if (!root || realpathSync(root) !== root || !process.env.REAL_ENGINE_RUN_ID
  || readFileSync(join(root, 'owner'), 'utf8') !== process.env.REAL_ENGINE_RUN_ID) {
  throw new Error('Use npm run test:e2e-real to create the private run root')
}
for (const [key, folder] of Object.entries(REAL_ENGINE_FOLDERS)) {
  if (process.env[key] !== join(root, folder)) throw new Error(`The launcher must isolate ${key}`)
}
if (process.env.TMUX || process.env.TMUX_PANE || process.env.E2E_ARTIFACTS_DIR) throw new Error('Inherited tmux or raw artifact capture is forbidden')

export default defineConfig({
  test: {
    environment: 'node', include: ['real-e2e/**/*.e2e.ts'],
    globalSetup: ['./e2e/harness/bundle.ts'],
    pool: 'forks', maxWorkers: 1, fileParallelism: false, retry: 0, bail: 1,
    testTimeout: 300_000, hookTimeout: 45_000,
  },
})
