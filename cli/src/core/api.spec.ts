import { describe, expect, it, vi } from 'vitest'
import { projectDisplayName, type RegisteredSession } from '../lib/registry.js'
import { AGENT_BROWSER_REQUESTS, CLOUD_DOWN, CLOUD_FALLBACKS, CONNECTOR_SYNC_OFF, CONVERSATIONS_OFF, ACCOUNT_BACKEND_OFF, accountIdentity, AGENT_ACTIONS_OFF, AGENT_CLEANUP_FALLBACKS, createCoreApi, DAEMON_UNKNOWN, DELIVERIES_OFF, DEVICES_FALLBACKS, DEVICES_REQUESTS, emptyPorts, GATEWAY_REQUESTS, LANE_OFF, MACHINE_ADDON_REQUESTS, PAIR_WAIT_MS, SERVICE_HTTP_ROUTES, SERVICE_WS_FRAMES, WIFI_REQUESTS, LONG_ANSWERS, MODELS_OFF, STORE_OFF, MODELS_REQUESTS, MONITOR_OFF, OBSERVER_KEY_OFF, ORCHESTRATOR_FALLBACKS, RECAPS_FALLBACKS, resolveAgent, SHARED_MACHINES_FALLBACKS, SHARED_MACHINES_OFF, SHARING_FALLBACKS, MESSAGES_FALLBACKS, TAB_KEY_OFF, TAB_RELAY_OFF, TERMINALS_OFF, TURN_DELIVERERS, WIFI_FALLBACKS, WIFI_OFF, WORKSPACES_FALLBACKS, WORKSPACES_OFF, WORKSPACES_UNAVAILABLE, type CoreApiDeps } from './api.js'
import { FAIL, readFallback } from './serviceHost.js'
import { HACHI_ID } from '../dsh/builtinIds.js'
import { answerAgentQuery } from './agentQueries.js'
import { shownAgents } from './experimentQueries.js'
import { createDevicesLink } from './devicesLink.js'
import { createWorkspacesLink } from './workspacesLink.js'
import { createAgentLife } from './agentLife.js'
import { agentsIn, processCoreApi } from '../services/processCoreApi.js'

const row = (agentId: string) => ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: '/work/app' }) as RegisteredSession

