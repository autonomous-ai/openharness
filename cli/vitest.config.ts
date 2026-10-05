import { availableParallelism } from 'node:os'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    // These suites spawn real shells, hooks and tmux helpers with bounded
    // deadlines. One worker per CPU starves those children on busy hosts, so
    // take half the machine: the other half is theirs.
    maxWorkers: Math.max(1, Math.floor(availableParallelism() / 2)),
  },
})
