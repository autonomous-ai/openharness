import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { agentsIn, daemonIn, isSession, processCoreApi, type ShownAgent } from './processCoreApi.js'
import { turnsLink } from './turnsLink.js'

const agent = (agentId: string, over: Partial<RegisteredSession> = {}) => ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: `/work/${agentId}`, ...over }) as RegisteredSession

describe('the core API a light service runs on in its own process', () => {
  it('answers the agents from what the core last said, by agent id or session id', () => {
    const live = [agent('a1'), agent('a2')]
    const api = processCoreApi('/data', 'projects', { live: () => live, advertised: () => [live[1]] })
    expect(api.dataDir).toBe('/data')
    expect(api.agents.live()).toEqual(live)
    expect(api.agents.all()).toEqual(live)
    expect(api.agents.advertised()).toEqual([live[1]])
    expect(api.agents.byAgent('a2')).toEqual(live[1])
    expect(api.agents.resolve('s-a1')).toEqual(live[0])
    expect(api.agents.resolve('nobody')).toBeUndefined()
  })

  it('answers agents it was never told of as none, and what these services never ask as nothing', async () => {
    const api = processCoreApi('/data', 'usage')
    expect(api.agents.live()).toEqual([])
    expect(api.agents.advertised()).toEqual([])
    expect(api.agents.byAgent('a1')).toBeUndefined()
    expect(api.agents.displayName(agent('a1'))).toBe('')
    expect(api.agents.terminalAvailable('a1')).toBe(false)
    // Only the core launches a terminal (#893): a service in its own process is refused.
    await expect(api.terminals.open({ argv: ['/bin/sh'] } as never)).resolves.toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
    api.agents.sync(agent('a1'))
    await expect(api.agents.runtimeModels()).resolves.toEqual([])
    expect(api.agents.runtimeProfile(agent('a1'))).toBeNull()
    api.agents.setRuntime('a1', 'opus')
    await expect(api.agents.fork('a1')).resolves.toEqual({ ok: false, error: 'UNSUPPORTED' })
    api.turns.send('a1', 'text')
    api.turns.stop('a1')
    expect(await api.turns.recent('a1', 3)).toEqual([])
    expect(await api.turns.asks('a1')).toEqual([])
    api.questions.answer('a1', 'q', {})
    await expect(api.questions.answerReviewed({} as never)).resolves.toBe(false)
    expect(api.transcripts.databaseHistory(agent('a1'))).toBeUndefined()
    expect(api.external.sessions.list()).toEqual([])
    await expect(api.external.sessions.scan()).resolves.toEqual([])
    expect(api.external.open.known().size).toBe(0)
    await expect(api.external.open.fresh()).resolves.toEqual(new Map())
    await expect(api.account.mintGridName()).resolves.toBeNull()
    // A service holds no credential, and says which one asked.
    await expect(api.account.accessToken()).rejects.toThrow('usage holds no credential')
    await expect(api.account.privateGridName()).resolves.toBeNull()
    expect(api.account.machineName()).toBeNull()
    api.clients.viewerChanged('a1')
    api.clients.gridNamed('grid')
    api.clients.gridModelsChanged()
    api.clients.dshInstallStatus({ phase: 'clone' })
    // What only the devices ask (services/devices.ts): nothing, from every other service.
    expect([api.machine.id(), api.machine.computerId(), api.machine.name()]).toEqual(['', '', ''])
    await expect(api.agents.activityText('a1')).resolves.toBeNull()
    expect(api.account.signedIn()).toBe(false)
    expect(api.account.environment()).toBe('')
    await expect(api.account.machines()).resolves.toEqual({ status: 503, body: {} })
    api.clients.sendLocal({ type: 'dial_focus', payload: {} })
    expect(api.clients.sendToWindow('w1', { type: 'dial_form', payload: {} })).toBe(false)
    expect(api.clients.hasWindow()).toBe(false)
    api.clients.devicesChanged({})
    api.clients.dialWatching(true)
    // With no way to ask the core, it acts on nothing: no agent made, no turn, no window told.
    await expect(api.agents.create({ engine: 'claude', cwd: '/w', dsh: null, prompt: 'p', name: 'n', bypassPermission: false }))
      .resolves.toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
    expect(api.agents.dsh(agent('a1'))).toBeNull()
    api.clients.windows({ type: 'orchestrator_changed', payload: {} })
    api.turns.deliver('a1', 'text', 'd1')
    expect(api.turns.cancelDelivery('d1')).toBe(false)
    expect(api.daemon).toMatchObject({ command: 'harness', port: 0 })
    expect(api.daemon.machineId()).toBe('')
    expect(await api.account.backend('GET', '/api/tab-channels')).toEqual({ status: 503, body: { error: 'SERVICE_UNAVAILABLE' } })
    expect(api.account.onNotice(() => {})()).toBeUndefined()
  })

  it('reads the account\'s backend through the core for an experiment, and hears the notices it is told', async () => {
    let answer: Record<string, unknown> | Error = { status: 200, body: { success: true } }
    const ask = vi.fn(async () => { if (answer instanceof Error) throw answer; return answer })
    const listeners: Array<(notice: never) => void> = []
    const api = processCoreApi('/data', 'collaboration', { ask, onNotice: (listener) => { listeners.push(listener as never); return () => {} } })
    expect(await api.account.backend('PATCH', '/api/tab-channels/settings', { enabled: true })).toEqual({ status: 200, body: { success: true } })
    expect(ask).toHaveBeenLastCalledWith('backend', { method: 'PATCH', path: '/api/tab-channels/settings', body: { enabled: true } })
    await api.account.backend('GET', '/api/tab-channels')
    expect(ask).toHaveBeenLastCalledWith('backend', { method: 'GET', path: '/api/tab-channels' })
    answer = { error: 'INVALID_REQUEST' }
    expect(await api.account.backend('GET', '/nope')).toEqual({ status: 502, body: { error: 'INVALID_REQUEST' } })
    answer = { status: 200 }
    expect(await api.account.backend('GET', '/api/x')).toEqual({ status: 502, body: { error: 'BACKEND_UNREACHABLE' } })
    answer = new Error('the link went')
    expect(await api.account.backend('GET', '/api/x')).toEqual({ status: 503, body: { error: 'SERVICE_UNAVAILABLE' } })
    api.account.onNotice(() => {})
    expect(listeners).toHaveLength(1)
  })

  it('acts on the core for an experiment: agents made, turns stopped and delivered, windows told, each asked', async () => {
    const answers: Record<string, Record<string, unknown> | Error> = {
      create: { ok: true, agentId: 'made' }, stop_turn: {}, windows: {}, deliver: {}, cancel_delivery: { cancelled: true },
    }
    const ask = vi.fn(async (query: string) => {
      const answer = answers[query]
      if (answer instanceof Error) throw answer
      return answer
    })
    const shown = { ...agent('a1'), displayName: 'Planner', terminalAvailable: true, dshContext: { viewerUrl: 'http://127.0.0.1:1/', viewerName: 'CAD' } } as unknown as ShownAgent
    const api = processCoreApi('/data', 'orchestrator', {
      live: () => [shown, agent('a2')], ask, deliveries: turnsLink(ask),
      daemon: () => ({ command: `'node' 'cli.js'`, port: 18473, machineId: () => 'm', autonomousEnv: 'staging' }),
    })
    const request = { engine: 'claude' as const, cwd: '/w', dsh: null, prompt: 'p', name: 'n', bypassPermission: false }
    expect(await api.agents.create(request)).toEqual({ ok: true, agentId: 'made' })
    expect(ask).toHaveBeenCalledWith('create', request)
    answers.create = { ok: false, error: 'ENGINE_NOT_INSTALLED', detail: 'not here' }
    expect(await api.agents.create(request)).toEqual({ ok: false, error: 'ENGINE_NOT_INSTALLED', detail: 'not here' })
    answers.create = {}
    expect(await api.agents.create(request)).toEqual({ ok: false, error: 'CREATE_FAILED' })
    answers.create = new Error('the link went')
    expect(await api.agents.create(request)).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
    expect(api.agents.displayName(shown)).toBe('Planner')
    expect(api.agents.terminalAvailable('a1')).toBe(true)
    expect(api.agents.terminalAvailable('a2')).toBe(false)
    expect(api.agents.dsh(shown)).toEqual({ viewerUrl: 'http://127.0.0.1:1/', viewerName: 'CAD' })
    api.turns.stop('a1')
    api.clients.windows({ type: 'orchestrator_changed', payload: { id: 'p' } })
    answers.stop_turn = new Error('gone')
    answers.windows = new Error('gone')
    api.turns.stop('a1')
    api.clients.windows({ type: 'orchestrator_changed', payload: { id: 'p' } })
    api.turns.deliver('a1', 'go', 'd1')
    await new Promise((settle) => setTimeout(settle, 0))
    expect(ask).toHaveBeenCalledWith('stop_turn', { agentId: 'a1' })
    expect(ask).toHaveBeenCalledWith('windows', { frame: { type: 'orchestrator_changed', payload: { id: 'p' } } })
    expect(ask).toHaveBeenCalledWith('deliver', { agentId: 'a1', text: 'go', deliveryId: 'd1' })
    expect(api.daemon.command).toBe(`'node' 'cli.js'`)
    expect(api.daemon.port).toBe(18473)
    expect(api.daemon.machineId()).toBe('m')
  })

  it('has Share\'s welcomes signed and its observers\' frames sent through the core, and watches through the link it is given', async () => {
    const answers: Record<string, Record<string, unknown> | Error> = { observer_key: { key: 'a2V5' }, observer_send: { sent: true } }
    const ask = vi.fn(async (query: string) => {
      const answer = answers[query]
      if (answer instanceof Error) throw answer
      return answer
    })
    const watch = { frame: vi.fn(async () => {}), close: vi.fn(async () => {}), onOutput: vi.fn(() => () => {}) }
    const api = processCoreApi('/data', 'sharing', { ask, watch, daemon: () => ({ command: 'x', port: 1, machineId: () => 'm', autonomousEnv: 'staging' }) })
    expect(await api.account.observerKey.publicKey()).toBe('a2V5')
    expect(await api.account.observerKey.signWelcome('m', 's', 'cA==', 'ZQ==')).toBe('a2V5')
    expect(ask).toHaveBeenCalledWith('observer_key', { op: 'public' })
    expect(ask).toHaveBeenCalledWith('observer_key', { op: 'sign', machineId: 'm', shareId: 's', peer: 'cA==', ephemeral: 'ZQ==' })
    answers.observer_key = { error: 'not a welcome to an observer' }
    await expect(api.account.observerKey.signWelcome('m', 's', 'x', 'y')).rejects.toThrow('not a welcome to an observer')
    answers.observer_key = {}
    await expect(api.account.observerKey.publicKey()).rejects.toThrow('did not answer')
    expect(api.clients.observer('observer:k', 'observer_frame', { a: 1 })).toBe(true)
    answers.observer_send = new Error('the link went')
    expect(api.clients.observer('observer:k', 'observer_frame', {})).toBe(true)
    await new Promise((settle) => setTimeout(settle, 0))
    expect(ask).toHaveBeenCalledWith('observer_send', { connId: 'observer:k', type: 'observer_frame', payload: { a: 1 } })
    expect(api.terminals.watch).toBe(watch)
    expect(api.daemon.autonomousEnv).toBe('staging')
    // Without the core to ask, it signs nothing and sends nothing.
    const alone = processCoreApi('/data', 'sharing')
    expect(alone.clients.observer('observer:k', 'observer_frame', {})).toBe(false)
    await expect(alone.account.observerKey.publicKey()).rejects.toThrow('no E2EE identity')
    expect(alone.daemon.autonomousEnv).toBe('prod')
  })

  it('reads the daemon\'s address out of the core\'s answer, and nothing out of anything else', () => {
    const address = daemonIn({ command: 'harness', port: 18473, machineId: 'm' })!
    expect(address).toMatchObject({ command: 'harness', port: 18473, autonomousEnv: 'prod' })
    expect(daemonIn({ command: 'harness', port: 18473, machineId: 'm', autonomousEnv: 'staging' })!.autonomousEnv).toBe('staging')
    expect(address.machineId()).toBe('m')
    expect(daemonIn({ command: 'harness', port: '18473', machineId: 'm' })).toBeNull()
    expect(daemonIn({ command: 'harness', port: 18473 })).toBeNull()
    expect(daemonIn({ error: 'NOT_AN_EXPERIMENT' })).toBeNull()
    expect(daemonIn(null)).toBeNull()
  })

  it('reads the agents out of the core\'s answer, and nothing out of anything else', () => {
    expect(agentsIn({ agents: [agent('a1'), { agentId: 7 }, null, 'a2'] })).toEqual([agent('a1')])
    expect(agentsIn({ error: 'QUERY_FAILED' })).toBeNull()
    expect(agentsIn(null)).toBeNull()
    expect(agentsIn(undefined)).toBeNull()
    expect(isSession(agent('a1'))).toBe(true)
    expect(isSession({ sessionId: 's' })).toBe(false)
  })
})
