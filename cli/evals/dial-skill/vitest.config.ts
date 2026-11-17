import { defineConfig } from 'vitest/config'

// Kept apart from cli/vitest.config.ts (src/** only), so npm test and CI never run the eval's tests.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['evals/dial-skill/**/*.spec.ts'],
    // Stage tests run git and child processes; the same 30 s as cli/vitest.config.ts.
    testTimeout: 30_000,
  },
})
