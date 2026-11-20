import { defineConfig } from 'vitest/config'

/**
 * The dial end to end on Windows (e2e/dialWindows.e2e.ts): a daemon in a throwaway profile and a stand-in dial
 * (e2e/harness/windowsDaemon.ts). Run with `E2E_BUNDLE=1` (the daemon starts from the run's bundle, e2e/harness/bundle.ts)
 * and `HARNESS_PTY_BIN` naming the harness-pty.exe built from pty/.
 *
 * Its own config: vitest.e2e.config.ts's global setups (a short TMPDIR for Unix sockets, a Node alone in its folder,
 * macOS's process-image helper) are for the tmux daemon of the Unix suite.
 */
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts', './e2e/harness/artifacts.ts'],
    globalSetup: ['./e2e/harness/bundle.ts'],
    include: ['e2e/dialWindows.e2e.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    maxWorkers: 1,
    pool: 'forks',
  },
})
