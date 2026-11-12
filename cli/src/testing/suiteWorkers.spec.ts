/**
 * The unit suite sizes its workers to the cores it may use (suiteWorkers.ts): the machine's, or a Swarm agent's share of them.
 * Sized to the whole machine by every agent at once, four runs took twice as long as one and every one failed
 * (docs/research/2026-11-11-agents-share-cpu.md).
 */
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { resolveConfig } from 'vitest/node'
import { suiteWorkers } from './suiteWorkers.js'

afterEach(() => { vi.unstubAllEnvs() })

it('takes half the machine\'s cores outside a Swarm, and never less than one worker', () => {
  expect(suiteWorkers({}, 16)).toBe(8)
  expect(suiteWorkers({}, 5)).toBe(2)
  expect(suiteWorkers({}, 1)).toBe(1)
})

it('takes half its agent\'s share of the cores, as the Swarm started it', () => {
  expect(suiteWorkers({ HARNESS_CORES: '4' }, 16)).toBe(2)
  expect(suiteWorkers({ HARNESS_CORES: '8' }, 16)).toBe(4)
  expect(suiteWorkers({ HARNESS_CORES: '1' }, 16)).toBe(1)
})

it('sizes itself to the machine when the share is not a count of cores', () => {
  for (const said of ['', '0', '-4', '2.5', 'many']) expect(suiteWorkers({ HARNESS_CORES: said }, 16), said).toBe(8)
})

// The review of #4150: a share is this machine's cores or fewer. One carried to a smaller machine, by a shell or a daemon
// an agent started, takes no more than that machine has.
it('takes no more than the machine has, whatever share it is told', () => {
  expect(suiteWorkers({ HARNESS_CORES: '32' }, 16)).toBe(8)
  expect(suiteWorkers({ HARNESS_CORES: '17' }, 16)).toBe(8)
  expect(suiteWorkers({ HARNESS_CORES: '16' }, 4)).toBe(2)
})

// The suite's own config (cli/vitest.config.ts), as Vitest reads it: a share reaches a run only through it.
it('sizes the unit suite by its config, which asks for these workers', async () => {
  const workers = async (cores: string) => {
    // Vitest's own variable would override the config's answer.
    vi.stubEnv('VITEST_MAX_WORKERS', '')
    vi.stubEnv('HARNESS_CORES', cores)
    return (await resolveConfig({ root: fileURLToPath(new URL('../..', import.meta.url)), config: 'vitest.config.ts' })).vitestConfig.maxWorkers
  }
  expect(await workers('4')).toBe(2)
  expect(await workers('')).toBe(suiteWorkers({}))
})
