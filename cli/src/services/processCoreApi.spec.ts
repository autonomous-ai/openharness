import { describe, expect, it, vi } from 'vitest'
import { TAB_KEY_OFF, TAB_RELAY_OFF } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import { agentsIn, daemonIn, isSession, processCoreApi, UNASKED, type ShownAgent } from './processCoreApi.js'
import { turnsLink } from './turnsLink.js'

it('grants typed deliveries only in its connected service namespace and refuses a missing or failed core', async () => {
  const ask = vi.fn(async () => ({ leased: true }))
  const api = processCoreApi('/data', 'worker', { ask })
  expect(await api.turns.leaseDeliveries('other', {})).toBe(false)
  expect(ask).not.toHaveBeenCalled()
  expect(await api.turns.leaseDeliveries('worker', { delivery: 100 })).toBe(true)
  expect(ask).toHaveBeenCalledWith('lease_deliveries', { leases: { delivery: 100 } })
  ask.mockRejectedValueOnce(new Error('Disconnected'))
  expect(await api.turns.leaseDeliveries('worker', {})).toBe(false)
  expect(await processCoreApi('/data', 'worker').turns.leaseDeliveries('worker', {})).toBe(false)
})
import { usageTarget } from '../lib/agentUsageWire.js'

const agent = (agentId: string, over: Partial<RegisteredSession> = {}) => ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: `/work/${agentId}`, ...over }) as RegisteredSession

