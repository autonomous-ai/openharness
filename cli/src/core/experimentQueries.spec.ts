import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { answerExperimentQuery, createForExperiment } from './experimentQueries.js'

const agent = (agentId: string) => ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: '/w' }) as RegisteredSession
const experiments = new Set(['orchestrator'])

describe('what an experiment in its own process may ask of the core', () => {
  it('shows the live agents as the apps are shown them: name, terminal and harness', async () => {
    const core = fakeCore({
      agents: {
        live: () => [agent('a1'), agent('a2')],
        displayName: (session) => `name of ${session.agentId}`,
        terminalAvailable: (agentId) => agentId === 'a1',
        dsh: (session) => (session.agentId === 'a1' ? { viewerUrl: 'http://127.0.0.1:1/' } as never : null),
      },
    })
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'shown', {})).toEqual({
      agents: [
        { ...agent('a1'), displayName: 'name of a1', terminalAvailable: true, dshContext: { viewerUrl: 'http://127.0.0.1:1/' } },
        { ...agent('a2'), displayName: 'name of a2', terminalAvailable: false, dshContext: null },
      ],
    })
  })

  it('creates an agent as asked, and refuses a request it cannot read', async () => {
    const create = vi.fn(async () => ({ ok: true as const, agentId: 'made' }))
    const core = fakeCore({ agents: { create } })
    const request = { engine: 'claude', cwd: '/w', dsh: 'cad', prompt: 'Plan it', name: 'Director', bypassPermission: true }
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'create', request)).toEqual({ ok: true, agentId: 'made' })
    expect(create).toHaveBeenLastCalledWith(request)
    await answerExperimentQuery(core, experiments, 'orchestrator', 'create', { ...request, dsh: '', bypassPermission: 'yes' })
    expect(create).toHaveBeenLastCalledWith({ ...request, dsh: null, bypassPermission: false })
    for (const bad of [{ ...request, engine: 3 }, { ...request, cwd: '' }, { ...request, prompt: null }, { ...request, name: undefined }]) {
      expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'create', bad)).toEqual({ ok: false, error: 'INVALID_REQUEST' })
    }
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('stops a turn, and tells the windows a change notice and nothing else', async () => {
    const stop = vi.fn()
    const windows = vi.fn()
    const core = fakeCore({ turns: { stop }, clients: { windows } })
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'stop_turn', { agentId: 'a1' })).toEqual({})
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'stop_turn', {})).toEqual({})
    expect(stop.mock.calls).toEqual([['a1']])
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'windows', { frame: { type: 'orchestrator_changed', payload: { id: 'p', revision: 2 } } })).toEqual({})
    expect(windows).toHaveBeenCalledWith({ type: 'orchestrator_changed', payload: { id: 'p', revision: 2 } })
    for (const frame of [undefined, { type: 'agents_list', payload: {} }, { type: 'orchestrator_changed' }, { type: 'orchestrator_changed', payload: 'x' }]) {
      expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'windows', { frame })).toEqual({ error: 'INVALID_FRAME' })
    }
    expect(windows).toHaveBeenCalledOnce()
  })

  it('says how an agent\'s shell reaches this daemon', async () => {
    const core = fakeCore({ daemon: { command: `'node' 'cli.js'`, port: 18473, machineId: () => 'machine-7', autonomousEnv: 'staging' } })
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'daemon', {})).toEqual({ command: `'node' 'cli.js'`, port: 18473, machineId: 'machine-7', autonomousEnv: 'staging' })
  })

  it('reads and writes the account\'s backend under /api/, signed in by the core, and nothing else', async () => {
    const backend = vi.fn(async () => ({ status: 200, body: { success: true, data: { tabs: [] } } }))
    const core = fakeCore({ account: { backend } })
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'backend', { method: 'PATCH', path: '/api/tab-channels/settings', body: { enabled: true } }))
      .toEqual({ status: 200, body: { success: true, data: { tabs: [] } } })
    expect(backend).toHaveBeenCalledWith('PATCH', '/api/tab-channels/settings', { enabled: true })
    for (const bad of [{ method: 'TRACE', path: '/api/x' }, { method: 'GET', path: '/auth/token' }, { method: 'GET' }]) {
      expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'backend', bad)).toEqual({ error: 'INVALID_REQUEST' })
    }
    expect(backend).toHaveBeenCalledOnce()
  })

  it('has Share\'s welcomes signed by the key the gateway holds, and says why it could not', async () => {
    const publicKey = vi.fn(async () => 'cHVi')
    const signWelcome = vi.fn(async () => 'c2ln')
    const core = fakeCore({ account: { observerKey: { publicKey, signWelcome } } })
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'observer_key', { op: 'public' })).toEqual({ key: 'cHVi' })
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'observer_key', { op: 'sign', machineId: 'm', shareId: 's', peer: 'p', ephemeral: 'e' })).toEqual({ key: 'c2ln' })
    expect(signWelcome).toHaveBeenCalledWith('m', 's', 'p', 'e')
    signWelcome.mockRejectedValueOnce(new Error('not a welcome to an observer'))
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'observer_key', {})).toEqual({ error: 'not a welcome to an observer' })
    publicKey.mockRejectedValueOnce('odd')
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'observer_key', { op: 'public' })).toEqual({ error: 'odd' })
  })

  it('sends Share\'s sealed frame to one of its observers, and nothing that is not one', async () => {
    const observer = vi.fn(() => true)
    const core = fakeCore({ clients: { observer } })
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'observer_send', { connId: 'observer:ken', type: 'observer_frame', payload: { __e2e: {} } })).toEqual({ sent: true })
    expect(observer).toHaveBeenCalledWith('observer:ken', 'observer_frame', { __e2e: {} })
    for (const bad of [{ connId: 'remote-1', type: 'observer_frame', payload: {} }, { connId: 'observer:ken', type: 'agents_list', payload: {} }, { connId: 'observer:ken', type: 'observer_frame' }]) {
      expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'observer_send', bad)).toEqual({ error: 'INVALID_FRAME' })
    }
    expect(observer).toHaveBeenCalledOnce()
  })

  it('answers none of these for a process that is not an experiment, and leaves other queries to whoever answers them', async () => {
    const core = fakeCore()
    expect(await answerExperimentQuery(core, experiments, 'gateway', 'create', {})).toEqual({ error: 'NOT_AN_EXPERIMENT' })
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'live', {})).toBeNull()
  })

  it('creates an experiment\'s agent as the window\'s agent_create does, with nothing of its own beyond what it asked', async () => {
    const request = { engine: 'claude' as const, cwd: '/w', dsh: 'cad', prompt: 'Plan it', name: 'Director', bypassPermission: false }
    const create = vi.fn(async () => ({ ok: true as const, session: agent('made') }))
    expect(await createForExperiment(create as never, request)).toEqual({ ok: true, agentId: 'made' })
    expect(create).toHaveBeenCalledWith({ ...request, grid: null, codexHome: null, agent: null, permissionMode: null })
    create.mockResolvedValueOnce({ ok: false, error: 'ENGINE_MISSING', detail: 'not here' } as never)
    expect(await createForExperiment(create as never, request)).toEqual({ ok: false, error: 'ENGINE_MISSING', detail: 'not here' })
    create.mockResolvedValueOnce({ ok: false, error: 'ENGINE_MISSING' } as never)
    expect(await createForExperiment(create as never, request)).toEqual({ ok: false, error: 'ENGINE_MISSING' })
    expect(await createForExperiment(null, request)).toEqual({ ok: false, error: 'UNSUPPORTED', detail: 'This daemon cannot create agents.' })
  })
})
