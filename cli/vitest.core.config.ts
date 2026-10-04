import { defineConfig } from 'vitest/config'
import base from './vitest.config.js'

/** The daemon's core modules (cli/src/core), held to 100% in every file as they move out of
 *  runForeground (docs/design/2026-10-03-harnessd.md, the core boundary). */
export default defineConfig({
  test: {
    ...base.test,
    include: ['src/core/**/*.spec.ts'],
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['src/core/**/*.ts'],
      exclude: ['src/core/**/*.spec.ts'],
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage/core',
      thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
})
