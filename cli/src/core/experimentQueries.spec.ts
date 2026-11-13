import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { processCoreApi } from '../services/processCoreApi.js'
import { EXPERIMENTS, EXPERIMENT_BACKEND_ROUTES, experimentBackendAllowed } from './api.js'
import { answerExperimentQuery, answerDaemonQuery, createForExperiment, creationForExperiment, createRouteRefusals } from './experimentQueries.js'

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
  it('answers an agent\'s turn through the real process path, to the Super Tab service alone', async () => {
    const activity = vi.fn(async () => ({ harness: 'working' as const }))
    const core = fakeCore({ agents: { activity } } as never)
    const both = new Set(['superTabs', 'cloud'])
    const api = (service: string) => processCoreApi('/data', service, { ask: async (query: string, payload: Record<string, unknown>) => {
      const answer = await answerExperimentQuery(core, both, service, query, payload)
      if (!answer) throw new Error('UNKNOWN_QUERY')
      return answer
    } })
    expect(await api('superTabs').agents.activity(['harness'])).toEqual({ harness: 'working' })
    expect(activity).toHaveBeenCalledWith(['harness'])
    activity.mockClear()
    expect(await api('cloud').agents.activity(['harness'])).toEqual({})
    expect(activity).not.toHaveBeenCalled()
  })

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

  // The native-turn record went with #3901: nothing in the core answers for it, and its query is no longer one an experiment
  // may ask.
  it('answers no native-turn query', async () => {
    expect(await answerExperimentQuery(fakeCore(), experiments, 'orchestrator', 'native_turns', { agentId: 'native' })).toBeNull()
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

  // The audit of 2026-11-12 (docs/design/2026-11-12-core-audit.md, Security 2): every `/api/` path was signed for all six
  // experiments, so the Swarm's process, which reads GitHub text and other accounts' messages, could call any route of the
  // account's backend as the account: its device keys, its connected services' vault, its machines.
  it('signs an experiment\'s backend call only on a route its service declared, by method and whole path', async () => {
    const backend = vi.fn(async () => ({ status: 200, body: { success: true } }))
    const core = fakeCore({ account: { backend } })
    const all = new Set(Object.keys(EXPERIMENTS))
    const said: string[] = []
    const refusals = createRouteRefusals((line) => said.push(line))
    const ask = (service: string, method: unknown, path: unknown) => answerExperimentQuery(core, all, service, 'backend', { method, path, body: { a: 1 } }, refusals)
    const share = '0b0e1c2d-3f4a-4b5c-8d6e-7f8091a2b3c4'
    const declared: Array<[string, string, string]> = [
      // The Swarm: its own API, by GET and POST, and whether the server takes the sign-in again (superTabs/host.ts).
      ['superTabs', 'GET', '/api/super-tabs'], ['superTabs', 'GET', '/api/super-tabs/list?after=abc'], ['superTabs', 'GET', '/api/super-tabs/grids'],
      ['superTabs', 'POST', '/api/super-tabs/6730a1b2c3d4e5f601234567/commands'], ['superTabs', 'POST', '/api/super-tabs/hosts/machine-1/starts/t1/s1'],
      ['superTabs', 'GET', '/api/super-tabs/t1/conversations/c1/messages?asAgentId=a1&before=12&beforeId=m1&thread=th1'],
      ['superTabs', 'GET', '/api/super-tabs/t1/conversations/c1/messages/m1/attachments/f1?asAgentId=a1'],
      ['superTabs', 'GET', '/api/super-tabs/t1/github-comments?repository=owner%2Frepo&ids=1,2&asAgentId=pm'],
      ['superTabs', 'GET', '/api/super-tabs/hosts/machine-1/changes?cursor=2026-11-13T01:02:03.000Z:42'], ['superTabs', 'GET', '/api/auth/me'],
      // What a Swarm process of a build before 0.5.84 still reads, until 2026-12-13 (core/api.ts).
      ['superTabs', 'GET', '/api/machines'],
      // Share: a grant's and a link's publication and removal. The router: Jev's hosted decision.
      ['sharing', 'PUT', `/api/harness-shares/${share}`], ['sharing', 'DELETE', `/api/harness-shares/${share}`],
      ['sharing', 'PUT', `/api/harness-links/${share}`], ['sharing', 'DELETE', `/api/harness-links/${share}`],
      ['router', 'POST', '/api/route/jev'],
    ]
    for (const [service, method, path] of declared) {
      expect(await ask(service, method, path), `${service} ${method} ${path}`).toEqual({ status: 200, body: { success: true } })
      expect(backend).toHaveBeenLastCalledWith(method, path, { a: 1 })
    }
    const refused: Array<[string, unknown, unknown]> = [
      // Another part of the account's backend, whoever asks.
      ['superTabs', 'GET', '/api/device-keys'], ['superTabs', 'GET', '/api/connector-vault'], ['superTabs', 'DELETE', '/api/machines/m1'],
      ['superTabs', 'PUT', '/api/machines/m1/share'], ['superTabs', 'GET', '/api/machines?all=1'], ['sharing', 'GET', '/api/machines'],
      ['sharing', 'GET', '/api/auth/me'], ['router', 'POST', '/api/route/agents'],
      ['orchestrator', 'PATCH', '/api/agent-messages/tabs/t1'], ['memory', 'GET', '/api/auth/me'], ['cloud', 'POST', '/api/super-tabs/t1/commands'],
      // A method its service never uses there.
      ['superTabs', 'DELETE', '/api/super-tabs/t1'], ['superTabs', 'PUT', '/api/super-tabs/t1/commands'], ['superTabs', 'POST', '/api/auth/me'],
      ['sharing', 'GET', `/api/harness-shares/${share}`], ['sharing', 'POST', `/api/harness-links/${share}`], ['router', 'GET', '/api/route/jev'],
      // A path that climbs out of its API, or is not whole segments of it.
      ['superTabs', 'GET', '/api/super-tabs/../device-keys'], ['superTabs', 'GET', '/api/super-tabs/t1/../../device-keys'],
      ['superTabs', 'GET', '/api/super-tabs/%2e%2e/device-keys'], ['superTabs', 'GET', '/api/super-tabs/t1%2F..%2F..%2Fdevice-keys'],
      ['superTabs', 'GET', '/api/super-tabs/a.b'], ['superTabs', 'GET', '/api/super-tabs//list'], ['superTabs', 'GET', '/api/super-tabs/'],
      ['superTabs', 'GET', '/api/super-tabsx'], ['superTabs', 'GET', '/api/super-tabs/list#x'], ['superTabs', 'GET', '/api/super-tabs/list?a=b c'],
      ['superTabs', 'GET', '/api/super-tabs/list?a=b#c'], ['superTabs', 'GET', '/api/super-tabs/list\n'], ['superTabs', 'GET', '/api/super-tabs\\..\\device-keys'],
      ['superTabs', 'GET', 'https://evil.example/api/super-tabs/list'],
      ['superTabs', 'GET', '/api/auth/me?x=1'], ['superTabs', 'GET', '/api/auth/me/x'],
      ['sharing', 'PUT', '/api/harness-shares/not-a-share'], ['sharing', 'PUT', `/api/harness-shares/${share}/x`], ['sharing', 'PUT', `/api/harness-shares/${share}?x=1`],
      ['sharing', 'PUT', '/api/harness-shares/../super-tabs'], ['router', 'POST', '/api/route/jev/x'], ['router', 'POST', '/api/route/jev?x=1'],
      // Not a call at all.
      ['superTabs', 'TRACE', '/api/super-tabs/list'], ['superTabs', 'GET', undefined], ['superTabs', undefined, '/api/super-tabs/list'], ['superTabs', 'GET', 7],
    ]
    backend.mockClear()
    for (const [service, method, path] of refused) expect(await ask(service, method, path), `${service} ${String(method)} ${String(path)}`).toEqual({ error: 'ROUTE_NOT_DECLARED' })
    expect(backend).not.toHaveBeenCalled()
    // Each is said in the core's log: its process hears only that the call failed.
    expect(said[0]).toBe('[services] superTabs asked for a backend route which it has not declared, and was refused: GET /api/device-keys (core/api.ts)')
    // A call that sends no body is made with none. And with no refusals handed in, the core's own are used.
    await answerExperimentQuery(core, all, 'superTabs', 'backend', { method: 'POST', path: '/api/super-tabs/hosts/machine-1/terminal' })
    expect(backend).toHaveBeenLastCalledWith('POST', '/api/super-tabs/hosts/machine-1/terminal', undefined)
  })

  it('says a refused route once for each service, method and shape, without its query, and stops at a bound for each service', () => {
    const lines: string[] = []
    const refuse = createRouteRefusals((line) => lines.push(line))
    const never = () => false
    expect(refuse('superTabs', 'GET', '/api/device-keys?since=1&self=m1', never)).toEqual({ error: 'ROUTE_NOT_DECLARED' })
    expect(refuse('superTabs', 'GET', '/api/device-keys?since=2', never)).toEqual({ error: 'ROUTE_NOT_DECLARED' })
    expect(lines).toEqual(['[services] superTabs asked for a backend route which it has not declared, and was refused: GET /api/device-keys (core/api.ts)'])
    // An id in a path is not a new route: a loop over a tab's deliveries is one line, not one for each.
    for (const id of ['d1', 'd2', '6730a1b2c3d4e5f601234567']) refuse('superTabs', 'DELETE', `/api/super-tabs/t1/agents/a1/deliveries/${id}`, never)
    expect(lines.slice(1)).toEqual(['[services] superTabs asked for a backend route which it has not declared, and was refused: DELETE /api/super-tabs/:id/agents/:id/deliveries/:id (core/api.ts)'])
    // A declared path refused for its query says so: the path is not what to look for.
    refuse('superTabs', 'GET', '/api/super-tabs/list?after=a b', (method, path) => method === 'GET' && path === '/api/super-tabs/list')
    expect(lines[2]).toBe('[services] superTabs asked for a backend route with a query that holds a space, a # or a character that is not printable, and was refused: GET /api/super-tabs/list (core/api.ts)')
    // What is not text, or not printable, is said as it can be, and never at length.
    refuse('superTabs', undefined, 7, never)
    refuse('superTabs', 'GET', `/api/x\n[services] forged line\u0007 ${'y'.repeat(400)}`, never)
    expect(lines[3]).toBe('[services] superTabs asked for a backend route which it has not declared, and was refused: undefine :id (core/api.ts)')
    expect(lines[4]).toMatch(/refused: GET \/api\/x\?\[services\] forged line\? y+ \(core\/api\.ts\)$/)
    expect(lines[4]!.length).toBeLessThan(300)
    // A process that asks for route after route fills no log: sixteen of a service's are said, then that it stops.
    for (let i = 0; i < 200; i++) refuse('superTabs', 'GET', `/api/other/${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${'abcdefghijklmnopqrstuvwxyz'[Math.floor(i / 26)]}`, never)
    expect(lines).toHaveLength(17)
    expect(lines[16]).toBe('[services] superTabs: further refused backend routes are not said')
    // Another service's are still said.
    refuse('sharing', 'GET', '/api/device-keys', never)
    expect(lines[17]).toBe('[services] sharing asked for a backend route which it has not declared, and was refused: GET /api/device-keys (core/api.ts)')
  })

  it('has every experiment declare its backend routes, if only that it calls none', () => {
    expect(Object.keys(EXPERIMENT_BACKEND_ROUTES).sort()).toEqual(Object.keys(EXPERIMENTS).sort())
    for (const service of ['orchestrator', 'memory', 'cloud']) expect(EXPERIMENT_BACKEND_ROUTES[service]).toEqual([])
    expect(experimentBackendAllowed('messages', 'GET', '/api/agent-messages')).toBe(false)
  })

  // A route a service starts to call and does not declare fails here, not in a person's Swarm: every backend path written
  // in an experiment's own code is one its service may call, by the method written beside it when one is. What a path is
  // built with stands in as `x`, or as a share's id.
  it('holds every backend path written in an experiment\'s code to the routes its service declared', () => {
    const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
    // Named with `/` on every platform: the lists below are matched as written.
    const sources = (dir: string): string[] => readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
      ? sources(`${dir}/${entry.name}`) : /\.ts$/.test(entry.name) && !/\.(spec|test|e2e)\.ts$/.test(entry.name) ? [`${dir}/${entry.name}`] : [])
    const OWN: Record<string, string[]> = {
      superTabs: [...sources('superTabs'), ...sources('lib').filter((file) => /^lib\/swarm[^/]*\.ts$/.test(file)), 'services/superTabs.ts', 'services/superTabsProcess.ts'],
      sharing: [...sources('sharing'), 'services/sharing.ts'],
      router: ['services/router.ts', ...sources('lib/jev')],
      orchestrator: [...sources('orchestrator'), 'services/orchestrator.ts'],
      memory: ['services/memory.ts'],
      cloud: [...sources('cloud'), 'services/cloud.ts'],
    }
    // Written there and not a call through the core's sign-in, each with what it is.
    const NOT_A_CALL: Record<string, string> = {
      'superTabs/machines.ts /api/': 'the check a saved start\'s path passes before it is read again: the core holds it to the Swarm\'s API',
    }
    const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
    /** The method written beside a path, when it is: `backend(core, 'POST', path)`, `publish(revoked ? 'DELETE' : 'PUT', path)`. */
    const methodsBeside = (node: ts.Node): string[] => {
      const call = node.parent
      const before = ts.isCallExpression(call) ? call.arguments[call.arguments.indexOf(node as ts.Expression) - 1] : undefined
      const named = (part: ts.Node | undefined): string[] => part && ts.isStringLiteralLike(part) && METHODS.includes(part.text) ? [part.text] : []
      return before && ts.isConditionalExpression(before) ? [...named(before.whenTrue), ...named(before.whenFalse)] : named(before)
    }
    const written: string[] = [], wrong: string[] = []
    for (const [service, files] of Object.entries(OWN)) {
      for (const file of files) {
        const source = ts.createSourceFile(file, readFileSync(join(SRC, ...file.split('/')), 'utf8'), ts.ScriptTarget.Latest, true)
        const visit = (node: ts.Node): void => {
          const built = (id: string): string | null => ts.isStringLiteralLike(node) ? node.text
            : ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map((span) => `${id}${span.literal.text}`).join('') : null
          const path = built('x')
          if (path?.startsWith('/api/')) {
            const methods = methodsBeside(node)
            written.push(`${file} ${methods.join('|')}${methods.length ? ' ' : ''}${path}`)
            const routes = EXPERIMENT_BACKEND_ROUTES[service]!
            const declared = (method: string | null) => ['x', '0b0e1c2d-3f4a-4b5c-8d6e-7f8091a2b3c4'].some((id) => routes.some((route) => (method === null || route.method === method) && route.path.test(built(id)!)))
            const allowed = methods.length ? methods.every(declared) : declared(null)
            if (!allowed && !NOT_A_CALL[`${file} ${path}`]) wrong.push(`${service}: ${file} ${methods.join('|')} ${path}`)
          }
          ts.forEachChild(node, visit)
        }
        visit(source)
      }
    }
    expect(wrong, 'Declare the route in EXPERIMENT_BACKEND_ROUTES (core/api.ts), in the pull request that says why the service calls it.').toEqual([])
    for (const exception of Object.keys(NOT_A_CALL)) expect(written, `${exception} is no longer written: remove it`).toContain(exception)
    // It finds what it checks, with the method where one is written: the Swarm's commands, Share's grants, the router's one call.
    expect(written).toContain('superTabs/host.ts POST /api/super-tabs/x/stopped')
    expect(written).toContain('sharing/owner.ts DELETE|PUT /api/harness-shares/x')
    expect(written).toContain('lib/jev/jevClient.ts /api/route/jev')
    expect(written.filter((path) => /^superTabs\/.* (GET|POST) \/api\/super-tabs\//.test(path)).length).toBeGreaterThan(20)
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

  it('tells Share and the Swarm which account is signed in here, and no other experiment', async () => {
    const identity = vi.fn(async (): Promise<{ accountId: string; email: string } | null> => ({ accountId: 'u-bob', email: 'bob@x.io' }))
    const core = fakeCore({ account: { identity } })
    const withShare = new Set(['orchestrator', 'sharing'])
    expect(await answerExperimentQuery(core, withShare, 'sharing', 'account', {})).toEqual({ accountId: 'u-bob', email: 'bob@x.io' })
    identity.mockResolvedValueOnce(null)
    expect(await answerExperimentQuery(core, withShare, 'sharing', 'account', {})).toEqual({ error: 'ACCOUNT_UNAVAILABLE' })
    // And the Swarm, whose round dial cards show the reader's own Buddy (Diego's dial, 2026-10-29: "No Buddy here yet"
    // with a Buddy, since the Swarm's process was answered nothing here).
    const withSwarm = new Set(['superTabs'])
    expect(await answerExperimentQuery(core, withSwarm, 'superTabs', 'account', {})).toEqual({ accountId: 'u-bob', email: 'bob@x.io' })
    // Any other service's `account` is its own link's to answer: models asks it for the grid name.
    expect(await answerExperimentQuery(core, withShare, 'orchestrator', 'account', {})).toBeNull()
    expect(await answerExperimentQuery(core, withShare, 'models', 'account', {})).toBeNull()
    expect(identity).toHaveBeenCalledTimes(3)
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

it('asks the core about the agents it is given, keeping only the first 64 ids that are strings, to the Swarm service alone', async () => {
  const activity = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map(id => [id, 'working' as const])))
  const core = fakeCore({ agents: { activity } } as never)
  const allowed = new Set(['superTabs', 'orchestrator'])
  expect(await answerExperimentQuery(core, allowed, 'superTabs', 'activity', { agentIds: ['a', 4, null, 'b'] })).toEqual({ activity: { a: 'working', b: 'working' } })
  expect(activity).toHaveBeenLastCalledWith(['a', 'b'])
  const many = Array.from({ length: 70 }, (_, i) => `agent-${i}`)
  await answerExperimentQuery(core, allowed, 'superTabs', 'activity', { agentIds: many })
  expect(activity).toHaveBeenLastCalledWith(many.slice(0, 64))
  // Without a list of ids, the core is asked about none rather than failing.
  for (const payload of [{}, { agentIds: 'a' }, { agentIds: { 0: 'a' } }]) {
    expect(await answerExperimentQuery(core, allowed, 'superTabs', 'activity', payload)).toEqual({ activity: {} })
    expect(activity).toHaveBeenLastCalledWith([])
  }
  activity.mockClear()
  expect(await answerExperimentQuery(core, allowed, 'orchestrator', 'activity', { agentIds: ['a'] })).toEqual({ error: 'NOT_SUPER_TABS' })
  expect(activity).not.toHaveBeenCalled()
})

// The Swarm host posts the answer of the turn that ended into its agent's person's chat (superTabs/agentReplies.ts); in its own
// process it asks the core for the answer of the turn whose prompt its end carried.
// A Swarm process of the release before (0.5.82) asks the last turn of a session of a core of this one: kept until 2026-12-10.
it('still gives the Swarm service of the release before the last turn of a session, as the core reads it, and no other service', async () => {
  const turn = { userMessage: 'Ship it.', assistantText: 'Shipped.' }
  const lastTurn = vi.fn(async (sessionId: string) => sessionId === 'session-1' ? turn : null)
  const core = fakeCore({ transcripts: { lastTurn } })
  const allowed = new Set(['superTabs', 'orchestrator'])
  expect(await answerExperimentQuery(core, allowed, 'superTabs', 'last_turn', { sessionId: 'session-1' })).toEqual({ turn })
  expect(await answerExperimentQuery(core, allowed, 'superTabs', 'last_turn', { sessionId: 'no-such-session' })).toEqual({ turn: null })
  for (const sessionId of ['', 4, null, undefined, 'x'.repeat(257)]) {
    expect(await answerExperimentQuery(core, allowed, 'superTabs', 'last_turn', { sessionId })).toEqual({ error: 'INVALID_REQUEST' })
  }
  expect(lastTurn).toHaveBeenCalledTimes(2)
  lastTurn.mockClear()
  expect(await answerExperimentQuery(core, allowed, 'orchestrator', 'last_turn', { sessionId: 'session-1' })).toEqual({ error: 'NOT_SUPER_TABS' })
  expect(await answerExperimentQuery(core, allowed, 'gateway', 'last_turn', { sessionId: 'session-1' })).toEqual({ error: 'NOT_AN_EXPERIMENT' })
  expect(lastTurn).not.toHaveBeenCalled()
})

it('gives the Swarm service the answer of the turn an end names, as the core has it, and no other service', async () => {
  const PROMPT = 'a'.repeat(32)
  const ask = { sessionId: 'session-1', prompt: PROMPT, turnId: 7 }
  const answerOf = vi.fn(async (end: { sessionId: string; prompt: string; turnId: number }) => end.sessionId === 'session-1' && end.prompt === PROMPT && end.turnId === 7 ? 'Shipped.' : null)
  const core = fakeCore({ turns: { answerOf } } as never)
  const allowed = new Set(['superTabs', 'orchestrator'])
  expect(await answerExperimentQuery(core, allowed, 'superTabs', 'turn_answer', ask)).toEqual({ answer: 'Shipped.' })
  expect(await answerExperimentQuery(core, allowed, 'superTabs', 'turn_answer', { ...ask, sessionId: 'no-such-session' })).toEqual({ answer: null })
  expect(answerOf).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'no-such-session', prompt: PROMPT, turnId: 7 }))
  for (const payload of [{ ...ask, sessionId: undefined }, { ...ask, sessionId: 4 }, { ...ask, sessionId: 'x'.repeat(257) }, { ...ask, prompt: undefined },
    { ...ask, prompt: 'Ship it.' }, { ...ask, prompt: 'A'.repeat(32) }, { ...ask, prompt: `${PROMPT}0` }, { ...ask, prompt: null },
    { ...ask, turnId: undefined }, { ...ask, turnId: 0 }, { ...ask, turnId: -1 }, { ...ask, turnId: 1.5 }, { ...ask, turnId: '7' }, { ...ask, turnId: null }, { ...ask, turnId: 2 ** 53 }]) {
    expect(await answerExperimentQuery(core, allowed, 'superTabs', 'turn_answer', payload), JSON.stringify(payload)).toEqual({ error: 'INVALID_REQUEST' })
  }
  expect(answerOf).toHaveBeenCalledTimes(2)
  answerOf.mockClear()
  expect(await answerExperimentQuery(core, allowed, 'orchestrator', 'turn_answer', ask)).toEqual({ error: 'NOT_SUPER_TABS' })
  expect(await answerExperimentQuery(core, allowed, 'gateway', 'turn_answer', ask)).toEqual({ error: 'NOT_AN_EXPERIMENT' })
  expect(answerOf).not.toHaveBeenCalled()
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
    expect(answerDaemonQuery(core, 'machineAddons', 'daemon')).toEqual({ command: 'harness', port: 18473, machineId: 'm_account', autonomousEnv: 'prod' })
    // The experiments' check alone would refuse it: the reason the core asks this first (core/main.ts).
    expect(await answerExperimentQuery(core, experiments, 'machineAddons', 'daemon', {})).toEqual({ error: 'NOT_AN_EXPERIMENT' })
    expect(answerDaemonQuery(core, 'machineAddons', 'shown')).toBeNull()
    expect(answerDaemonQuery(core, 'wifi', 'daemon')).toBeNull()
  })

  it('is told to Hachi\'s service and the agent cleanup, which reach this daemon and the owner\'s other machines as a tool does', () => {
    const core = fakeCore({ daemon: { machineId: () => 'm_account' } as never })
    for (const service of ['hachi', 'agentCleanup']) expect(answerDaemonQuery(core, service, 'daemon')).toMatchObject({ port: 18473, machineId: 'm_account' })
  })
})