describe('the core API a light service runs on in its own process', () => {
  it('validates native observation pages and never advances a cursor on an unavailable core', async () => {
    const cursor = { epoch: 'fixture-observation-epoch', sequence: 0 }, page = { cursor, observations: [], gap: false }
    const ask = vi.fn(async (): Promise<Record<string, unknown>> => ({ page }))
    const api = processCoreApi('/data', 'worker', { ask })
    expect(await api.transcripts.nativeTurns!('native')).toEqual(page)
    expect(ask).toHaveBeenLastCalledWith('native_turns', { agentId: 'native' })
    expect(await api.transcripts.nativeTurns!('native', cursor)).toEqual(page)
    expect(ask).toHaveBeenLastCalledWith('native_turns', { agentId: 'native', cursor })
    ask.mockResolvedValueOnce({ page: { ...page, observations: [{}] } })
    expect(await api.transcripts.nativeTurns!('native', cursor)).toBeNull()
    ask.mockRejectedValueOnce(new Error('Disconnected'))
    expect(await api.transcripts.nativeTurns!('native', cursor)).toBeNull()
    expect(await processCoreApi('/data', 'worker').transcripts.nativeTurns!('native')).toBeNull()
  })
  it('accepts only the requested native creation receipt from the core', async () => {
    const id = 'creation-fixture-1234', observation = { creationId: id, state: 'cancelled' }
    const ask = vi.fn(async (): Promise<Record<string, unknown>> => ({ observation }))
    const api = processCoreApi('/data', 'worker', { ask })
    expect(await api.agents.creationStatus!(id)).toEqual(observation)
    expect(ask).toHaveBeenCalledWith('creation_status', { creationId: id })
    ask.mockResolvedValueOnce({ observation: { ...observation, creationId: 'other' } })
    expect(await api.agents.creationStatus!(id)).toBeNull()
    ask.mockResolvedValueOnce({})
    expect(await api.agents.creationStatus!(id)).toBeNull()
    ask.mockRejectedValueOnce(new Error('Core unavailable'))
    expect(await api.agents.creationStatus!(id)).toBeNull()
    expect(await processCoreApi('/data', 'worker').agents.creationStatus!(id)).toBeNull()
  })
  it('retains the observed runtime profile and treats absent or malformed older projections as unknown', () => {
    const api = processCoreApi('/data', 'worker')
    const selectedModel = 'runtime-v1:a1:claude:opus@high'
    expect(api.agents.runtimeProfile({ ...agent('a1'), selectedModel } as ShownAgent)).toBe(selectedModel)
    for (const value of [undefined, null, 42, {}]) {
      expect(api.agents.runtimeProfile({ ...agent('a1'), selectedModel: value } as ShownAgent)).toBeNull()
    }
  })
  it('reads only an exact validated usage snapshot, without reading a transcript', async () => {
    const target = usageTarget(agent('a', { transcriptPath: '/fixture/session', registeredAt: 1 }))
    expect(await processCoreApi('/data', 'projects').usage!(target)).toBeNull()
    const ask = vi.fn(async () => ({ target, value: { totalTokens: 4, updatedAt: '2026-10-01T00:00:00Z' } }))
    const api = processCoreApi('/data', 'projects', { ask })
    expect(await api.usage!(target)).toMatchObject({ totalTokens: 4 })
    for (const answer of [{}, { target: { ...target, sessionId: 'other' }, value: null }, { target, value: { totalTokens: -1 } }]) {
      ask.mockResolvedValueOnce(answer as never)
      expect(await api.usage!(target)).toBeNull()
    }
    ask.mockRejectedValueOnce(new Error('offline'))
    expect(await api.usage!(target)).toBeNull()
  })
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
    expect(await api.transcripts.lastTurn('s1')).toBeNull()
    await expect(api.account.mintGridName()).resolves.toBeNull()
    // A service holds no credential, and says which one asked.
    await expect(api.account.accessToken()).rejects.toThrow('usage holds no credential')
    await expect(api.account.privateGridName()).resolves.toBeNull()
    expect(api.account.machineName()).toBeNull()
    api.clients.viewerChanged('a1')
    expect(api.clients.viewerFrame('c1', 'viewer_data', {})).toBe(false)
    api.clients.gridNamed('grid')
    api.clients.gridModelsChanged()
    api.clients.dshInstallStatus({ phase: 'clone' })
    // What only the devices ask (services/devices.ts): nothing, from every other service.
    expect([api.machine.id(), api.machine.computerId(), api.machine.name()]).toEqual(['', '', ''])
    await expect(api.agents.activityText('a1')).resolves.toBeNull()
    await expect(UNASKED.activity()).resolves.toEqual({})
    // With no link to the core it reports no activity; with one, what the core answered, and only valid states.
    await expect(api.agents.activity(['a1'])).resolves.toEqual({})
    const ask = vi.fn(async (_query: string, _payload: Record<string, unknown>): Promise<Record<string, unknown>> => ({ activity: { a1: 'working', a2: 'idle', a3: 'unknown', a4: 'bogus', a5: 7 } }))
    const linked = processCoreApi('/data', 'messages', { ask })
    await expect(linked.agents.activity(['a1', 'a2'])).resolves.toEqual({ a1: 'working', a2: 'idle', a3: 'unknown' })
    expect(ask).toHaveBeenCalledWith('activity', { agentIds: ['a1', 'a2'] })
    for (const answer of [{}, { activity: 'x' }, { activity: null }]) {
      ask.mockResolvedValueOnce(answer)
      await expect(linked.agents.activity(['a1'])).resolves.toEqual({})
    }
    ask.mockRejectedValueOnce(new Error('offline'))
    await expect(linked.agents.activity(['a1'])).resolves.toEqual({})
    // The one-line summaries: none without a link; with one, the core's strings under the agents asked about. An older core
    // answers `activity` without `summaries`, and that reads as none.
    await expect(UNASKED.summaries()).resolves.toEqual({})
    await expect(api.agents.summaries(['a1'])).resolves.toEqual({})
    const askSummaries = vi.fn(async (_query: string, _payload: Record<string, unknown>): Promise<Record<string, unknown>> => ({ activity: {}, summaries: { a1: 'Fix the login', a2: 7, a3: '' } }))
    const withSummaries = processCoreApi('/data', 'messages', { ask: askSummaries })
    await expect(withSummaries.agents.summaries(['a1', 'a2'])).resolves.toEqual({ a1: 'Fix the login' })
    expect(askSummaries).toHaveBeenCalledWith('activity', { agentIds: ['a1', 'a2'], summaries: true })
    for (const answer of [{ activity: {} }, { summaries: 'x' }, { summaries: null }]) {
      askSummaries.mockResolvedValueOnce(answer)
      await expect(withSummaries.agents.summaries(['a1'])).resolves.toEqual({})
    }
    askSummaries.mockRejectedValueOnce(new Error('offline'))
    await expect(withSummaries.agents.summaries(['a1'])).resolves.toEqual({})
    expect(api.account.signedIn()).toBe(false)
    expect(api.account.environment()).toBe('')
    await expect(api.account.machines()).resolves.toEqual({ status: 503, body: { error: 'SERVICE_UNAVAILABLE' } })
    // What the devices' process starts from before it asks the core for the list.
    await expect(UNASKED.account.machines()).resolves.toEqual({ status: 503, body: {} })
    api.clients.sendLocal({ type: 'dial_focus', payload: {} })
    expect(api.clients.sendToWindow('w1', { type: 'dial_form', payload: {} })).toBe(false)
    expect(api.clients.hasWindow()).toBe(false)
    api.clients.devicesChanged({})
    api.clients.dialWatching(true)
    // What only the recaps ask (services/recaps.ts): nothing, from every other service.
    api.clients.turnCard({ type: 'commander_event', agentId: 'a', dbSessionId: 's', payload: {} })
    api.clients.turnSummary({ type: 'turn_summary' })
    expect(await api.transcripts.lastTurn('s1')).toBeNull()
    // With no way to ask the core, it acts on nothing: no agent made, no turn, no window told.
    await expect(api.agents.create({ engine: 'claude', cwd: '/w', dsh: null, prompt: 'p', name: 'n', bypassPermission: false }))
      .resolves.toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
    expect(api.agents.dsh(agent('a1'))).toBeNull()
    api.clients.windows({ type: 'orchestrator_changed', payload: {} })
    api.turns.deliver('a1', 'text', 'd1')
    expect(api.turns.cancelDelivery('d1')).toBe(false)
    expect(api.daemon).toMatchObject({ command: 'harness', port: 0 })
    expect(api.daemon.machineId()).toBe('')
    expect(await api.account.backend('GET', '/api/agent-messages')).toEqual({ status: 503, body: { error: 'SERVICE_UNAVAILABLE' } })
    // With no core to ask, no account either.
    expect(await api.account.identity()).toBeNull()
    expect(api.account.onNotice(() => {})()).toBeUndefined()
  })

  it('reads the account\'s backend through the core for an experiment, and hears the notices it is told', async () => {
    let answer: Record<string, unknown> | Error = { status: 200, body: { success: true } }
    const ask = vi.fn(async () => { if (answer instanceof Error) throw answer; return answer })
    const listeners: Array<(notice: never) => void> = []
    const api = processCoreApi('/data', 'messages', { ask, onNotice: (listener) => { listeners.push(listener as never); return () => {} } })
    expect(await api.account.backend('PATCH', '/api/agent-messages/tabs/t1', { enabled: true })).toEqual({ status: 200, body: { success: true } })
    expect(ask).toHaveBeenLastCalledWith('backend', { method: 'PATCH', path: '/api/agent-messages/tabs/t1', body: { enabled: true } })
    await api.account.backend('GET', '/api/agent-messages')
    expect(ask).toHaveBeenLastCalledWith('backend', { method: 'GET', path: '/api/agent-messages' })
    answer = { error: 'INVALID_REQUEST' }
    expect(await api.account.backend('GET', '/nope')).toEqual({ status: 502, body: { error: 'INVALID_REQUEST' } })
    answer = { status: 200 }
    expect(await api.account.backend('GET', '/api/x')).toEqual({ status: 502, body: { error: 'BACKEND_UNREACHABLE' } })
    answer = new Error('the link went')
    expect(await api.account.backend('GET', '/api/x')).toEqual({ status: 503, body: { error: 'SERVICE_UNAVAILABLE' } })
    api.account.onNotice(() => {})
    expect(listeners).toHaveLength(1)
  })

  it('lists the account\'s machines the way it reads the backend, and no more than that read may ask', async () => {
    const ask = vi.fn(async (_query: string, _payload: Record<string, unknown>): Promise<Record<string, unknown>> => ({ status: 200, body: { data: { machines: [{ machineId: 'm1', name: 'remote-1' }] } } }))
    const api = processCoreApi('/data', 'superTabs', { ask })
    expect(await api.account.machines()).toEqual({ status: 200, body: { data: { machines: [{ machineId: 'm1', name: 'remote-1' }] } } })
    expect(ask).toHaveBeenCalledOnce()
    expect(ask).toHaveBeenCalledWith('backend', { method: 'GET', path: '/api/machines' })
    // A service the core does not answer for (it is not an experiment) gets the core's refusal, not a list.
    ask.mockResolvedValueOnce({ error: 'NOT_AN_EXPERIMENT' })
    expect(await processCoreApi('/data', 'store', { ask }).account.machines()).toEqual({ status: 502, body: { error: 'NOT_AN_EXPERIMENT' } })
  })

  it('gives the cloud agents their doors only with a core to ask, and never waits on or throws from them', async () => {
    expect(processCoreApi('/data', 'cloud').cloud).toBeUndefined()
    const ask = vi.fn(async (_query: string): Promise<Record<string, unknown>> => { throw new Error('gone') })
    const doors = processCoreApi('/data', 'cloud', { ask }).cloud!
    doors.publish([])
    doors.ask('cloud_1', 'cloud_q_1', { text: 'Which?', choices: [] })
    doors.unask('cloud_1', 'cloud_q_1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ask.mock.calls.map(([query]) => query)).toEqual(['cloud_publish', 'cloud_ask', 'cloud_unask'])
  })

  it('gives the Super Tab service its door only with a core to ask, and never waits on or throws from it', async () => {
    expect(processCoreApi('/data', 'superTabs').superTabs).toBeUndefined()
    const ask = vi.fn(async (_query: string, _payload: Record<string, unknown>): Promise<Record<string, unknown>> => { throw new Error('gone') })
    processCoreApi('/data', 'superTabs', { ask }).superTabs!.attention([])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ask).toHaveBeenCalledWith('super_tab_attention', { items: [] })
  })

  it('tells the core the Swarm cards and recaps as two queries, never waiting on or throwing from them', async () => {
    const ask = vi.fn(async (_query: string, _payload: Record<string, unknown>): Promise<Record<string, unknown>> => { throw new Error('gone') })
    const doors = processCoreApi('/data', 'superTabs', { ask }).superTabs!
    const recap = { tabId: 't1', leadId: 'l1', text: 'Shipped', at: 1, none: false }
    doors.cards([])
    doors.cardRecap(recap)
    doors.shareObservers()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ask).toHaveBeenCalledWith('super_tab_cards', { items: [] })
    expect(ask).toHaveBeenCalledWith('super_tab_card_recap', { recap })
    expect(ask).toHaveBeenCalledWith('super_tab_observers', {})
  })

  it('asks the core to read and type a member\'s terminal, and answers plainly when the core cannot be asked', async () => {
    const ask = vi.fn(async (query: string, _payload: Record<string, unknown>): Promise<Record<string, unknown>> =>
      query === 'super_tab_screen' ? { ok: true, text: 'Allow?', hold: 'permission_open' } : { ok: true })
    const doors = processCoreApi('/data', 'superTabs', { ask }).superTabs!
    expect(await doors.screen('h1', 20)).toEqual({ ok: true, text: 'Allow?', hold: 'permission_open' })
    expect(ask).toHaveBeenLastCalledWith('super_tab_screen', { agentId: 'h1', scrollback: 20 })
    expect(await doors.input('h1', 'yes', ['Enter'])).toEqual({ ok: true })
    expect(ask).toHaveBeenLastCalledWith('super_tab_input', { agentId: 'h1', text: 'yes', keys: ['Enter'] })
    ask.mockRejectedValue(new Error('gone'))
    expect(await doors.screen('h1', 0)).toEqual({ ok: false, error: 'This machine\'s daemon could not be asked. Try again in a moment.' })
    expect(await doors.input('h1', 'x', [])).toEqual({ ok: false, error: 'This machine\'s daemon could not be asked. Try again in a moment.' })
    ask.mockResolvedValue({ error: 'NOT_SUPER_TABS' })
    expect(await doors.input('h1', 'x', [])).toEqual({ ok: false, error: 'NOT_SUPER_TABS' })
    ask.mockResolvedValue({})
    expect(await doors.screen('h1', 0)).toEqual({ ok: false, error: 'The terminal could not be reached.' })
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
    // Only Agent Messages is given shared tabs' keys (services/messagesProcess.ts): an experiment holds none, asker or not.
    expect(api.account.tabKey).toBe(TAB_KEY_OFF)
    expect(api.account.tabRelay).toBe(TAB_RELAY_OFF)
    // The account signed in here, asked of the core (core/experimentQueries.ts `account`): Share derives its tabs'
    // observers for it. A core that cannot say, or says something else, answers none.
    expect(await api.account.identity()).toBeNull()
    expect(ask).toHaveBeenCalledWith('account', {})
    answers.account = { accountId: 'u-bob', email: 'bob@x.io', extra: 1 }
    expect(await api.account.identity()).toEqual({ accountId: 'u-bob', email: 'bob@x.io' })
    for (const odd of [{ accountId: '', email: 'bob@x.io' }, { accountId: 'u-bob', email: '' }, { accountId: 7, email: 'bob@x.io' }, { accountId: 'u-bob' }, { error: 'NOT_SHARING' }]) {
      answers.account = odd
      expect(await api.account.identity()).toBeNull()
    }
    answers.account = new Error('the link went')
    expect(await api.account.identity()).toBeNull()
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

it('asks for native stop evidence and treats an absent or failed link as unknown', async () => {
  const ask = vi.fn(async (): Promise<Record<string, unknown>> => ({ stopped: true }))
  const api = processCoreApi('/data', 'superTabs', { ask })
  expect(await api.agents.stopped!('a')).toBe(true)
  expect(ask).toHaveBeenLastCalledWith('stopped', { agentId: 'a' })
  ask.mockResolvedValueOnce({ stopped: false })
  expect(await api.agents.stopped!('a')).toBe(false)
  ask.mockRejectedValueOnce(new Error('offline'))
  expect(await api.agents.stopped!('a')).toBe(false)
  expect(await processCoreApi('/data', 'superTabs').agents.stopped!('a')).toBe(false)
})

it('asks whether an agent is gone and treats an absent or failed link as not gone', async () => {
  const ask = vi.fn(async (): Promise<Record<string, unknown>> => ({ gone: true }))
  const api = processCoreApi('/data', 'superTabs', { ask })
  expect(await api.agents.gone!('a')).toBe(true)
  expect(ask).toHaveBeenLastCalledWith('gone', { agentId: 'a' })
  ask.mockRejectedValueOnce(new Error('offline'))
  expect(await api.agents.gone!('a')).toBe(false)
  expect(await processCoreApi('/data', 'superTabs').agents.gone!('a')).toBe(false)
})

it('carries the exact native close identity through the service process and fails closed without the core', async () => {
  const request = { agentId: 'worker', creationId: 'super-original-creation', sessionId: 'native', createdAt: '2026-10-22T00:00:00.000Z' }
  const ask = vi.fn(async () => ({ closed: true as const }))
  expect(await processCoreApi('/data', 'superTabs', { ask }).agents.closeSwarm!(request)).toEqual({ closed: true })
  expect(ask).toHaveBeenCalledWith('close_swarm', request)
  ask.mockRejectedValueOnce(new Error('Gone'))
  expect(await processCoreApi('/data', 'superTabs', { ask }).agents.closeSwarm!(request)).toEqual({ error: 'SERVICE_UNAVAILABLE' })
  expect(await processCoreApi('/data', 'superTabs').agents.closeSwarm!(request)).toEqual({ error: 'SERVICE_UNAVAILABLE' })
})

it('asks the core to reopen a Lead or close a member, and fails closed without it', async () => {
  const ask = vi.fn(async (query: string): Promise<Record<string, unknown>> => query === 'keep_lead_alive' ? { ok: true } : { closed: true })
  const api = processCoreApi('/data', 'superTabs', { ask })
  expect(await api.agents.keepLeadAlive!('lead')).toEqual({ ok: true })
  expect(ask).toHaveBeenLastCalledWith('keep_lead_alive', { agentId: 'lead' })
  expect(await api.agents.closeMember!('worker')).toEqual({ closed: true })
  expect(ask).toHaveBeenLastCalledWith('close_member', { agentId: 'worker' })
  expect(await api.agents.closeMember!('worker', 'super-0123456789abcdef')).toEqual({ closed: true })
  expect(ask).toHaveBeenLastCalledWith('close_member', { agentId: 'worker', creationId: 'super-0123456789abcdef' })
  ask.mockResolvedValueOnce({ ok: false, error: 'AGENT_BUSY', detail: 'busy' })
  expect(await api.agents.keepLeadAlive!('lead')).toEqual({ ok: false, error: 'AGENT_BUSY', detail: 'busy' })
  ask.mockResolvedValueOnce({ ok: false, error: 'NOT_A_LEAD' })
  expect(await api.agents.keepLeadAlive!('lead')).toEqual({ ok: false, error: 'NOT_A_LEAD' })
  ask.mockResolvedValueOnce({ ok: false })
  expect(await api.agents.keepLeadAlive!('lead')).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
  ask.mockResolvedValueOnce({ ok: 'yes' })
  expect(await api.agents.keepLeadAlive!('lead')).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
  ask.mockRejectedValueOnce(new Error('offline'))
  expect(await api.agents.keepLeadAlive!('lead')).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
  ask.mockRejectedValueOnce(new Error('offline'))
  expect(await api.agents.closeMember!('worker')).toEqual({ error: 'SERVICE_UNAVAILABLE' })
  const alone = processCoreApi('/data', 'superTabs')
  expect(await alone.agents.keepLeadAlive!('lead')).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
  expect(await alone.agents.closeMember!('worker')).toEqual({ error: 'SERVICE_UNAVAILABLE' })
})
