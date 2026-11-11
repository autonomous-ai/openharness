import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentBrowserPort, CoreApi, CorePorts } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { AgentBrowserOptions } from './agentBrowser.js'
import { agentBrowserCoreApi, runAgentBrowserService } from './agentBrowserProcess.js'
import { runServiceProcess, type CoreConnection, type ServiceProcessOptions } from './process.js'
import { turnsLink } from './turnsLink.js'

// The real default reaches a real socket: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })

describe('the agent browser in its own process', () => {
  const setup = () => {
    let options: ServiceProcessOptions | null = null
    let api: CoreApi | null = null
    let given: AgentBrowserOptions | undefined
    const port: AgentBrowserPort = {
      attached: vi.fn(), stopped: vi.fn(), deleted: vi.fn(), frameContext: vi.fn(), stop: vi.fn(), onCloseViewers: vi.fn(),
      streamCommand: vi.fn((agentId: string) => (agentId === 'a9' ? { argv: ['podman', 'exec'] } : { error: 'NOT_READY' as const })),
    }
    const requests = { agent_browser_available: vi.fn() }
    const stop = vi.fn()
    const service = runAgentBrowserService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (opts) => { options = opts; return { stop } },
      start: (core, ports: Pick<CorePorts, 'agentBrowser'>, opts) => { api = core; given = opts; ports.agentBrowser = port; return requests },
    })
    return { options: options!, api: api!, given: given!, port, requests, service, stop }
  }

  it('answers its requests and hears what the core tells it of agents, and nothing else', () => {
    const { options, port, requests } = setup()
    expect(options).toMatchObject({ name: 'agentBrowser', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't', requests })
    const row = { agentId: 'a1', sessionId: 's1', browser: true } as RegisteredSession
    options.onEvent!({ kind: 'attached', session: row })
    options.onEvent!({ kind: 'attached', session: { browser: true } })
    options.onEvent!({ kind: 'stopped', agentId: 'a1' })
    options.onEvent!({ kind: 'deleted', agentId: 'a2' })
    options.onEvent!({ kind: 'deleted', agentId: '' })
    options.onEvent!({ kind: 'other', agentId: 'x' })
    expect(vi.mocked(port.attached).mock.calls).toEqual([[row]])
    expect(vi.mocked(port.stopped).mock.calls).toEqual([['a1']])
    expect(vi.mocked(port.deleted).mock.calls).toEqual([['a2']])
  })

  it('tells the core each browser\'s state, and all of them again at every connection', async () => {
    const { options, given } = setup()
    // No core yet: kept until there is one.
    given.told!('a1', { state: 'starting' })
    const query = vi.fn(async (_query: string, _payload?: Record<string, unknown>) => ({}))
    options.onConnected!({ query } satisfies CoreConnection)
    expect(query.mock.calls).toEqual([['browser_state', { agentId: 'a1', state: { state: 'starting' } }]])
    given.told!('a1', { state: 'ready' })
    given.told!('a2', { state: 'setup', step: 'building' })
    given.told!('a2', undefined)
    expect(query.mock.calls.slice(1)).toEqual([
      ['browser_state', { agentId: 'a1', state: { state: 'ready' } }],
      ['browser_state', { agentId: 'a2', state: { state: 'setup', step: 'building' } }],
      ['browser_state', { agentId: 'a2' }],
    ])
    options.onDisconnected!()
    const next = vi.fn(async () => { throw new Error('gone') })
    options.onConnected!({ query: next } as CoreConnection)
    expect(next.mock.calls).toEqual([['browser_state', { agentId: 'a1', state: { state: 'ready' } }]])
    given.told!('a3', { state: 'starting' })
    await Promise.resolve()
  })

  // The core answers a viewer's open in line, so a ready browser's state carries the exec that reaches it.
  it('a ready browser\'s state carries its stream command', () => {
    const { options, given } = setup()
    const query = vi.fn(async (_query: string, _payload?: Record<string, unknown>) => ({}))
    options.onConnected!({ query } satisfies CoreConnection)
    given.told!('a9', { state: 'ready' })
    given.told!('a1', { state: 'ready' })
    expect(query.mock.calls).toEqual([
      ['browser_state', { agentId: 'a9', state: { state: 'ready' }, command: ['podman', 'exec'] }],
      ['browser_state', { agentId: 'a1', state: { state: 'ready' } }],
    ])
  })

  it('asks the core for its agents\' ids, and a pane\'s agent, and gets no answer when the core cannot say', async () => {
    const { options, api } = setup()
    await expect(api.agents.ids!()).rejects.toThrow('no core')
    expect(await api.agents.ofPane!('%7', [4242])).toBeNull()
    let answer: Record<string, unknown> = { live: ['a1', 7], stopped: ['a2'] }
    const query = vi.fn(async (_query: string, _payload?: Record<string, unknown>) => answer)
    options.onConnected!({ query } satisfies CoreConnection)
    expect(await api.agents.ids!()).toEqual({ live: ['a1'], stopped: ['a2'] })
    expect(query).toHaveBeenLastCalledWith('agent_ids', {})
    answer = { error: 'UNKNOWN_QUERY' }
    await expect(api.agents.ids!()).rejects.toThrow('no answer')
    // The command's parents go with its pane: the core holds the pane's own process to them.
    answer = { agentId: 'a1', guest: false }
    expect(await api.agents.ofPane!('%7', [4242, 1])).toEqual({ agentId: 'a1', guest: false })
    expect(query).toHaveBeenLastCalledWith('agent_of_pane', { pane: '%7', ancestors: [4242, 1] })
    answer = { agentId: 'kim', guest: true }
    expect(await api.agents.ofPane!('%8', [4343])).toEqual({ agentId: 'kim', guest: true })
    // An older relay's `agent_browser_state` names its pane alone.
    answer = { agentId: 'a1', guest: false }
    expect(await api.agents.ofPane!('%7')).toEqual({ agentId: 'a1', guest: false })
    expect(query).toHaveBeenLastCalledWith('agent_of_pane', { pane: '%7' })
    // No agent, or an answer that does not say whose it is: none.
    for (const shape of [{ agentId: null }, { agentId: 'a1' }, { agentId: 'a1', guest: 'no' }, { error: 'UNKNOWN_QUERY' }]) {
      answer = shape
      expect(await api.agents.ofPane!('%7', [4242]), JSON.stringify(shape)).toBeNull()
    }
  })

  // A command waits on this: a core that does not answer is no agent, never a command left hanging.
  it('a core that never answers a pane\'s agent is no agent after 10 s', async () => {
    vi.useFakeTimers()
    const { options, api } = setup()
    options.onConnected!({ query: () => new Promise(() => {}) } as CoreConnection)
    const asked = api.agents.ofPane!('%7', [4242])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await asked).toBeNull()
  })

  it('a core that never answers the ids is no answer after 10 s', async () => {
    vi.useFakeTimers()
    const { options, api } = setup()
    options.onConnected!({ query: () => new Promise(() => {}) } as CoreConnection)
    const asked = api.agents.ids!()
    const settled = asked.catch((error: Error) => error.message)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await settled).toBe('the core did not answer within 10000 ms')
  })

  // The person's Start and Stop: the core sets the row's flag and tells this process before it answers.
  it('asks the core to set the flag, and answers what it said', async () => {
    const { options, api } = setup()
    let answer: Record<string, unknown> = { ok: true, changed: true }
    const query = vi.fn(async (_query: string, _payload?: Record<string, unknown>) => answer)
    options.onConnected!({ query } satisfies CoreConnection)
    expect(await api.agents.setBrowser!('a1', true)).toEqual({ ok: true, changed: true })
    expect(query).toHaveBeenLastCalledWith('set_browser', { agentId: 'a1', on: true })
    answer = { ok: true, changed: false }
    expect(await api.agents.setBrowser!('a1', false)).toEqual({ ok: true, changed: false })
    expect(query).toHaveBeenLastCalledWith('set_browser', { agentId: 'a1', on: false })
    for (const error of ['NOT_RUNNING', 'NOT_ALLOWED']) {
      answer = { error }
      expect(await api.agents.setBrowser!('a1', true)).toEqual({ error })
    }
  })

  it('a core that does not answer the switch rejects', async () => {
    const { options, api } = setup()
    await expect(api.agents.setBrowser!('a1', true)).rejects.toThrow('no core')
    let answer: Record<string, unknown> = { error: 'UNKNOWN_QUERY' }
    options.onConnected!({ query: async () => answer } as CoreConnection)
    await expect(api.agents.setBrowser!('a1', true)).rejects.toThrow('no answer')
    answer = { ok: true }
    await expect(api.agents.setBrowser!('a1', true)).rejects.toThrow('no answer')
    vi.useFakeTimers()
    options.onConnected!({ query: () => new Promise(() => {}) } as CoreConnection)
    const settled = api.agents.setBrowser!('a1', true).catch((error: Error) => error.message)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await settled).toBe('the core did not answer within 10000 ms')
  })

  // The ready and stop lines (agentBrowser/notices.ts): typed by the core, which tells this process what became of each.
  it('delivers its lines through the core and hears what became of them', async () => {
    const { options, api, port } = setup()
    const query = vi.fn(async (_query: string, _payload?: Record<string, unknown>) => ({}))
    options.onConnected!({ query } satisfies CoreConnection)
    const heard = vi.fn()
    api.turns.onDelivery(heard)
    api.turns.deliver('a1', 'Your browser is ready', 'agent-browser:a1:ready:1')
    const [name, payload] = query.mock.calls.at(-1)!
    expect(name).toBe('deliver')
    expect(payload).toMatchObject({ agentId: 'a1', text: 'Your browser is ready' })
    expect(String(payload!.deliveryId)).toMatch(/^agent-browser:a1:ready:/)
    const event = { deliveryId: 'agent-browser:a1:ready:1', sessionId: 'a1', state: 'delivered' }
    options.onEvent!({ kind: 'delivery', event })
    expect(heard).toHaveBeenCalledWith(event)
    expect(port.attached).not.toHaveBeenCalled()
    expect(port.stopped).not.toHaveBeenCalled()
    expect(port.deleted).not.toHaveBeenCalled()
  })

  it('counts through the core, and loses a count it cannot hand over', async () => {
    const { options, api } = setup()
    api.count!('agent_browser_enabled')
    const query = vi.fn(async () => { throw new Error('gone') })
    options.onConnected!({ query } as CoreConnection)
    api.count!('agent_browser_start_ok')
    expect(query).toHaveBeenCalledWith('count', { metric: 'agent_browser_start_ok' })
    await Promise.resolve()
  })

  it('stops the browsers\' watch with the process', () => {
    const { port, service, stop } = setup()
    service.stop()
    expect(port.stop).toHaveBeenCalled()
    expect(stop).toHaveBeenCalled()
  })

  it('with nothing handed in, starts the real service on the real link', () => {
    const service = runAgentBrowserService({ dataDir: '/data', socketPath: '/s', machineId: 'm', token: 't' })
    expect(vi.mocked(runServiceProcess)).toHaveBeenCalledWith(expect.objectContaining({ name: 'agentBrowser' }))
    service.stop()
  })

  it('is the light services\' core API besides', () => {
    const ask = async () => ({})
    const api = agentBrowserCoreApi('/data', ask, turnsLink(ask))
    expect(api.dataDir).toBe('/data')
    expect(api.agents.live()).toEqual([])
  })
})
