import { defineConfig } from 'vitest/config'
import base from './vitest.config.js'

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['src/dsh/**/*.spec.ts', 'src/backendSocket.dsh.spec.ts', 'src/backendSocket.models.spec.ts', 'src/lib/newAgentModel.spec.ts', 'src/lib/launchOverrides.spec.ts', 'src/lib/createAgentPane.spec.ts', 'src/lib/registry.spec.ts'],
    testTimeout: 30_000,
    coverage: {
      provider: 'v8', enabled: true,
      include: ['src/lib/newAgentModel.ts', 'src/dsh/adapters.ts', 'src/dsh/compatibility.ts', 'src/dsh/runtime.ts', 'src/dsh/launch.ts', 'src/dsh/materialize.ts'],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100, perFile: true },
      reporter: ['text', 'json', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage/portability',
    },
  },
})
