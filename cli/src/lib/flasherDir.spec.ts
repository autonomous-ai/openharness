import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllEnvs() })

describe('FLASHER_DIR', () => {
  it('a relative HARNESS_FLASHER_CACHE is under the home, as config/env.ts reads every Harness folder', async () => {
    vi.resetModules()
    vi.stubEnv('HARNESS_FLASHER_CACHE', 'flasher')
    expect((await import('./flasherDir.js')).FLASHER_DIR).toBe(join(homedir(), 'flasher'))
  })
})
