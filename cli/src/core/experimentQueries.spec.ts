import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { answerExperimentQuery, answerMachineAddonsQuery, createForExperiment, creationForExperiment } from './experimentQueries.js'

const agent = (agentId: string) => ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: '/w' }) as RegisteredSession
const experiments = new Set(['orchestrator'])

describe('the cloud agents\' doors', () => {
  it('are the cloud service\'s alone, and carry its harnesses and questions to the core', async () => {
    const cloud = { publish: vi.fn(), ask: vi.fn(), unask: vi.fn() }
    const core = fakeCore({ cloud })
    const both = new Set(['orchestrator', 'cloud'])
    expect(await answerExperimentQuery(core, both, 'cloud', 'cloud_publish', { harnesses: [{ agentId: 'cloud_1' }] })).toEqual({})
    expect(cloud.publish).toHaveBeenLastCalledWith([{ agentId: 'cloud_1' }])
    await answerExperimentQuery(core, both, 'cloud', 'cloud_publish', { harnesses: 'x' })
    expect(cloud.publish).toHaveBeenLastCalledWith([])
    await answerExperimentQuery(core, both, 'cloud', 'cloud_ask', { agentId: 'cloud_1', questionId: 'cloud_q_1', requestId: 'the-link-s-own', question: { text: 'Which?', choices: [] } })
    expect(cloud.ask).toHaveBeenCalledWith('cloud_1', 'cloud_q_1', { text: 'Which?', choices: [] })
    await answerExperimentQuery(core, both, 'cloud', 'cloud_ask', {})
    expect(cloud.ask).toHaveBeenLastCalledWith('', '', {})
    await answerExperimentQuery(core, both, 'cloud', 'cloud_unask', { agentId: 'cloud_1', questionId: 'cloud_q_1' })
    expect(cloud.unask).toHaveBeenCalledWith('cloud_1', 'cloud_q_1')
    expect(await answerExperimentQuery(core, both, 'orchestrator', 'cloud_publish', {})).toEqual({ error: 'NOT_CLOUD' })
    expect(await answerExperimentQuery(fakeCore(), both, 'cloud', 'cloud_publish', {})).toEqual({ error: 'NOT_CLOUD' })
  })
})

