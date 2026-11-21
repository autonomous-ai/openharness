/**
 * The gateway's process and the core's link to it, spoken end to end in memory: what one side says, the
 * other hears as the same call. The relay itself is a stand-in here (gateway/gateway.spec.ts and the socket's
 * specs hold its rules); what this holds is that nothing is lost or renamed on the way between the processes.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { clearAuthSession, writeAuthSession } from '../lib/authSession.js'
import type { GatewayEvents, GatewayOps, GatewayPort, WindowRelay } from '../core/api.js'
import { createGatewayLink } from '../core/gatewayLink.js'
import { GATEWAY_CALLS } from '../lib/gatewayWire.js'
import { RelayConnectError } from '../lib/relayFrames.js'
import { encodeTerminalLocal, TerminalBinaryKind, type TerminalBinaryClear } from '../lib/terminalBinary.js'
import type { CoreConnection, ServiceProcessOptions } from '../services/process.js'
import { b64e, newIdentity } from '../lib/e2ee/core.js'
import { runGatewayService } from './gatewayProcess.js'
import type { GatewayHost, StartedGateway } from './start.js'
import { TabSessions } from './tabKey.js'
import { countUsage } from './usageEvents.js'

const STREAM = '00000000-0000-4000-8000-000000000002'
const alice = newIdentity(), bob = newIdentity()
const clear: TerminalBinaryClear = { kind: TerminalBinaryKind.input, streamId: STREAM, seq: 3, compressed: false, bytes: new Uint8Array([108, 115]) }

function stubGateway() {
  const port = {
    usage: vi.fn(), usageCounter: vi.fn(), connect: vi.fn(), serveThisComputerOnly: vi.fn(), holdRequests: vi.fn(), openRequests: vi.fn(), connected: vi.fn(() => true),
    broadcast: vi.fn(), commander: vi.fn(), user: vi.fn(), reply: vi.fn(), target: vi.fn(() => true), terminal: vi.fn(() => true),
    terminalBinary: vi.fn(() => true), observer: vi.fn(() => true), windowOpened: vi.fn(), localClients: vi.fn(), local: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  } satisfies GatewayPort
  const answer = { status: 200, body: { ok: true } }
  const legacyConnectorVault = {
      seal: vi.fn(async (plaintext: string) => { if (!plaintext) throw new Error('nothing to seal'); return { sealed: plaintext } }),
      open: vi.fn(async (envelope: unknown) => ((envelope as { sealed?: string })?.sealed ? { plaintext: (envelope as { sealed: string }).sealed, complete: true } : null)),
    }
  const ops = {
    accessToken: vi.fn(async () => 'never asked: the process answers the core from its own renewal'),
    backend: vi.fn(async (_method: string, _path: string, _body?: unknown) => answer),
    machines: vi.fn(async (_fallback?: boolean) => answer), mintGridName: vi.fn(async (): Promise<string | null> => 'private-grid'),
    status: vi.fn(async () => ({ fingerprint: 'AB12', pairs: [], pending: null })),
    account: vi.fn(), reachable: vi.fn(),
    lane: {
      hello: vi.fn(async (machineId: string) => ({ type: 'e2e_hello', machineId })), welcome: vi.fn(async () => true),
      rekey: vi.fn(async () => {}), seal: vi.fn(async (_m: string, frame: Record<string, unknown>) => ({ frame: { ...frame, sealed: true } })),
      open: vi.fn(async () => ({ unreadable: true as const })), drop: vi.fn(),
    },
    observerKey: {
      publicKey: vi.fn(async () => 'cHVi'),
      signWelcome: vi.fn(async (_m: string, shareId: string) => { if (shareId === 'bad') throw new Error('not a welcome to an observer'); return 'c2ln' }),
    },
    connectorSync: vi.fn(async () => ({ shared: true })),

    tabKey: new TabSessions(() => alice, () => 'alice-mac'),
    tabRelay: { open: vi.fn(async () => {}), send: vi.fn(async (_tab: string, to: string) => to === 'alice-mac'), close: vi.fn() },
    sharedTrust: vi.fn(async (desired: { pins?: unknown[]; keys?: unknown[] }) => {
      if (desired.pins?.length === 0 && desired.keys?.length === 0) throw new Error('stores unwritable')
      return { pins: desired.pins?.length ?? -1, keys: desired.keys?.length ?? -1 }
    }),
  } satisfies GatewayOps
  const sessions: Array<{ send: ReturnType<typeof vi.fn>; sendBinary: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn> }> = []
  const windowRelay = {
    acquire: vi.fn(async () => { const session = { send: vi.fn(async () => {}), sendBinary: vi.fn(async () => {}), detach: vi.fn() }; sessions.push(session); return session }),
    acquireIsolated: vi.fn(async () => { throw new RelayConnectError('NO_PEER_LINK') }),
    invalidate: vi.fn(), invalidateIsolated: vi.fn(),
    acquireShare: vi.fn(async (_machineId: string, shareId: string) => {
      if (shareId === 'ended') throw new RelayConnectError('Sharing ended or invitation expired', 4403)
      const session = { send: vi.fn(async () => {}), sendBinary: vi.fn(async () => {}), detach: vi.fn() }
      sessions.push(session)
      return session
    }),
  } satisfies WindowRelay
  const requests = {
    gateway_http: vi.fn(async (payload: Record<string, unknown>) => ({ status: 200, body: { devices: [], asked: payload.target } })),
    gateway_ws: vi.fn(async () => ({ handled: false })),
  }
  return { port, ops, legacyConnectorVault, windowRelay, requests, sessions, stop: vi.fn(async () => {}) }
}

function wire() {
  let options!: ServiceProcessOptions
  const gateways: Array<ReturnType<typeof stubGateway>> = []
  const hosts: GatewayHost[] = []
  const linkStop = vi.fn()
  // The process's own renewal of the sign-in (lib/authRefresh.ts), which reaches no backend here.
  const tokens = { accessToken: vi.fn(async (_options?: { force?: boolean; failedToken?: string }) => 'token-a') }
  const service = runGatewayService({
    dataDir: '/data', socketPath: '/data/daemon.sock', machineId: 'computer-1', token: 'token', tokens,
    run: (given) => { options = given; return { stop: linkStop } },
    start: (host) => { hosts.push(host); const stub = stubGateway(); gateways.push(stub); return stub as unknown as StartedGateway },
  })
  const heard = {
    frame: vi.fn(), binary: vi.fn(), client: vi.fn(), disconnected: vi.fn(), observer: vi.fn(), toLocal: vi.fn(), status: vi.fn(),
    linkDown: vi.fn(), commanders: vi.fn(), commanderJoined: vi.fn(), meta: vi.fn(), notice: vi.fn(), revoked: vi.fn(), busy: vi.fn(),
    toWindows: vi.fn(), tabFrame: vi.fn(),
    streamControl: vi.fn(),
  }
  const backend = vi.fn(async () => ({ status: 200, body: { data: { acct: 'a' } } }))
  const wifiServing = vi.fn(async () => true)
  const link = createGatewayLink({
    events: heard as unknown as GatewayEvents,
    notify: (frame) => { options.onEvent!(frame.payload as Record<string, unknown>); return true },
    notifyBinary: (bytes) => { options.onBinary!(bytes); return true },
    buffered: () => 0,
    call: async (type, payload) => {
      try { return { ...await options.requests[type](payload, { local: true, owner: true }) } } catch { return { error: 'SERVICE_FAILED' } }
    },
    start: () => ({ machineId: 'machine-1', computerId: 'computer-1', autonomousEnv: 'prod', signedIn: true, account: { machineId: 'machine-1', signIn: null } }),
    backend, wifiServing,
  })
  const core: CoreConnection = {
    query: (query, payload = {}) => link.answer(query, payload),
    notice: (kind, payload = {}) => link.notice({ ...payload, kind }),
    sendBinary: (bytes) => { link.binary(bytes); return true },
  }
  const connect = () => { options.onConnected!(core); link.connected() }
  const disconnect = () => { options.onDisconnected!(); link.disconnected() }
  return { link, heard, gateways, hosts, core, connect, disconnect, tokens, backend, wifiServing, options: () => options, service, linkStop }
}

describe('the gateway\'s process, spoken to by the core', () => {
  it('binds pane answers to the original core and gateway while keeping physical callback credit process-owned', async () => {
    const w = wire()
    const query = vi.spyOn(w.core, 'query')
    query.mockImplementation(async name => name === 'follow_agents' ? { agents: [] } : { agentId: 'a1', guest: true })
    w.connect()
    const first = w.hosts[0]
    expect(await first.agents!.ofPane!('%1')).toEqual({ agentId: 'a1', guest: true })
    let answer!: (value: Record<string, unknown>) => void
    query.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    const pending = first.agents!.ofPane!('%1')
    w.disconnect()
    w.connect()
    answer({ agentId: 'stale-agent' })
    expect(await pending).toBeNull()
    const calls = query.mock.calls.length
    expect(await first.agents!.ofPane!('%1')).toBeNull()
    expect(query).toHaveBeenCalledTimes(calls)
    expect(w.hosts[1].callbackReplay).toBe(first.callbackReplay)
    expect(await w.hosts[1].agents!.ofPane!('%1')).toEqual({ agentId: 'a1', guest: true })
    await w.service.stop()
  })

  it('passes browser provenance and cancellation intact, and returns unavailable after gateway loss', async () => {
    const w = wire()
    const request = w.options().requests.gateway_ws!
    const frame = { frame: 'browser_callback', payload: { url: 'http://localhost:1/callback' } }
    const asker = { local: false, owner: true, connection: 'phone-1' }
    const closed = new AbortController().signal
    expect(await request(frame, asker, closed)).toEqual({ error: 'SERVICE_UNAVAILABLE' })
    w.connect()
    expect(await request(frame, asker, closed)).toEqual({ handled: false })
    expect(w.gateways[0].requests.gateway_ws).toHaveBeenCalledWith(frame, asker, closed)
    w.disconnect()
    expect(await request(frame, asker, closed)).toEqual({ error: 'SERVICE_UNAVAILABLE' })
    await w.service.stop()
  })

  it('delivers current input facts without replaying an old source to a replacement gateway', async () => {
    const w = wire()
    vi.spyOn(w.core, 'query').mockResolvedValue({ agents: [] })
    w.connect()
    const first = vi.fn(), second = vi.fn()
    const unfollow = w.hosts[0].agents!.follow!(first)
    const fact = { kind: 'input', agentId: 'a1', startedByAgent: false, source: { connection: 'phone-1', clientKind: 'phone' } }
    w.options().onEvent!({ kind: 'agent', event: fact })
    expect(first).toHaveBeenCalledWith(fact)
    unfollow()
    w.disconnect()
    w.connect()
    w.hosts[1].agents!.follow!(second)
    expect(second).not.toHaveBeenCalled()
    w.options().onEvent!({ kind: 'agent', event: { ...fact, source: { connection: 'phone-2', clientKind: 'phone' } } })
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
    await w.service.stop()
  })

  it('keeps service counters under recorder admission even when provenance is malformed', () => {
    const w = wire(), counted: string[] = []
    w.connect()
    const gateway = w.gateways[0]
    gateway.port.usage.mockImplementation(event => countUsage(event, metric => counted.push(metric), () => {}))
    const receive = (payload: Record<string, unknown>) => w.options().onEvent!({ kind: 'usageCounter', ...payload })
    receive({ service: 'hachi', metric: 'hachi_wake_done' })
    receive({ service: 'agentBrowser', metric: 'agent_browser_failed_podman_old' })
    receive({ service: 'agentBrowser', metric: 'hachi_wake_done' })
    receive({ service: 'hachi', metric: 'ui_desktop_hachi_opened' })
    for (const service of [null, 1, {}, 'unknown']) receive({ service, metric: 'hachi_wake_done' })
    receive({ service: 'hachi', metric: null })
    expect(counted).toEqual(['hachi_wake_done', 'agent_browser_failed_podman_old'])
    expect(gateway.port.usageCounter).not.toHaveBeenCalled()
    receive({ metric: 'create_failed' })
    expect(gateway.port.usageCounter).toHaveBeenCalledExactlyOnceWith('create_failed')
  })

  it('binds wake admission and delayed readiness to the originating gateway and core connection', async () => {
    const w = wire()
    w.connect()
    let finish!: (value: boolean) => void
    w.wifiServing.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const old = w.hosts[0].wifiServing!()
    expect(w.wifiServing).toHaveBeenCalledOnce()
    w.disconnect(); w.connect()
    finish(true)
    expect(await old).toBe(false)
    expect(await w.hosts[0].wifiServing!()).toBe(false)
    expect(w.wifiServing).toHaveBeenCalledOnce()
    expect(await w.hosts[1].wifiServing!()).toBe(true)
    expect(w.wifiServing).toHaveBeenCalledTimes(2)
    await w.service.stop()
  })

  it('builds the gateway only when a core says start, with what the core holds, and again on each start', async () => {
    const w = wire()
    w.link.port.holdRequests()
    w.link.port.connect()
    w.link.port.localClients({ desktop: 1, tui: 2 })
    w.link.ops.reachable(['m2'])
    expect(w.gateways).toHaveLength(0)
    w.connect()
    expect(w.gateways).toHaveLength(1)
    const [gateway] = w.gateways
    expect(w.hosts[0]).toMatchObject({ machineId: 'machine-1', computerId: 'computer-1', autonomousEnv: 'prod', signedIn: true, account: { machineId: 'machine-1', signIn: null } })
    expect(gateway.port.holdRequests).toHaveBeenCalled()
    expect(gateway.port.localClients).toHaveBeenCalledWith({ desktop: 1, tui: 2 })
    expect(gateway.ops.reachable).toHaveBeenCalledWith(['m2'])
    expect(gateway.port.connect).toHaveBeenCalled()
    w.link.port.usage?.({ kind: 'observed', payload: { measure: 'collector_days' } })
    expect(gateway.port.usage).toHaveBeenCalledWith({ kind: 'observed', payload: { measure: 'collector_days' } })
    w.link.port.usageCounter?.('create_failed')
    expect(gateway.port.usageCounter).toHaveBeenCalledWith('create_failed')
    // Its tokens are its process's own to renew, one renewal for every start (the core audit of 2026-11-12, decision
    // 4): it asks the core for none.
    expect(w.hosts[0].tokens).toBe(w.tokens)
    // The core going stops it; the next core builds a new one, signed out this time serving this computer only.
    w.disconnect()
    expect(gateway.stop).toHaveBeenCalled()
    w.link.port.serveThisComputerOnly()
    w.link.port.openRequests()
    w.connect()
    expect(w.gateways).toHaveLength(2)
    expect(w.gateways[1].port.serveThisComputerOnly).toHaveBeenCalled()
    expect(w.gateways[1].port.holdRequests).not.toHaveBeenCalled()
    expect(w.hosts[1].tokens).toBe(w.tokens)
  })

  it('hands the core the account\'s token from its own renewal, and the session\'s own refusal', async () => {
    // Expired on disk: the core reads a token that needs no renewal itself, and asks this process to renew one.
    writeAuthSession({ version: 1, accessToken: 'expired', refreshToken: 'r-1', expiresAt: Date.now() - 1, autonomousEnv: 'prod', computerId: 'computer-1', updatedAt: 1 })
    onTestFinished(() => clearAuthSession())
    const w = wire()
    w.connect()
    expect(await w.link.ops.accessToken({ force: true, failedToken: 'expired' })).toBe('token-a')
    expect(w.tokens.accessToken).toHaveBeenLastCalledWith({ force: true, failedToken: 'expired' })
    expect(await w.link.ops.accessToken()).toBe('token-a')
    expect(w.tokens.accessToken).toHaveBeenLastCalledWith({ force: false })
    w.tokens.accessToken.mockRejectedValueOnce(Object.assign(new Error('session over'), { code: 'INVALID_REFRESH' }))
    await expect(w.link.ops.accessToken()).rejects.toMatchObject({ name: 'AuthSessionError', code: 'INVALID_REFRESH', message: 'session over' })
    // Even with no gateway started: the renewal is the process's, not a start's.
    w.disconnect()
    expect(await w.link.ops.accessToken()).toBe('token-a')
    // Not the gateway's own: its processes never ask the core for a token any more.
    expect(w.gateways[0].ops.accessToken).not.toHaveBeenCalled()
  })

  it('stops the gateway, and its usage collector with it, before its link closes as the process goes', async () => {
    // The process's stop used to close the link and nothing else: the gateway's stop waited for the link's close
    // event, which the process's exit came before, so its collector never wrote a clean exit
    // (health_cli_unclean_restart, 69 to 170 on 2026-10-16, production counters).
    const w = wire()
    w.connect()
    const [gateway] = w.gateways
    let finished = false
    gateway.stop.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); finished = true })
    const stopping = w.service.stop()
    expect(gateway.stop).toHaveBeenCalledOnce()
    expect(w.linkStop).toHaveBeenCalledOnce()
    expect(gateway.stop.mock.invocationCallOrder[0]).toBeLessThan(w.linkStop.mock.invocationCallOrder[0])
    await stopping
    expect(finished).toBe(true)
    // The link's close that follows finds nothing left to stop.
    w.disconnect()
    expect(gateway.stop).toHaveBeenCalledOnce()
    // Never started: the process still goes.
    const idle = wire()
    await idle.service.stop()
    expect(idle.linkStop).toHaveBeenCalledOnce()
  })

  it('starts once it knows the core took its link, though the core says start a frame before', () => {
    const w = wire()
    // The core's link says start as it takes the connection, before the `connected` that tells this process.
    w.link.connected()
    expect(w.gateways).toHaveLength(0)
    w.options().onConnected!({ query: async () => ({}), notice: () => {}, sendBinary: () => true })
    expect(w.gateways).toHaveLength(1)
    // And a core that went before saying it was connected leaves nothing to start.
    w.options().onDisconnected!()
    w.link.disconnected()
    w.link.connected()
    w.options().onDisconnected!()
    w.options().onConnected!({ query: async () => ({}), notice: () => {}, sendBinary: () => true })
    expect(w.gateways).toHaveLength(1)
  })

  it('carries every frame the core has for remote clients to the gateway, as the same call', async () => {
    const w = wire()
    w.connect()
    const { port } = w.gateways[0]
    w.link.notice({ kind: 'status', connected: true })
    w.link.notice({ kind: 'client', connId: 'phone-1', client: { role: 'web', label: null, identity: 'P', direct: false } })
    w.link.port.broadcast({ type: 'turn_started' })
    // A guest's harness's event, named for that guest's sessions (gateway/gateway.ts `broadcast`).
    w.link.port.broadcast({ type: 'turn_started', agentId: 'guests' }, 'kim@acme.io')
    w.link.port.commander({ type: 'commander_event' })
    w.link.port.user({ type: 'notification' })
    w.link.port.reply('phone-1', 'agents_list', 'r-1', { agents: [] })
    w.link.port.target('phone-1', 'viewer_data', { a: 1 })
    w.link.port.terminal('phone-1', 'terminal_ready', { streamId: STREAM })
    w.link.port.terminalBinary('phone-1', encodeTerminalLocal(clear)!)
    w.link.port.observer('observer:1', 'observer_frame', { b: 2 })
    w.link.port.windowOpened('tui')
    await w.link.port.local('local:w', { type: 'e2ee_pairings_list', payload: {} })
    w.link.ops.account({ machineId: 'machine-1', signIn: { epoch: 'e', adopted: false, at: 1 } })
    w.link.ops.reachable(null)
    await w.link.stop()
    expect(port.broadcast).toHaveBeenCalledWith({ type: 'turn_started' })
    expect(port.broadcast).toHaveBeenCalledWith({ type: 'turn_started', agentId: 'guests' }, 'kim@acme.io')
    expect(port.commander).toHaveBeenCalledWith({ type: 'commander_event' })
    expect(port.user).toHaveBeenCalledWith({ type: 'notification' })
    expect(port.reply).toHaveBeenCalledWith('phone-1', 'agents_list', 'r-1', { agents: [] })
    expect(port.target).toHaveBeenCalledWith('phone-1', 'viewer_data', { a: 1 })
    expect(port.terminal).toHaveBeenCalledWith('phone-1', 'terminal_ready', { streamId: STREAM })
    expect(port.terminalBinary).toHaveBeenCalledWith('phone-1', encodeTerminalLocal(clear))
    expect(port.observer).toHaveBeenCalledWith('observer:1', 'observer_frame', { b: 2 })
    expect(port.windowOpened).toHaveBeenCalledWith('tui')
    expect(port.local).toHaveBeenCalledWith('local:w', { type: 'e2ee_pairings_list', payload: {} })
    const { ops } = w.gateways[0]
    expect(ops.account).toHaveBeenCalledWith({ machineId: 'machine-1', signIn: { epoch: 'e', adopted: false, at: 1 } })
    expect(ops.reachable).toHaveBeenCalledWith(null)
    // Stopped: what the core says after is for no gateway, and is dropped.
    expect(w.gateways[0].stop).toHaveBeenCalled()
    w.link.port.broadcast({ type: 'after' })
    expect(port.broadcast).toHaveBeenCalledTimes(2)
  })

  it('tells the core everything the gateway says, as the same call', () => {
    const w = wire()
    w.connect()
    const events = w.hosts[0].events
    events.frame('phone-1', { type: 'message' }, 'p2p', 'web')
    events.binary('phone-1', clear)
    events.client('phone-1', { role: 'device', label: 'Dial', identity: 'P', direct: true })
    events.disconnected('phone-1')
    events.observer('observer:1', 'observer_hello', { a: 1 })
    events.toLocal('local:w', { type: 'x' })
    events.status(true)
    events.linkDown()
    events.commanders(2, null, true)
    events.commanders(1, 1)
    events.commanderJoined()
    events.meta({ gridName: 'grid-1' })
    events.notice({ type: 'zoo_changed', revision: 4 })
    events.revoked()
    events.busy()
    events.toWindows({ type: 'device_keys_changed', payload: {} })
    events.tabFrame({ sharedTabId: 'a1b2c3d4e5f6a1b2c3d4e5f6', closed: { code: 4403, reason: 'Not in this shared tab' } })
    events.streamControl('agentBrowser', 's-1', { route: 'turn' })
    events.streamControl('agentBrowser', 's-2', { route: null })
    events.streamControl('agentBrowser', null, { kind: 'transport_error' })
    const { heard } = w
    expect(heard.frame).toHaveBeenCalledWith('phone-1', { type: 'message' }, 'p2p', 'web')
    expect(heard.binary).toHaveBeenCalledWith('phone-1', clear, encodeTerminalLocal(clear))
    expect(heard.client).toHaveBeenCalledWith('phone-1', { role: 'device', label: 'Dial', identity: 'P', direct: true })
    expect(heard.disconnected).toHaveBeenCalledWith('phone-1')
    expect(heard.observer).toHaveBeenCalledWith('observer:1', 'observer_hello', { a: 1 })
    expect(heard.toLocal).toHaveBeenCalledWith('local:w', { type: 'x' })
    expect(heard.status).toHaveBeenCalledWith(true)
    expect(heard.linkDown).toHaveBeenCalled()
    expect(heard.commanders.mock.calls).toEqual([[2, null, true], [1, 1, false]])
    expect(heard.commanderJoined).toHaveBeenCalled()
    expect(heard.meta).toHaveBeenCalledWith({ gridName: 'grid-1' })
    expect(heard.notice).toHaveBeenCalledWith({ type: 'zoo_changed', revision: 4 })
    expect(heard.revoked).toHaveBeenCalled()
    expect(heard.busy).toHaveBeenCalled()
    expect(heard.toWindows).toHaveBeenCalledWith({ type: 'device_keys_changed', payload: {} })
    expect(heard.tabFrame).toHaveBeenCalledWith({ sharedTabId: 'a1b2c3d4e5f6a1b2c3d4e5f6', closed: { code: 4403, reason: 'Not in this shared tab' } })
    expect(heard.streamControl).toHaveBeenCalledWith('agentBrowser', 's-1', { route: 'turn' })
    expect(heard.streamControl).toHaveBeenCalledWith('agentBrowser', 's-2', { route: null })
    expect(heard.streamControl).toHaveBeenCalledWith('agentBrowser', null, { kind: 'transport_error' })
  })

  it('answers the core\'s calls from the gateway it runs, and 503 with none running', async () => {
    const w = wire()
    expect(await w.link.ops.backend('GET', '/api/desk')).toEqual({ status: 503, body: { error: 'GATEWAY_UNAVAILABLE' } })
    w.connect()
    expect(await w.link.ops.status()).toEqual({ fingerprint: 'AB12', pairs: [], pending: null })
    expect(await w.link.ops.backend('GET', '/api/desk')).toEqual({ status: 200, body: { ok: true } })
  })

  it('answers its routes of the door from the gateway it runs, and asks the core whether the Wi-Fi device\'s service serves', async () => {
    const w = wire()
    const asker = { local: true, owner: true }
    const route = { method: 'GET', target: '/api/autonomous-device/list' }
    // Not started: the request fails, and its route answers for it (core/serviceRoutes.ts).
    expect(() => w.options().requests.gateway_http!(route, asker)).toThrow('the gateway has not started')
    w.connect()
    expect(await w.options().requests.gateway_http!(route, asker)).toEqual({ status: 200, body: { devices: [], asked: '/api/autonomous-device/list' } })
    expect(w.gateways[0].requests.gateway_http).toHaveBeenCalledWith(route, asker)
    // Only the core can ask for that service's process: asked over the link, and no once the link is gone.
    expect(await w.hosts[0].wifiServing!()).toBe(true)
    w.disconnect()
    expect(await w.hosts[0].wifiServing!()).toBe(false)
  })

  it('runs the fleet\'s lane\'s sessions in the gateway it runs, and seals nothing with none running', async () => {
    const w = wire()
    const lane = w.link.ops.lane
    // Not started: the lane gets no session and no frame back as it was.
    await expect(lane.hello('m2', 'PEER')).rejects.toThrow(/not running/)
    w.connect()
    expect(await lane.hello('m2', 'PEER')).toEqual({ type: 'e2e_hello', machineId: 'm2' })
    expect(await lane.welcome('m2', { ephPub: 'E' })).toBe(true)
    await lane.rekey('m2', { epoch: 'x' })
    expect(await lane.seal('m2', { type: 'message' })).toEqual({ frame: { type: 'message', sealed: true } })
    expect(await lane.open('m2', { type: 'message' })).toEqual({ unreadable: true })
    // The far daemon's new epoch crosses the process line as itself.
    w.gateways[0]!.ops.lane.open.mockResolvedValueOnce({ unknownEpoch: true } as never)
    expect(await lane.open('m2', { type: 'commander_question' })).toEqual({ unknownEpoch: true })
    lane.drop('m2')
    await Promise.resolve()
    const { ops } = w.gateways[0]
    expect(ops.lane.hello).toHaveBeenCalledWith('m2', 'PEER')
    expect(ops.lane.welcome).toHaveBeenCalledWith('m2', { ephPub: 'E' })
    expect(ops.lane.rekey).toHaveBeenCalledWith('m2', { epoch: 'x' })
    expect(ops.lane.drop).toHaveBeenCalledWith('m2')
    expect(await w.options().requests[GATEWAY_CALLS.lane]({ op: 'nothing' }, { local: true, owner: true })).toEqual({ error: 'UNKNOWN_OP' })
    w.disconnect()
    expect(await lane.seal('m2', { type: 'message' })).toEqual({ lost: true })
  })

  it('signs Share\'s welcomes with the identity it holds, and none while it is not running', async () => {
    const w = wire()
    const key = w.link.ops.observerKey
    await expect(key.publicKey()).rejects.toThrow(/not running/)
    w.connect()
    expect(await key.publicKey()).toBe('cHVi')
    expect(await key.signWelcome('m', 'share-1', 'cA==', 'ZQ==')).toBe('c2ln')
    expect(w.gateways[0].ops.observerKey.signWelcome).toHaveBeenCalledWith('m', 'share-1', 'cA==', 'ZQ==')
    await expect(key.signWelcome('m', 'bad', 'cA==', 'ZQ==')).rejects.toThrow('not a welcome to an observer')
    w.gateways[0].ops.observerKey.publicKey.mockRejectedValueOnce('odd')
    await expect(key.publicKey()).rejects.toThrow('odd')
  })

  it('dispatches gateway_tab_key to TabSessions, and holds no key while it is not running', async () => {
    const TAB = 'a1b2c3d4e5f6a1b2c3d4e5f6'
    const toBob = { sharedTabId: TAB, machineId: 'bob-mini', peerPub: b64e(bob.pub) }
    const toAlice = { sharedTabId: TAB, machineId: 'alice-mac', peerPub: b64e(alice.pub) }
    const peer = new TabSessions(() => bob, () => 'bob-mini')
    const w = wire()
    const key = w.link.ops.tabKey
    await expect(key.publicKey()).rejects.toThrow(/not running/)
    expect(await key.seal(toBob, { type: 'ping' })).toEqual({ lost: true })
    w.connect()
    expect(await key.publicKey()).toBe(b64e(alice.pub))
    await expect(key.signRoster('tab-1', 1, '{}')).rejects.toThrow('not a roster')
    const answer = await peer.accept(toAlice, await key.hello(toBob))
    expect(await key.welcome(toBob, (answer as { welcome: Record<string, unknown> }).welcome)).toBe(true)
    const sealed = await key.seal(toBob, { type: 'ping' }) as { frame: Record<string, unknown> }
    expect(await peer.open(toAlice, sealed.frame)).toEqual({ frame: { type: 'ping' } })
    expect(await key.open(toBob, (await peer.seal(toAlice, { type: 'pong' }) as { frame: Record<string, unknown> }).frame)).toEqual({ frame: { type: 'pong' } })
    key.drop(toBob)
    await Promise.resolve()
    expect(await key.seal(toBob, { type: 'ping' })).toEqual({ lost: true })
    for (const method of ['clear', 'constructor', 'nothing']) {
      expect(await w.options().requests[GATEWAY_CALLS.tabKey]({ method, args: [] }, { local: true, owner: true })).toEqual({ error: 'UNKNOWN_METHOD' })
    }
  })

  it('dispatches gateway_tab_relay to the gateway\'s relay, and sends nothing while it is not running', async () => {
    const TAB = 'a1b2c3d4e5f6a1b2c3d4e5f6'
    const w = wire()
    const relay = w.link.ops.tabRelay
    await relay.open(TAB)
    expect(await relay.send(TAB, 'alice-mac', {})).toBe(false)
    w.connect()
    const ops = w.gateways[0].ops.tabRelay
    await relay.open(TAB)
    expect(ops.open).toHaveBeenCalledWith(TAB)
    expect(await relay.send(TAB, 'alice-mac', { sealed: 1 })).toBe(true)
    expect(await relay.send(TAB, 'carol-pc', { sealed: 1 })).toBe(false)
    expect(ops.send).toHaveBeenCalledWith(TAB, 'alice-mac', { sealed: 1 })
    relay.close(TAB)
    await Promise.resolve()
    expect(ops.close).toHaveBeenCalledWith(TAB)
    for (const method of ['closeAll', 'constructor', 'nothing']) {
      expect(await w.options().requests[GATEWAY_CALLS.tabRelay]({ method, args: [TAB] }, { local: true, owner: true })).toEqual({ error: 'UNKNOWN_METHOD' })
    }
  })

  it('keeps old-core vault RPC only in the gateway and gives the new core metadata only', async () => {
    const w = wire()
    const call = (payload: Record<string, unknown>) => w.options().requests[GATEWAY_CALLS.connectorVault](payload, { local: true, owner: true })
    expect(await call({ op: 'seal', plaintext: '{}' })).toEqual({ error: 'CONNECTORS_SYNC_UNAVAILABLE' })
    await expect(w.link.ops.connectorSync(true)).rejects.toThrow('CONNECTORS_SYNC_UNAVAILABLE')
    w.connect()
    expect(await w.link.ops.connectorSync(true)).toEqual({ shared: true })
    expect(await call({ op: 'sync', refresh: true, requestId: 'wire-request' })).toEqual({ shared: true })
    expect(await call({ op: 'sync', refresh: true, requestId: {} })).toEqual({ error: 'UNKNOWN_OP' })
    expect(await call({ op: 'sync', refresh: true, requestId: 'x'.repeat(129) })).toEqual({ error: 'UNKNOWN_OP' })
    expect(await call({ op: 'seal', plaintext: '{"v":1}' })).toEqual({ envelope: { sealed: '{"v":1}' } })
    expect(await call({ op: 'open', envelope: { sealed: '{"v":1}' } })).toEqual({ plaintext: '{"v":1}', complete: true })
    expect(await call({ op: 'open', envelope: { other: 1 } })).toEqual({})
    expect(await call({ op: 'seal', plaintext: '' })).toEqual({ error: 'nothing to seal' })
    expect(await call({ op: 'nothing' })).toEqual({ error: 'UNKNOWN_OP' })
    expect(await call({ op: 'sync', refresh: 'yes' })).toEqual({ error: 'UNKNOWN_OP' })
    expect(await call({ op: 'sync', refresh: true, plaintext: 'synthetic' })).toEqual({ error: 'UNKNOWN_OP' })
  })

  it('makes the trust stores hold what sharing asks, only the parts it sent, valid peers only', async () => {
    const w = wire()
    const trust = w.link.ops.sharedTrust
    await expect(trust({ pins: [] })).rejects.toThrow(/not started|not running/)
    w.connect()
    const peer = { machineId: 'a'.repeat(32), pub: Buffer.alloc(32, 1).toString('base64'), label: 'Studio' }
    expect(await trust({ pins: [peer, { machineId: '../x', pub: 'bad', label: '' }] })).toEqual({ pins: 1, keys: -1 })
    expect(w.gateways[0].ops.sharedTrust).toHaveBeenLastCalledWith({ pins: [peer] })
    expect(await trust({ keys: [peer] })).toEqual({ pins: -1, keys: 1 })
    expect(w.gateways[0].ops.sharedTrust).toHaveBeenLastCalledWith({ keys: [peer] })
    await expect(trust({ pins: [], keys: [] })).rejects.toThrow('stores unwritable')
    w.gateways[0].ops.sharedTrust.mockRejectedValueOnce('odd')
    await expect(trust({})).rejects.toThrow('odd')
  })

  it('opens a window\'s session on another machine, carries it both ways, and fails it as the pool did', async () => {
    const w = wire()
    w.connect()
    const { windowRelay, sessions } = w.gateways[0]
    const sink = { sendFrame: vi.fn(() => true), sendBinary: vi.fn(() => true) }
    const onClosed = vi.fn()
    const session = await w.link.windowRelay.acquire('m2', 'prod', { type: 'machine_select' }, sink, onClosed)
    expect(windowRelay.acquire).toHaveBeenCalledWith('m2', 'prod', { type: 'machine_select' }, expect.anything(), expect.any(Function))
    await session.send({ type: 'agents_list' })
    await session.sendBinary(clear)
    expect(sessions[0].send).toHaveBeenCalledWith({ type: 'agents_list' })
    expect(sessions[0].sendBinary).toHaveBeenCalledWith(clear)
    // What the other machine sends the window comes back through the core to it.
    const [, , , poolSink, poolClosed] = windowRelay.acquire.mock.calls[0] as unknown as [string, string, unknown, { sendFrame(f: unknown): boolean; sendBinary(b: Uint8Array): boolean }, (c: number, r: string) => void]
    poolSink.sendFrame({ type: 'agents_list_result' })
    expect(poolSink.sendBinary(Uint8Array.of(1, 2))).toBe(true)
    expect(sink.sendFrame).toHaveBeenCalledWith({ type: 'agents_list_result' })
    expect(sink.sendBinary).toHaveBeenCalledWith(Uint8Array.of(1, 2))
    poolClosed(4404, 'NO_PEER_LINK')
    expect(onClosed).toHaveBeenCalledWith(4404, 'NO_PEER_LINK')
    // A background one the pool refuses fails with the pool's own words.
    await expect(w.link.windowRelay.acquireIsolated('m3', 'prod', {}, sink, vi.fn())).rejects.toMatchObject({ message: 'NO_PEER_LINK', closeCode: 1011 })
    w.link.windowRelay.invalidate('m2')
    w.link.windowRelay.invalidateIsolated('m3')
    expect(windowRelay.invalidate).toHaveBeenCalledWith('m2')
    expect(windowRelay.invalidateIsolated).toHaveBeenCalledWith('m3')
    // Another, detached by the window; a gateway that stops lets the rest go.
    const second = await w.link.windowRelay.acquire('m4', 'prod', {}, sink, vi.fn())
    second.detach()
    expect(sessions[1].detach).toHaveBeenCalled()
    await w.link.windowRelay.acquire('m5', 'prod', {}, sink, vi.fn())
    w.disconnect()
    expect(sessions[2].detach).toHaveBeenCalled()
  })

  it('watches a shared harness through the Share relay it runs, and fails as the Share relay did', async () => {
    const w = wire()
    w.connect()
    const { windowRelay, sessions } = w.gateways[0]
    const sink = { sendFrame: vi.fn(() => true), sendBinary: vi.fn(() => true) }
    const session = await w.link.windowRelay.acquireShare!('owner', 'share-1', sink, vi.fn())
    expect(windowRelay.acquireShare).toHaveBeenCalledWith('owner', 'share-1', expect.anything(), expect.any(Function))
    await session.send({ type: 'terminal_open', payload: {} })
    expect(sessions[0].send).toHaveBeenCalledWith({ type: 'terminal_open', payload: {} })
    await expect(w.link.windowRelay.acquireShare!('owner', 'ended', sink, vi.fn())).rejects.toMatchObject({ message: 'Sharing ended or invitation expired', closeCode: 4403 })
  })

  it('refuses a window while it has not started, and drops what it cannot read', async () => {
    const w = wire()
    w.options().onConnected!({ query: async () => ({}), notice: (kind, payload = {}) => w.link.notice({ ...payload, kind }), sendBinary: () => true })
    w.link.connected = () => {}
    // The core's link has not said start: there is no pool to open on.
    w.options().onEvent!({ kind: 'windowOpen', id: 'window-1', machineId: 'm2' })
    await vi.waitFor(() => expect(w.heard.frame).not.toHaveBeenCalled())
    w.options().onEvent!({ kind: 'broadcast', frame: { type: 'x' } })
    w.options().onEvent!({ kind: 'mystery' })
    w.options().onBinary!(Uint8Array.of(9))
    expect(w.gateways).toHaveLength(0)
  })
})

describe('account HTTP across the gateway service link', () => {
  it('performs backend and machine requests in the gateway, the core supplying nothing', async () => {
    const w = wire()
    w.connect()
    const { ops } = w.gateways[0]
    expect(await w.link.ops.backend('POST', '/api/desk/ops', { changes: [] })).toEqual({ status: 200, body: { ok: true } })
    expect(ops.backend).toHaveBeenCalledWith('POST', '/api/desk/ops', { changes: [] })
    await w.link.ops.machines(true)
    expect(ops.machines).toHaveBeenCalledWith(true)
    await w.link.ops.machines()
    expect(ops.machines).toHaveBeenCalledWith(false)
    expect(await w.link.ops.mintGridName()).toBe('private-grid')
    expect(w.backend).not.toHaveBeenCalled()
    w.hosts[0].machines!({ owner: 'machine-1', body: { machines: [{ machineId: 'm2' }] }, fetchedAt: 1000 })
  })
})
