import { defineConfig } from 'vitest/config'
import base from './vitest.config.js'

/** The daemon's core modules (cli/src/core) and the services on its boundary (cli/src/services), held
 *  to 100% in every file as they move out of runForeground (docs/design/2026-10-03-harnessd.md, the
 *  core boundary). */
export default defineConfig({
  test: {
    ...base.test,
    include: ['src/core/**/*.spec.ts', 'src/services/**/*.spec.ts'],
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['src/core/**/*.ts', 'src/services/**/*.ts'],
      // core/main.ts is the composition root, moved out of cli.ts as it was: wiring only, held to its size by
      // src/architecture.spec.ts and run by the end-to-end suite as `harness __run`, which no unit test loads.
      exclude: ['src/core/**/*.spec.ts', 'src/services/**/*.spec.ts', 'src/core/main.ts'],
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage/core',
      thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
})
