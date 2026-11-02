import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    // No unit test opens Redis (#2434).
    setupFiles: ['src/lib/noRedis.test-support.ts'],
  },
})
