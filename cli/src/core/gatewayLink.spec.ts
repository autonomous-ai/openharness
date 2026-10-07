import { describe, expect, it, vi } from 'vitest'
import { decodeGatewayBinary, encodeGatewayBinary, GatewayBinary, GATEWAY_CALLS } from '../lib/gatewayWire.js'
import { RelayConnectError } from '../lib/relayFrames.js'
import { decodeTerminalLocal, encodeTerminalLocal, TerminalBinaryKind, type TerminalBinaryClear } from '../lib/terminalBinary.js'
import type { GatewayEvents, LaneSeal } from './api.js'
import { createGatewayLink, GATEWAY_BUFFER_LIMIT, LANE_WAIT_MS, laneOf, OWED_MAX, PAIR_WAIT_MS, WINDOW_GATEWAY_GONE } from './gatewayLink.js'
import { ON_DEMAND_START_MS } from './serviceLinks.js'

const STREAM = '00000000-0000-4000-8000-000000000001'
const bytesOf = (text: string): TerminalBinaryClear => ({ kind: TerminalBinaryKind.output, streamId: STREAM, seq: 1, compressed: false, bytes: new TextEncoder().encode(text) })

function events(): { [K in keyof GatewayEvents]: ReturnType<typeof vi.fn> } {
  return {
    frame: vi.fn(), binary: vi.fn(), client: vi.fn(), disconnected: vi.fn(), observer: vi.fn(), toLocal: vi.fn(), status: vi.fn(),
    linkDown: vi.fn(), commanders: vi.fn(), commanderJoined: vi.fn(), meta: vi.fn(), notice: vi.fn(), revoked: vi.fn(), busy: vi.fn(),
    device: vi.fn(), deviceRevoked: vi.fn(), toWindows: vi.fn(),
  }
}

function setup(over: { buffered?: number; call?: (type: string, payload: Record<string, unknown>, waitMs?: number) => Promise<Record<string, unknown>>; startWaitMs?: number; start?: () => Record<string, unknown> } = {}) {
  const heard = events()
  const sent: Array<Record<string, unknown>> = []
  const binary: Uint8Array[] = []
  let buffered = over.buffered ?? 0
  let writable = true
  const log = vi.fn()
  let clock = 1_000_000
  const call = vi.fn(over.call ?? (async () => ({ status: 200, body: { ok: true } })))
  const tokens = { accessToken: vi.fn(async () => 'token-1') }
  const backend = vi.fn(async () => ({ status: 200, body: { data: { seen: {} } } }))
  const want = vi.fn()
  const machines = vi.fn()
  const link = createGatewayLink({
    events: heard as unknown as GatewayEvents,
    notify: (frame) => { sent.push(frame.payload as Record<string, unknown>); return writable },
    notifyBinary: (bytes) => { binary.push(bytes); return true },
    buffered: () => buffered,
    call,
    start: over.start ?? (() => ({ machineId: 'm1', computerId: 'c1', autonomousEnv: 'prod', signedIn: true })),
    machines,
    tokens, backend, log, now: () => clock, want, ...(over.startWaitMs ? { startWaitMs: over.startWaitMs } : {}),
  })
  return {
    link, heard, sent, binary, call, tokens, backend, log, want, machines,
    kinds: () => sent.map((payload) => payload.kind),
    setBuffered: (bytes: number) => { buffered = bytes },
    setWritable: (value: boolean) => { writable = value },
    tick: (ms: number) => { clock += ms },
  }
}

/** A remote client the gateway has registered with the core. */
const register = (link: ReturnType<typeof setup>['link'], connId: string, role: 'web' | 'device' = 'web') =>
  link.notice({ kind: 'client', connId, client: { role, label: null, identity: 'PUB', direct: false } })

