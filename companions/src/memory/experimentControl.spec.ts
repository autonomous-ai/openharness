import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { MemoryControl } from './control.js'
import { MemoryExperimentSettings } from './experiment.js'

afterEach(() => vi.restoreAllMocks())

it('lets the verified local owner disable coding memory while companions stay off', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'memory-setting-route-'))
  const settings = new MemoryExperimentSettings(directory)
  const owner = 'a'.repeat(64)
  settings.write(owner, true, 0)
  const runtime = vi.fn(() => null)
  let person = true
  const verify = vi.fn(async () => person ? { ok: true as const, pid: 123 }
    : { ok: false as const, error: 'INSIDE_HARNESS' as const, detail: 'agent' })
  const memory = new MemoryControl({ runtime, verify,
    experiment: { owner: () => owner, read: key => settings.read(key),
      write: async (key, enabled, expected) => settings.write(key, enabled, expected) } })
  const ask = (input: Record<string, unknown>) => memory.local(input, 'owner')
  try {
    expect(await ask({ action: 'experiment' })).toMatchObject({ ok: true, enabled: true, revision: 1 })
    expect(await ask({ action: 'configure_experiment', enabled: false, expected: 1 }))
      .toMatchObject({ ok: true, enabled: false, revision: 2 })
    expect(new MemoryExperimentSettings(directory).enabled(owner)).toBe(false)
    expect(await ask({ action: 'configure_experiment', enabled: true, expected: 2, token: 'agent' }))
      .toMatchObject({ error: 'PERSON_ONLY' })
    person = false
    expect(await ask({ action: 'configure_experiment', enabled: true, expected: 2 }))
      .toMatchObject({ error: 'INSIDE_HARNESS' })
    person = true
    expect(await ask({ action: 'experiment', owner: 'b'.repeat(64) })).toMatchObject({ error: 'INVALID_INPUT' })
    verify.mockClear()
    for (const action of ['status', 'list']) {
      expect(await ask({ action })).toMatchObject({ error: 'UNSUPPORTED' })
    }
    for (const action of ['show', 'preview', 'apply']) {
      expect(await ask({ action })).toMatchObject({ error: 'INVALID_INPUT' })
    }
    expect(verify).not.toHaveBeenCalled()
    expect(settings.enabled(owner)).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
