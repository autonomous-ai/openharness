import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RegisteredSession } from './registry.js'

let directory = ''
beforeEach(() => {
  vi.resetModules()
  directory = mkdtempSync(join(tmpdir(), 'harness-stopped-'))
  vi.stubEnv('ADAPTER_DATA_DIR', directory)
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

async function fixture() {
  const { registry } = await import('./registry.js')
  const { StoppedAgentStore } = await import('./stoppedAgents.js')
  const entry = registry.openPendingAgent({ engine: 'codex', runtimes: [{ backend: 'tmux', paneId: '%8' }], cwd: '/tmp/work', defaultName: 'My work', codexHome: '/tmp/profile', dsh: 'autonomous/fixture', permissionMode: 'plan' })!
  const saved: RegisteredSession = { ...entry, sessionId: 'conversation-123', title: 'Continue my work', processIdentity: { pid: 98765, executable: 'codex', startMarker: 'old-process' } }
  const store = new StoppedAgentStore(join(directory, 'stopped-agents'))
  return { registry, StoppedAgentStore, saved, store }
}

describe('stopped harness persistence', () => {
  it('retains the conversation and launch profile after removal and store reload', async () => {
    const { registry, StoppedAgentStore, saved, store } = await fixture()
    store.save(saved)
    registry.removeAgent(saved.agentId)
    const restored = new StoppedAgentStore(join(directory, 'stopped-agents')).get(saved.agentId)!
    expect(restored).toMatchObject({ agentId: saved.agentId, sessionId: 'conversation-123', engine: 'codex', cwd: '/tmp/work', codexHome: '/tmp/profile', dsh: 'autonomous/fixture', permissionMode: 'plan', active: false })
    expect(registry.list()).toHaveLength(0)
    expect(registry.advertised()).toHaveLength(0)
    expect(store.available([])).toHaveLength(1)
    expect(statSync(join(directory, 'stopped-agents', `${saved.agentId}.json`)).mode & 0o777).toBe(0o600)
  })

  it('hides a running identity or conversation, without discarding its archive', async () => {
    const { saved, store } = await fixture()
    store.save(saved)
    expect(store.available([saved])).toEqual([])
    expect(store.available([{ ...saved, agentId: 'another-agent' }])).toEqual([])
    expect(store.available([{ ...saved, agentId: 'another-agent', codexHome: '/other/profile' }])).toHaveLength(1)
    expect(store.available([])).toHaveLength(1)
  })

  it('stopping the shell left by an exited engine preserves its conversation', async () => {
    const { saved, store } = await fixture()
    store.save(saved)
    store.save({ ...saved, engine: 'terminal', sessionId: '', codexHome: null, dsh: null })
    expect(store.get(saved.agentId)).toMatchObject({ engine: 'codex', sessionId: 'conversation-123', codexHome: '/tmp/profile' })
  })

  it('resumes on a new route with the same identity and refuses a duplicate claim', async () => {
    const { registry, saved, store } = await fixture()
    store.save(saved)
    registry.removeAgent(saved.agentId)
    const resumed = registry.resumePendingAgent(store.get(saved.agentId)!, [{ backend: 'tmux', paneId: '%99' }])!
    expect(resumed).toMatchObject({ agentId: saved.agentId, sessionId: saved.sessionId, tmuxPane: '%99', processIdentity: null, launch: { state: 'starting' }, permissionMode: 'plan', codexHome: '/tmp/profile' })
    expect(registry.resumePendingAgent(saved, [{ backend: 'tmux', paneId: '%100' }])).toBeNull()
    expect(registry.advertised()).toHaveLength(1)
  })

  it('does not follow a planted archive symlink or overwrite unsafe state', async () => {
    const { saved, store } = await fixture()
    store.save(saved)
    const file = join(directory, 'stopped-agents', `${saved.agentId}.json`)
    const other = join(directory, 'other.json')
    writeFileSync(other, 'untouched', { mode: 0o600 })
    rmSync(file)
    symlinkSync(other, file)
    expect(() => store.get(saved.agentId)).toThrow()
    expect(() => store.save(saved)).toThrow()
    expect(readFileSync(other, 'utf8')).toBe('untouched')
    rmSync(file)
    store.save(saved)
    chmodSync(file, 0o666)
    expect(() => store.get(saved.agentId)).toThrow()
  })
})
