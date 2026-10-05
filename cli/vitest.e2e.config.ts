import { defineConfig } from 'vitest/config'

/**
 * End-to-end: each file boots real daemons (see e2e/harness/daemon.ts) under throwaway homes with
 * private tmux servers and fake engines. Files run one at a time so their timing is the daemon's,
 * not the host's contention.
 */
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['e2e/**/*.e2e.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    pool: 'forks',
  },
})
