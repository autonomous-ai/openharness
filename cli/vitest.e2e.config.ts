import { defineConfig } from 'vitest/config'

/**
 * End-to-end: each file boots real daemons (see e2e/harness/daemon.ts) under throwaway homes with
 * private tmux servers and fake engines. Files run one at a time by default, so their timing is the
 * daemon's, not the host's contention.
 *
 * `E2E_WORKERS=<n>` runs n files at a time. Each file has its own daemons, homes, ports and tmux
 * servers, so they share nothing but the machine; one at a time, the suite took about 25 minutes on a
 * 12-core Mac. The checks whose numbers depend on a quiet machine (the soak, scale) run on their own,
 * when asked, either way.
 */
const workers = Math.max(1, Number(process.env.E2E_WORKERS ?? 1) || 1)

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['e2e/**/*.e2e.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: workers > 1,
    maxWorkers: workers,
    pool: 'forks',
  },
})
