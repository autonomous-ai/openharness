import * as childProcesses from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

describe('fakePodman', () => {
  // A spec's first `podman info` is under a 5 s deadline (podman.ts), which macOS's first-exec check pushed it past.
  it('runs its file once before it returns, so no deadline meets that check', async () => {
    vi.resetModules()
    const { fakePodman, trackingFakes } = await import('./fakePodman.js')
    const spawnSync = vi.fn(childProcesses.spawnSync)
    trackingFakes({ ...childProcesses, spawnSync: spawnSync as unknown as typeof childProcesses.spawnSync })
    const fake = fakePodman()
    try {
      expect(spawnSync.mock.calls.map(([command]) => command)).toEqual([fake.path])
      expect(readFileSync(fake.path, 'utf8').split('\n')[0]).toBe(`#!${process.execPath}`)
      expect(statSync(fake.path).mode & 0o777).toBe(0o755)
    } finally {
      await fake.remove()
    }
  })

  it('without trackingFakes installed says so', async () => {
    vi.resetModules()
    const { fakePodman } = await import('./fakePodman.js')
    expect(() => fakePodman()).toThrow('trackingFakes')
  })
})