describe('the gateway in its own process, as the core sees it', () => {
  it('says nothing to a gateway that is not there, and tells one that connects everything it starts from', () => {
    const { link, sent, kinds } = setup()
    link.port.connect()
    link.port.holdRequests()
    link.port.localClients({ desktop: 1, tui: 1 })
    link.ops.wifiService(true)
    link.ops.account({ machineId: 'm1', signIn: null })
    link.ops.reachable(['m2'])
    expect(sent).toEqual([])
    link.connected()
    expect(kinds()).toEqual(['start'])
    expect(sent[0]).toEqual({
      kind: 'start', machineId: 'm1', computerId: 'c1', autonomousEnv: 'prod', signedIn: true,
      requestsOpen: false, dial: 'connect', localClients: { desktop: 1, tui: 1 }, wifiService: true, reachable: ['m2'],
    })
    link.port.openRequests()
    link.port.serveThisComputerOnly()
    expect(kinds().slice(1)).toEqual(['open', 'thisComputerOnly'])
  })

  it('carries the core\'s frames for remote clients, and refuses what it knows cannot reach one', async () => {
    const { link, sent, binary, kinds } = setup()
    link.connected()
    // No backend link yet, and nobody registered: nothing for a remote client can go.
    expect(link.port.connected()).toBe(false)
    expect(link.port.target('phone-1', 'viewer_data', {})).toBe(false)
    expect(link.port.terminal('phone-1', 'terminal_ready', {})).toBe(false)
    expect(link.port.terminalBinary('phone-1', bytesOf('hi'))).toBe(false)
    expect(link.port.observer('observer:1', 'observer_frame', {})).toBe(false)
    expect(link.port.device('dial-1', 'autonomous_device_event', {})).toBe(false)
    link.notice({ kind: 'status', connected: true })
    register(link, 'phone-1')
    expect(link.port.connected()).toBe(true)
    link.port.broadcast({ type: 'turn_started' })
    link.port.commander({ type: 'commander_event' })
    link.port.user({ type: 'notification' })
    link.port.reply('phone-1', 'agents_list', 'r-1', { agents: [] })
    expect(link.port.target('phone-1', 'viewer_data', { a: 1 })).toBe(true)
    expect(link.port.terminal('phone-1', 'terminal_ready', { streamId: STREAM })).toBe(true)
    expect(link.port.observer('observer:1', 'observer_frame', { b: 2 })).toBe(true)
    expect(link.port.device('phone-1', 'autonomous_device_result', { c: 3 })).toBe(true)
    link.port.deviceClient('phone-1', 'PUB')
    link.port.windowOpened('tui')
    await link.port.local('local:w', { type: 'e2ee_pairings_list', payload: {} })
    expect(link.port.terminalBinary('phone-1', bytesOf('hi'))).toBe(true)
    // An id the binary frame cannot carry: refused, never sent half-framed.
    register(link, 'x'.repeat(300))
    expect(link.port.terminalBinary('x'.repeat(300), bytesOf('hi'))).toBe(false)
    expect(kinds().slice(1)).toEqual(['broadcast', 'commander', 'user', 'reply', 'target', 'terminal', 'observer', 'device', 'deviceClient', 'windowOpened', 'localFrame'])
    expect(sent[4]).toEqual({ kind: 'reply', connId: 'phone-1', type: 'agents_list', requestId: 'r-1', payload: { agents: [] } })
    const framed = decodeGatewayBinary(binary[0])!
    expect(framed).toMatchObject({ kind: GatewayBinary.remote, id: 'phone-1' })
    expect(decodeTerminalLocal(framed.bytes)).toEqual(bytesOf('hi'))
    await link.stop()
    expect(kinds().at(-1)).toBe('stop')
  })

  it('drops what would pile up on the socket to a gateway that reads nothing, and says so once a minute', () => {
    const { link, kinds, setBuffered, log, tick } = setup()
    link.connected()
    register(link, 'phone-1')
    setBuffered(GATEWAY_BUFFER_LIMIT + 1)
    link.port.broadcast({ type: 'text_delta' })
    link.port.commander({ type: 'commander_event' })
    expect(link.port.terminalBinary('phone-1', bytesOf('hi'))).toBe(false)
    expect(kinds()).toEqual(['start'])
    expect(log).toHaveBeenCalledTimes(1)
    tick(61_000)
    link.port.broadcast({ type: 'text_delta' })
    expect(log).toHaveBeenCalledTimes(2)
    expect(log.mock.calls[1][0]).toContain('2 more since')
    // What is not bulk (a reply) still goes: it is one frame, and the client is waiting for it.
    link.port.reply('phone-1', 'agents_list', 'r', {})
    expect(kinds()).toEqual(['start', 'reply'])
  })

  it('hands the core what the gateway tells it, read as data', () => {
    const { link, heard } = setup()
    link.connected()
    link.notice({ kind: 'frame', connId: 'phone-1', frame: { type: 'message' }, transport: 'p2p', role: 'web' })
    link.notice({ kind: 'frame', connId: 'dial-1', frame: 'not a frame', transport: 'relay', role: 'device' })
    link.notice({ kind: 'client', connId: 'phone-1', client: null })
    link.notice({ kind: 'disconnected', connId: 'phone-1' })
    link.notice({ kind: 'observer', connId: 'observer:1', type: 'observer_hello', payload: { a: 1 } })
    link.notice({ kind: 'toLocal', connId: 'local:w', frame: { type: 'x' } })
    link.notice({ kind: 'status', connected: true })
    link.notice({ kind: 'linkDown' })
    link.notice({ kind: 'commanders', count: 2, active: 1, recheck: true })
    link.notice({ kind: 'commanders', count: 'x', active: null })
    link.notice({ kind: 'commanderJoined' })
    link.notice({ kind: 'meta', meta: { name: 'Mac' } })
    link.notice({ kind: 'notice', notice: { type: 'desk_changed', revision: 3 } })
    link.notice({ kind: 'revoked' })
    link.notice({ kind: 'busy' })
    link.notice({ kind: 'device', connId: 'dial-1', frame: { type: 'autonomous_device_request' }, opened: { type: 'hello' } })
    link.notice({ kind: 'device', connId: 'dial-1', frame: { type: 'autonomous_device_request' }, opened: null })
    link.notice({ kind: 'deviceRevoked', identity: 'PUB' })
    link.notice({ kind: 'toWindows', frame: { type: 'device_key_added' } })
    link.notice({ kind: 'mystery' })
    expect(heard.frame.mock.calls).toEqual([['phone-1', { type: 'message' }, 'p2p', 'web'], ['dial-1', {}, 'relay', 'device']])
    expect(heard.client).toHaveBeenCalledWith('phone-1', null)
    expect(heard.disconnected).toHaveBeenCalledWith('phone-1')
    expect(heard.observer).toHaveBeenCalledWith('observer:1', 'observer_hello', { a: 1 })
    expect(heard.toLocal).toHaveBeenCalledWith('local:w', { type: 'x' })
    expect(heard.status).toHaveBeenCalledWith(true)
    expect(heard.linkDown).toHaveBeenCalled()
    expect(heard.commanders.mock.calls).toEqual([[2, 1, true], [0, null, false]])
    expect(heard.commanderJoined).toHaveBeenCalled()
    expect(heard.meta).toHaveBeenCalledWith({ name: 'Mac' })
    expect(heard.notice).toHaveBeenCalledWith({ type: 'desk_changed', revision: 3 })
    expect(heard.revoked).toHaveBeenCalled()
    expect(heard.busy).toHaveBeenCalled()
    expect(heard.device.mock.calls).toEqual([['dial-1', { type: 'autonomous_device_request' }, { type: 'hello' }], ['dial-1', { type: 'autonomous_device_request' }, null]])
    expect(heard.deviceRevoked).toHaveBeenCalledWith('PUB')
    expect(heard.toWindows).toHaveBeenCalledWith({ type: 'device_key_added' })
  })

  it('hands on a remote client\'s terminal bytes, and drops what it cannot read', () => {
    const { link, heard } = setup()
    const local = encodeTerminalLocal(bytesOf('ls\r'))!
    link.binary(encodeGatewayBinary(GatewayBinary.remote, 'phone-1', local)!)
    link.binary(encodeGatewayBinary(GatewayBinary.remote, 'phone-1', new Uint8Array([1, 2]))!)
    link.binary(new Uint8Array([9, 9]))
    expect(heard.binary.mock.calls).toEqual([['phone-1', bytesOf('ls\r')]])
  })

  it('a gateway that goes takes the relay with it: every remote client, the link and the devices watching', async () => {
    const { link, heard } = setup()
    link.connected()
    link.notice({ kind: 'status', connected: true })
    register(link, 'phone-1')
    register(link, 'dial-1', 'device')
    link.notice({ kind: 'disconnected', connId: 'dial-1' })
    link.disconnected()
    expect(heard.disconnected.mock.calls).toEqual([['dial-1'], ['phone-1']])
    expect(heard.linkDown).toHaveBeenCalled()
    expect(heard.commanders).toHaveBeenLastCalledWith(0, null)
    expect(heard.status).toHaveBeenLastCalledWith(false)
    expect(link.port.connected()).toBe(false)
    // Gone while the link was down: nothing more to say about the link.
    heard.status.mockClear()
    link.connected()
    link.disconnected()
    expect(heard.status).not.toHaveBeenCalled()
  })

  it('a gateway that connects again without having been seen to go starts afresh, and the last one\'s clients go', () => {
    const { link, heard, kinds } = setup()
    link.connected()
    register(link, 'phone-1')
    link.connected()
    expect(heard.disconnected).toHaveBeenCalledWith('phone-1')
    expect(kinds()).toEqual(['start', 'start'])
    expect(link.port.terminal('phone-1', 'terminal_ready', {})).toBe(false)
  })

  it('answers the daemon\'s own commands about the keys from the gateway, and 503 while it is down', async () => {
    const answers: Record<string, Record<string, unknown>> = {
      [GATEWAY_CALLS.pair]: { status: 200, body: { label: 'Phone' } },
      [GATEWAY_CALLS.listPairs]: { error: 'SERVICE_UNAVAILABLE', service: 'gateway', retryable: true },
      [GATEWAY_CALLS.devicesList]: { status: 200, body: 'not an object' },
    }
    const { link, call } = setup({ call: async (type) => answers[type] ?? { status: 204, body: { type } } })
    expect(await link.ops.pair('ABCD')).toEqual({ status: 200, body: { label: 'Phone' } })
    expect(call).toHaveBeenCalledWith(GATEWAY_CALLS.pair, { code: 'ABCD' }, PAIR_WAIT_MS)
    expect(await link.ops.listPairs()).toEqual({ status: 503, body: { error: 'GATEWAY_UNAVAILABLE' } })
    expect(await link.ops.devicesList()).toEqual({ status: 200, body: {} })
    const each = [
      link.ops.revoke('1'), link.ops.revokeAll(), link.ops.setRemotePassword('pw'), link.ops.clearRemotePassword(),
      link.ops.remotePasswordStatus(), link.ops.trustLinkedPeer({ pub: 'P', machineId: 'm', label: 'l' }), link.ops.groupList(),
      link.ops.groupSync(), link.ops.groupRemove('2'), link.ops.devicesRemove('P'), link.ops.devicesHistory(),
      link.ops.devicesDismiss({ pub: 'P' }), link.ops.devicesRebaseline(true, { seq: 1, hash: 'h' }), link.ops.devicesRebaseline(false),
    ]
    expect((await Promise.all(each)).map((answer) => answer.status)).toEqual(Array(each.length).fill(204))
    expect(call).toHaveBeenCalledWith(GATEWAY_CALLS.devicesRebaseline, { confirm: true, head: { seq: 1, hash: 'h' } }, undefined)
    expect(call).toHaveBeenCalledWith(GATEWAY_CALLS.devicesRebaseline, { confirm: false }, undefined)
  })

  it('reads the gateway\'s status, with nothing to show while it is down, and never starts it for that', async () => {
    const said = { fingerprint: 'AB12', pairs: [{ fingerprint: 'CD34' }], pending: { label: 'Phone' } }
    let answer: Record<string, unknown> = said
    const { link, call, want } = setup({ call: async () => answer })
    // Never started: `/api/status` is answered without it, and does not ask for it.
    expect(await link.ops.status()).toEqual({ fingerprint: null, pairs: [], pending: null })
    expect(call).not.toHaveBeenCalled()
    expect(want).not.toHaveBeenCalled()
    link.connected()
    expect(await link.ops.status()).toEqual(said)
    expect(call).toHaveBeenCalledWith(GATEWAY_CALLS.status, {}, 2_000)
    link.disconnected()
    answer = { error: 'SERVICE_UNAVAILABLE' }
    expect(await link.ops.status()).toEqual({ fingerprint: null, pairs: [], pending: null })
  })

  it('is asked for once, by the first thing that needs it, and tells it what waited, in order, after its start', () => {
    const { link, sent, kinds, want } = setup()
    // What only says how things stand asks for nothing: it is told in the start.
    link.port.localClients({ desktop: 1, tui: 0 })
    link.ops.wifiService(false)
    expect(want).not.toHaveBeenCalled()
    // A window's E2EE request: asked for, and held.
    void link.port.local('conn-1', { type: 'e2ee_pairings_list', payload: { requestId: 'r1' } })
    expect(want).toHaveBeenCalledTimes(1)
    void link.port.local('conn-2', { type: 'phone_pair', payload: { requestId: 'r2' } })
    link.port.connect()
    link.ops.wifiService(true)
    expect(want).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([])
    link.connected()
    expect(kinds()).toEqual(['start', 'localFrame', 'localFrame'])
    expect(sent[1]).toEqual({ kind: 'localFrame', connId: 'conn-1', frame: { type: 'e2ee_pairings_list', payload: { requestId: 'r1' } } })
    expect(sent[2]).toMatchObject({ connId: 'conn-2' })
    // Gone later, it is the master's to restart: nothing waits for it, and it is not asked for again.
    link.disconnected()
    void link.port.local('conn-3', { type: 'e2ee_pairings_list', payload: {} })
    link.connected()
    expect(kinds()).toEqual(['start', 'localFrame', 'localFrame', 'start'])
    expect(want).toHaveBeenCalledTimes(1)
  })

  it('is asked for by a sign-in\'s dial and by the Wi-Fi device\'s service, each once', () => {
    const dialed = setup()
    dialed.link.port.connect()
    expect(dialed.want).toHaveBeenCalledTimes(1)
    const wifi = setup()
    wifi.link.ops.wifiService(true)
    wifi.link.port.connect()
    expect(wifi.want).toHaveBeenCalledTimes(1)
  })

  it('lets go of what waited when it does not start in time, the oldest first when too much waits', async () => {
    vi.useFakeTimers()
    try {
      const { link, sent } = setup({ startWaitMs: 20_000 })
      const select = { type: 'machine_select', payload: {} }
      const sink = { sendFrame: vi.fn(() => true), sendBinary: vi.fn(() => true) }
      const opening = link.windowRelay.acquire('m2', 'prod', select, sink, vi.fn())
      void link.port.local('conn-1', { type: 'e2ee_pairings_list', payload: {} })
      vi.advanceTimersByTime(20_000)
      await expect(opening).rejects.toEqual(new RelayConnectError('the relay did not start', WINDOW_GATEWAY_GONE))
      // No late E2EE request goes to a gateway that came after the startup deadline.
      link.connected()
      expect(sent.map((payload) => payload.kind)).toEqual(['start'])

      const crowded = setup()
      const first = crowded.link.windowRelay.acquire('m2', 'prod', select, sink, vi.fn())
      for (let i = 0; i < OWED_MAX; i++) void crowded.link.port.local(`conn-${i}`, { type: 'e2ee_pairings_list', payload: {} })
      await expect(first).rejects.toEqual(new RelayConnectError('the relay did not start', WINDOW_GATEWAY_GONE))
      crowded.link.connected()
      expect(crowded.sent).toHaveLength(1 + OWED_MAX)
      // The default wait, when none is given.
      const plain = setup()
      void plain.link.port.local('conn-1', { type: 'e2ee_pairings_list', payload: {} })
      vi.advanceTimersByTime(ON_DEMAND_START_MS)
      plain.link.connected()
      expect(plain.sent).toHaveLength(1)
    } finally { vi.useRealTimers() }
  })

  it('carries the Wi-Fi device\'s requests, a refusal as the device\'s local API words it', async () => {
    let answer: Record<string, unknown> = { result: { devices: [] } }
    const { link, call } = setup({ call: async () => answer })
    expect(await link.ops.wifi({ op: 'list' })).toEqual({ result: { devices: [] } })
    expect(call).toHaveBeenLastCalledWith(GATEWAY_CALLS.wifi, { op: 'list' }, undefined)
    answer = { refused: { code: 'UNKNOWN_DEVICE', message: 'Device pairing not found' } }
    expect(await link.ops.wifi({ op: 'pair', device: 'd', code: 'c' })).toEqual({ refused: { code: 'UNKNOWN_DEVICE', message: 'Device pairing not found' } })
    expect(call).toHaveBeenLastCalledWith(GATEWAY_CALLS.wifi, { op: 'pair', device: 'd', code: 'c' }, PAIR_WAIT_MS)
    answer = { refused: { code: 7 } }
    expect((await link.ops.wifi({ op: 'discover' })) as { refused: { code: string } }).toMatchObject({ refused: { code: 'UNAVAILABLE' } })
    answer = { error: 'SERVICE_UNAVAILABLE' }
    expect(await link.ops.wifi({ op: 'revoke', id: 'x' })).toMatchObject({ refused: { code: 'UNAVAILABLE' } })
  })

  it('asks the gateway for Share\'s owner\'s key, and says none is held while it cannot answer', async () => {
    let answer: Record<string, unknown> = { key: 'cHVi' }
    const { link, call } = setup({ call: async () => answer })
    expect(await link.ops.observerKey.publicKey()).toBe('cHVi')
    expect(call).toHaveBeenLastCalledWith(GATEWAY_CALLS.observerKey, { op: 'public' }, LANE_WAIT_MS)
    expect(await link.ops.observerKey.signWelcome('m', 's', 'cA==', 'ZQ==')).toBe('cHVi')
    expect(call).toHaveBeenLastCalledWith(GATEWAY_CALLS.observerKey, { op: 'sign', machineId: 'm', shareId: 's', peer: 'cA==', ephemeral: 'ZQ==' }, LANE_WAIT_MS)
    answer = { error: 'not a welcome to an observer' }
    await expect(link.ops.observerKey.signWelcome('m', 's', 'x', 'y')).rejects.toThrow('not a welcome to an observer')
    for (const error of ['SERVICE_UNAVAILABLE', 'SERVICE_FAILED', undefined]) {
      answer = error ? { error } : {}
      await expect(link.ops.observerKey.publicKey()).rejects.toThrow(/not running/)
    }
  })

  it('carries the fleet\'s lane to the gateway\'s sessions, every step a call in order, and never a frame back unsealed', async () => {
    let answer: Record<string, unknown> = {}
    const { link, call } = setup({ call: async () => answer })
    const lane = link.ops.lane
    answer = { frame: { type: 'e2e_hello', payload: { identityPub: 'P' } } }
    expect(await lane.hello('m2', 'PEER')).toEqual({ type: 'e2e_hello', payload: { identityPub: 'P' } })
    expect(call).toHaveBeenLastCalledWith(GATEWAY_CALLS.lane, { op: 'hello', machineId: 'm2', peerPub: 'PEER' }, LANE_WAIT_MS)
    answer = { ok: true }
    expect(await lane.welcome('m2', { ephPub: 'E' })).toBe(true)
    expect(call).toHaveBeenLastCalledWith(GATEWAY_CALLS.lane, { op: 'welcome', machineId: 'm2', payload: { ephPub: 'E' } }, LANE_WAIT_MS)
    await lane.rekey('m2', { epoch: 'x' })
    expect(call).toHaveBeenLastCalledWith(GATEWAY_CALLS.lane, { op: 'rekey', machineId: 'm2', payload: { epoch: 'x' } }, LANE_WAIT_MS)
    answer = { frame: { type: 'message', payload: { __e2e: {} } } }
    expect(await lane.seal('m2', { type: 'message', payload: { content: 'hi' } })).toEqual({ frame: { type: 'message', payload: { __e2e: {} } } })
    expect(call).toHaveBeenLastCalledWith(GATEWAY_CALLS.lane, { op: 'seal', machineId: 'm2', frame: { type: 'message', payload: { content: 'hi' } } }, LANE_WAIT_MS)
    answer = { frame: { type: 'agents_list_result', payload: {} } }
    expect(await lane.open('m2', { type: 'agents_list_result' })).toEqual({ frame: { type: 'agents_list_result', payload: {} } })
    answer = { unreadable: true }
    expect(await lane.open('m2', { type: 'agents_list_result' })).toEqual({ unreadable: true })
    lane.drop('m2')
    expect(call).toHaveBeenLastCalledWith(GATEWAY_CALLS.lane, { op: 'drop', machineId: 'm2' }, LANE_WAIT_MS)
    // The gateway not there (or failed): no session is started, nothing is sealed or opened.
    answer = { error: 'SERVICE_UNAVAILABLE' }
    await expect(lane.hello('m2', 'PEER')).rejects.toThrow(/not running/)
    expect(await lane.welcome('m2', {})).toBe(false)
    expect(await lane.seal('m2', { type: 'message', payload: { content: 'hi' } })).toEqual({ lost: true })
    expect(await lane.open('m2', { type: 'agents_list_result' })).toEqual({ lost: true })
  })

  it('hands the core\'s services the gateway\'s lane as it is when each is called', async () => {
    const one = { hello: vi.fn(async () => ({ type: 'e2e_hello' })), welcome: vi.fn(async () => true), rekey: vi.fn(async () => {}),
      seal: vi.fn(async () => ({ lost: true as const })), open: vi.fn(async () => ({ unreadable: true as const })), drop: vi.fn() } satisfies LaneSeal
    let current: LaneSeal = one
    const lane = laneOf(() => current)
    expect(await lane.hello('m', 'P')).toEqual({ type: 'e2e_hello' })
    expect(await lane.welcome('m', { a: 1 })).toBe(true)
    await lane.rekey('m', { b: 2 })
    expect(await lane.seal('m', { type: 't' })).toEqual({ lost: true })
    expect(await lane.open('m', { type: 't' })).toEqual({ unreadable: true })
    lane.drop('m')
    expect(one.hello).toHaveBeenCalledWith('m', 'P')
    expect(one.welcome).toHaveBeenCalledWith('m', { a: 1 })
    expect(one.rekey).toHaveBeenCalledWith('m', { b: 2 })
    expect(one.drop).toHaveBeenCalledWith('m')
    const two = { ...one, seal: vi.fn(async (_m: string, frame: Record<string, unknown>) => ({ frame })) }
    current = two
    expect(await lane.seal('m', { type: 'later' })).toEqual({ frame: { type: 'later' } })
  })

  it('tells the gateway what the core learns for it', () => {
    const { link, sent } = setup()
    link.connected()
    link.ops.revokeIdentity('PUB')
    link.ops.reachable(null)
    expect(sent.slice(1)).toEqual([{ kind: 'revokeIdentity', identity: 'PUB' }, { kind: 'reachable', machineIds: null }])
  })

  it('hands the gateway a token from the account, and the session\'s own refusal when there is none', async () => {
    const { link, tokens, backend } = setup()
    expect(await link.answer('access_token', { force: true, failedToken: 'old' })).toEqual({ token: 'token-1' })
    expect(tokens.accessToken).toHaveBeenLastCalledWith({ force: true, failedToken: 'old' })
    await link.answer('access_token', {})
    expect(tokens.accessToken).toHaveBeenLastCalledWith({ force: false })
    tokens.accessToken.mockRejectedValueOnce(Object.assign(new Error('refresh refused'), { code: 'INVALID_REFRESH' }))
    expect(await link.answer('access_token', {})).toEqual({ code: 'INVALID_REFRESH', message: 'refresh refused' })
    tokens.accessToken.mockRejectedValueOnce('down')
    expect(await link.answer('access_token', {})).toEqual({ code: 'UNAVAILABLE', message: 'down' })
    // The device key log's reads of the backend, and nothing else the core's session could reach.
    expect(await link.answer('backend', { method: 'GET', path: '/api/device-keys?since=4' })).toEqual({ status: 200, body: { data: { seen: {} } } })
    expect(backend).toHaveBeenCalledWith('GET', '/api/device-keys?since=4')
    // The harnesses shared with this account, which the Share relay looks a share up in before it dials.
    expect(await link.answer('backend', { method: 'GET', path: '/api/harness-shares' })).toEqual({ status: 200, body: { data: { seen: {} } } })
    expect(backend).toHaveBeenLastCalledWith('GET', '/api/harness-shares')
    expect(await link.answer('backend', { method: 'GET', path: '/api/harness-shares/x' })).toEqual({ error: 'UNKNOWN_QUERY' })
    expect(await link.answer('backend', { method: 'GET', path: '/api/machines' })).toEqual({ error: 'UNKNOWN_QUERY' })
    expect(await link.answer('backend', { method: 'POST', path: '/api/device-keys' })).toEqual({ error: 'UNKNOWN_QUERY' })
    expect(await link.answer('agents', {})).toEqual({ error: 'UNKNOWN_QUERY' })
    expect(backend).toHaveBeenCalledTimes(2)
  })
})

