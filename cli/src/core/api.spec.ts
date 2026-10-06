import { describe, expect, it, vi } from 'vitest'
import { projectDisplayName, type RegisteredSession } from '../lib/registry.js'
import { ACCOUNT_BACKEND_OFF, AGENT_ACTIONS_OFF, createCoreApi, DAEMON_UNKNOWN, DELIVERIES_OFF, DEVICES_FALLBACKS, emptyPorts, LANE_OFF, LONG_ANSWERS, MODELS_OFF, MODELS_REQUESTS, MONITOR_OFF, OBSERVER_KEY_OFF, ORCHESTRATOR_FALLBACKS, resolveAgent, SHARING_FALLBACKS, TEAMS_FALLBACKS, TERMINALS_OFF, WIFI_FALLBACKS, WIFI_OFF, type CoreApiDeps } from './api.js'
import { FAIL, readFallback } from './serviceHost.js'

const row = (agentId: string) => ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: '/work/app' }) as RegisteredSession

describe('the core API services stand on', () => {
  it('gives a service with no lane of the core\'s nothing to seal with, and never its frame back in the clear', async () => {
    await expect(LANE_OFF.hello('m', 'pub')).rejects.toThrow(/no E2EE identity/)
    expect(await LANE_OFF.welcome('m', {})).toBe(false)
    await expect(LANE_OFF.rekey('m', {})).resolves.toBeUndefined()
    expect(await LANE_OFF.seal('m', { type: 'message', payload: { text: 'hello' } })).toEqual({ lost: true })
    expect(await LANE_OFF.open('m', { type: 'message' })).toEqual({ lost: true })
    expect(LANE_OFF.drop('m')).toBeUndefined()
  })

  it('gives a service with no delivery of the core\'s nothing to write, take back or hear', async () => {
    expect(DELIVERIES_OFF.deliver('a', 'hello', 'd1')).toBeUndefined()
    expect(DELIVERIES_OFF.cancelDelivery('d1')).toBe(false)
    expect(DELIVERIES_OFF.onDelivery(() => {})()).toBeUndefined()
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
      stoppedAgents: { list: vi.fn(() => [row('stopped')]) } as unknown as CoreApiDeps['stoppedAgents'],
      databaseHistory: vi.fn(),
      externalSessions: { list: vi.fn(), scan: vi.fn() } as unknown as CoreApiDeps['externalSessions'],
      openSessions: { known: vi.fn(), fresh: vi.fn() } as unknown as CoreApiDeps['openSessions'],
      syncSession: vi.fn(),
      runtimeModels: vi.fn(async () => []),
      viewerChanged: vi.fn(),
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
      log: vi.fn(),
    })

  it('lists every agent, live then stopped, and names them as the apps do', async () => {
    const deps = coreDeps()
    const core = createCoreApi(deps)
    expect(core.dataDir).toBe('/data')
    expect(await core.terminals.open({ argv: ['/bin/zsh'], cwd: '/work' })).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
    const terminals = { open: vi.fn(async () => ({ ok: true as const, agentId: 'shell' })), watch: TERMINALS_OFF.watch }
    expect(createCoreApi({ ...deps, terminals }).terminals).toBe(terminals)
    expect(core.agents.all().map((s) => s.agentId)).toEqual(['live', 'stopped'])
    expect(core.agents.live().map((s) => s.agentId)).toEqual(['live'])
    expect(core.agents.displayName).toBe(projectDisplayName)
    expect(core.transcripts.databaseHistory).toBe(deps.databaseHistory)
    expect(core.external.sessions).toBe(deps.externalSessions)
    expect(core.external.open).toBe(deps.openSessions)
    expect(core.agents.byAgent('live')?.agentId).toBe('live')
    expect(core.agents.byAgent('gone')).toBeUndefined()
    expect(core.agents.resolve('s-live')?.agentId).toBe('live')
    expect(core.agents.resolve('gone')).toBeUndefined()
    expect(core.agents.terminalAvailable('live')).toBe(true)
    expect(core.agents.sync).toBe(deps.syncSession)
    expect(core.agents.runtimeModels).toBe(deps.runtimeModels)
    expect(core.clients.viewerChanged).toBe(deps.viewerChanged)
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
    expect(core.account.signedIn).toBe(deps.signedIn)
    expect(core.account.environment).toBe(deps.environment)
    expect(core.account.machines).toBe(deps.machines)
    expect(core.clients.hasWindow).toBe(deps.hasWindow)
    expect(core.clients.devicesChanged).toBe(deps.devicesChanged)
    expect(core.clients.dialWatching).toBe(deps.dialWatching)
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

  it('answers ⌘K, when the devices fail, with no agent picked and nothing sent, saying why', async () => {
    const reason = 'the devices service is unavailable'
    expect(await (readFallback(DEVICES_FALLBACKS.routeTask).value)).toMatchObject({ agentId: '', reason, candidates: [] })
    expect(readFallback(DEVICES_FALLBACKS.routeSend)).toEqual({ deferred: true, value: { ok: false, machine: '', reason } })
    // The Wi-Fi device finds no desk to walk; the dial and the window bridges hear nothing.
    expect(readFallback(DEVICES_FALLBACKS.stepFocus).value).toBe('no_agents')
    for (const member of ['card', 'desk', 'swarms', 'unread', 'appFocus', 'seen', 'settings', 'windowFocus', 'windowReply', 'voiceReply', 'windowGone', 'scroll', 'engines', 'commanders'] as const) {
      expect(DEVICES_FALLBACKS[member], member).toBeUndefined()
    }
    expect(readFallback(DEVICES_FALLBACKS.stop)).toEqual({ deferred: true, value: undefined })
    expect(FAIL).toBeTypeOf('symbol')
  })

  it('answers, when the Wi-Fi device\'s service is off, nothing to its devices and "not running" to a receipt', () => {
    expect(readFallback(WIFI_FALLBACKS.receipt)).toEqual({ deferred: true, value: { unavailable: true } })
    for (const member of ['request', 'resume', 'appFocus', 'stop'] as const) {
      expect(readFallback(WIFI_FALLBACKS[member]), member).toEqual({ deferred: true, value: undefined })
    }
    for (const member of ['session', 'dropped', 'revoked', 'card', 'turnStarted', 'turnEnded', 'stream', 'transcript', 'delivery',
      'dispatched', 'inputStatus', 'agentGone', 'revealed'] as const) {
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
    await expect(WIFI_OFF.submit('a', 't', 'd')).resolves.toBeUndefined()
    for (const call of [() => WIFI_OFF.cancel('d'), () => WIFI_OFF.started('a', 't'),
      () => WIFI_OFF.reveal('o', 'a'), () => WIFI_OFF.send('c', 'i', 't', {}), () => WIFI_OFF.hello('c', null), () => WIFI_OFF.joined(), () => WIFI_OFF.ready(),
      () => WIFI_OFF.unpaired('i'), () => WIFI_OFF.focus('r'), () => WIFI_OFF.transcripts('a', 0), () => WIFI_OFF.watching([]),
      () => WIFI_OFF.streams([])]) expect(call()).toBeUndefined()
  })

  it('falls back, when the teams fail, to an undo that has nothing to undo, and holds no pane for a team', () => {
    const undo = TEAMS_FALLBACKS.prepare as () => void
    expect(undo()).toBeUndefined()
    expect(TEAMS_FALLBACKS.canWrite).toBe(false)
  })

  it('starts with every port empty: a service fills its own when it starts', () => {
    expect(emptyPorts()).toEqual({ search: null, viewers: null, models: null, workspaces: null, teams: null, devices: null, wifi: null, monitor: null, orchestrator: null, sharing: null })
    expect(emptyPorts()).not.toBe(emptyPorts())
  })

  it('answers models\' fallbacks while it is off: no set-up and no target, no note and no prewarm, no name of its own', async () => {
    const grid = { baseUrl: 'https://fixture.invalid/g/n1/relay/v1', model: 'm' }
    const launch = { networkId: 'n1', networkName: 'mine', baseUrl: grid.baseUrl, apiKey: 'k' }
    await expect(MODELS_OFF.ensure()).rejects.toThrow('the models service is unavailable')
    await expect(MODELS_OFF.launchTarget({ model: 'm', grid: 'mine' })).rejects.toThrow('the models service is unavailable')
    await expect(MODELS_OFF.moveTarget({ gridName: null, model: 'm' })).rejects.toThrow('the models service is unavailable')
    await expect(MODELS_OFF.lists()).rejects.toThrow('the models service is unavailable')
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
  })

  it('gives a service that acts on no agent nothing to create and no harness to read, and a daemon it was never told of', async () => {
    expect(await AGENT_ACTIONS_OFF.create({ engine: 'claude', cwd: '/w', dsh: null, prompt: 'p', name: 'n', bypassPermission: false }))
      .toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
    expect(AGENT_ACTIONS_OFF.dsh(row('a'))).toBeNull()
    expect(DAEMON_UNKNOWN.machineId()).toBe('')
  })

  it('gives a service that reads no backend an unavailable answer, and no notice to hear', async () => {
    expect(await ACCOUNT_BACKEND_OFF.backend('GET', '/api/tab-channels')).toEqual({ status: 503, body: { error: 'SERVICE_UNAVAILABLE' } })
    expect(ACCOUNT_BACKEND_OFF.onNotice(() => {})()).toBeUndefined()
  })

  it('watches no terminal and signs nothing for a service without the core\'s terminals or key', async () => {
    await expect(TERMINALS_OFF.watch.frame('observer:x', 'terminal_open', {})).resolves.toBeUndefined()
    await expect(TERMINALS_OFF.watch.close('observer:x')).resolves.toBeUndefined()
    expect(TERMINALS_OFF.watch.onOutput(() => {})()).toBeUndefined()
    await expect(OBSERVER_KEY_OFF.publicKey()).rejects.toThrow('no E2EE identity')
    await expect(OBSERVER_KEY_OFF.signWelcome('m', 's', 'p', 'e')).rejects.toThrow('no E2EE identity')
    expect(SHARING_FALLBACKS).toEqual({ observer: undefined, linkDown: undefined, stop: undefined })
  })

  it('answers no role and reads no frame while the orchestrator is off', () => {
    expect(ORCHESTRATOR_FALLBACKS).toEqual({ roleOf: null, frame: undefined, stop: undefined })
  })

  it('answers the monitor\'s fallbacks while it is off: no readings, nothing measured to forget', async () => {
    await expect(MONITOR_OFF.resources()).rejects.toThrow('the monitor service is unavailable')
    expect(await MONITOR_OFF.storage([], true)).toEqual(new Map())
  })
})
