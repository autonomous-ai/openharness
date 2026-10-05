import { defineConfig, mergeConfig } from 'vitest/config'
import config from './vitest.config.js'
import { DurationSequencer } from './src/__fixtures__/ciTestSequencer.js'

export default mergeConfig(config, defineConfig({
  test: { sequence: { sequencer: DurationSequencer } },
}))
