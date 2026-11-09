import { defineConfig } from 'vitest/config'
import base from './vitest.config.js'

/** The daemon's core modules (cli/src/core) and the services on its boundary (cli/src/services), held
 *  to 100% in every file as they move out of runForeground (docs/design/2026-10-03-harnessd.md, the
 *  core boundary). */
export default defineConfig({
  test: {
    ...base.test,
    // The gate runs under v8 coverage, and these specs do real fsyncs and renames: 5.2-5.7 s each on a loaded Intel Mac, over the
    // default 5 s (handoffPublication, then its native sibling). 30 s changes no assertion.
    testTimeout: 30_000,
    include: ['src/core/**/*.spec.ts', 'src/services/**/*.spec.ts'],
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['src/core/**/*.ts', 'src/services/**/*.ts'],
      // core/main.ts is the composition root: wiring only. src/architecture.spec.ts checks its import
      // boundaries; the end-to-end suite runs it as `harness __run`, which no unit test loads.
      exclude: ['src/core/**/*.spec.ts', 'src/services/**/*.spec.ts', 'src/core/main.ts'],
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage/core',
      thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
})