describe('the link\'s defaults', () => {
  it('logs on the console and stamps with the clock when not told otherwise', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const link = createGatewayLink({
      events: events() as unknown as GatewayEvents, notify: () => true, notifyBinary: () => true, buffered: () => GATEWAY_BUFFER_LIMIT + 1,
      call: async () => ({}), start: () => ({}), tokens: { accessToken: async () => 't' }, backend: async () => ({ status: 200, body: {} }),
    })
    link.connected()
    link.port.broadcast({ type: 'text_delta' })
    link.notice({ kind: 'mystery' })
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})

describe('a window here working on another machine, through the gateway', () => {
  const select = { type: 'machine_select', payload: { machineId: 'm2' } }
  const sink = () => ({ sendFrame: vi.fn(() => true), sendBinary: vi.fn(() => true) })

  it('opens when the gateway says it did, and carries its frames and bytes both ways', async () => {
    const { link, sent, binary, kinds } = setup()
    link.connected()
    const window = sink()
    const onClosed = vi.fn()
    const opening = link.windowRelay.acquire('m2', 'prod', select, window, onClosed)
    expect(sent.at(-1)).toEqual({ kind: 'windowOpen', id: 'window-1', machineId: 'm2', autonomousEnv: 'prod', frame: select, isolated: false })
    link.notice({ kind: 'windowOpened', id: 'window-1' })
    link.notice({ kind: 'windowOpened', id: 'window-1' })
    const session = await opening
    await session.send({ type: 'agents_list' })
    await session.sendBinary(bytesOf('ls\r'))
    expect(sent.at(-1)).toEqual({ kind: 'windowSend', id: 'window-1', frame: { type: 'agents_list' } })
    expect(decodeGatewayBinary(binary[0])).toMatchObject({ kind: GatewayBinary.window, id: 'window-1' })
    link.notice({ kind: 'windowFrame', id: 'window-1', frame: { type: 'agents_list_result' } })
    link.notice({ kind: 'windowFrame', id: 'window-9', frame: { type: 'stray' } })
    link.binary(encodeGatewayBinary(GatewayBinary.window, 'window-1', new Uint8Array([7, 7]))!)
    expect(window.sendFrame).toHaveBeenCalledWith({ type: 'agents_list_result' })
    expect(window.sendBinary).toHaveBeenCalledWith(new Uint8Array([7, 7]))
    link.notice({ kind: 'windowClosed', id: 'window-1', code: 4404, reason: 'NO_PEER_LINK' })
    expect(onClosed).toHaveBeenCalledWith(4404, 'NO_PEER_LINK')
    // Said twice, or of a window it never had: nothing more.
    link.notice({ kind: 'windowClosed', id: 'window-1', code: 4404, reason: 'NO_PEER_LINK' })
    expect(onClosed).toHaveBeenCalledOnce()
    session.detach()
    expect(kinds()).not.toContain('windowDetach')
    link.windowRelay.invalidate('m2')
    link.windowRelay.invalidateIsolated('m2')
    expect(sent.slice(-2)).toEqual([{ kind: 'windowInvalidate', machineId: 'm2', isolated: false }, { kind: 'windowInvalidate', machineId: 'm2', isolated: true }])
  })

  it('a window that leaves says so; one the gateway could not open fails as the pool failed it', async () => {
    const { link, kinds } = setup()
    link.connected()
    const opening = link.windowRelay.acquireIsolated('m2', 'prod', select, sink(), vi.fn())
    link.notice({ kind: 'windowOpened', id: 'window-1' })
    ;(await opening).detach()
    expect(kinds().at(-1)).toBe('windowDetach')
    const failing = link.windowRelay.acquire('m2', 'prod', select, sink(), vi.fn())
    link.notice({ kind: 'windowFailed', id: 'window-2', reason: 'NO_PEER_LINK' })
    await expect(failing).rejects.toEqual(new RelayConnectError('NO_PEER_LINK', 1011))
    const refused = link.windowRelay.acquire('m2', 'prod', select, sink(), vi.fn())
    link.notice({ kind: 'windowFailed', id: 'window-3', code: 4403 })
    await expect(refused).rejects.toMatchObject({ closeCode: 4403, message: 'relay failed' })
  })

  it('watches a harness shared with this account through the gateway, and is told 4403 when the share ended', async () => {
    const { link, sent, want } = setup()
    // The gateway not started yet: asked for, and the window opened once it has.
    const window = sink()
    const watching = link.windowRelay.acquireShare!('owner', 'share-1', window, vi.fn())
    expect(want).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([])
    link.connected()
    expect(sent.at(-1)).toEqual({ kind: 'windowOpen', id: 'window-1', machineId: 'owner', share: 'share-1' })
    link.notice({ kind: 'windowOpened', id: 'window-1' })
    await watching
    link.notice({ kind: 'windowFrame', id: 'window-1', frame: { type: 'connected', payload: { readOnly: true } } })
    expect(window.sendFrame).toHaveBeenCalledWith({ type: 'connected', payload: { readOnly: true } })
    const ended = link.windowRelay.acquireShare!('owner', 'share-2', sink(), vi.fn())
    link.notice({ kind: 'windowFailed', id: 'window-2', code: 4403, reason: 'Sharing ended or invitation expired' })
    await expect(ended).rejects.toEqual(new RelayConnectError('Sharing ended or invitation expired', 4403))
  })

  it('the gateway gone: a window waiting to open and one open are both told to try again', async () => {
    const { link } = setup()
    link.connected()
    link.disconnected()
    // Gone, out of reach just now, as the relay said when it could not dial.
    await expect(link.windowRelay.acquire('m2', 'prod', select, sink(), vi.fn())).rejects.toMatchObject({ closeCode: WINDOW_GATEWAY_GONE })
    link.connected()
    const onClosed = vi.fn()
    const open = link.windowRelay.acquire('m2', 'prod', select, sink(), onClosed)
    link.notice({ kind: 'windowOpened', id: 'window-1' })
    const session = await open
    const waiting = link.windowRelay.acquire('m3', 'prod', select, sink(), vi.fn())
    link.disconnected()
    expect(onClosed).toHaveBeenCalledWith(WINDOW_GATEWAY_GONE, 'the relay restarted')
    await expect(waiting).rejects.toMatchObject({ closeCode: WINDOW_GATEWAY_GONE })
    // Its bytes go nowhere now: the gateway is not there to take them.
    await session.sendBinary(bytesOf('x'))
  })
})

describe('local requests when the gateway cannot answer', () => {
  const request = (requestId: string, type = 'e2ee_pairings_list') => ({ type, payload: { requestId } })
  const refusal = (requestId: string, type = 'e2ee_pairings_list') => ({
    type: `${type}_result`, payload: { requestId, error: 'SERVICE_UNAVAILABLE', service: 'gateway', retryable: true },
  })

  it('refuses in-flight and new requests on disconnection, without failing an answered request or replaying one', async () => {
    const { link, heard, kinds } = setup()
    link.connected()
    await link.port.local('a', request('done'))
    await link.port.local('a', request('waiting'))
    await link.port.local('b', request('waiting'))
    link.notice({ kind: 'toLocal', connId: 'a', frame: { type: 'e2ee_pairings_list_result', payload: { requestId: 'done', pairs: [] } } })
    // Neither an unrelated request type nor another connection can complete this request.
    link.notice({ kind: 'toLocal', connId: 'a', frame: { type: 'phone_pair_result', payload: { requestId: 'waiting' } } })
    link.notice({ kind: 'toLocal', connId: 'other', frame: { type: 'e2ee_pairings_list_result', payload: { requestId: 'waiting' } } })
    heard.toLocal.mockClear()
    link.disconnected()
    expect(heard.toLocal.mock.calls).toEqual([['a', refusal('waiting')], ['b', refusal('waiting')]])
    await link.port.local('a', request('down'))
    expect(heard.toLocal).toHaveBeenLastCalledWith('a', refusal('down'))
    link.connected()
    expect(kinds()).toEqual(['start', 'localFrame', 'localFrame', 'localFrame', 'start'])
  })

  it('answers when a connected socket refuses the frame', async () => {
    const { link, heard, setWritable } = setup()
    link.connected()
    setWritable(false)
    await link.port.local('a', request('failed-send'))
    expect(heard.toLocal.mock.calls).toEqual([['a', refusal('failed-send')]])
    link.disconnected()
    expect(heard.toLocal).toHaveBeenCalledOnce()
  })

  it('bounds the unanswered wait, gives interactive pairing its own deadline, and coalesces an identical pending request', async () => {
    vi.useFakeTimers()
    try {
      const { link, heard, kinds } = setup()
      link.connected()
      await link.port.local('a', request('list'))
      await link.port.local('a', request('list'))
      await link.port.local('a', request('phone', 'phone_pair'))
      await link.port.local('a', request('device', 'device_e2ee_pair'))
      expect(kinds()).toEqual(['start', 'localFrame', 'localFrame', 'localFrame'])
      vi.advanceTimersByTime(LANE_WAIT_MS)
      expect(heard.toLocal.mock.calls).toEqual([['a', refusal('list')]])
      vi.advanceTimersByTime(PAIR_WAIT_MS - LANE_WAIT_MS)
      expect(heard.toLocal.mock.calls.slice(1)).toEqual([['a', refusal('phone', 'phone_pair')], ['a', refusal('device', 'device_e2ee_pair')]])
      link.disconnected()
      expect(heard.toLocal).toHaveBeenCalledTimes(3)
    } finally { vi.useRealTimers() }
  })

  it('bounds in-flight requests and refuses excess work before it can mutate pairing state', async () => {
    const { link, heard, kinds } = setup()
    link.connected()
    for (let i = 0; i < OWED_MAX; i++) await link.port.local('a', request(String(i)))
    await link.port.local('a', request('excess', 'e2ee_pairings_unpair_all'))
    expect(heard.toLocal.mock.calls).toEqual([['a', refusal('excess', 'e2ee_pairings_unpair_all')]])
    expect(kinds().filter((kind) => kind === 'localFrame')).toHaveLength(OWED_MAX)
    link.disconnected()
    expect(heard.toLocal).toHaveBeenCalledTimes(OWED_MAX + 1)
  })

  it('refuses queued requests on startup expiry and eviction, never sending refused mutations later', async () => {
    vi.useFakeTimers()
    try {
      const { link, heard, sent } = setup()
      for (let i = 0; i <= OWED_MAX; i++) await link.port.local('a', request(String(i), 'e2ee_pairing_unpair'))
      expect(heard.toLocal.mock.calls).toEqual([['a', refusal('0', 'e2ee_pairing_unpair')]])
      vi.advanceTimersByTime(ON_DEMAND_START_MS)
      expect(heard.toLocal).toHaveBeenCalledTimes(OWED_MAX + 1)
      link.connected()
      expect(sent.map((payload) => payload.kind)).toEqual(['start'])
    } finally { vi.useRealTimers() }
  })
})

describe('account HTTP owned by the gateway', () => {
  it('forwards methods and optional bodies, and bounds the answer', async () => {
    const { link, call } = setup()
    expect(await link.ops.backend('GET', '/api/auth/me')).toEqual({ status: 200, body: { ok: true } })
    expect(call).toHaveBeenLastCalledWith(GATEWAY_CALLS.backend, { method: 'GET', path: '/api/auth/me' }, 25_000)
    await link.ops.backend('PATCH', '/api/machines/m1', { name: 'Laptop' })
    expect(call).toHaveBeenLastCalledWith(GATEWAY_CALLS.backend, { method: 'PATCH', path: '/api/machines/m1', body: { name: 'Laptop' } }, 25_000)
    call.mockResolvedValueOnce({ name: 'private-grid' })
    expect(await link.ops.mintGridName()).toBe('private-grid')
    call.mockResolvedValueOnce({})
    expect(await link.ops.mintGridName()).toBeNull()
    call.mockResolvedValueOnce({ error: 'SERVICE_UNAVAILABLE' })
    await expect(link.ops.mintGridName()).rejects.toThrow('SERVICE_UNAVAILABLE')
  })

  it('answers the guest list without waking a gateway or reading a previous account', async () => {
    const { link, call, want, machines } = setup({ start: () => ({ signedIn: true, account: { machineId: null }, computerId: 'computer', machineName: 'Laptop', hostname: 'host' }) })
    expect(await link.ops.machines()).toMatchObject({ status: 200, body: { data: { guest: true, stale: false, machines: [
      { machineId: 'computer', computerId: 'computer', name: 'Laptop', hostname: 'host', status: 'online' },
    ] } } })
    expect(call).not.toHaveBeenCalled()
    expect(want).not.toHaveBeenCalled()
    expect(machines).toHaveBeenCalledWith(expect.objectContaining({ owner: null }))
  })

  it('retains reported rows across a crash, but never hides a sign-out or crosses accounts', async () => {
    let owner = 'account-a'
    const { link, call, machines } = setup({ start: () => ({ signedIn: true, account: { machineId: owner } }) })
    const body = { success: true, data: { machines: [{ machineId: 'm2' }] } }
    link.notice({ kind: 'machines', owner, body, fetchedAt: 1000 })
    expect(machines).toHaveBeenLastCalledWith({ owner, body, fetchedAt: 1000 })
    call.mockResolvedValue({ error: 'SERVICE_UNAVAILABLE' })
    link.disconnected()
    expect(await link.ops.machines(true)).toEqual({ status: 200, body: { success: true, data: { machines: [{ machineId: 'm2' }], stale: true, staleSince: new Date(1000).toISOString() } } })
    expect((await link.ops.machines()).status).toBe(503)
    owner = 'account-b'
    expect((await link.ops.machines(true)).status).toBe(503)
    owner = ''
    expect(await link.ops.machines(true)).toMatchObject({ status: 200, body: { data: { guest: true, stale: false } } })
    owner = 'account-a'
    call.mockResolvedValueOnce({ status: 401, body: { error: 'NOT_SIGNED_IN' } })
    expect((await link.ops.machines(true)).status).toBe(401)
    expect((await link.ops.machines(true)).status).toBe(503)
    link.notice({ kind: 'machines', owner, body, fetchedAt: 1000 })
    call.mockResolvedValueOnce({ status: 403, body: {} })
    expect((await link.ops.machines(true)).status).toBe(403)
    expect((await link.ops.machines(true)).status).toBe(503)
    link.notice({ kind: 'machines', owner, body: null, fetchedAt: 1000 })
    expect((await link.ops.machines(true)).status).toBe(503)
  })

  it('accepts empty notices and bounds malformed timestamps before a stale response uses one', () => {
    const { link, machines } = setup()
    for (const fetchedAt of [undefined, Infinity, 1e30]) {
      link.notice({ kind: 'machines', owner: null, body: [], fetchedAt })
      expect(machines).toHaveBeenLastCalledWith({ owner: null, body: null, fetchedAt: 1_000_000 })
    }
    link.notice({ kind: 'machines' })
    expect(machines).toHaveBeenLastCalledWith({ owner: null, body: null, fetchedAt: 1_000_000 })
  })
})

it('rejects a reply when the core changed accounts while the gateway was answering', async () => {
  let owner = 'a'
  const { link } = setup({ start: () => ({ signedIn: true, account: { machineId: owner } }),
    call: async () => { owner = 'b'; return { status: 200, body: { machines: ['a'] } } } })
  expect(await link.ops.machines(true)).toMatchObject({ status: 409, body: { error: { code: 'ACCOUNT_CHANGED' } } })
})

it('forgets reported presence when accounts change and ignores notices already in flight from the old account', () => {
  let owner = 'a'
  const { link, machines } = setup({ start: () => ({ account: { machineId: owner } }) })
  const body = { machines: [{ machineId: 'private-a' }] }
  link.notice({ kind: 'machines', owner, body, fetchedAt: 1000 })
  link.ops.account({ machineId: owner, signIn: null })
  expect(machines).toHaveBeenCalledTimes(1)
  owner = 'b'
  link.ops.account({ machineId: owner, signIn: null })
  expect(machines).toHaveBeenLastCalledWith({ owner, body: null, fetchedAt: 1_000_000 })
  link.notice({ kind: 'machines', owner: 'a', body, fetchedAt: 1001 })
  expect(machines).toHaveBeenCalledTimes(2)
})

it('uses fresh account facts rather than the relay startup sign-in flag', async () => {
  const { link, call } = setup({ start: () => ({ signedIn: false, account: { machineId: 'new-account' } }) })
  expect(await link.ops.machines()).toEqual({ status: 200, body: { ok: true } })
  expect(call).toHaveBeenCalledWith(GATEWAY_CALLS.machines, { fallback: false }, 25_000)
})
