import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import config from './vitest.super-tabs.config.js'
import { createDurationSequencer, readTimingHintsFile } from './src/lib/ciShards.test-support.js'

// PR CI's backend-integration job (.github/workflows/ci.yml): the Super Tab integration suite in four shards balanced by
// integration/ci-durations.json. `npx vitest run --config vitest.super-tabs.ci.config.ts --shard=N/4` reproduces shard N.
const hints = readTimingHintsFile(fileURLToPath(new URL('./integration/ci-durations.json', import.meta.url)))

export default mergeConfig(config, defineConfig({ test: { sequence: { sequencer: createDurationSequencer(hints) } } }))
