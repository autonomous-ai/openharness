import { defineConfig, mergeConfig } from 'vitest/config'
import config from './vitest.e2e.config.js'
import { createDurationSequencer, E2E_HINT_PATH, readTimingHintsFile } from './src/__fixtures__/ciTestSequencer.js'

/**
 * The end-to-end suite as CI runs it (.github/workflows/cli-e2e.yml): the same files, timeouts and
 * one-file-at-a-time default as `vitest.e2e.config.ts`, split into shards by the timing hints in
 * `ci-e2e-durations.json`. Vitest's own `--shard` splits by file count, and the files here run from
 * twenty seconds to six and a half minutes: by count, one runner could draw the four longest.
 * `--config vitest.e2e.ci.config.ts --shard=N/8` reproduces a CI shard's files locally.
 */
export default mergeConfig(config, defineConfig({
  test: { sequence: { sequencer: createDurationSequencer(readTimingHintsFile('ci-e2e-durations.json', E2E_HINT_PATH)) } },
}))
