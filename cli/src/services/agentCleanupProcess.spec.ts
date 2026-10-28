import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoreApi } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import { agentCleanupCoreApi, runAgentCleanupService } from './agentCleanupProcess.js'
import type { createAgentCleanup } from './agentCleanup.js'
import { runServiceProcess, type CoreConnection, type ServiceProcessOptions } from './process.js'

// The real default reaches a real socket: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

const kid = (agentId: string) => ({ agentId, sessionId: `s-${agentId}`, startedBy: 'agent', parentAgentId: 'lead' }) as RegisteredSession

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agent-cleanup-process-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.clearAllMocks() })

describe('the agent cleanup in its own process', () => {
  const setup = () => {
    let options: ServiceProcessOptions | null = null
    let api: CoreApi | null = null
    const port = { closed: vi.fn(), typed: vi.fn(), stop: vi.fn() }
    let refresh: (() => Promise<void>) | undefined
    const stop = vi.fn()
    const service = runAgentCleanupService({
      dataDir: dir, socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (given) => { options = given; return { stop } },
      create: (core, deps) => { api = core; refresh = deps?.refresh; return { port, look: vi.fn(), closeStartedBy: vi.fn() } },
    })
    return { options: options!, api: api!, port, refresh: refresh!, service, stop }
  }

  it('hears from the core which harness was closed and which the person typed into, and nothing else', () => {
    const { options, port } = setup()
    expect(options).toMatchObject({ name: 'agentCleanup', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't', requests: {} })
    options.onEvent!({ kind: 'closed', agentId: 'lead' })
    options.onEvent!({ kind: 'typed', agentId: 'kid' })
    options.onEvent!({ kind: 'typed', agentId: '' })
    options.onEvent!({ kind: 'closed' })
    options.onEvent!({ kind: 'other', agentId: 'x' })
    expect(port.closed.mock.calls).toEqual([['lead']])
    expect(port.typed.mock.calls).toEqual([['kid']])
  })

  it('reads the live agents from the core before it acts, and none when the core cannot say', async () => {
    const { options, api, refresh } = setup()
    // No core yet: none.
    await refresh()
    expect(api.agents.live()).toEqual([])
    let answer: Record<string, unknown> = { agents: [kid('k1')] }
    const query = vi.fn(async (_query: string, _payload?: Record<string, unknown>) => answer)
    options.onConnected!({ query } satisfies CoreConnection)
    await refresh()
    expect(query).toHaveBeenLastCalledWith('live', {})
    expect(api.agents.live().map((s) => s.agentId)).toEqual(['k1'])
    answer = { error: 'UNKNOWN_QUERY' }
    await refresh()
    expect(api.agents.live()).toEqual([])
    options.onDisconnected!()
    await refresh()
    expect(api.agents.live()).toEqual([])
  })

  it('asks the core when a harness last moved and to close it, and takes no answer as none and not closed', async () => {
    const query = vi.fn(async (name: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
      (name === 'lastActivity' ? { at: payload.agentId === 'k1' ? 1_000 : null } : { closed: true }))
    const ask = (name: string, payload: Record<string, unknown>) => query(name, payload)
    const api = agentCleanupCoreApi(dir, () => [kid('k1')], ask)
    expect(await api.agents.lastActivity!('k1')).toBe(1_000)
    expect(await api.agents.lastActivity!('k2')).toBeNull()
    expect(await api.agents.closeStarted!('k1', 'now')).toEqual({ closed: true })
    expect(query).toHaveBeenLastCalledWith('closeStarted', { agentId: 'k1', mode: 'now' })
    expect(api.agents.byAgent('k1')?.agentId).toBe('k1')
    const gone = agentCleanupCoreApi(dir, () => [], async () => { throw new Error('the core went away') })
    expect(await gone.agents.lastActivity!('k1')).toBeNull()
    expect(await gone.agents.closeStarted!('k1', 'idle')).toEqual({ error: 'SERVICE_UNAVAILABLE' })
  })

  // HARNESS_SWARM: the Super Tab members it keeps come from the Swarm's side, which its process loads only while it is on.
  it('keeps the members the Swarm hands it while it is on, and none without it', () => {
    const given: Array<Parameters<typeof createAgentCleanup>[1]> = []
    const create = (_core: CoreApi, deps?: Parameters<typeof createAgentCleanup>[1]) => { given.push(deps); return { port: { closed: vi.fn(), typed: vi.fn(), stop: vi.fn() }, look: vi.fn(), closeStartedBy: vi.fn() } }
    const retainedHarnesses = vi.fn(() => new Set(['member']))
    const base = { dataDir: dir, socketPath: '/s', machineId: 'm', token: 't', run: () => ({ stop: vi.fn() }), create }
    runAgentCleanupService({ ...base, swarm: { retainedHarnesses } })
    runAgentCleanupService(base)
    expect(given[0]!.retained).toBe(retainedHarnesses)
    expect(given[1]).not.toHaveProperty('retained')
  })

  it('stops its looks with the process', () => {
    const { service, port, stop } = setup()
    service.stop()
    expect(port.stop).toHaveBeenCalled()
    expect(stop).toHaveBeenCalled()
  })

  it('runs as a real service by default, on the cleanup', async () => {
    vi.useFakeTimers()
    try {
      const service = runAgentCleanupService({ dataDir: dir, socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
      const options = vi.mocked(runServiceProcess).mock.calls.at(-1)![0]
      expect(options.name).toBe('agentCleanup')
      // The real cleanup on the process's core API: a harness closed, what it started is asked of the core and closed.
      const query = vi.fn(async (name: string, _payload?: Record<string, unknown>) => (name === 'live' ? { agents: [kid('k1')] } : { closed: true }))
      options.onConnected!({ query })
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      options.onEvent!({ kind: 'closed', agentId: 'lead' })
      await vi.advanceTimersByTimeAsync(0)
      expect(query.mock.calls).toEqual([['live', {}], ['closeStarted', { agentId: 'k1', mode: 'now' }]])
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[agent-cleanup\] closed a harness \(k1\): the harness that started it was closed/))
      service.stop()
    } finally { vi.useRealTimers() }
  })
})
