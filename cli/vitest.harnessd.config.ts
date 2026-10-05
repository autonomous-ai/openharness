import { defineConfig } from 'vitest/config'
import base from './vitest.config.js'

/** harnessd's master, protocol and core link: the daemon's supervisor, held to 100% in every file. */
export default defineConfig({
  test: {
    ...base.test,
    include: ['src/harnessd/**/*.spec.ts'],
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['src/harnessd/**/*.ts'],
      exclude: ['src/harnessd/**/*.spec.ts'],
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage/harnessd',
      thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
})
