import { availableParallelism } from 'node:os'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Gives the run a temporary folder of its own, which its workers' folders go in (vitest.tmpdir.ts).
    globalSetup: ['./src/__fixtures__/vitestRun.ts'],
    setupFiles: ['./vitest.tmpdir.ts', './vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    // These suites spawn real shells, hooks and tmux helpers with bounded
    // deadlines. One worker per CPU starves those children on busy hosts, so
    // take half the machine: the other half is theirs.
    maxWorkers: Math.max(1, Math.floor(availableParallelism() / 2)),
    // Many cases do real I/O: git, child processes, and disk flushes, each a full drive flush on macOS (F_FULLFSYNC).
    // On a loaded developer Mac they run about 10 times as long as alone: a full run at load 8-10 sent cases of
    // 0.5-2 s alone past vitest's 5 s, a different handful each run (2026-11-11). The same 30 s as
    // vitest.portability.config.ts and testing/handoffLimits.ts. A passing case takes no longer for it.
    testTimeout: 30_000,
  },
})
