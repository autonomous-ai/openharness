import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RegisteredSession } from './registry.js'

vi.mock('./bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))
vi.mock('./processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))

const SESSION = 'agent:main:harness-1'
const runtimes = [{ backend: 'tmux' as const, paneId: '%1' }]
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'registry-local-'))
  vi.stubEnv('ADAPTER_DATA_DIR', root)
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); rmSync(root, { recursive: true, force: true }) })

async function load() { vi.resetModules(); const mod = await import('./registry.js'); mod.registry.load(); return mod }
const disk = (): RegisteredSession[] => JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'))
async function pending() {
  const { registry, strictPersistedRow } = await load()
  const row = registry.openPendingAgent({ engine: 'openclaw', cwd: root, runtimes })!
  expect(row).toBeTruthy()
  return { registry, row, strictPersistedRow }
}
async function bound() {
  const made = await pending()
  expect(made.registry.register({ engine: 'openclaw', sessionId: SESSION, runtimes, cwd: root })).toBeTruthy()
  return made
}

it('a local row keeps its folder through a save, a load, a bind and a resume, and reads its store there from the start', async () => {
  const { registry, strictPersistedRow } = await load()
  const row = registry.openPendingAgent({ engine: 'openclaw', cwd: root, runtimes, openclawLocal: '/run/skill-1' })!
  expect(row).toMatchObject({ openclawLocal: '/run/skill-1', openclawStateDir: '/run/skill-1' })
  expect(strictPersistedRow(disk()[0])).toMatchObject({ openclawLocal: '/run/skill-1', openclawStateDir: '/run/skill-1' })
  expect(registry.register({ engine: 'openclaw', sessionId: SESSION, runtimes, cwd: root })!.entry)
    .toMatchObject({ openclawLocal: '/run/skill-1', openclawStateDir: '/run/skill-1' })
  expect(registry.setOpenclawStateDir(row.agentId, '/elsewhere')).toBe(false)
  const again = (await load()).registry
  const saved = { ...again.byAgent(row.agentId)! }
  expect(saved).toMatchObject({ openclawLocal: '/run/skill-1', openclawStateDir: '/run/skill-1' })
  again.removeAgent(row.agentId)
  expect(again.resumePendingAgent(saved, [{ backend: 'tmux', paneId: '%2' }])).toMatchObject({ openclawLocal: '/run/skill-1' })
})

it('a row with no folder has no field, and its state folder is still set off the TUI', async () => {
  const { registry, row } = await pending()
  expect(row).not.toHaveProperty('openclawLocal')
  expect(registry.setOpenclawStateDir(row.agentId, '/gw/state')).toBe(true)
})

it('keeps the session keys a harness moved off, newest first, at most 32, across a load', async () => {
  const { registry, row } = await bound()
  const move = (key: string) => registry.register({ engine: 'openclaw', sessionId: key, runtimes, cwd: root })!.entry
  expect(move('agent:main:tui-2').earlierSessionIds).toEqual([SESSION])
  expect(move('agent:main:tui-3').earlierSessionIds).toEqual(['agent:main:tui-2', SESSION])
  for (let i = 4; i < 44; i++) move(`agent:main:tui-${i}`)
  const kept = (await load()).registry.byAgent(row.agentId)!.earlierSessionIds!
  expect(kept).toHaveLength(32)
  expect(kept[0]).toBe('agent:main:tui-42')
  expect(new Set(kept).size).toBe(32)
})

it('a saved row keeps only a text folder and text keys of at most 256 characters, once each', async () => {
  const { strictPersistedRow } = await pending()
  const row = disk()[0]
  expect(strictPersistedRow({ ...row, openclawLocal: '' })).not.toHaveProperty('openclawLocal')
  expect(strictPersistedRow({ ...row, openclawLocal: 7 })).not.toHaveProperty('openclawLocal')
  expect(strictPersistedRow({ ...row, earlierSessionIds: 'a' })).not.toHaveProperty('earlierSessionIds')
  expect(strictPersistedRow({ ...row, earlierSessionIds: ['', 3, 'x'.repeat(257)] })).not.toHaveProperty('earlierSessionIds')
  expect(strictPersistedRow({ ...row, earlierSessionIds: ['b', '', 'a', 'b', 'x'.repeat(257)] })!.earlierSessionIds).toEqual(['b', 'a'])
})