describe('the Super Tab service\'s door', () => {
  it('is the Super Tab service\'s alone, and hands its members\' waits to the core whole', async () => {
    const superTabs = { attention: vi.fn(), cards: vi.fn(), cardRecap: vi.fn(), shareObservers: vi.fn(), screen: vi.fn(), input: vi.fn(), inputIfScreen: vi.fn() }
    const core = fakeCore({ superTabs })
    const both = new Set(['orchestrator', 'superTabs'])
    const item = { agentId: 'a1', requestId: 'supertab:x:blocked', superTab: 'Pilot', attention: 'stuck', text: 'Stuck: no key' }
    expect(await answerExperimentQuery(core, both, 'superTabs', 'super_tab_attention', { items: [item] })).toEqual({})
    expect(superTabs.attention).toHaveBeenLastCalledWith([item])
    await answerExperimentQuery(core, both, 'superTabs', 'super_tab_attention', { items: 'x' })
    expect(superTabs.attention).toHaveBeenLastCalledWith([])
    expect(await answerExperimentQuery(core, both, 'orchestrator', 'super_tab_attention', {})).toEqual({ error: 'NOT_SUPER_TABS' })
    expect(await answerExperimentQuery(fakeCore(), both, 'superTabs', 'super_tab_attention', {})).toEqual({ error: 'NOT_SUPER_TABS' })
  })

  it('hands it the Swarm cards and a Lead\'s recap the same way, to the Super Tab service alone', async () => {
    const superTabs = { attention: vi.fn(), cards: vi.fn(), cardRecap: vi.fn(), shareObservers: vi.fn(), screen: vi.fn(), input: vi.fn(), inputIfScreen: vi.fn() }
    const core = fakeCore({ superTabs })
    const both = new Set(['orchestrator', 'superTabs'])
    const recap = { tabId: 't1', leadId: 'l1', text: 'Shipped', at: 1, none: false }
    expect(await answerExperimentQuery(core, both, 'superTabs', 'super_tab_cards', { items: [{ id: 't1' }] })).toEqual({})
    expect(superTabs.cards).toHaveBeenLastCalledWith([{ id: 't1' }])
    await answerExperimentQuery(core, both, 'superTabs', 'super_tab_cards', { items: 'x' })
    expect(superTabs.cards).toHaveBeenLastCalledWith([])
    expect(await answerExperimentQuery(core, both, 'superTabs', 'super_tab_card_recap', { recap })).toEqual({})
    expect(superTabs.cardRecap).toHaveBeenLastCalledWith(recap)
    for (const query of ['super_tab_cards', 'super_tab_card_recap', 'super_tab_observers']) {
      expect(await answerExperimentQuery(core, both, 'orchestrator', query, {})).toEqual({ error: 'NOT_SUPER_TABS' })
      expect(await answerExperimentQuery(fakeCore(), both, 'superTabs', query, {})).toEqual({ error: 'NOT_SUPER_TABS' })
    }
  })

  it('asks for Share when a Swarm host here has members to show its agents to', async () => {
    const superTabs = { attention: vi.fn(), cards: vi.fn(), cardRecap: vi.fn(), shareObservers: vi.fn(), screen: vi.fn(), input: vi.fn(), inputIfScreen: vi.fn() }
    expect(await answerExperimentQuery(fakeCore({ superTabs }), new Set(['superTabs']), 'superTabs', 'super_tab_observers', {})).toEqual({})
    expect(superTabs.shareObservers).toHaveBeenCalledOnce()
  })
  it('reads and types a member\'s terminal for the Super Tab service alone, refusing what is not well formed', async () => {
    const superTabs = { attention: vi.fn(), cards: vi.fn(), cardRecap: vi.fn(), shareObservers: vi.fn(),
      screen: vi.fn(async () => ({ ok: true as const, text: 'Allow?', hold: null })), input: vi.fn(async () => ({ ok: true as const })), inputIfScreen: vi.fn(async () => ({ ok: true as const })) }
    const core = fakeCore({ superTabs }), both = new Set(['orchestrator', 'superTabs'])
    expect(await answerExperimentQuery(core, both, 'superTabs', 'super_tab_screen', { agentId: 'h1', scrollback: 40 })).toEqual({ ok: true, text: 'Allow?', hold: null })
    expect(superTabs.screen).toHaveBeenLastCalledWith('h1', 40)
    await answerExperimentQuery(core, both, 'superTabs', 'super_tab_screen', { agentId: 'h1' })
    expect(superTabs.screen).toHaveBeenLastCalledWith('h1', 0)
    expect(await answerExperimentQuery(core, both, 'superTabs', 'super_tab_input', { agentId: 'h1', text: 'yes', keys: ['Enter'] })).toEqual({ ok: true })
    expect(superTabs.input).toHaveBeenLastCalledWith('h1', 'yes', ['Enter'])
    await answerExperimentQuery(core, both, 'superTabs', 'super_tab_input', { agentId: 'h1', keys: ['1'] })
    expect(superTabs.input).toHaveBeenLastCalledWith('h1', '', ['1'])
    for (const [query, payload] of [['super_tab_screen', { agentId: 'bad id' }], ['super_tab_screen', { agentId: 'h1', scrollback: 'x' }],
      ['super_tab_input', { agentId: 'h1', text: 7 }], ['super_tab_input', { agentId: 'h1', keys: [1] }], ['super_tab_input', { agentId: 'h1', keys: 'Enter' }]] as const) {
      expect(await answerExperimentQuery(core, both, 'superTabs', query, payload)).toEqual({ ok: false, error: 'INVALID_REQUEST' })
    }
    expect(await answerExperimentQuery(core, both, 'superTabs', 'super_tab_input_if_screen', { agentId: 'h1', keys: ['Escape'], screen: 'Update available' })).toEqual({ ok: true })
    expect(superTabs.inputIfScreen).toHaveBeenLastCalledWith('h1', ['Escape'], 'Update available')
    for (const payload of [{ agentId: 'bad id', keys: ['Escape'], screen: 'x' }, { agentId: 'h1', keys: ['Escape'] }, { agentId: 'h1', keys: ['Escape'], screen: 7 },
      { agentId: 'h1', keys: [], screen: 'x' }, { agentId: 'h1', screen: 'x' }]) {
      expect(await answerExperimentQuery(core, both, 'superTabs', 'super_tab_input_if_screen', payload)).toEqual({ ok: false, error: 'INVALID_REQUEST' })
    }
    for (const query of ['super_tab_screen', 'super_tab_input', 'super_tab_input_if_screen']) {
      expect(await answerExperimentQuery(core, both, 'orchestrator', query, { agentId: 'h1' })).toEqual({ error: 'NOT_SUPER_TABS' })
      expect(await answerExperimentQuery(fakeCore(), both, 'superTabs', query, { agentId: 'h1' })).toEqual({ error: 'NOT_SUPER_TABS' })
    }
  })
})