describe('the core API services stand on', () => {
  it('allows a bounded batch of GitHub reads to finish outside the core', () => {
    expect(LONG_ANSWERS.projects).toEqual({ git_pull_requests_status: 120_000 })
  })
  it('sends each of the Wi-Fi device\'s routes to the service that answers it, as a request that service declares', () => {
    const route = (path: string) => SERVICE_HTTP_ROUTES.find((each) => each.path.test(path))
    for (const path of ['hello', 'publish', 'decision', 'proposals']) expect(route(`/api/autonomous-device/machine-addon/${path}`)?.type).toBe('machine_addons_http')
    for (const path of ['receipt', 'addon/state', 'addon/propose', 'addon/proposal']) expect(route(`/api/autonomous-device/${path}`)?.type).toBe('wifi_http')
    // The pairings and direct links, and any other path under them, which the gateway says it does not know.
    for (const path of ['discover', 'pair/start', 'pair/status', 'list', 'status', 'revoke', 'receipts', 'pair/cancel']) {
      expect(route(`/api/autonomous-device/${path}`)?.type, path).toBe('gateway_http')
    }
    expect(route('/api/status')).toBeUndefined()
    const declared = new Set<string>([...GATEWAY_REQUESTS, ...WIFI_REQUESTS, ...MACHINE_ADDON_REQUESTS])
    for (const each of SERVICE_HTTP_ROUTES) expect(declared.has(each.type), each.type).toBe(true)
    // Not answered is not "not sent": a proposal may have reached the device.
    expect(route('/api/autonomous-device/addon/propose')!.unanswered).toMatchObject({ status: 504, body: { error: { code: 'OUTCOME_UNKNOWN' } } })
    // A pairing waits for the Wi-Fi device's service, then for its code's rounds (PAIR_WAIT_MS).
    expect(route('/api/autonomous-device/pair/start')!.waitMs).toBeGreaterThan(15_000 + PAIR_WAIT_MS)
  })
  it('sends the keys\' routes and the phone\'s sign-in code to the gateway, the code only over the daemon\'s own socket', () => {
    const route = (method: string, path: string) => SERVICE_HTTP_ROUTES.find((each) => each.path.test(path) && (!each.methods || each.methods.includes(method)))
    const keys = [['POST', '/api/pair'], ['GET', '/api/pairs'], ['POST', '/api/revoke'], ['POST', '/api/revoke-all'], ['POST', '/api/remote-password/set'],
      ['POST', '/api/remote-password/clear'], ['GET', '/api/remote-password/status'], ['POST', '/api/link/trust-peer'], ['GET', '/api/group'],
      ['POST', '/api/group/sync'], ['POST', '/api/group/remove'], ['GET', '/api/devices'], ['POST', '/api/devices/remove'],
      ['POST', '/api/devices/rebaseline'], ['GET', '/api/devices/history'], ['POST', '/api/devices/dismiss'], ['POST', '/api/auth/handoff']] as const
    for (const [method, path] of keys) {
      expect(route(method, path), `${method} ${path}`).toMatchObject({ type: 'gateway_http', unanswered: { status: 503, body: { error: 'GATEWAY_UNAVAILABLE' } } })
      // Each write needs the local header, and so does the device history, a read of the account's whole device story.
      expect(route(method, path)!.writes ?? [], `${method} ${path}`).toEqual(method === 'POST' || path === '/api/devices/history' ? [method] : [])
      expect(route(method, path)!.door, `${method} ${path}`).toBe(path === '/api/auth/handoff' ? 'socket' : undefined)
    }
    // A method the door never took is not taken: the door's 404, as before.
    for (const [method, path] of [['GET', '/api/pair'], ['POST', '/api/pairs'], ['GET', '/api/auth/handoff'], ['GET', '/api/devices/remove']]) expect(route(method, path), `${method} ${path}`).toBeUndefined()
    expect(route('POST', '/api/pair')!.waitMs).toBe(PAIR_WAIT_MS)
    expect(route('GET', '/api/pairs')!.waitMs).toBe(30_000)
  })
  it('sends a window\'s ⌘K and its answer to a spoken task to the devices, as a request they declare', () => {
    expect(SERVICE_WS_FRAMES.map((each) => [each.frame, each.type, each.result])).toEqual([
      ['route_task', 'devices_ws', 'route_result'], ['route_send', 'devices_ws', 'route_send_result'], ['voice_route_reply', 'devices_ws', undefined]])
    for (const each of SERVICE_WS_FRAMES) expect((DEVICES_REQUESTS as readonly string[]).includes(each.type)).toBe(true)
    const reason = 'the devices service is unavailable'
    expect(SERVICE_WS_FRAMES[0].unanswered).toEqual({ agentId: '', machineId: '', name: '', confidence: 0, reason, candidates: [], weighed: 0, machines: 0, via: '' })
    expect(SERVICE_WS_FRAMES[1].unanswered).toEqual({ ok: false, machine: '', reason })
  })
  it('gives a service with no lane of the core\'s nothing to seal with, and never its frame back in the clear', async () => {
    await expect(LANE_OFF.hello('m', 'pub')).rejects.toThrow(/no E2EE identity/)
    expect(await LANE_OFF.welcome('m', {})).toBe(false)
    await expect(LANE_OFF.rekey('m', {})).resolves.toBeUndefined()
    expect(await LANE_OFF.seal('m', { type: 'message', payload: { text: 'hello' } })).toEqual({ lost: true })
    expect(await LANE_OFF.open('m', { type: 'message' })).toEqual({ lost: true })
    expect(LANE_OFF.drop('m')).toBeUndefined()
  })

  it('gives a service with no tab key of the core\'s no signature or session, and never its frame back in the clear', async () => {
    const link = { sharedTabId: 't', machineId: 'm', peerPub: 'p' }
    await expect(TAB_KEY_OFF.publicKey()).rejects.toThrow(/no E2EE identity/)
    await expect(TAB_KEY_OFF.signRoster('t', 1, '{}')).rejects.toThrow(/no E2EE identity/)
    await expect(TAB_KEY_OFF.signKeyChange('t', 'p')).rejects.toThrow(/no E2EE identity/)
    await expect(TAB_KEY_OFF.hello(link)).rejects.toThrow(/no E2EE identity/)
    expect(await TAB_KEY_OFF.welcome(link, {})).toBe(false)
    expect(await TAB_KEY_OFF.accept(link, {})).toEqual({ refused: true })
    expect(await TAB_KEY_OFF.seal(link, { type: 'message' })).toEqual({ lost: true })
    expect(await TAB_KEY_OFF.open(link, { type: 'message' })).toEqual({ lost: true })
    expect(TAB_KEY_OFF.drop(link)).toBeUndefined()
    expect(ACCOUNT_BACKEND_OFF.tabKey).toBe(TAB_KEY_OFF)
  })

  it('gives a service with no tab relay of the core\'s nothing opened and nothing sent', async () => {
    await expect(TAB_RELAY_OFF.open('t')).resolves.toBeUndefined()
    expect(await TAB_RELAY_OFF.send('t', 'm', {})).toBe(false)
    expect(TAB_RELAY_OFF.close('t')).toBeUndefined()
    expect(ACCOUNT_BACKEND_OFF.tabRelay).toBe(TAB_RELAY_OFF)
  })

  it('gives a service with no delivery of the core\'s nothing to write, take back or hear', async () => {
    expect(DELIVERIES_OFF.deliver('a', 'hello', 'd1')).toBeUndefined()
    expect(DELIVERIES_OFF.cancelDelivery('d1')).toBe(false)
    expect(DELIVERIES_OFF.onDelivery(() => {})()).toBeUndefined()
  })

  // The agent browser types its ready and stopped lines into the agent, from its own process too.
  it('lets the agent browser write turns into agents from its own process', () => {
    expect(TURN_DELIVERERS).toContain('agentBrowser')
  })

  it('resolves an agent in a service\'s own copy as the registry does: by agent id, then session id', () => {
    const agents = [{ ...row('a'), sessionId: '' }, row('b')]
    expect(resolveAgent(agents, 'b')?.agentId).toBe('b')
    expect(resolveAgent(agents, 's-b')?.agentId).toBe('b')
    expect(resolveAgent(agents, '')).toBeUndefined()
    expect(resolveAgent(agents, 'nobody')).toBeUndefined()
  })

  /** The core's own pieces, as `createCoreApi` is handed them. */
  const coreDeps = (): CoreApiDeps => ({
      dataDir: '/data',
      registry: {
        list: vi.fn(() => [row('live')]),
        byAgent: vi.fn((agentId: string) => (agentId === 'live' ? row('live') : undefined)),
        resolve: vi.fn((id: string) => (id === 'live' || id === 's-live' ? row('live') : undefined)),
        advertised: vi.fn(() => [row('live')]),
        terminalAvailable: vi.fn((agentId: string) => agentId === 'live'),
      } as unknown as CoreApiDeps['registry'],
      stoppedAgents: { list: vi.fn(() => [row('stopped')]), ids: vi.fn(() => ['stopped']) } as unknown as CoreApiDeps['stoppedAgents'],
      databaseHistory: vi.fn(),
      syncSession: vi.fn(),
      runtimeModels: vi.fn(async () => []),
      viewerChanged: vi.fn(),
      streamFrame: vi.fn(() => true),
      gridNamed: vi.fn(),
      gridModelsChanged: vi.fn(),
      dshInstallStatus: vi.fn(),
      mintGridName: vi.fn(async () => 'grid-1'),
      accessToken: vi.fn(async () => 'token'),
      lane: LANE_OFF,
      privateGridName: vi.fn(async () => 'grid-1'),
      machineName: vi.fn(() => 'Studio'),
      backend: vi.fn(async () => ({ status: 200, body: {} })),
      onNotice: vi.fn(() => () => {}),
      runtimeProfile: vi.fn(() => null),
      setRuntime: vi.fn(),
      fork: vi.fn(async () => ({ ok: true as const, agentId: 'fork' })),
      create: vi.fn(async () => ({ ok: true as const, agentId: 'made' })),
      dsh: vi.fn(() => null),
      windows: vi.fn(),
      daemon: { command: 'harness', port: 18473, machineId: () => 'machine-1', autonomousEnv: 'prod' },
      observerKey: OBSERVER_KEY_OFF,
      tabKey: TAB_KEY_OFF,
      tabRelay: TAB_RELAY_OFF,
      connectorSync: CONNECTOR_SYNC_OFF,
      observer: vi.fn(() => true),
      turns: { send: vi.fn(), stop: vi.fn(), recent: vi.fn(async () => []), asks: vi.fn(async () => []), deliver: vi.fn(), cancelDelivery: vi.fn(() => true), onDelivery: vi.fn(() => () => {}) },
      questions: { answer: vi.fn(), answerReviewed: vi.fn(async () => true) },
      machine: { id: vi.fn(() => 'machine-1'), computerId: vi.fn(() => 'computer-1'), name: vi.fn(() => 'Studio') },
      activityText: vi.fn(async () => 'Reading 3 files'),
      signedIn: vi.fn(() => true),
      environment: vi.fn(() => 'prod'),
      machines: vi.fn(async () => ({ status: 200, body: {} })),
      sendLocal: vi.fn(),
      sendToWindow: vi.fn(() => true),
      hasWindow: vi.fn(() => true),
      devicesChanged: vi.fn(),
      dialWatching: vi.fn(),
      wifi: WIFI_OFF,
      lastTurn: vi.fn(async () => null),
      turnCard: vi.fn(),
      turnSummary: vi.fn(),
      log: vi.fn(),
    })

  it.each(['credential', 'null', 'absent'] as const)('keeps %s launch custody out of every service agent read', (kind) => {
    const override = { networkId: 'fixture', networkName: 'Fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic-agent-view-canary' }
    const live = row('live'), stopped = row('stopped'), cloud = row('cloud')
    for (const session of [live, stopped, cloud]) {
      if (kind === 'credential') session.gridLaunch = override
      else if (kind === 'null') session.gridLaunch = null
    }
    const before = structuredClone([live, stopped, cloud])
    const deps = coreDeps()
    deps.registry.list = () => [live]
    deps.registry.advertised = () => [live]
    deps.registry.byAgent = id => id === live.agentId ? live : undefined
    deps.registry.resolve = id => id === live.sessionId ? live : undefined
    deps.stoppedAgents.list = () => [stopped]
    const core = createCoreApi({ ...deps, cloudRows: () => [cloud] })
    const views = [...core.agents.all(), ...core.agents.live(), ...core.agents.advertised(),
      core.agents.byAgent('live')!, core.agents.resolve('s-live')!, ...core.agents.cloud!()]
    expect(views.map(session => session.agentId)).toEqual(['live', 'stopped', 'live', 'live', 'live', 'live', 'cloud'])
    for (const session of views) {
      expect(Object.hasOwn(session, 'gridLaunch')).toBe(false)
      expect(session).toEqual(row(session.agentId))
      expect([live, stopped, cloud].includes(session)).toBe(false)
    }
    expect([live, stopped, cloud]).toEqual(before)
    if (kind === 'credential') expect(live.gridLaunch).toBe(override)
    // Even a view taken before a key is assigned must not become a secret-bearing alias later.
    for (const session of [live, stopped, cloud]) session.gridLaunch = override
    expect(JSON.stringify(views)).not.toContain(override.apiKey)
    expect(views.every(session => !Object.hasOwn(session, 'gridLaunch'))).toBe(true)
    expect(core.agents.byAgent('missing')).toBeUndefined()
    expect(core.agents.resolve('missing')).toBeUndefined()
  })

  it('sends metadata without launch credentials through every agent-list service dispatch', async () => {
    const override = { networkId: 'fixture', networkName: 'Fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic-agent-dispatch-canary' }
    const live: RegisteredSession = { ...row('live'), dsh: 'fixture', browser: true, gridLaunch: override }
    const stopped = { ...row('stopped'), gridLaunch: override }
    const deps = coreDeps()
    deps.registry.list = () => [live]
    deps.registry.advertised = () => [live]
    deps.stoppedAgents.list = () => [stopped]
    const core = createCoreApi(deps)
    const replies = await Promise.all(['agents', 'live', 'advertised'].map(query => answerAgentQuery(core, query)))
    replies.push(shownAgents(core))
    const devices = createDevicesLink({ core, notify: () => true, call: async () => ({}), state: () => ({
      desk: [], foreground: false, swarms: null, unread: [], focus: { voice: null, form: null }, engines: [], commanders: false,
    }) })
    replies.push(await devices.answer('view', {}))
    const workspaces = createWorkspacesLink(core, frame => { replies.push(frame.payload ?? {}); return true }, async () => ({}))
    workspaces.port.nameBranches()
    const browserEvents: unknown[] = []
    const life = createAgentLife({ live: () => [live], hears: {},
      notify: (_service, frame) => { browserEvents.push(frame); return true } })
    replies.push(life.followed('viewers', { each: true, having: ['dsh'] }))
    replies.push(life.followed('agentBrowser', {}))
    life.disconnected('agentBrowser')
    replies.push(life.followed('agentBrowser', {}))
    life.running(live)
    expect(browserEvents).toHaveLength(1)
    for (const reply of replies) {
      const agents = agentsIn(reply)
      expect(agents?.length).toBeGreaterThan(0)
      expect(agents?.every(session => !Object.hasOwn(session, 'gridLaunch'))).toBe(true)
      // This reader shape is unchanged from the oldest supported source (2026-10-16).
      const service = processCoreApi('/data', 'search', { live: () => agents ?? [] })
      expect(service.agents.byAgent('live')).toMatchObject({ agentId: 'live', sessionId: 's-live', dsh: 'fixture' })
    }
    const sent = JSON.stringify([replies, browserEvents])
    expect(sent).not.toContain('gridLaunch')
    expect(sent).not.toContain(override.apiKey)
    expect(live.gridLaunch).toBe(override)
    expect(stopped.gridLaunch).toBe(override)
  })

  it('lists every agent, live then stopped, and names them as the apps do', async () => {
    const deps = coreDeps()
    const core = createCoreApi(deps)
    expect(core.conversations).toBe(CONVERSATIONS_OFF)
    const conversations = { ...CONVERSATIONS_OFF }
    expect(createCoreApi({ ...deps, conversations }).conversations).toBe(conversations)
    // The cloud agents' doors, only from a core that offers them.
    expect(core.cloud).toBeUndefined()
    const cloud = { publish: vi.fn(), ask: vi.fn(), unask: vi.fn() }
    expect(createCoreApi({ ...deps, cloud }).cloud).toBe(cloud)
    expect(core.agents.cloud).toBeUndefined()
    const rows = [{ agentId: 'cloud_1' }] as RegisteredSession[]
    expect(createCoreApi({ ...deps, cloudRows: () => rows }).agents.cloud!()).toEqual(rows)
    expect(core.dataDir).toBe('/data')
    expect(await core.terminals.open({ argv: ['/bin/zsh'], cwd: '/work' })).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
    const terminals = { ...TERMINALS_OFF, open: vi.fn(async () => ({ ok: true as const, agentId: 'shell' })), watch: TERMINALS_OFF.watch }
    expect(createCoreApi({ ...deps, terminals }).terminals).toBe(terminals)
    expect(core.agents.all().map((s) => s.agentId)).toEqual(['live', 'stopped'])
    expect(core.agents.live().map((s) => s.agentId)).toEqual(['live'])
    expect(core.agents.displayName).toBe(projectDisplayName)
    expect(core.transcripts.databaseHistory).toBe(deps.databaseHistory)
    expect(core.agents.byAgent('live')?.agentId).toBe('live')
    expect(core.agents.byAgent('gone')).toBeUndefined()
    expect(core.agents.resolve('s-live')?.agentId).toBe('live')
    expect(core.agents.resolve('gone')).toBeUndefined()
    expect(core.agents.terminalAvailable('live')).toBe(true)
    expect(core.agents.sync).toBe(deps.syncSession)
    expect(core.agents.runtimeModels).toBe(deps.runtimeModels)
    expect(core.clients.viewerChanged).toBe(deps.viewerChanged)
    // A viewer stream's frames reach a client; nothing else a viewers process names does.
    expect(core.clients.streamFrame('c1', 'viewer_data', { streamId: 's' })).toBe(true)
    expect(deps.streamFrame).toHaveBeenCalledWith('c1', 'viewer_data', { streamId: 's' })
    expect(core.clients.streamBytes).toBeUndefined()
    expect(core.clients.dshInstallStatus).toBe(deps.dshInstallStatus)
    expect(core.agents.advertised().map((s) => s.agentId)).toEqual(['live'])
    expect(core.clients.gridNamed).toBe(deps.gridNamed)
    expect(core.clients.gridModelsChanged).toBe(deps.gridModelsChanged)
    expect(core.account.mintGridName).toBe(deps.mintGridName)
    expect(core.account.accessToken).toBe(deps.accessToken)
    expect(core.account.lane).toBe(deps.lane)
    expect(core.account.privateGridName).toBe(deps.privateGridName)
    expect(core.account.machineName).toBe(deps.machineName)
    expect(core.account.backend).toBe(deps.backend)
    expect(core.account.onNotice).toBe(deps.onNotice)
    expect(core.account.observerKey).toBe(deps.observerKey)
    expect(core.account.tabKey).toBe(deps.tabKey)
    expect(core.account.tabRelay).toBe(deps.tabRelay)
    expect(core.clients.observer).toBe(deps.observer)
    // What a device or another machine asks of an agent here: the core's own handlers, as they are.
    expect(core.agents.runtimeProfile).toBe(deps.runtimeProfile)
    expect(core.agents.setRuntime).toBe(deps.setRuntime)
    expect(core.agents.fork).toBe(deps.fork)
    // What an experiment acts on the core through.
    expect(core.agents.create).toBe(deps.create)
    expect(core.agents.dsh).toBe(deps.dsh)
    expect(core.clients.windows).toBe(deps.windows)
    expect(core.daemon).toBe(deps.daemon)
    expect(core.turns).toBe(deps.turns)
    expect(core.questions).toBe(deps.questions)
    // What the devices ask of the core: this computer, the sign-in, a pane's footer, the windows.
    expect(core.machine).toBe(deps.machine)
    expect(core.agents.activityText).toBe(deps.activityText)
    // Agent Messages asks whether harnesses work; a core that was not given the reader reports none.
    await expect(core.agents.activity(['a1'])).resolves.toEqual({})
    const activity = vi.fn(async () => ({ a1: 'working' as const }))
    await expect(createCoreApi({ ...deps, activity }).agents.activity(['a1'])).resolves.toEqual({ a1: 'working' })
    // The same for the one-line summaries (ruling T2): none from a core that was not given the reader.
    await expect(core.agents.summaries(['a1'])).resolves.toEqual({})
    const summaries = vi.fn(async () => ({ a1: 'Fix the login' }))
    await expect(createCoreApi({ ...deps, summaries }).agents.summaries(['a1'])).resolves.toEqual({ a1: 'Fix the login' })
    expect(core.account.signedIn).toBe(deps.signedIn)
    expect(core.account.environment).toBe(deps.environment)
    expect(core.account.machines).toBe(deps.machines)
    expect(core.clients.hasWindow).toBe(deps.hasWindow)
    expect(core.clients.devicesChanged).toBe(deps.devicesChanged)
    expect(core.clients.dialWatching).toBe(deps.dialWatching)
    expect(core.transcripts.lastTurn).toBe(deps.lastTurn)
  })

  it('closes for the agent cleanup only a harness another agent started, the conversation it is now, and keeps it', async () => {
    // Whatever the cleanup asks, from its own process or this one, the core decides what it may close
    // (services/agentCleanup.ts): a harness the person started is never one.
    const started = { ...row('kid'), startedBy: 'agent' as const, registeredAt: Date.parse('2026-10-12T08:00:00Z') }
    const mine = { ...row('mine'), registeredAt: 0 }
    const deps = coreDeps()
    const byAgent = vi.fn((agentId: string) => (agentId === 'kid' ? started : agentId === 'mine' ? mine : undefined))
    const closeAgent = vi.fn<NonNullable<CoreApiDeps['closeAgent']>>(async () => ({ closed: true }))
    const activityAt = vi.fn(async () => 1_234)
    const core = createCoreApi({ ...deps, registry: { ...deps.registry, byAgent } as unknown as CoreApiDeps['registry'], closeAgent, activityAt })
    expect(await core.agents.closeStarted!('kid', 'idle')).toEqual({ closed: true })
    // An idle close refuses one that still runs background commands; past the cleanup's ceiling it closes it and
    // counts them. A close now carries no rule for them.
    expect(closeAgent).toHaveBeenCalledWith({ agentId: 'kid', sessionId: 's-kid', createdAt: '2026-10-12T08:00:00.000Z', mode: 'idle', background: 'refuse' })
    expect(await core.agents.closeStarted!('mine', 'now')).toEqual({ error: 'NOT_AGENT_STARTED' })
    expect(await core.agents.closeStarted!('gone', 'now')).toEqual({ error: 'AGENT_CHANGED' })
    expect(closeAgent).toHaveBeenCalledTimes(1)
    await core.agents.closeStarted!('kid', 'idle', true)
    expect(closeAgent).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'idle', background: 'count' }))
    await core.agents.closeStarted!('kid', 'now', true)
    expect(closeAgent.mock.calls.at(-1)![0]).toEqual({ agentId: 'kid', sessionId: 's-kid', createdAt: '2026-10-12T08:00:00.000Z', mode: 'now' })
    expect(await core.agents.lastActivity!('kid')).toBe(1_234)
    expect(activityAt).toHaveBeenCalledWith(started)
    expect(await core.agents.lastActivity!('gone')).toBeNull()
    // A core built without a close or a clock closes nothing and knows no time.
    const bare = createCoreApi({ ...deps, registry: { ...deps.registry, byAgent } as unknown as CoreApiDeps['registry'] })
    expect(await bare.agents.closeStarted!('kid', 'now')).toEqual({ error: 'UNSUPPORTED' })
    expect(await bare.agents.lastActivity!('kid')).toBeNull()
  })

  // `harness browser`'s tools in a pane name their agent by it.
  it('names the live agent of a pane', async () => {
    const deps = coreDeps()
    const paned = { ...row('live'), runtimes: [{ backend: 'tmux', paneId: '%7' }] } as RegisteredSession
    const core = createCoreApi({ ...deps, registry: { ...deps.registry, list: vi.fn(() => [paned]) } as unknown as CoreApiDeps['registry'] })
    expect(await core.agents.ofPane!('%7')).toEqual({ agentId: 'live', guest: false })
    expect(await core.agents.ofPane!('%8')).toBeNull()
  })

  // Review Focus 1 (re-check 2 of #2093): pane ids restart in every tmux server, so a private server inside one agent's
  // pane counts up to another agent's pane id. `harness browser` sends its parents' pids, and the pane's own process,
  // read from the daemon's terminal backend, has to be among them.
  it('ofPane with ancestors is null when the pane\'s process is not among them (another tmux server\'s pane of the same id), and the agent when it is; without ancestors it answers as before', async () => {
    const deps = coreDeps()
    const live = { ...row('live'), runtimes: [{ backend: 'tmux', paneId: '%7' }] } as RegisteredSession
    const kim = { ...row('kim'), guest: 'kim@acme.io', runtimes: [{ backend: 'tmux', paneId: '%8' }] } as RegisteredSession
    const registry = { ...deps.registry, list: vi.fn(() => [live, kim]) } as unknown as CoreApiDeps['registry']
    const panePid = vi.fn(async (session: RegisteredSession): Promise<number | null> => (session.agentId === 'live' ? 4242 : 4343))
    const core = createCoreApi({ ...deps, registry, panePid })
    // Run in a private server's %7 inside kim's pane: its parents are kim's pane's, never live's.
    expect(await core.agents.ofPane!('%7', [9001, 9000, 4343, 1])).toBeNull()
    expect(await core.agents.ofPane!('%7', [9001, 4242, 1])).toEqual({ agentId: 'live', guest: false })
    expect(panePid).toHaveBeenLastCalledWith(live)
    expect(await core.agents.ofPane!('%8', [4343, 1])).toEqual({ agentId: 'kim', guest: true })
    expect(await core.agents.ofPane!('%9', [4242])).toBeNull()
    // A pane whose process cannot be read proves nothing.
    panePid.mockResolvedValueOnce(null)
    expect(await core.agents.ofPane!('%7', [4242])).toBeNull()
    panePid.mockRejectedValueOnce(new Error('tmux did not answer'))
    expect(await core.agents.ofPane!('%7', [4242])).toBeNull()
    // Nor does a core that cannot read it.
    expect(await createCoreApi({ ...deps, registry }).agents.ofPane!('%7', [4242])).toBeNull()
    // Without ancestors, as an older relay's `agent_browser_state` asks: the pane's agent, read from nothing else.
    const calls = panePid.mock.calls.length
    expect(await core.agents.ofPane!('%7')).toEqual({ agentId: 'live', guest: false })
    expect(panePid).toHaveBeenCalledTimes(calls)
  })

  // What happens to agents (core/agentLife.ts), lent to the services in the core's process that follow them.
  it('agents.follow is the dep\'s, and absent without one', () => {
    const follow = vi.fn(() => () => {})
    expect(createCoreApi({ ...coreDeps(), follow }).agents.follow).toBe(follow)
    expect(createCoreApi(coreDeps()).agents.follow).toBeUndefined()
  })

  it('hands a service\'s product counters on only where the core was told where they go', () => {
    const count = vi.fn()
    createCoreApi({ ...coreDeps(), count }).count!('agent_browser_enabled')
    expect(count).toHaveBeenCalledWith('agent_browser_enabled')
    expect(createCoreApi(coreDeps()).count).toBeUndefined()
  })

  it('exposes no default stream sender without a service-scoped adapter', () => {
    const { streamFrame: _unused, ...deps } = coreDeps()
    const core = createCoreApi(deps)
    expect(core.clients.streamFrame('c1', 'viewer_data', {})).toBe(false)
    expect(core.clients.streamFrame('c1', 'agent_browser_open_result', {})).toBe(false)
    expect(core.clients.streamBytes).toBeUndefined()
  })

  it('passes an explicitly scoped stream byte sender through', () => {
    const streamBytes = vi.fn(() => true)
    expect(createCoreApi({ ...coreDeps(), streamBytes }).clients.streamBytes).toBe(streamBytes)
  })

  it('tells the agent cleanup nothing while it is off: every harness is left open, as before it, and none whose told lines it could not erase is deleted', () => {
    const { forgetTold, ...notices } = AGENT_CLEANUP_FALLBACKS
    expect(notices).toEqual({ closed: undefined, typed: undefined, stop: undefined })
    expect(readFallback(forgetTold)).toEqual({ deferred: true, value: false })
  })

  it('lets the recaps send a turn\'s cards and recaps, and nothing else, down those doors', () => {
    const log = vi.fn()
    const turnCard = vi.fn()
    const turnSummary = vi.fn()
    const core = createCoreApi({ turnCard, turnSummary, log } as unknown as CoreApiDeps)
    const card = { type: 'commander_event' as const, agentId: 'a', dbSessionId: 's', payload: { kind: 'done' } }
    core.clients.turnCard(card)
    core.clients.turnSummary({ type: 'turn_summary', payload: {} })
    core.clients.turnSummary({ type: 'turn_summary_pending', payload: {} })
    expect(turnCard).toHaveBeenCalledWith(card)
    expect(turnSummary.mock.calls.map(([frame]) => frame.type)).toEqual(['turn_summary', 'turn_summary_pending'])
    // A frame that is not theirs is refused, and said: a recaps process speaks to the core as a service.
    core.clients.turnCard({ ...card, type: 'agents_list' } as never)
    core.clients.turnSummary({ type: 'commander_event' } as never)
    core.clients.turnSummary(undefined as never)
    expect(turnCard).toHaveBeenCalledTimes(1)
    expect(turnSummary).toHaveBeenCalledTimes(2)
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      '[services] the recaps sent agents_list, which is not theirs to send',
      '[services] the recaps sent commander_event, which is not theirs to send',
      '[services] the recaps sent undefined, which is not theirs to send',
    ])
    // Said to the daemon's log unless told otherwise.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createCoreApi({ turnCard, turnSummary } as unknown as CoreApiDeps).clients.turnCard({ type: 'nope' } as never)
    expect(warn).toHaveBeenCalledWith('[services] the recaps sent nope, which is not theirs to send')
    warn.mockRestore()
  })

  it('tells the recaps nothing, and reads no recap, when they fail', () => {
    expect(RECAPS_FALLBACKS).toMatchObject({ lifecycle: undefined, recaps: null })
    expect(readFallback(RECAPS_FALLBACKS.liveCards)).toEqual({ deferred: true, value: [] })
  })

  it('lets the devices put their own frames in front of the windows, and no other', () => {
    const deps = coreDeps()
    const core = createCoreApi(deps)
    core.clients.sendLocal({ type: 'dial_focus', payload: { agentId: 'a' } })
    expect(deps.sendLocal).toHaveBeenCalledWith({ type: 'dial_focus', payload: { agentId: 'a' } })
    expect(core.clients.sendToWindow('window-1', { type: 'dial_form', payload: {} })).toBe(true)
    expect(deps.sendToWindow).toHaveBeenCalledWith('window-1', { type: 'dial_form', payload: {} })
    // A devices process speaks as a service: what it may show a person is decided here, frame by frame.
    core.clients.sendLocal({ type: 'agent_deleted', payload: {} } as unknown as Parameters<typeof core.clients.sendLocal>[0])
    expect(core.clients.sendToWindow('window-1', { type: 'dial_focus', payload: {} } as unknown as Parameters<typeof core.clients.sendToWindow>[1])).toBe(false)
    core.clients.sendLocal(null as unknown as Parameters<typeof core.clients.sendLocal>[0])
    expect(deps.sendLocal).toHaveBeenCalledTimes(1)
    expect(deps.sendToWindow).toHaveBeenCalledTimes(1)
    expect(deps.log).toHaveBeenCalledWith('[services] the devices sent a window agent_deleted, which is not theirs to send')
    expect(deps.log).toHaveBeenCalledWith('[services] the devices sent a window dial_focus, which is not theirs to send')
    // Said to the console when the core gives no log of its own.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createCoreApi({ ...deps, log: undefined }).clients.sendLocal({ type: 'nothing' } as unknown as Parameters<typeof core.clients.sendLocal>[0])
    expect(warn).toHaveBeenCalledWith('[services] the devices sent a window nothing, which is not theirs to send')
    warn.mockRestore()
  })

  // Hachi 5a (OPENHARNES-15): `harness goal done` on Hachi's home tells every window of the account, here and away.
  it('lets the goals tell the windows a goal of the live Hachi harness closed, and nothing else', () => {
    const deps = coreDeps()
    expect(createCoreApi(deps).clients.hachiGoalDone).toBeUndefined()
    const hachi = { ...row('hachi'), dsh: HACHI_ID }
    const registry = { ...deps.registry, byAgent: vi.fn((id: string) => (id === 'hachi' ? hachi : id === 'live' ? row('live') : undefined)) } as unknown as CoreApiDeps['registry']
    const hachiGoalDone = vi.fn()
    const core = createCoreApi({ ...deps, registry, hachiGoalDone })
    const told = { agentId: 'hachi', goalId: 'g1', title: 'flaky login test' }
    core.clients.hachiGoalDone!({ ...told, extra: 'dropped' } as typeof told)
    expect(hachiGoalDone.mock.calls).toEqual([[told]])
    // A goals process speaks as a service: whose goal it is, and its shape, are decided here.
    for (const notice of [
      { ...told, agentId: 'live' }, { ...told, agentId: 'gone' }, { ...told, goalId: '' }, { ...told, goalId: 7 },
      { ...told, title: '' }, { ...told, title: 'x'.repeat(81) }, null,
    ]) core.clients.hachiGoalDone!(notice as typeof told)
    expect(hachiGoalDone).toHaveBeenCalledTimes(1)
    expect(deps.log).toHaveBeenCalledWith('[services] the goals sent a goal done that is not the live Hachi\'s')
    expect(deps.log).toHaveBeenCalledTimes(7)
  })

  it('answers ⌘K, when the devices fail, with no agent picked and nothing sent, saying why', async () => {
    const reason = 'the devices service is unavailable'
    expect(SERVICE_WS_FRAMES.find(route => route.frame === 'route_task')?.unanswered).toMatchObject({ agentId: '', reason, candidates: [] })
    expect(SERVICE_WS_FRAMES.find(route => route.frame === 'route_send')?.unanswered).toEqual({ ok: false, machine: '', reason })
    // The Wi-Fi device finds no desk to walk; the dial and the window bridges hear nothing.
    expect(readFallback(DEVICES_FALLBACKS.stepFocus).value).toBe('no_agents')
    for (const member of ['card', 'desk', 'swarms', 'unread', 'appFocus', 'seen', 'settings', 'windowFocus', 'windowReply', 'windowGone', 'scroll', 'engines', 'commanders'] as const) {
      expect(DEVICES_FALLBACKS[member], member).toBeUndefined()
    }
    expect(readFallback(DEVICES_FALLBACKS.stop)).toEqual({ deferred: true, value: undefined })
    expect(FAIL).toBeTypeOf('symbol')
  })

  it('answers the mod\'s poll, when the devices fail, as with no dial, and holds no approval call', () => {
    // Off is no device, which the mod asks again a minute later, never an empty hold it would follow at once.
    expect(readFallback(DEVICES_FALLBACKS.inboxPoll)).toEqual({ deferred: true, value: { off: true } })
    expect(DEVICES_FALLBACKS.inboxGone).toBeUndefined()
    // The dial only shows a waiting prompt: the devices are asked no approval.
    expect(Object.keys(DEVICES_FALLBACKS).filter((member) => /approval/i.test(member))).toEqual([])
  })

  it('answers, when the Wi-Fi device\'s service is off, nothing to its devices', () => {
    for (const member of ['resume', 'appFocus', 'stop'] as const) {
      expect(readFallback(WIFI_FALLBACKS[member]), member).toEqual({ deferred: true, value: undefined })
    }
    for (const member of ['card', 'turnEnded', 'stream', 'transcript', 'delivery',
      'events', 'input', 'disconnected', 'agentGone', 'revealed'] as const) {
      expect(WIFI_FALLBACKS[member], member).toBeUndefined()
    }
  })

  it('gives a service that is not the Wi-Fi device\'s doors that list, send, make and move nothing', async () => {
    expect(await WIFI_OFF.view()).toEqual({ agents: [], store: [], hasWindow: false })
    expect(await WIFI_OFF.stop('a')).toBe(false)
    expect(await WIFI_OFF.answer('a', 'r', {})).toBe(false)
    expect(await WIFI_OFF.create('p', 'claude', '/w')).toEqual({ ok: false, error: 'UNSUPPORTED' })
    expect(await WIFI_OFF.stepFocus('next')).toBe('no_app')
    expect(WIFI_OFF.scroll('down', 0, 0)).toBe(false)
    expect(WIFI_OFF.focusApp('a', 0, 'r')).toBe(false)
    for (const call of [() => WIFI_OFF.reveal('o', 'a'), () => WIFI_OFF.focus('r'), () => WIFI_OFF.transcripts('a', 0), () => WIFI_OFF.watching([]),
      () => WIFI_OFF.streams([])]) expect(call()).toBeUndefined()
  })

  it('falls back, when Agent Messages fails, to writing none of its deliveries', () => {
    expect(MESSAGES_FALLBACKS.canWrite).toBe(false)
  })

  it('falls back, when cloud agents fail, to refusing each call with a reason a person reads', () => {
    for (const fallback of Object.values(CLOUD_FALLBACKS)) expect(readFallback(fallback)).toEqual({ deferred: true, value: CLOUD_DOWN })
    expect(CLOUD_DOWN.detail).toContain('Cloud agents are not running here')
  })

  it('starts with every port empty: a service fills its own when it starts', () => {
    expect(emptyPorts()).toEqual({ usage: null, store: null, search: null, viewers: null, models: null, workspaces: null, messages: null, devices: null, wifi: null, monitor: null, connectors: null, orchestrator: null, sharing: null, recaps: null, agentCleanup: null, cloud: null, sharedMachines: null })
    expect(emptyPorts()).not.toBe(emptyPorts())
  })

  it('refuses package descriptions while Store is absent instead of inventing package facts', async () => {
    const ports = emptyPorts()
    await expect((ports.store ?? STORE_OFF).dshDescribe({ dsh: 'test/draw', engine: 'claude' }))
      .rejects.toMatchObject({ name: 'ServiceUnavailableError', service: 'store', message: 'the store service is unavailable' })
  })

  it('answers models\' fallbacks while it is off: no set-up and no target, no note and no prewarm, no name of its own', async () => {
    const grid = { baseUrl: 'https://fixture.invalid/g/n1/relay/v1', model: 'm' }
    const launch = { networkId: 'n1', networkName: 'mine', baseUrl: grid.baseUrl, apiKey: 'k' }
    const dsh = { dsh: 'test/draw', workspace: '/workspace', engine: 'claude' as const, account: {}, key: 'agent' }
    await expect(STORE_OFF.dshMaterialize(dsh)).rejects.toThrow('the store service is unavailable')
    await expect(STORE_OFF.dshLaunch(dsh)).rejects.toThrow('the store service is unavailable')
    await expect(MODELS_OFF.ensure()).rejects.toThrow('the models service is unavailable')
    await expect(MODELS_OFF.launchTarget({ model: 'm', grid: 'mine' })).rejects.toThrow('the models service is unavailable')
    await expect(MODELS_OFF.moveTarget({ gridName: null, model: 'm' })).rejects.toThrow('the models service is unavailable')
    await expect(MODELS_OFF.lists()).rejects.toThrow('the models service is unavailable')
    await expect(MODELS_OFF.gridAssignments([])).rejects.toThrow('the models service is unavailable')
    // A launch on a grid or a saved API is refused while models is off (core/agents/launch.ts `gridLaunchThrough`).
    await expect(MODELS_OFF.gridLaunch({ engine: 'claude', override: launch, machine: { hermesSystemManaged: false } })).rejects.toThrow('the models service is unavailable')
    await expect(MODELS_OFF.apiTarget({ connectionId: 'openrouter', model: 'm' })).rejects.toThrow('the models service is unavailable')
    expect(await MODELS_OFF.privateGridName()).toBeNull()
    expect(MODELS_OFF.annotation(grid)).toBeNull()
    expect([MODELS_OFF.prewarm(grid), MODELS_OFF.moved(launch), MODELS_OFF.machines(null, 'here'), MODELS_OFF.signedOut()]).toEqual([undefined, undefined, undefined, undefined])
  })

  it('waits longer only for answers that take longer, each a request or port call of its service', () => {
    for (const type of Object.keys(LONG_ANSWERS.models!)) {
      expect([...MODELS_REQUESTS, 'ensure', 'moveTarget', 'launchTarget', 'privateGridName', 'lists']).toContain(type)
    }
    // A grid command may run half an hour, and is waited for longer than that.
    expect(LONG_ANSWERS.models!.grid_fleet_run).toBeGreaterThan(30 * 60_000)
    // An agent's browser command runs up to 70 s (navigation's 60 s and the service's 10 s), and `harness browser`
    // waits 75 s for it: the core waits longer, so the CLI's own line says it timed out.
    expect(LONG_ANSWERS.agentBrowser).toEqual({ agent_browser_run: 80_000 })
    expect(AGENT_BROWSER_REQUESTS).toContain('agent_browser_run')
  })

  it('gives a service that acts on no agent nothing to create and no harness to read, and a daemon it was never told of', async () => {
    expect(await AGENT_ACTIONS_OFF.create({ engine: 'claude', cwd: '/w', dsh: null, prompt: 'p', name: 'n', bypassPermission: false }))
      .toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
    expect(AGENT_ACTIONS_OFF.dsh(row('a'))).toBeNull()
    expect(DAEMON_UNKNOWN.machineId()).toBe('')
  })

  it('gives a service that reads no backend an unavailable answer, no account and no notice to hear', async () => {
    expect(await ACCOUNT_BACKEND_OFF.backend('GET', '/api/agent-messages')).toEqual({ status: 503, body: { error: 'SERVICE_UNAVAILABLE' } })
    expect(await ACCOUNT_BACKEND_OFF.identity()).toBeNull()
    expect(ACCOUNT_BACKEND_OFF.onNotice(() => {})()).toBeUndefined()
  })

  it('reads the account signed in here through the core\'s sign-in, once it is known, and again until it is', async () => {
    const me = (user: unknown, status = 200) => ({ status, body: { success: status === 200, data: { user } } })
    const backend = vi.fn<CoreApiDeps['backend']>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({ status: 502, body: { error: 'BACKEND_UNREACHABLE' } })
      .mockResolvedValueOnce(me({ id: 'u-alice' }))
      .mockResolvedValueOnce(me({ id: '', email: 'alice@x.io' }))
      .mockResolvedValueOnce(me({ id: 'u-alice', email: '' }))
      .mockResolvedValueOnce({ status: 200, body: { success: true } })
      .mockResolvedValueOnce(me({ id: 'u-alice', email: 'alice@x.io', name: 'Alice' }))
    const identity = accountIdentity(backend)
    for (let i = 0; i < 6; i++) expect(await identity()).toBeNull()
    expect(await identity()).toEqual({ accountId: 'u-alice', email: 'alice@x.io' })
    // Known now: a sign-in to another account starts a new core, so it is never read again.
    expect(await identity()).toEqual({ accountId: 'u-alice', email: 'alice@x.io' })
    expect(backend).toHaveBeenCalledTimes(7)
    expect(backend).toHaveBeenCalledWith('GET', '/api/auth/me')
    // The core's own: createCoreApi reads it through the backend it is handed.
    const core = createCoreApi({ ...coreDeps(), backend: vi.fn(async () => me({ id: 'u-bob', email: 'bob@y.io' })) })
    expect(await core.account.identity()).toEqual({ accountId: 'u-bob', email: 'bob@y.io' })
  })

  it('watches no terminal and signs nothing for a service without the core\'s terminals or key', async () => {
    await expect(TERMINALS_OFF.describe('missing')).resolves.toBeNull()
    await expect(TERMINALS_OFF.visitStatus('missing')).resolves.toEqual({ exited: false })
    await expect(TERMINALS_OFF.watch.frame('observer:x', 'terminal_open', {})).resolves.toBeUndefined()
    await expect(TERMINALS_OFF.watch.close('observer:x')).resolves.toBeUndefined()
    expect(TERMINALS_OFF.watch.onOutput(() => {})()).toBeUndefined()
    await expect(OBSERVER_KEY_OFF.publicKey()).rejects.toThrow('no E2EE identity')
    await expect(OBSERVER_KEY_OFF.signWelcome('m', 's', 'p', 'e')).rejects.toThrow('no E2EE identity')
    await expect(CONNECTOR_SYNC_OFF(true)).rejects.toThrow('CONNECTORS_SYNC_UNAVAILABLE')
    expect(SHARING_FALLBACKS).toEqual({ observer: undefined, linkDown: undefined, stop: undefined })
  })

  it('answers no role and reads no frame while the orchestrator is off', () => {
    expect(ORCHESTRATOR_FALLBACKS).toEqual({ roleOf: null, frame: undefined, stop: undefined })
  })

  it('answers the monitor\'s fallbacks while it is off: no readings, nothing measured to forget', async () => {
    await expect(MONITOR_OFF.resources()).rejects.toThrow('the monitor service is unavailable')
    expect(await MONITOR_OFF.storage([], true)).toEqual(new Map())
  })

  it('answers for workspaces while they are off: branches keep their names, a create waits, and no worktree is read or removed', async () => {
    const project = { source: 'worktree' as const, gitSource: '/work/app' }
    const target = { cwd: '/work/app-wt' }
    expect(WORKSPACES_OFF.stop()).toBeUndefined()
    expect(WORKSPACES_OFF.nameBranches()).toBeUndefined()
    expect(WORKSPACES_OFF.ready()).toBe(false)
    expect(await WORKSPACES_OFF.prepareInstructions('/work/app-wt', 'claude')).toBe(false)
    const folder = { ok: false, error: 'SERVICE_UNAVAILABLE', detail: `Could not make the project folder. ${WORKSPACES_UNAVAILABLE}` }
    expect(await WORKSPACES_OFF.prepareFolder(project, { cloneFallback: true })).toEqual(folder)
    expect(await WORKSPACES_OFF.describeWorkspace(target, [])).toBeNull()
    const review = { ok: false, reason: `The worktree could not be checked. ${WORKSPACES_UNAVAILABLE}` }
    expect(await WORKSPACES_OFF.reviewWorktree(target, [])).toEqual(review)
    const removal = { ok: false, reason: `The worktree was kept. ${WORKSPACES_UNAVAILABLE}` }
    expect(await WORKSPACES_OFF.removeWorktree({} as never, target, [], true)).toEqual(removal)
    // A service that fails answers the same, and its create is never told it may go on.
    expect(readFallback(WORKSPACES_FALLBACKS.nameBranches)).toEqual({ deferred: false, value: undefined })
    expect(readFallback(WORKSPACES_FALLBACKS.ready)).toEqual({ deferred: false, value: false })
    expect(readFallback(WORKSPACES_FALLBACKS.prepareFolder)).toEqual({ deferred: true, value: folder })
    expect(readFallback(WORKSPACES_FALLBACKS.describeWorkspace)).toEqual({ deferred: true, value: null })
    expect(readFallback(WORKSPACES_FALLBACKS.reviewWorktree)).toEqual({ deferred: true, value: review })
    expect(readFallback(WORKSPACES_FALLBACKS.removeWorktree)).toEqual({ deferred: true, value: removal })
  })

  it('answers a guest\'s New Harness while shared machines is off: guest access unavailable, in words, and nothing to stop', async () => {
    expect(await SHARED_MACHINES_OFF.guestLaunch({ email: 'kim@acme.io', engine: 'claude', bypassPermission: true }))
      .toEqual({ ok: false, error: 'GUEST_UNAVAILABLE', detail: expect.stringMatching(/Sharing isn't running/) })
    expect(SHARED_MACHINES_OFF.stop()).toBeUndefined()
    expect(SHARED_MACHINES_FALLBACKS.stop).toBeUndefined()
    expect(LONG_ANSWERS.sharedMachines).toEqual({ guestLaunch: 2 * 60_000, shared_machines: 11 * 60_000 })
  })
})
