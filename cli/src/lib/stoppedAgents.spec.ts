import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, constants, openSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RegisteredSession } from './registry.js'

vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, openSync: vi.fn(fs.openSync) } })

let directory = ''
beforeEach(() => {
  vi.resetModules()
  directory = mkdtempSync(join(tmpdir(), 'harness-stopped-'))
  vi.stubEnv('ADAPTER_DATA_DIR', directory)
})
afterEach(() => {
  vi.mocked(openSync).mockRestore()
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


it('keeps the original identity searchable while preserving the surviving shell route', async () => {
  const { registry, saved, store } = await fixture()
  // Use the actual row, as the daemon does after registering its session.
  Object.assign(registry.byAgent(saved.agentId)!, saved)
  store.save(saved)
  const shell = registry.releaseEngine(saved.agentId, true)!
  expect(shell.agentId).not.toBe(saved.agentId)
  expect(shell).toMatchObject({ engine: 'terminal', sessionId: '', tmuxPane: '%8', processIdentity: null })
  expect(registry.byAgent(saved.agentId)).toBeUndefined()
  expect(registry.bySession(saved.sessionId)).toBeUndefined()
  expect(store.available(registry.list()).map(row => row.agentId)).toEqual([saved.agentId])
  const resumed = registry.resumePendingAgent(store.get(saved.agentId)!, [{ backend: 'tmux', paneId: '%99' }])!
  expect(resumed.agentId).toBe(saved.agentId)
  expect(registry.byRuntimeTerminal({ backend: 'tmux', paneId: '%8' })?.agentId).toBe(shell.agentId)
  expect(registry.list()).toHaveLength(2)
})

it('reserves allocation across daemon restarts and different receipt IDs', async () => {
  const { store, StoppedAgentStore, saved } = await fixture()
  const token = store.beginResume(saved.agentId)!
  const restarted = new StoppedAgentStore(join(directory, 'stopped-agents'))
  expect(restarted.beginResume(saved.agentId)).toBeNull()
  restarted.finishResume(saved.agentId, 'someone-else')
  expect(store.beginResume(saved.agentId)).toBeNull()
  restarted.finishResume(saved.agentId, token)
  expect(store.beginResume(saved.agentId)).not.toBeNull()
})

it('keeps readable archives discoverable beside corrupt, unsupported and mismatched records', async () => {
  const { saved, store } = await fixture()
  expect(store.list()).toEqual([])
  store.save(saved)
  const base = join(directory, 'stopped-agents')
  for (const [id, content] of Object.entries({ corrupt: '{', version: JSON.stringify({ version: 99 }), invalid: JSON.stringify({ version: 1, session: {} }), mismatch: JSON.stringify({ version: 1, session: saved }) })) {
    writeFileSync(join(base, `${id}.json`), content, { mode: 0o600 })
  }
  writeFileSync(join(base, 'unrelated.tmp'), 'skip')
  expect(store.list().map(row => row.agentId)).toEqual([saved.agentId])
  expect(store.get('missing')).toBeNull()
  expect(store.get('../invalid')).toBeNull()
  expect(() => store.save({ ...saved, agentId: '../invalid' })).toThrow()
  expect(() => store.beginResume('../invalid')).toThrow()
  store.finishResume('../invalid')
  store.finishResume('absent')
  chmodSync(base, 0o777)
  expect(() => store.list()).toThrow()
})

it('persists a standalone shell and a runtime without the legacy tmux alias', async () => {
  const { saved, store } = await fixture()
  store.save({ ...saved, engine: 'terminal', sessionId: '', tmuxPane: '', runtimes: [{ backend: 'herdr', endpointId: 'fixture', paneId: '1' } as any], primaryRuntimeKey: ['herdr', 'fixture', '1'].join('\0'), codexHome: null })
  const disk = JSON.parse(readFileSync(join(directory, 'stopped-agents', `${saved.agentId}.json`), 'utf8'))
  expect(disk.session).not.toHaveProperty('tmuxPane')
  expect(disk.session.sessionId).toBe('')
  store.save({ ...saved, agentId: 'null-profile', codexHome: null })
  expect(store.available([{ ...saved, agentId: 'live', codexHome: null }]).some(row => row.agentId === 'null-profile')).toBe(false)
  expect(store.available([{ ...saved, sessionId: '' }])).toBeDefined()
})

it('fails closed on corrupt reservation data and unsafe reservation files', async () => {
  const { saved, store } = await fixture()
  const token = store.beginResume(saved.agentId)!
  const marker = join(directory, 'stopped-agents', `${saved.agentId}.resume`)
  writeFileSync(marker, '{')
  expect(() => store.finishResume(saved.agentId, token)).toThrow()
  expect(store.beginResume(saved.agentId)).toBeNull()
  rmSync(marker)
  // A directory in place of the reservation cannot be unlinked as a file.
  symlinkSync('/dev/null', marker)
  expect(() => store.finishResume(saved.agentId)).toThrow()
  rmSync(marker)
  // Fail before allocation if private-state traversal itself is unsafe.
  chmodSync(join(directory, 'stopped-agents'), 0o777)
  expect(() => store.beginResume(saved.agentId)).toThrow()
})

it('does not allocate when reserving disk space fails', async () => {
  const { saved, store } = await fixture()
  store.save(saved)
  const real = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(openSync).mockImplementation((file, flags, mode) => {
    if (typeof flags === 'number' && (flags & constants.O_EXCL)) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    return real.openSync(file, flags, mode)
  })
  expect(() => store.beginResume(saved.agentId)).toThrow('disk full')
  expect(store.get(saved.agentId)?.sessionId).toBe(saved.sessionId)
})
