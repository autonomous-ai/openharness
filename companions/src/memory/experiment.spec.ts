import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MemoryExperimentSettings } from './experiment.js'
import { MemoryControl } from './control.js'

let directory: string, settings: MemoryExperimentSettings
const owner = 'a'.repeat(64), other = 'b'.repeat(64)
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memory-experiment-'))
  settings = new MemoryExperimentSettings(directory)
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

it('defaults off without writing and persists each account independently across restart', () => {
  expect(settings.read(owner)).toEqual({ enabled: false, revision: 0 })
  expect(existsSync(join(directory, `${owner}.json`))).toBe(false)
  expect(settings.write(owner, true, 0)).toEqual({ enabled: true, revision: 1 })
  expect(settings.enabled(other)).toBe(false)
  expect(settings.enabled(null)).toBe(false)
  settings = new MemoryExperimentSettings(directory)
  expect(settings.read(owner)).toEqual({ enabled: true, revision: 1 })
  expect(statSync(join(directory, `${owner}.json`)).mode & 0o777).toBe(0o600)
  expect(() => settings.write(owner, false, 0)).toThrow('settings_changed')
  expect(settings.write(owner, false, 1)).toEqual({ enabled: false, revision: 2 })
})

it('lets an explicit off override the legacy environment default and fails closed on unreadable settings', () => {
  settings = new MemoryExperimentSettings(directory, true)
  expect(settings.enabled(owner)).toBe(true)
  settings.write(owner, false, 0)
  expect(new MemoryExperimentSettings(directory, true).enabled(owner)).toBe(false)
  writeFileSync(join(directory, `${other}.json`), '{broken')
  expect(settings.enabled(other)).toBe(false)
  expect(() => settings.read(other)).toThrow('settings_unavailable')
  expect(() => settings.read('../escape')).toThrow('owner_changed')
})

it('exposes the choice to the verified owner even while the preview runtime is off', async () => {
  let current = owner, changes = 0, person = true
  const control = new MemoryControl({ runtime: () => null,
    verify: async () => person ? { ok: true, pid: 123 } : { ok: false, error: 'INSIDE_HARNESS', detail: 'agent' },
    experiment: { owner: () => current, read: id => settings.read(id), write: async (id, on, expected) => {
      const choice = settings.write(id, on, expected); changes++; return choice
    } } })
  const request = (payload: Record<string, unknown>) => control.local({ verb: 'memory', ...payload }, 'socket')
  expect(await request({ action: 'experiment' })).toEqual({ ok: true, enabled: false, revision: 0 })
  expect(changes).toBe(0)
  const command = { action: 'configure_experiment', enabled: true, expected: 0 }
  expect(await request({ ...command, token: 'agent' })).toMatchObject({ error: 'PERSON_ONLY' })
  person = false
  expect(await request(command)).toMatchObject({ error: 'INSIDE_HARNESS' })
  person = true
  expect(await request({ ...command, owner: other })).toMatchObject({ error: 'INVALID_INPUT' })
  expect(await request(command)).toEqual({ ok: true, enabled: true, revision: 1 })
  expect(changes).toBe(1)
  expect(await request(command)).toMatchObject({ error: 'SETTINGS_CHANGED' })
  current = other
  expect(await request({ action: 'experiment' })).toEqual({ ok: true, enabled: false, revision: 0 })
  expect(readFileSync(join(directory, `${owner}.json`), 'utf8')).toContain('"enabled":true')
})

it('rejects an account change during process verification before writing a choice', async () => {
  let current = owner
  const control = new MemoryControl({ runtime: () => null,
    verify: async () => { current = other; return { ok: true, pid: 123 } },
    experiment: { owner: () => current, read: id => settings.read(id), write: async (id, on, expected) => settings.write(id, on, expected) } })
  expect(await control.local({ action: 'configure_experiment', enabled: true, expected: 0 }, 'socket'))
    .toMatchObject({ error: 'OWNER_CHANGED' })
  expect(settings.enabled(owner)).toBe(false)
  expect(settings.enabled(other)).toBe(false)
})
