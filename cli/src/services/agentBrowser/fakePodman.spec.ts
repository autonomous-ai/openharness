import * as childProcesses from 'node:child_process'
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

  // A call logs itself with one append, which creates the file before it writes the line: a spec that read the log
  // then found an empty file, and threw (agentBrowser.spec.ts under parallel load, 2026-11-19).
  it('reads only the calls and pids whose lines are whole', async () => {
    vi.resetModules()
    const { fakePodman, trackingFakes } = await import('./fakePodman.js')
    trackingFakes(childProcesses)
    const fake = fakePodman()
    const dir = dirname(fake.path)
    try {
      writeFileSync(join(dir, 'calls.jsonl'), '')
      expect(fake.calls()).toEqual([])
      appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ args: ['ps'], stdin: '' })}\n{"args":["in`)
      expect(fake.calls()).toEqual([{ args: ['ps'], stdin: '' }])
      appendFileSync(join(dir, 'pids.log'), '4242\n42')
      expect(fake.pids()).toEqual([4242])
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
