import { SERVICE_HOSTS } from '../harnessd/services.js'
import { describe, expect, it, vi } from 'vitest'
import { projectDisplayName, type RegisteredSession } from '../lib/registry.js'
import { captureSessionSnapshot, SESSION_SNAPSHOT_MAX_BYTES, SESSION_SNAPSHOT_MAX_ROWS, AGENT_BROWSER_REQUESTS, CLOUD_DOWN, CLOUD_FALLBACKS, CONNECTOR_SYNC_OFF, CONVERSATIONS_OFF, ACCOUNT_BACKEND_OFF, accountIdentity, sendLocalWindow, AGENT_ACTIONS_OFF, AGENT_CLEANUP_FALLBACKS, createCoreApi, DAEMON_UNKNOWN, DELIVERIES_OFF, DEVICES_FALLBACKS, DEVICES_REQUESTS, emptyPorts, GATEWAY_REQUESTS, LANE_OFF, MACHINE_ADDON_REQUESTS, PAIR_WAIT_MS, SERVICE_HTTP_ROUTES, SERVICE_WS_FRAMES, WIFI_REQUESTS, LONG_ANSWERS, MODELS_OFF, STORE_OFF, MODELS_REQUESTS, MONITOR_OFF, OBSERVER_KEY_OFF, ORCHESTRATOR_FALLBACKS, RECAPS_FALLBACKS, resolveAgent, SHARED_MACHINES_FALLBACKS, SHARED_MACHINES_OFF, SHARING_FALLBACKS, MESSAGES_FALLBACKS, TAB_KEY_OFF, TAB_RELAY_OFF, TERMINALS_OFF, TURN_DELIVERERS, WIFI_FALLBACKS, WIFI_OFF, WORKSPACES_FALLBACKS, WORKSPACES_OFF, WORKSPACES_UNAVAILABLE, type CoreApiDeps } from './api.js'
import { FAIL, readFallback } from './serviceHost.js'
import { HACHI_ID } from '../dsh/builtinIds.js'
import { answerAgentQuery } from './agentQueries.js'
import { shownAgents } from './experimentQueries.js'
import { createDevicesLink } from './devicesLink.js'
import { createWorkspacesLink } from './workspacesLink.js'
import { createAgentLife } from './agentLife.js'
import { agentsIn, processCoreApi } from '../services/processCoreApi.js'
import { agentFacts, agentFrame } from '../lib/agentFrame.js'
import * as transcriptActivity from '../lib/transcriptActivity.js'
import { createFrameParts } from './frameParts.js'

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
    const frames = SERVICE_WS_FRAMES.filter(each => each.type === 'devices_ws')
    expect(frames.map((each) => [each.frame, each.type, each.result])).toEqual([
      ['route_task', 'devices_ws', 'route_result'], ['route_send', 'devices_ws', 'route_send_result'], ['voice_route_reply', 'devices_ws', undefined]])
    for (const each of frames) expect((DEVICES_REQUESTS as readonly string[]).includes(each.type)).toBe(true)
    const reason = 'the devices service is unavailable'
    expect(frames[0].unanswered).toEqual({ agentId: '', machineId: '', name: '', confidence: 0, reason, candidates: [], weighed: 0, machines: 0, via: '' })
    expect(frames[1].unanswered).toEqual({ ok: false, machine: '', reason })
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
      facts: session => agentFacts(session, session.agentId === 'live'),
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
      hasWindow: vi.fn(() => true),
      devicesChanged: vi.fn(),
      dialWatching: vi.fn(),
      wifi: WIFI_OFF,
      lastTurn: vi.fn(async () => null),
      turnCard: vi.fn(),
      turnSummary: vi.fn(),
      log: vi.fn(),
    })

  it('captures complete lean current session facts with parts last and no launch authority or retained service trees', async () => {
    const live = { ...row('live'), active: true, registeredAt: 1, lastHookAt: 2, transcriptPath: '/history/session',
      firstTask: 'PRIVATE', dsh: 'retained', gridLaunch: storedGridFixture({ networkId: 'fixture', networkName: 'Fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'PRIVATE' }), launch: { state: 'held', service: 'engine', detail: 'wait', nativeToken: 'PRIVATE' } } as RegisteredSession
    const hidden = { ...live, agentId: 'hidden', sessionId: '', launch: undefined, dsh: undefined }
    const deps = coreDeps(), order: string[] = []
    deps.registry.list = () => [live, hidden]
    deps.registry.byAgent = id => id === 'live' ? live : hidden
    const parts = { dsh: 'published', ignored: { secret: 'PRIVATE' } }
    deps.runtimeProfile = session => { order.push(`profile ${session.agentId}`); parts.dsh = session.agentId; return 'selected' }
    deps.turns.running = id => { order.push(`running ${id}`); return id === live.sessionId }
    deps.facts = session => { order.push(`facts ${session.agentId}`); return { displayName: session.agentId, terminalAvailable: session === live, parts } }
    deps.cloudRows = () => [{ ...live, agentId: 'cloud', displayName: 'Cloud name', runtimeProfile: 'cloud-profile' } as RegisteredSession]
    const pending = createCoreApi(deps).agents.snapshot()
    parts.dsh = 'after-await'; live.launch = { state: 'ready' }
    const captured = await pending
    expect(order).toEqual(['profile live', 'running s-live', 'facts live', 'profile hidden', 'running ', 'facts hidden'])
    expect(captured.registered).toHaveLength(2)
    expect(captured.registered[0]).toMatchObject({ session: { transcriptPath: '/history/session', launch: { state: 'held', service: 'engine', detail: 'wait' } },
      facts: { displayName: 'live', terminalAvailable: true, parts: { dsh: 'live' } }, selectedModel: 'selected', turnRunning: true })
    expect(captured.registered[1]).toMatchObject({ facts: { terminalAvailable: false }, turnRunning: false })
    expect(captured.registered[1].session).not.toHaveProperty('launch')
    expect(captured.registered[1].session).not.toHaveProperty('dsh')
    expect(captured.cloud).toEqual([{ agentId: 'cloud', sessionId: 's-live', engine: 'claude', registeredAt: 1,
      transcriptPath: '/history/session', lastHookAt: 2, displayName: 'Cloud name', selectedModel: 'cloud-profile' }])
    expect(JSON.stringify(captured)).not.toContain('PRIVATE')
    expect(deps.stoppedAgents.list).not.toHaveBeenCalled()
    // Optional source fields keep their exact absence and fallback meaning, without inventing full rows.
    deps.cloudRows = undefined; deps.facts = session => ({ displayName: session.agentId, terminalAvailable: true, parts: { dsh: null } })
    for (const launch of [{ state: 'starting' }, { state: 'ready' }, { state: 'failed', error: 'FAILED' },
      { state: 'failed', error: 'FAILED', detail: 'detail' }] as const) {
      live.launch = launch
      expect((await createCoreApi(deps).agents.snapshot()).registered[0].session.launch).toEqual(launch)
    }
    deps.cloudRows = () => [live]
    expect((await createCoreApi(deps).agents.snapshot()).cloud[0]).toMatchObject({ displayName: '', selectedModel: null })
  })

  it.each(['replaced', 'removed', 'unavailable'] as const)('refuses a session whose final facts provider makes it %s before detachment', async change => {
    const original = { ...row('live'), registeredAt: 1, lastHookAt: 0, transcriptPath: null, active: true }
    let current: RegisteredSession | undefined = original
    const deps = coreDeps()
    deps.registry.list = () => [original]; deps.registry.byAgent = () => current
    deps.turns.running = () => false
    deps.facts = () => {
      if (change === 'unavailable') return null as unknown as ReturnType<NonNullable<CoreApiDeps['facts']>>
      current = change === 'removed' ? undefined : { ...original, cwd: '/replacement' }
      return { displayName: 'old name', terminalAvailable: true, parts: { dsh: 'old/package' } }
    }
    await expect(createCoreApi(deps).agents.snapshot()).rejects.toThrow('SESSION_SNAPSHOT_UNAVAILABLE')
    expect(deps.log).toHaveBeenCalledExactlyOnceWith('[sessions] SESSION_SNAPSHOT_UNAVAILABLE')
  })

  it('refuses unavailable authority and bounds complete captures before copying rows or reading later providers', async () => {
    const live = { ...row('live'), registeredAt: 1, lastHookAt: 0, transcriptPath: null, active: true }
    const deps = coreDeps()
    deps.registry.list = () => [live]; deps.registry.byAgent = () => live
    deps.turns.running = () => false
    await expect(createCoreApi({ ...deps, facts: undefined }).agents.snapshot()).rejects.toThrow('SESSION_SNAPSHOT_UNAVAILABLE')
    await expect(createCoreApi({ ...deps, turns: { ...deps.turns, running: undefined } }).agents.snapshot()).rejects.toThrow('SESSION_SNAPSHOT_UNAVAILABLE')
    deps.runtimeProfile = () => { deps.registry.byAgent = () => undefined; return null }
    await expect(createCoreApi(deps).agents.snapshot()).rejects.toThrow('SESSION_SNAPSHOT_UNAVAILABLE')
    deps.registry.byAgent = () => live; deps.runtimeProfile = () => null
    const facts = vi.fn(() => ({ displayName: 'Live', terminalAvailable: true, parts: {} }))
    deps.facts = facts
    deps.registry.list = () => Array(SESSION_SNAPSHOT_MAX_ROWS + 1).fill(live)
    await expect(createCoreApi(deps).agents.snapshot()).rejects.toThrow('SESSION_SNAPSHOT_TOO_LARGE')
    expect(facts).not.toHaveBeenCalled()
    deps.registry.list = () => [live]
    deps.machine.name = () => 'x'.repeat(SESSION_SNAPSHOT_MAX_BYTES)
    await expect(createCoreApi(deps).agents.snapshot()).rejects.toThrow('SESSION_SNAPSHOT_TOO_LARGE')
    expect(facts).not.toHaveBeenCalled()
    deps.machine.name = () => 'Desk'
    deps.facts = () => ({ displayName: 'Live', terminalAvailable: true, parts: { dsh: 'x'.repeat(SESSION_SNAPSHOT_MAX_BYTES) } })
    await expect(createCoreApi(deps).agents.snapshot()).rejects.toThrow('SESSION_SNAPSHOT_TOO_LARGE')
    expect(deps.log).toHaveBeenCalledWith('[sessions] SESSION_SNAPSHOT_TOO_LARGE')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => captureSessionSnapshot({ ...deps, log: undefined })).toThrow('SESSION_SNAPSHOT_TOO_LARGE')
    expect(warn).toHaveBeenCalledWith('[sessions] SESSION_SNAPSHOT_TOO_LARGE'); warn.mockRestore()
    await expect(processCoreApi('/data', 'fixture').agents.snapshot()).rejects.toThrow('SESSION_SNAPSHOT_UNAVAILABLE')
  })

  it('captures current registered facts for app and component callers without widening shown replies', async () => {
    const live = { ...row('live'), active: true, registeredAt: 1, lastHookAt: 1, boundAt: 0,
      transcriptPath: null, defaultName: 'Before attachment', runtimes: [], primaryRuntimeKey: '' }
    let current: RegisteredSession | undefined = live
    const publication = { dsh: 'published/id', dshName: 'Published name', viewerUrl: null, viewerName: null, verdict: null }
    const deps = coreDeps()
    deps.registry.list = () => current ? [current] : []
    deps.registry.byAgent = id => id === 'live' ? current : undefined
    deps.registry.terminalAvailable = () => false
    deps.facts = session => agentFacts(session, deps.registry.terminalAvailable(session.agentId), publication)
    deps.runtimeProfile = () => 'runtime-v1:kept'
    const core = createCoreApi(deps), shown = core.agents.live()[0]
    const frame = await agentFrame(live, { selectedModel: 'runtime-v1:kept', terminalAvailable: false, parts: () => publication })
    expect(core.agents.facts({ ...shown, defaultName: 'stale caller name' })).toEqual({
      displayName: frame.name, terminalAvailable: frame.terminal.available, parts: publication,
    })
    expect(createCoreApi({ ...deps, facts: undefined }).agents.facts(shown)).toBeNull()
    expect(frame).toMatchObject({ name: 'Before attachment', launch: { state: 'ready' }, dsh: 'published/id', dshName: 'Published name' })
    expect(Object.hasOwn(shown, 'launch')).toBe(false)
    expect(shownAgents(core)).toEqual({ agents: [{ ...shown, displayName: frame.name,
      terminalAvailable: false, selectedModel: 'runtime-v1:kept', dshContext: null }] })
    live.dsh = 'old/id'
    expect(shownAgents(core)).toMatchObject({ agents: [{ dshContext: {
      id: 'published/id', name: 'Published name', viewerUrl: null, viewerName: null, verdict: null,
    } }] })
    current = undefined
    expect(core.agents.facts(shown)).toBeNull()
    expect(processCoreApi('/data', 'fixture', { live: () => [shown] }).agents.facts(shown)).toBeNull()
    expect(shownAgents(processCoreApi('/data', 'fixture', { live: () => [shown] }))).toEqual({ error: 'SESSION_FACTS_UNAVAILABLE' })
  })

  it('keeps app facts in their original await phases and rejects a newer run\'s publication', async () => {
    const live = { ...row('live'), active: true, registeredAt: 1, lastHookAt: 1, boundAt: 0,
      transcriptPath: null, defaultName: 'Before read', runtimes: [], primaryRuntimeKey: '' }
    let available = false, epoch = 'first'
    const deps = coreDeps()
    deps.registry.list = () => [live]
    deps.registry.byAgent = id => id === 'live' ? live : undefined
    deps.registry.terminalAvailable = () => available
    deps.facts = session => agentFacts(session, deps.registry.terminalAvailable(session.agentId), parts.read(session.agentId))
    const core = createCoreApi(deps)
    const parts = createFrameParts({ core, epoch: () => epoch, hosts: { fixture: {
      services: ['fixture'], heapLimitMiB: 1, rssLimitMiB: 0,
      frameParts: { fixture: { fields: ['dsh', 'dshName'] } },
    } } })
    const publisher = parts.scope('fixture', core)
    publisher.agents.publishFrame!({ ...live, frameEpoch: epoch }, { dsh: 'first/id', dshName: 'First' })
    let release!: (value: number) => void
    const reading = vi.spyOn(transcriptActivity, 'transcriptActivityAt').mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    try {
      const pending = agentFrame(live, { selectedModel: 'caller-selected', terminalAvailable: available, parts: parts.forFrame(live) })
      expect(reading).toHaveBeenCalledOnce()
      live.defaultName = 'After read'; available = true; epoch = 'replacement'
      publisher.agents.publishFrame!({ ...live, frameEpoch: epoch }, { dsh: 'replacement/id', dshName: 'Replacement' })
      release(1)
      expect(await pending).toMatchObject({ name: 'After read', terminal: { available: false },
        selectedModel: 'caller-selected', dsh: null, dshName: null })
      expect(core.agents.facts(live)).toEqual({ displayName: 'After read', terminalAvailable: true,
        parts: { dsh: 'replacement/id', dshName: 'Replacement' } })
      const changedDuringFormat = await agentFrame(live, { selectedModel: 'caller-selected', terminalAvailable: available,
        parts: parts.forFrame(live), waitingFor: () => { epoch = 'third'; return null } })
      expect(changedDuringFormat).toMatchObject({ dsh: null, dshName: null })
    } finally { reading.mockRestore() }
  })

  it('keeps every registered row and its raw launch state separate from app defaults and terminal membership', async () => {
    const registered: RegisteredSession[] = [
      { ...row('unbound'), sessionId: '', active: true },
      { ...row('starting'), active: true, launch: { state: 'starting' as const } },
      { ...row('ready'), active: true, launch: { state: 'ready' as const } },
      { ...row('failed'), active: true, launch: { state: 'failed' as const, error: 'ENGINE_DID_NOT_START', detail: 'See terminal.' } },
      { ...row('inactive'), active: false },
    ].map(session => ({ ...session, registeredAt: 1, transcriptPath: null, runtimes: [], primaryRuntimeKey: '' }))
    const deps = coreDeps()
    deps.registry.list = () => registered
    deps.registry.byAgent = id => registered.find(session => session.agentId === id)
    deps.registry.terminalAvailable = id => id === 'ready'
    deps.registry.advertised = () => registered.filter(session => deps.registry.terminalAvailable(session.agentId))
    deps.facts = session => agentFacts(session, deps.registry.terminalAvailable(session.agentId))
    const core = createCoreApi(deps)
    const shown = shownAgents(core).agents as Array<Record<string, unknown>>
    expect(shown.map(session => session.agentId)).toEqual(registered.map(session => session.agentId))
    expect(core.agents.advertised().map(session => session.agentId)).toEqual(['ready'])
    expect(shown.map(session => session.terminalAvailable)).toEqual([false, false, true, false, false])
    for (const [index, session] of registered.entries()) {
      const facts = core.agents.facts(session)!
      const frame = await agentFrame(session, { selectedModel: null, terminalAvailable: facts.terminalAvailable })
      expect(shown[index]).toEqual({ ...session, displayName: frame.name, terminalAvailable: frame.terminal.available,
        selectedModel: null, dshContext: null })
      expect(frame.launch).toEqual(session.launch ?? { state: 'ready' })
      expect(frame.status).toBe(session.active ? 'active' : 'offline')
      expect(Object.hasOwn(shown[index], 'launch')).toBe(Object.hasOwn(session, 'launch'))
    }
  })

  it.each(['credential', 'null', 'absent'] as const)('keeps %s launch custody out of every service agent read', async (kind) => {
    const override = storedGridFixture({ networkId: 'fixture', networkName: 'Fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic-agent-view-canary' })
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
    deps.stoppedAgents.list = async () => [stopped]
    const core = createCoreApi({ ...deps, cloudRows: () => [cloud] })
    const views = [...await core.agents.all(), ...core.agents.live(), ...core.agents.advertised(),
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
    expect(JSON.stringify(views)).not.toContain(override.credential.binding)
    expect(views.every(session => !Object.hasOwn(session, 'gridLaunch'))).toBe(true)
    expect(core.agents.byAgent('missing')).toBeUndefined()
    expect(core.agents.resolve('missing')).toBeUndefined()
  })

  it('sends metadata without launch credentials through every agent-list service dispatch', async () => {
    const override = storedGridFixture({ networkId: 'fixture', networkName: 'Fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic-agent-dispatch-canary' })
    const live: RegisteredSession = { ...row('live'), dsh: 'fixture', browser: true, gridLaunch: override }
    const stopped = { ...row('stopped'), gridLaunch: override }
    const deps = coreDeps()
    deps.registry.list = () => [live]
    deps.registry.advertised = () => [live]
    deps.stoppedAgents.list = async () => [stopped]
    const core = createCoreApi(deps)
    const replies = await Promise.all(['agents', 'live', 'advertised'].map(query => answerAgentQuery(core, query)))
    replies.push(shownAgents(core))
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
    expect(sent).not.toContain(override.credential.binding)
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
    const cloud = { checkpoint: vi.fn(() => 'a'.repeat(64)), publish: vi.fn(() => ({ ok: true as const })), ask: vi.fn(), unask: vi.fn() }
    expect(createCoreApi({ ...deps, cloud }).cloud).toBe(cloud)
    expect(core.agents.cloud).toBeUndefined()
    const rows = [{ agentId: 'cloud_1' }] as RegisteredSession[]
    expect(createCoreApi({ ...deps, cloudRows: () => rows }).agents.cloud!()).toEqual(rows)
    expect(core.dataDir).toBe('/data')
    expect(await core.terminals.open({ argv: ['/bin/zsh'], cwd: '/work' })).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
    const terminals = { ...TERMINALS_OFF, open: vi.fn(async () => ({ ok: true as const, agentId: 'shell' })), watch: TERMINALS_OFF.watch }
    expect(createCoreApi({ ...deps, terminals }).terminals).toBe(terminals)
    expect((await core.agents.all()).map((s) => s.agentId)).toEqual(['live', 'stopped'])
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

  it('grants local delivery only for the authenticated service and declared target/type pair', () => {
    const declarations = SERVICE_HOSTS.devices.windows!, send = vi.fn(() => true), log = vi.fn()
    const delivery = (kind: string, type: string) => ({ target: kind === 'connection' ? { kind, connId: 'physical-window' } : { kind }, frame: { type, payload: {} } })
    for (const [service, rights] of Object.entries(declarations)) {
      for (const [kind, frames] of Object.entries(rights)) for (const type of frames!) {
        const frame = delivery(kind, type)
        expect(sendLocalWindow(frame, rights, send, log)).toBe(true)
        expect(send).toHaveBeenLastCalledWith(frame)
        expect(createCoreApi(coreDeps()).clients.sendWindow(frame as never)).toBe(false)
      }
    }
    for (const [rights, kind, type] of [
      [declarations.wifi, 'all', 'device_focus'], [declarations.wifi, 'connection', 'device_prepare_open'],
      [declarations.devices, 'first', 'device_focus'], [declarations.devices, 'all', 'device_focus'],
      [declarations.devices, 'all', 'dial_form'], [declarations.devices, 'connection', 'dial_focus'],
      [declarations.wifi, 'first', 'agent_deleted'], [undefined, 'first', 'device_focus'],
      [{ first: undefined }, 'first', 'device_focus'],
    ] as const) expect(sendLocalWindow(delivery(kind, type), rights, send, log)).toBe(false)
    expect(log.mock.calls.every(([line]) => line === '[services] WINDOW_FRAME_REFUSED')).toBe(true)
  })

  it('refuses malformed local delivery without forwarding content or trusting prototype keys', () => {
    const rights = SERVICE_HOSTS.devices.windows!.wifi, send = vi.fn(() => true), log = vi.fn()
    const valid = { target: { kind: 'first' }, frame: { type: 'device_focus', payload: {} } }
    const bad = [undefined, null, [], new Date(), {}, { target: valid.target }, { ...valid, frame: { type: 'device_focus' } }, { ...valid, target: null }, { ...valid, target: [] },
      { ...valid, frame: null }, { ...valid, frame: [] }, { ...valid, frame: { ...valid.frame, payload: null } },
      { ...valid, frame: { ...valid.frame, payload: [] } }, { ...valid, frame: { ...valid.frame, payload: new Date() } },
      { ...valid, target: { kind: 'constructor' } }, { ...valid, target: {} },
      { ...valid, target: { kind: 'first', connId: 'chosen' } }, { ...valid, frame: { payload: {} } },
      { ...valid, frame: { type: 3, payload: {} } }, { ...valid, target: Object.create({ kind: 'first' }) },
      { ...valid, frame: Object.create(valid.frame) }]
    for (const frame of bad) expect(sendLocalWindow(frame, rights, send, log)).toBe(false)
    for (const target of [{ kind: 'connection' }, { kind: 'connection', connId: '' }, { kind: 'connection', connId: 1 },
      { kind: 'connection', connId: 'x'.repeat(257) }, { kind: 'connection', connId: 'w', extra: true }]) {
      expect(sendLocalWindow({ target, frame: { type: 'dial_form', payload: {} } }, SERVICE_HOSTS.devices.windows!.devices, send, log)).toBe(false)
    }
    expect(send).not.toHaveBeenCalled()
    const plain = Object.assign(Object.create(null), valid)
    plain.target = Object.assign(Object.create(null), valid.target)
    plain.frame = { ...valid.frame, payload: Object.create(null) }
    expect(sendLocalWindow(plain, rights, send, log)).toBe(true)
    send.mockReturnValueOnce(false)
    expect(sendLocalWindow(valid, rights, send, log)).toBe(false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try { expect(sendLocalWindow(null, rights, send)).toBe(false); expect(warn).toHaveBeenCalledWith('[services] WINDOW_FRAME_REFUSED') }
    finally { warn.mockRestore() }
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
    for (const member of ['delivery', 'input', 'disconnected', 'revealed'] as const) {
      expect(WIFI_FALLBACKS[member], member).toBeUndefined()
    }
  })

  it('gives a service that is not the Wi-Fi device\'s doors that list, send, make and move nothing', async () => {
    expect(await WIFI_OFF.stop('a')).toBe(false)
    expect(await WIFI_OFF.create('p', 'claude', '/w')).toEqual({ ok: false, error: 'UNSUPPORTED' })
    expect(await WIFI_OFF.stepFocus('next')).toBe('no_app')
    expect(WIFI_OFF.scroll('down', 0, 0)).toBe(false)
    expect(WIFI_OFF).not.toHaveProperty('focusApp')
    expect(WIFI_OFF).not.toHaveProperty('reveal')
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
import { storedGridFixture } from '../testing/gridCredentials.js'
