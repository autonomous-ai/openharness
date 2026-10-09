import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runtime as claudeRuntime } from '../engines/claude/runtimeProfile.js'
import { RuntimeProfileState } from './runtimeProfileState.js'
import { engineNow, loadEngine } from '../engines/inProcess.js'
import type { InlineRuntimeContext } from '../engines/facets/inlineRuntime.js'

vi.mock('./bootId.js', async real => ({ ...await real<object>(), currentBootId: () => 'fixture-boot' }))
vi.mock('../engines/inProcess.js', async real => ({ ...await real<object>(), engineNow: vi.fn(), loadEngine: vi.fn() }))

let root: string | undefined
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (root) rmSync(root, { recursive: true, force: true })
})

it('fences deferred config, staged history and detached pane observations against Registry.register replacements', async () => {
  root = mkdtempSync(join(tmpdir(), 'profile-registry-'))
  vi.stubEnv('ADAPTER_DATA_DIR', root)
  vi.stubEnv('CLAUDE_PROJECTS_DIR', root)
  vi.resetModules()
  const { registry } = await import('./registry.js')
  registry.load()
  const input = { engine: 'hermes' as const, sessionId: '20261009_060000_abc123', tmuxPane: '%81', cwd: root,
    hermesHome: join(root, 'first') }
  registry.openProcessAgent({ ...input, processIdentity: { pid: 7001, executable: 'hermes', startMarker: 'fixture' } })
  const old = registry.register(input)!.entry
  let finish!: (effort: string) => void
  const configuredEffort = vi.fn(() => new Promise<string>(resolve => { finish = resolve }))
  const pane = vi.fn(({ state }) => { state.model = 'from-pane' })
  const profiles = new RuntimeProfileState(() => ({ ...claudeRuntime, configuredEffort, pane }), id => registry.resolve(id))
  profiles.hydrate(old, [])
  profiles.confirmEffort(old.sessionId, 'high')
  const before = profiles.getState(old.sessionId)
  const pending = profiles.ingestConfig(old), staged = profiles.beginHydrate(old)
  staged.ingest(JSON.stringify({ type: 'assistant', version: '9.9.9', message: { model: 'claude-opus-5' } }))
  const current = registry.register({ ...input, hermesHome: join(root, 'second') })!.entry
  expect(current).not.toBe(old)
  expect(current.agentId).toBe(old.agentId)
  expect(old.hermesHome).toBe(input.hermesHome)
  finish('low')
  expect(await pending).toBe(false)
  expect(profiles.getState(old.sessionId)).toEqual(before)
  const install = vi.fn(() => true)
  expect(staged.commitWith!(install)).toBe(false)
  expect(install).not.toHaveBeenCalled()
  profiles.hydrate(old, [])
  expect(profiles.ingest(old, JSON.stringify({ type: 'assistant', message: { model: 'stale' } }))).toBe(false)
  expect(profiles.ingestPane(old, 'stale pane')).toBe(false)
  expect(await profiles.ingestConfig(old)).toBe(false)
  expect(pane).not.toHaveBeenCalled()
  expect(configuredEffort).toHaveBeenCalledOnce()
  expect(profiles.getState(old.sessionId)).toEqual(before)
  profiles.ingestPane(current, 'current pane', true)
  expect(pane).toHaveBeenCalledOnce()
  expect(profiles.getState(current.sessionId).model).toBe('from-pane')
  profiles.forget(old.sessionId)
})

it('drops an optional config refresh queued by a row replaced before the refresh starts', async () => {
  root = mkdtempSync(join(tmpdir(), 'profile-registry-'))
  vi.stubEnv('ADAPTER_DATA_DIR', root)
  vi.stubEnv('CLAUDE_PROJECTS_DIR', root)
  vi.resetModules()
  const { registry } = await import('./registry.js')
  registry.load()
  const input = { engine: 'hermes' as const, sessionId: '20261009_060001_abc123', tmuxPane: '%82', cwd: root,
    hermesHome: join(root, 'first') }
  registry.openProcessAgent({ ...input, processIdentity: { pid: 7002, executable: 'hermes', startMarker: 'fixture' } })
  const old = registry.register(input)!.entry
  const config = vi.fn(async () => true)
  const reader = { engine: 'hermes', target: () => null, config,
    pane: ({ state, refreshConfig }: InlineRuntimeContext) => { state.model = 'observed'; refreshConfig() } }
  const module = { createRuntimeProfileReader: () => reader }
  vi.mocked(engineNow).mockReturnValue(module as never)
  vi.mocked(loadEngine).mockResolvedValue(module as never)
  const profiles = new RuntimeProfileState(() => undefined, id => registry.resolve(id))
  profiles.ingestPane(old, 'old pane', true)
  const current = registry.register({ ...input, hermesHome: join(root, 'second') })!.entry
  expect(current).not.toBe(old)
  await Promise.resolve()
  expect(config).not.toHaveBeenCalled()
  expect(loadEngine).not.toHaveBeenCalled()
  profiles.forget(old.sessionId)
})