describe('what an experiment in its own process may ask of the core', () => {
  it('reads exact creation observations without treating an unavailable provider as an absent launch', async () => {
    const id = 'creation-fixture-1234'
    const known = { creationId: id, state: 'cancelled' as const }
    const core = fakeCore({ agents: { creationStatus: async () => known } })
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'creation_status', { creationId: id })).toEqual({ observation: known })
    expect(await answerExperimentQuery(fakeCore(), experiments, 'orchestrator', 'creation_status', {})).toEqual({ observation: null })
    expect(await creationForExperiment(null, id)).toBeNull()
    const read = vi.fn(async (input, _asker, reply) => { reply({ ...input, state: 'created', agent: { id: 'native', private: 'not projected' } }) })
    expect(await creationForExperiment(read, 'invalid')).toBeNull()
    expect(read).not.toHaveBeenCalled()
    expect(await creationForExperiment(read, id)).toEqual({ creationId: id, state: 'created', agentId: 'native' })
    expect(await creationForExperiment(async () => {}, id)).toBeNull()
    expect(await creationForExperiment(async () => { throw new Error('Disk unavailable') }, id)).toBeNull()
    expect(await creationForExperiment(async (input, _asker, reply) => { reply({ ...input, state: 'cancelled' }) }, id)).toEqual(known)
    expect(await creationForExperiment(async (_, _asker, reply) => { reply({ creationId: 'other', state: 'cancelled' }) }, id)).toBeNull()
    expect(await creationForExperiment(async (input, _asker, reply) => { reply({ ...input, state: 'unavailable', createdAgentId: 'closed-native' }) }, id))
      .toEqual({ creationId: id, state: 'created', agentId: 'closed-native' })
    expect(await creationForExperiment(async (input, _asker, reply) => { reply({ ...input, state: 'unavailable' }) }, id)).toBeNull()
  })
  it('requires fresh native stop evidence, including when a core is older', async () => {
    const core = fakeCore({ agents: { stopped: async id => id === 'stopped' } })
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'stopped', { agentId: 'stopped' })).toEqual({ stopped: true })
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'stopped', { agentId: 'live' })).toEqual({ stopped: false })
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'stopped', {})).toEqual({ stopped: false })
    expect(await answerExperimentQuery(fakeCore(), experiments, 'orchestrator', 'stopped', { agentId: 'unknown' })).toEqual({ stopped: false })
  })

  it('says an agent is gone only on fresh evidence, and not for a core that cannot tell', async () => {
    const core = fakeCore({ agents: { gone: async id => id === 'closed' } })
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'gone', { agentId: 'closed' })).toEqual({ gone: true })
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'gone', { agentId: 'live' })).toEqual({ gone: false })
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'gone', {})).toEqual({ gone: false })
    expect(await answerExperimentQuery(fakeCore(), experiments, 'orchestrator', 'gone', { agentId: 'closed' })).toEqual({ gone: false })
  })

  it('bounds native observation queries and keeps an older core unavailable', async () => {
    const cursor = { epoch: 'fixture-observation-epoch', sequence: 0 }
    const page = { cursor, observations: [], gap: false }, nativeTurns = vi.fn(async () => page)
    const core = fakeCore({ transcripts: { nativeTurns } })
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'native_turns', { agentId: 'native' })).toEqual({ page })
    expect(nativeTurns).toHaveBeenLastCalledWith('native', undefined)
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'native_turns', { agentId: 'native', cursor })).toEqual({ page })
    expect(nativeTurns).toHaveBeenLastCalledWith('native', cursor)
    for (const payload of [{}, { agentId: 'native', cursor: null }, { agentId: 'native', cursor: { ...cursor, sequence: -1 } }]) {
      expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'native_turns', payload)).toEqual({ error: 'INVALID_REQUEST' })
    }
    expect(await answerExperimentQuery(fakeCore(), experiments, 'orchestrator', 'native_turns', { agentId: 'native' })).toEqual({ page: null })
  })

  it('shows the live agents as the apps are shown them: name, terminal and harness', async () => {
    const core = fakeCore({
      agents: {
        live: () => [agent('a1'), agent('a2')],
        displayName: (session) => `name of ${session.agentId}`,
        terminalAvailable: (agentId) => agentId === 'a1',
        runtimeProfile: session => session.agentId === 'a1' ? 'runtime-v1:a1:claude:opus@high' : null,
        dsh: (session) => (session.agentId === 'a1' ? { viewerUrl: 'http://127.0.0.1:1/' } as never : null),
      },
    })
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'shown', {})).toEqual({
      agents: [
        { ...agent('a1'), displayName: 'name of a1', terminalAvailable: true, selectedModel: 'runtime-v1:a1:claude:opus@high', dshContext: { viewerUrl: 'http://127.0.0.1:1/' } },
        { ...agent('a2'), displayName: 'name of a2', terminalAvailable: false, selectedModel: null, dshContext: null },
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
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'backend', { method: 'PATCH', path: '/api/agent-messages/tabs/t1', body: { enabled: true } }))
      .toEqual({ status: 200, body: { success: true, data: { tabs: [] } } })
    expect(backend).toHaveBeenCalledWith('PATCH', '/api/agent-messages/tabs/t1', { enabled: true })
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

  it('tells Share which account is signed in here, which its tabs\' observers are derived for, and no other experiment', async () => {
    const identity = vi.fn(async (): Promise<{ accountId: string; email: string } | null> => ({ accountId: 'u-bob', email: 'bob@x.io' }))
    const core = fakeCore({ account: { identity } })
    const withShare = new Set(['orchestrator', 'sharing'])
    expect(await answerExperimentQuery(core, withShare, 'sharing', 'account', {})).toEqual({ accountId: 'u-bob', email: 'bob@x.io' })
    identity.mockResolvedValueOnce(null)
    expect(await answerExperimentQuery(core, withShare, 'sharing', 'account', {})).toEqual({ error: 'ACCOUNT_UNAVAILABLE' })
    // Any other service's `account` is its own link's to answer: models asks it for the grid name.
    expect(await answerExperimentQuery(core, withShare, 'orchestrator', 'account', {})).toBeNull()
    expect(await answerExperimentQuery(core, withShare, 'models', 'account', {})).toBeNull()
    expect(identity).toHaveBeenCalledTimes(2)
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

it('exposes identity-bound close only to the Swarm service and validates its native identity', async () => {
  const closeSwarm = vi.fn(async () => ({ closed: true as const })), core = fakeCore({ agents: { closeSwarm } })
  const allowed = new Set(['superTabs', 'orchestrator'])
  const payload = { expiresAt: Date.now() + 120_000, agentId: 'worker', creationId: 'super-original-creation', sessionId: 'native', createdAt: '2026-10-22T00:00:00.000Z' }
  expect(await answerExperimentQuery(core, allowed, 'superTabs', 'close_swarm', payload)).toEqual({ closed: true })
  expect(closeSwarm).toHaveBeenCalledWith(payload)
  expect(await answerExperimentQuery(core, allowed, 'superTabs', 'close_swarm', { agentId: 'gone' })).toEqual({ closed: true })
  expect(closeSwarm).toHaveBeenLastCalledWith({ agentId: 'gone' })
  expect(await answerExperimentQuery(core, allowed, 'orchestrator', 'close_swarm', payload)).toEqual({ error: 'NOT_SUPER_TABS' })
  for (const invalid of [{ ...payload, agentId: '' }, { ...payload, sessionId: 1 }, { ...payload, createdAt: 'bad' }, { ...payload, creationId: 'bad' }, { ...payload, creationId: 4 }, { ...payload, createdAt: 4 }, { ...payload, expiresAt: 'later' }, { ...payload, expiresAt: Infinity }]) {
    expect(await answerExperimentQuery(core, allowed, 'superTabs', 'close_swarm', invalid)).toEqual({ error: 'INVALID_REQUEST' })
  }
  expect(await answerExperimentQuery(fakeCore(), allowed, 'superTabs', 'close_swarm', payload)).toEqual({ error: 'UNSUPPORTED' })
})

it('lets only the Swarm service reopen a Lead or close a member, by a valid agent id', async () => {
  const keepLeadAlive = vi.fn(async () => ({ ok: true as const })), closeMember = vi.fn(async () => ({ closed: true as const }))
  const core = fakeCore({ agents: { keepLeadAlive, closeMember } })
  const allowed = new Set(['superTabs', 'orchestrator'])
  expect(await answerExperimentQuery(core, allowed, 'superTabs', 'keep_lead_alive', { agentId: 'lead' })).toEqual({ ok: true })
  expect(keepLeadAlive).toHaveBeenCalledWith('lead')
  expect(await answerExperimentQuery(core, allowed, 'superTabs', 'close_member', { agentId: 'worker' })).toEqual({ closed: true })
  expect(closeMember).toHaveBeenCalledWith('worker', undefined)
  expect(await answerExperimentQuery(core, allowed, 'superTabs', 'close_member', { agentId: 'worker', creationId: 'super-0123456789abcdef' })).toEqual({ closed: true })
  expect(closeMember).toHaveBeenLastCalledWith('worker', 'super-0123456789abcdef')
  for (const creationId of ['short', 4]) expect(await answerExperimentQuery(core, allowed, 'superTabs', 'close_member', { agentId: 'worker', creationId })).toEqual({ error: 'INVALID_REQUEST' })
  for (const query of ['keep_lead_alive', 'close_member']) {
    expect(await answerExperimentQuery(core, allowed, 'orchestrator', query, { agentId: 'lead' })).toEqual({ error: 'NOT_SUPER_TABS' })
    for (const agentId of ['', '../x', 4]) expect(await answerExperimentQuery(core, allowed, 'superTabs', query, { agentId })).toEqual({ error: 'INVALID_REQUEST' })
  }
  expect(await answerExperimentQuery(fakeCore(), allowed, 'superTabs', 'keep_lead_alive', { agentId: 'lead' })).toEqual({ ok: false, error: 'UNSUPPORTED' })
  expect(await answerExperimentQuery(fakeCore(), allowed, 'superTabs', 'close_member', { agentId: 'worker' })).toEqual({ error: 'UNSUPPORTED' })
  expect(keepLeadAlive).toHaveBeenCalledTimes(1)
  expect(closeMember).toHaveBeenCalledTimes(2)
})

describe('what the add-ons of a device that is this machine ask of the core', () => {
  it('is told this daemon\'s address, though not an experiment, and nothing else of the experiments\' doors', async () => {
    const core = fakeCore({ daemon: { machineId: () => 'm_account' } as never })
    expect(answerMachineAddonsQuery(core, 'machineAddons', 'daemon')).toEqual({ command: 'harness', port: 18473, machineId: 'm_account', autonomousEnv: 'prod' })
    // The experiments' check alone would refuse it: the reason the core asks this first (core/main.ts).
    expect(await answerExperimentQuery(core, experiments, 'machineAddons', 'daemon', {})).toEqual({ error: 'NOT_AN_EXPERIMENT' })
    expect(answerMachineAddonsQuery(core, 'machineAddons', 'shown')).toBeNull()
    expect(answerMachineAddonsQuery(core, 'wifi', 'daemon')).toBeNull()
  })
})

