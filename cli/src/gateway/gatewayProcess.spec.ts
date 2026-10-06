/**
 * The gateway's process and the core's link to it, spoken end to end in memory: what one side says, the
 * other hears as the same call. The relay itself is a stand-in here (gateway/gateway.spec.ts and the socket's
 * specs hold its rules); what this holds is that nothing is lost or renamed on the way between the processes.
 */
import { describe, expect, it, vi } from 'vitest'
import type { GatewayEvents, GatewayOps, GatewayPort, WindowRelay } from '../core/api.js'
import { createGatewayLink } from '../core/gatewayLink.js'
import { GATEWAY_CALLS } from '../lib/gatewayWire.js'
import { RelayConnectError } from '../lib/relayFrames.js'
import { TerminalBinaryKind, type TerminalBinaryClear } from '../lib/terminalBinary.js'
import type { CoreConnection, ServiceProcessOptions } from '../services/process.js'
import { runGatewayService } from './gatewayProcess.js'
import type { GatewayHost, StartedGateway } from './start.js'

const STREAM = '00000000-0000-4000-8000-000000000002'
const clear: TerminalBinaryClear = { kind: TerminalBinaryKind.input, streamId: STREAM, seq: 3, compressed: false, bytes: new Uint8Array([108, 115]) }

function stubGateway() {
  const port = {
    connect: vi.fn(), serveThisComputerOnly: vi.fn(), holdRequests: vi.fn(), openRequests: vi.fn(), connected: vi.fn(() => true),
    broadcast: vi.fn(), commander: vi.fn(), user: vi.fn(), reply: vi.fn(), target: vi.fn(() => true), terminal: vi.fn(() => true),
    terminalBinary: vi.fn(() => true), observer: vi.fn(() => true), windowOpened: vi.fn(), localClients: vi.fn(), local: vi.fn(async () => {}),
    device: vi.fn(() => true), deviceClient: vi.fn(), stop: vi.fn(async () => {}),
  } satisfies GatewayPort
  const answer = { status: 200, body: { ok: true } }
  const ops = {
    status: vi.fn(async () => ({ fingerprint: 'AB12', pairs: [], pending: null })),
    pair: vi.fn(async () => answer), listPairs: vi.fn(async () => answer), revoke: vi.fn(async () => answer), revokeAll: vi.fn(async () => answer),
    setRemotePassword: vi.fn(async () => answer), clearRemotePassword: vi.fn(async () => answer), remotePasswordStatus: vi.fn(async () => answer),
    trustLinkedPeer: vi.fn(async () => answer), groupList: vi.fn(async () => answer), groupSync: vi.fn(async () => answer),
    groupRemove: vi.fn(async () => answer), devicesList: vi.fn(async () => answer), devicesRemove: vi.fn(async () => answer),
    devicesHistory: vi.fn(async () => answer), devicesDismiss: vi.fn(async () => answer), devicesRebaseline: vi.fn(async () => answer),
    wifi: vi.fn(async () => ({ result: { devices: [] } })), wifiService: vi.fn(), revokeIdentity: vi.fn(),
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
  return { port, ops, windowRelay, sessions, stop: vi.fn(async () => {}) }
}

function wire() {
  let options!: ServiceProcessOptions
  const gateways: Array<ReturnType<typeof stubGateway>> = []
  const hosts: GatewayHost[] = []
  runGatewayService({
    dataDir: '/data', socketPath: '/data/daemon.sock', machineId: 'computer-1', token: 'token',
    run: (given) => { options = given; return { stop: vi.fn() } },
    start: (host) => { hosts.push(host); const stub = stubGateway(); gateways.push(stub); return stub as unknown as StartedGateway },
  })
  const heard = {
    frame: vi.fn(), binary: vi.fn(), client: vi.fn(), disconnected: vi.fn(), observer: vi.fn(), toLocal: vi.fn(), status: vi.fn(),
    linkDown: vi.fn(), commanders: vi.fn(), commanderJoined: vi.fn(), meta: vi.fn(), notice: vi.fn(), revoked: vi.fn(), busy: vi.fn(),
    device: vi.fn(), deviceRevoked: vi.fn(), toWindows: vi.fn(),
  }
  const tokens = { accessToken: vi.fn(async () => 'token-a') }
  const backend = vi.fn(async () => ({ status: 200, body: { data: { acct: 'a' } } }))
  const link = createGatewayLink({
    events: heard as unknown as GatewayEvents,
    notify: (frame) => { options.onEvent!(frame.payload as Record<string, unknown>); return true },
    notifyBinary: (bytes) => { options.onBinary!(bytes); return true },
    buffered: () => 0,
    call: async (type, payload) => {
      try { return { ...await options.requests[type](payload, { local: true, owner: true }) } } catch { return { error: 'SERVICE_FAILED' } }
    },
    start: () => ({ machineId: 'machine-1', computerId: 'computer-1', autonomousEnv: 'prod', signedIn: true, account: { machineId: 'machine-1', signIn: null } }),
    tokens, backend,
  })
  const core: CoreConnection = {
    query: (query, payload = {}) => link.answer(query, payload),
    notice: (kind, payload = {}) => link.notice({ ...payload, kind }),
    sendBinary: (bytes) => { link.binary(bytes); return true },
  }
  const connect = () => { options.onConnected!(core); link.connected() }
  const disconnect = () => { options.onDisconnected!(); link.disconnected() }
  return { link, heard, gateways, hosts, connect, disconnect, tokens, backend, options: () => options }
}

describe('the gateway\'s process, spoken to by the core', () => {
  it('builds the gateway only when a core says start, with what the core holds, and again on each start', async () => {
    const w = wire()
    w.link.port.holdRequests()
    w.link.port.connect()
    w.link.port.localClients(1)
    w.link.ops.reachable(['m2'])
    w.link.ops.wifiService(true)
    expect(w.gateways).toHaveLength(0)
    w.connect()
    expect(w.gateways).toHaveLength(1)
    const [gateway] = w.gateways
    expect(w.hosts[0]).toMatchObject({ machineId: 'machine-1', computerId: 'computer-1', autonomousEnv: 'prod', signedIn: true, account: { machineId: 'machine-1', signIn: null } })
    expect(gateway.port.holdRequests).toHaveBeenCalled()
    expect(gateway.port.localClients).toHaveBeenCalledWith(1)
    expect(gateway.ops.reachable).toHaveBeenCalledWith(['m2'])
    expect(gateway.ops.wifiService).toHaveBeenCalledWith(true)
    expect(gateway.port.connect).toHaveBeenCalled()
    // Its tokens and its reads of the backend are the core's to hand out.
    expect(await w.hosts[0].tokens.accessToken({ force: true })).toBe('token-a')
    expect(w.tokens.accessToken).toHaveBeenCalledWith({ force: true })
    expect(await w.hosts[0].backend('GET', '/api/device-keys?since=0')).toEqual({ status: 200, body: { data: { acct: 'a' } } })
    w.tokens.accessToken.mockRejectedValueOnce(Object.assign(new Error('session over'), { code: 'INVALID_REFRESH' }))
    await expect(w.hosts[0].tokens.accessToken()).rejects.toMatchObject({ name: 'AuthSessionError', code: 'INVALID_REFRESH' })
    // The core going stops it; the next core builds a new one, signed out this time serving this computer only.
    w.disconnect()
    expect(gateway.stop).toHaveBeenCalled()
    await expect(w.hosts[0].tokens.accessToken()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(await w.hosts[0].backend('GET', '/api/device-keys')).toMatchObject({ status: 502 })
    w.link.port.serveThisComputerOnly()
    w.link.port.openRequests()
    w.connect()
    expect(w.gateways).toHaveLength(2)
    expect(w.gateways[1].port.serveThisComputerOnly).toHaveBeenCalled()
    expect(w.gateways[1].port.holdRequests).not.toHaveBeenCalled()
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
    w.link.port.commander({ type: 'commander_event' })
    w.link.port.user({ type: 'notification' })
    w.link.port.reply('phone-1', 'agents_list', 'r-1', { agents: [] })
    w.link.port.target('phone-1', 'viewer_data', { a: 1 })
    w.link.port.terminal('phone-1', 'terminal_ready', { streamId: STREAM })
    w.link.port.terminalBinary('phone-1', clear)
    w.link.port.observer('observer:1', 'observer_frame', { b: 2 })
    w.link.port.windowOpened()
    await w.link.port.local('local:w', { type: 'e2ee_pairings_list', payload: {} })
    w.link.port.device('phone-1', 'autonomous_device_result', { c: 3 })
    w.link.port.deviceClient('phone-1', 'P')
    w.link.port.deviceClient('phone-1', null)
    w.link.ops.revokeIdentity('P')
    w.link.ops.account({ machineId: 'machine-1', signIn: { epoch: 'e', adopted: false, at: 1 } })
    w.link.ops.reachable(null)
    w.link.ops.wifiService(false)
    await w.link.stop()
    expect(port.broadcast).toHaveBeenCalledWith({ type: 'turn_started' })
    expect(port.commander).toHaveBeenCalledWith({ type: 'commander_event' })
    expect(port.user).toHaveBeenCalledWith({ type: 'notification' })
    expect(port.reply).toHaveBeenCalledWith('phone-1', 'agents_list', 'r-1', { agents: [] })
    expect(port.target).toHaveBeenCalledWith('phone-1', 'viewer_data', { a: 1 })
    expect(port.terminal).toHaveBeenCalledWith('phone-1', 'terminal_ready', { streamId: STREAM })
    expect(port.terminalBinary).toHaveBeenCalledWith('phone-1', clear)
    expect(port.observer).toHaveBeenCalledWith('observer:1', 'observer_frame', { b: 2 })
    expect(port.windowOpened).toHaveBeenCalled()
    expect(port.local).toHaveBeenCalledWith('local:w', { type: 'e2ee_pairings_list', payload: {} })
    expect(port.device).toHaveBeenCalledWith('phone-1', 'autonomous_device_result', { c: 3 })
    expect(port.deviceClient.mock.calls).toEqual([['phone-1', 'P'], ['phone-1', null]])
    const { ops } = w.gateways[0]
    expect(ops.revokeIdentity).toHaveBeenCalledWith('P')
    expect(ops.account).toHaveBeenCalledWith({ machineId: 'machine-1', signIn: { epoch: 'e', adopted: false, at: 1 } })
    expect(ops.reachable).toHaveBeenCalledWith(null)
    expect(ops.wifiService).toHaveBeenLastCalledWith(false)
    // Stopped: what the core says after is for no gateway, and is dropped.
    expect(w.gateways[0].stop).toHaveBeenCalled()
    w.link.port.broadcast({ type: 'after' })
    expect(port.broadcast).toHaveBeenCalledTimes(1)
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
    events.device('dial-1', { type: 'autonomous_device_request' }, { type: 'hello' })
    events.deviceRevoked('P')
    events.toWindows({ type: 'device_keys_changed', payload: {} })
    const { heard } = w
    expect(heard.frame).toHaveBeenCalledWith('phone-1', { type: 'message' }, 'p2p', 'web')
    expect(heard.binary).toHaveBeenCalledWith('phone-1', clear)
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
    expect(heard.device).toHaveBeenCalledWith('dial-1', { type: 'autonomous_device_request' }, { type: 'hello' })
    expect(heard.deviceRevoked).toHaveBeenCalledWith('P')
    expect(heard.toWindows).toHaveBeenCalledWith({ type: 'device_keys_changed', payload: {} })
  })

  it('answers the core\'s commands about the keys from the gateway it runs, and 503 with none running', async () => {
    const w = wire()
    expect(await w.link.ops.listPairs()).toEqual({ status: 503, body: { error: 'GATEWAY_UNAVAILABLE' } })
    w.connect()
    const { ops } = w.gateways[0]
    expect(await w.link.ops.status()).toEqual({ fingerprint: 'AB12', pairs: [], pending: null })
    for (const ask of [
      () => w.link.ops.pair('CODE'), () => w.link.ops.listPairs(), () => w.link.ops.revoke('1'), () => w.link.ops.revokeAll(),
      () => w.link.ops.setRemotePassword('pw'), () => w.link.ops.clearRemotePassword(), () => w.link.ops.remotePasswordStatus(),
      () => w.link.ops.trustLinkedPeer({ pub: 'P', machineId: 'm', label: 'l' }), () => w.link.ops.groupList(), () => w.link.ops.groupSync(),
      () => w.link.ops.groupRemove('2'), () => w.link.ops.devicesList(), () => w.link.ops.devicesRemove('P'), () => w.link.ops.devicesHistory(),
      () => w.link.ops.devicesDismiss({ baseline: true }), () => w.link.ops.devicesRebaseline(true, { seq: 2, hash: 'h' }),
    ]) expect(await ask()).toEqual({ status: 200, body: { ok: true } })
    expect(ops.pair).toHaveBeenCalledWith('CODE')
    expect(ops.revoke).toHaveBeenCalledWith('1')
    expect(ops.setRemotePassword).toHaveBeenCalledWith('pw')
    expect(ops.trustLinkedPeer).toHaveBeenCalledWith({ pub: 'P', machineId: 'm', label: 'l' })
    expect(ops.groupRemove).toHaveBeenCalledWith('2')
    expect(ops.devicesRemove).toHaveBeenCalledWith('P')
    expect(ops.devicesDismiss).toHaveBeenCalledWith({ baseline: true })
    expect(ops.devicesRebaseline).toHaveBeenCalledWith(true, { seq: 2, hash: 'h' })
    expect(await w.link.ops.wifi({ op: 'pair', device: 'dev', code: 'C' })).toEqual({ result: { devices: [] } })
    expect(ops.wifi).toHaveBeenCalledWith({ op: 'pair', device: 'dev', code: 'C', id: '' })
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
