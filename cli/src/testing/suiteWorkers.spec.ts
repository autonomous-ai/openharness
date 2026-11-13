/**
 * The unit suite sizes its workers to half the machine's cores (suiteWorkers.ts): the other half is for the shells, hooks
 * and tmux helpers its tests start.
 */
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { resolveConfig } from 'vitest/node'
import { suiteWorkers } from './suiteWorkers.js'

afterEach(() => { vi.unstubAllEnvs() })

it('takes half the machine\'s cores, and never less than one worker', () => {
  expect(suiteWorkers(16)).toBe(8)
  expect(suiteWorkers(5)).toBe(2)
  expect(suiteWorkers(1)).toBe(1)
})

// The suite's own config (cli/vitest.config.ts), as Vitest reads it.
it('sizes the unit suite by its config, which asks for these workers', async () => {
  // Vitest's own variable would override the config's answer.
  vi.stubEnv('VITEST_MAX_WORKERS', '')
  const config = await resolveConfig({ root: fileURLToPath(new URL('../..', import.meta.url)), config: 'vitest.config.ts' })
  expect(config.vitestConfig.maxWorkers).toBe(suiteWorkers())
})
