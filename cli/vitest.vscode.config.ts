import { defineConfig } from 'vitest/config'
import base from './vitest.config.js'

/**
 * The Harness Device VS Code extension in a real VS Code (plugins/harness-device-vscode/gate): a local gate, never PR
 * CI's, as it downloads a VS Code and opens its window. The base's setup keeps every Harness data folder a throwaway.
 */
export default defineConfig({
  test: {
    ...base.test,
    // With the unit tests of the gate's own helpers, which launch nothing.
    include: ['../plugins/harness-device-vscode/gate/**/*.gate.ts', '../plugins/harness-device-vscode/gate/**/*.test.ts'],
    fileParallelism: false,
    // The download is a few hundred MB, and a VS Code starts slowly on a loaded Mac.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
})
