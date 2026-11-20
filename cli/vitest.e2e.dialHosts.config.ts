import { defineConfig } from 'vitest/config'
import { DIAL_HOST_FILES } from './e2e/harness/dialHosts.js'
import config from './vitest.e2e.config.js'

/**
 * The dial's hosts as CI's `e2e (dial hosts)` job runs them (.github/workflows/cli-e2e.yml): the files that drive
 * herdr, WezTerm, Zellij, kitty, an X11 desktop and sway, with the e2e suite's timeouts and setup. Run with
 * `E2E_DIAL_HOSTS=1` a host that is not installed fails its file instead of skipping it (e2e/harness/dialHosts.ts).
 *
 * Spread, not `mergeConfig`, which would add these files to the suite's `include` rather than replace it.
 */
export default defineConfig({ ...config, test: { ...config.test, include: DIAL_HOST_FILES } })
