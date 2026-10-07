/**
 * The gateway in its own process, as the core sees it (docs/design/2026-10-06-core-boundary-next.md, step
 * 10, R2; the process's side is gateway/gatewayProcess.ts). The relay, the E2EE sessions and every key
 * live there; the core keeps what it must read in line, as the gateway last said it, and sends what it has
 * for remote clients in the clear, over the service link only the master's token opens.
 *
 *   - What the core reads synchronously is kept here from the gateway's notices: whether the backend link
 *     is up, and the remote clients it holds a session with (the socket keeps their roles and labels).
 *   - What the core has for a remote client goes to the gateway as it is, never held: a frame the gateway
 *     is not there to seal is a frame no remote client could have got. While the gateway reads nothing
 *     (hung), what would pile up on the socket to it is dropped at GATEWAY_BUFFER_LIMIT and said once a
 *     minute; the master kills a hung gateway soon after.
 *   - The gateway gone (crashed, killed, restarting) is the relay gone: every remote client with it, the
 *     link down, no device watching. A window working on another machine through it is closed, and opens
 *     again on its own. The windows on this computer and the agents never notice.
 *   - Each time the gateway connects it is told everything it starts from (`start`): it builds its relay
 *     afresh, as a core's restart did when the relay ran in the core.
 */
import { RelayConnectError } from '../lib/relayFrames.js'
import { decodeGatewayBinary, encodeGatewayBinary, GatewayBinary, GATEWAY_CALLS } from '../lib/gatewayWire.js'
import { decodeTerminalLocal, encodeTerminalLocal } from '../lib/terminalBinary.js'
import { answerAccountQuery } from './accountQueries.js'
import { LANE_OFF } from './api.js'
import type {
  BackendNotice, GatewayEvents, GatewayOps, GatewayPort, GatewayRefusal, GatewayStatus, HttpAnswer, LaneSeal,
  RemoteClient, RemoteRole, RemoteTransport, WindowRelay, WindowRelaySession, WindowRelaySink,
} from './api.js'
import type { ServiceFrame } from './serviceLinks.js'

export interface GatewayLinkDeps {
  /** The core's side of what the gateway tells it (BackendSocket's `fromGateway`). */
  events: GatewayEvents
  /** The service link to the gateway (core/serviceLinks.ts, for `gateway`). */
  notify(frame: ServiceFrame): boolean
  notifyBinary(bytes: Uint8Array): boolean
  buffered(): number
  call(type: string, payload: Record<string, unknown>, waitMs?: number): Promise<Record<string, unknown>>
  /** What the gateway starts from each time it connects: this machine's ids, whether it is signed in. */
  start(): Record<string, unknown>
  /** The account's tokens (`core.account`): the gateway asks for one each time it dials, and holds none. */
  tokens: { accessToken(opts?: { force?: boolean; failedToken?: string }): Promise<string> }
  /** A read of the backend's REST API under the account's session (the core's proxy). */
  backend(method: 'GET', path: string): Promise<HttpAnswer>
  newId?: () => string
  now?: () => number
  log?: (line: string) => void
}

/** Bytes waiting on the socket to the gateway past which a frame for remote clients is dropped. A hung
 *  gateway reads nothing for up to its heartbeat deadline (30 s); every event and terminal byte for
 *  remote clients would wait in the core's memory meanwhile. */
export const GATEWAY_BUFFER_LIMIT = 16 * 1024 * 1024

/** How long a pairing may take: the code is typed on one screen and checked over the relay, round by round. */
export const PAIR_WAIT_MS = 120_000

/** The close a window on another machine gets when the gateway it went through is gone: try again shortly. */
export const WINDOW_GATEWAY_GONE = 1013

/** How long the fleet's lane waits on the gateway to seal or open a frame. The frames behind it wait too,
 *  in order; a gateway that has not answered in this long is hung, and the master ends it soon after. */
export const LANE_WAIT_MS = 5_000

const UNAVAILABLE: HttpAnswer = { status: 503, body: { error: 'GATEWAY_UNAVAILABLE' } }

interface Window {
  sink: WindowRelaySink
  onClosed: (code: number, reason: string) => void
  opening: { resolve: (session: WindowRelaySession) => void; reject: (error: Error) => void } | null
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const record = (value: unknown): Record<string, unknown> =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})

export function createGatewayLink(deps: GatewayLinkDeps) {
  const { events } = deps
  const log = deps.log ?? ((line: string) => console.warn(line))
  const now = deps.now ?? Date.now
  let counter = 0
  const newId = deps.newId ?? (() => `window-${++counter}`)
  /** The gateway's process is connected to this core. */
  let up = false
  /** The backend link, as the gateway last said. */
  let linkUp = false
  // What the gateway is told again whenever it connects.
  let requestsOpen = true
  let dial: 'connect' | 'local' | null = null
  let localClients = 0
  let wifiService = false
  let reachable: string[] | null = null
  /** The remote clients the gateway registered, to forget each when it goes. */
  const clients = new Set<string>()
  const windows = new Map<string, Window>()
  let droppedSaidAt = -Infinity
  let droppedUnsaid = 0

  const send = (kind: string, payload: Record<string, unknown> = {}): boolean =>
    up && deps.notify({ type: 'service_event', payload: { ...payload, kind } })
  /** A frame for remote clients: dropped rather than held while the gateway reads nothing. */
  const fits = (): boolean => {
    if (deps.buffered() <= GATEWAY_BUFFER_LIMIT) return true
    const at = now()
    if (at - droppedSaidAt < 60_000) droppedUnsaid++
    else {
      log(`[gateway] it is not reading: frames for remote clients dropped${droppedUnsaid ? ` · ${droppedUnsaid} more since` : ''}`)
      droppedSaidAt = at
      droppedUnsaid = 0
    }
    return false
  }
  const bulk = (kind: string, payload: Record<string, unknown>): boolean => up && fits() && send(kind, payload)
  const reachableClient = (connId: string): boolean => up && clients.has(connId)

  const port: GatewayPort = {
    connect: () => { dial = 'connect'; send('connect') },
    serveThisComputerOnly: () => { dial = 'local'; send('thisComputerOnly') },
    holdRequests: () => { requestsOpen = false; send('hold') },
    openRequests: () => { requestsOpen = true; send('open') },
    connected: () => up && linkUp,
    broadcast: (frame) => { bulk('broadcast', { frame }) },
    commander: (frame) => { bulk('commander', { frame }) },
    user: (frame) => { send('user', { frame }) },
    reply: (connId, type, requestId, payload) => { send('reply', { connId, type, requestId, payload }) },
    target: (connId, type, payload) => up && linkUp && clients.has(connId) && bulk('target', { connId, type, payload }),
    terminal: (connId, type, payload) => reachableClient(connId) && bulk('terminal', { connId, type, payload }),
    terminalBinary: (connId, clear) => {
      if (!reachableClient(connId) || !fits()) return false
      const local = encodeTerminalLocal(clear)
      const bytes = local && encodeGatewayBinary(GatewayBinary.remote, connId, local)
      return !!bytes && deps.notifyBinary(bytes)
    },
    observer: (connId, type, payload) => up && linkUp && send('observer', { connId, type, payload }),
    windowOpened: () => { send('windowOpened') },
    localClients: (count) => { localClients = count; send('localClients', { count }) },
    local: async (connId, frame) => { send('localFrame', { connId, frame }) },
    device: (connId, type, payload) => reachableClient(connId) && send('device', { connId, type, payload }),
    deviceClient: (connId, identity) => { send('deviceClient', { connId, identity }) },
    stop: async () => { send('stop') },
  }

  const http = async (type: string, payload: Record<string, unknown> = {}, waitMs?: number): Promise<HttpAnswer> => {
    const answer = await deps.call(type, payload, waitMs)
    return typeof answer.status === 'number' ? { status: answer.status, body: record(answer.body) } : UNAVAILABLE
  }

  /**
   * The fleet's lane's sessions, in the gateway (gateway/lane.ts). Every one of them is a call, the lane's
   * drop too, so the gateway takes them in the order the lane made them. A gateway that is not there
   * starts no session and seals nothing: the lane hears `lost`, never its frame back as it was.
   */
  const lane = (op: string, payload: Record<string, unknown> = {}) => deps.call(GATEWAY_CALLS.lane, { ...payload, op }, LANE_WAIT_MS)
  const laneOps: LaneSeal = {
    hello: async (machineId, peerPub) => {
      const answer = await lane('hello', { machineId, peerPub })
      if (answer.frame && typeof answer.frame === 'object') return record(answer.frame)
      throw new Error('the gateway could not start an E2EE session: it is not running')
    },
    welcome: async (machineId, payload) => (await lane('welcome', { machineId, payload })).ok === true,
    rekey: async (machineId, payload) => { await lane('rekey', { machineId, payload }) },
    seal: async (machineId, frame) => {
      const answer = await lane('seal', { machineId, frame })
      return answer.frame && typeof answer.frame === 'object' ? { frame: record(answer.frame) } : { lost: true }
    },
    open: async (machineId, frame) => {
      const answer = await lane('open', { machineId, frame })
      if (answer.frame && typeof answer.frame === 'object') return { frame: record(answer.frame) }
      return answer.unreadable === true ? { unreadable: true } : { lost: true }
    },
    drop: (machineId) => { void lane('drop', { machineId }) },
  }

  /** Share's owner's key, held by the gateway (gateway/observerKey.ts): each a call; none while it is away. */
  const ownerKey = async (payload: Record<string, unknown>): Promise<string> => {
    const answer = await deps.call(GATEWAY_CALLS.observerKey, payload, LANE_WAIT_MS)
    if (typeof answer.key === 'string') return answer.key
    // Its process down, or its gateway not started yet: no key to sign with.
    throw new Error(typeof answer.error === 'string' && !answer.error.startsWith('SERVICE_') ? answer.error : 'the gateway holds no key just now: it is not running')
  }

  const ops: GatewayOps = {
    status: async (): Promise<GatewayStatus> => {
      const answer = await deps.call(GATEWAY_CALLS.status, {}, 2_000)
      return {
        fingerprint: typeof answer.fingerprint === 'string' ? answer.fingerprint : null,
        pairs: Array.isArray(answer.pairs) ? answer.pairs as Array<Record<string, unknown>> : [],
        pending: answer.pending && typeof answer.pending === 'object' ? answer.pending as Record<string, unknown> : null,
      }
    },
    pair: (code) => http(GATEWAY_CALLS.pair, { code }, PAIR_WAIT_MS),
    listPairs: () => http(GATEWAY_CALLS.listPairs),
    revoke: (id) => http(GATEWAY_CALLS.revoke, { id }),
    revokeAll: () => http(GATEWAY_CALLS.revokeAll),
    setRemotePassword: (password) => http(GATEWAY_CALLS.setRemotePassword, { password }),
    clearRemotePassword: () => http(GATEWAY_CALLS.clearRemotePassword),
    remotePasswordStatus: () => http(GATEWAY_CALLS.remotePasswordStatus),
    trustLinkedPeer: (peer) => http(GATEWAY_CALLS.trustLinkedPeer, { peer }),
    groupList: () => http(GATEWAY_CALLS.groupList),
    groupSync: () => http(GATEWAY_CALLS.groupSync),
    groupRemove: (selector) => http(GATEWAY_CALLS.groupRemove, { selector }),
    devicesList: () => http(GATEWAY_CALLS.devicesList),
    devicesRemove: (pub) => http(GATEWAY_CALLS.devicesRemove, { pub }),
    devicesHistory: () => http(GATEWAY_CALLS.devicesHistory),
    devicesDismiss: (body) => http(GATEWAY_CALLS.devicesDismiss, { body }),
    devicesRebaseline: (confirm, head) => http(GATEWAY_CALLS.devicesRebaseline, { confirm, ...(head ? { head } : {}) }),
    wifi: async (request) => {
      const answer = await deps.call(GATEWAY_CALLS.wifi, request, request.op === 'pair' ? PAIR_WAIT_MS : undefined)
      if (answer.result && typeof answer.result === 'object') return { result: answer.result as Record<string, unknown> }
      const refused = record(answer.refused)
      const why: GatewayRefusal = typeof refused.code === 'string'
        ? { code: refused.code, message: text(refused.message) }
        : { code: 'UNAVAILABLE', message: 'The Wi-Fi device link is not reachable on this computer right now. Try again.' }
      return { refused: why }
    },
    wifiService: (on) => { wifiService = on; send('wifiService', { on }) },
    revokeIdentity: (identity) => { send('revokeIdentity', { identity }) },
    account: (next) => { send('account', { account: next }) },
    reachable: (machineIds) => { reachable = machineIds; send('reachable', { machineIds }) },
    lane: laneOps,
    observerKey: {
      publicKey: () => ownerKey({ op: 'public' }),
      signWelcome: (machineId, shareId, peer, ephemeral) => ownerKey({ op: 'sign', machineId, shareId, peer, ephemeral }),
    },
  }

  /** A window's session through the gateway: to another of the owner's machines, or to a harness shared
   *  with this account (`share`). */
  const openWindow = (open: Record<string, unknown>, sink: WindowRelaySink, onClosed: (code: number, reason: string) => void): Promise<WindowRelaySession> =>
    new Promise((resolve, reject) => {
      if (!up) { reject(new RelayConnectError('the relay is restarting', WINDOW_GATEWAY_GONE)); return }
      const id = newId()
      windows.set(id, { sink, onClosed, opening: { resolve, reject } })
      send('windowOpen', { ...open, id })
    })
  const open = (isolated: boolean) => (machineId: string, autonomousEnv: string, selectFrame: Record<string, unknown>,
    sink: WindowRelaySink, onClosed: (code: number, reason: string) => void): Promise<WindowRelaySession> =>
    openWindow({ machineId, autonomousEnv, frame: selectFrame, isolated }, sink, onClosed)
  const sessionOf = (id: string): WindowRelaySession => ({
    send: async (frame) => { send('windowSend', { id, frame }) },
    sendBinary: async (clear) => {
      const local = encodeTerminalLocal(clear)
      const bytes = local && encodeGatewayBinary(GatewayBinary.window, id, local)
      if (bytes && up) deps.notifyBinary(bytes)
    },
    detach: () => { if (windows.delete(id)) send('windowDetach', { id }) },
  })
  const windowRelay: WindowRelay = {
    acquire: open(false),
    acquireIsolated: open(true),
    invalidate: (machineId) => { send('windowInvalidate', { machineId, isolated: false }) },
    invalidateIsolated: (machineId) => { send('windowInvalidate', { machineId, isolated: true }) },
    acquireShare: (machineId, shareId, sink, onClosed) => openWindow({ machineId, share: shareId }, sink, onClosed),
  }

  /** A window's connection ended, from the gateway's side or because the gateway went. */
  const closeWindow = (id: string, code: number, reason: string): void => {
    const window = windows.get(id)
    if (!window) return
    windows.delete(id)
    if (window.opening) window.opening.reject(new RelayConnectError(reason, code))
    else window.onClosed(code, reason)
  }

  /** What the gateway tells the core (`service_notice`): trusted as the gateway's, the master's token
   *  having opened the link, but read as data, never thrown on. */
  const notice = (payload: Record<string, unknown>): void => {
    const connId = text(payload.connId)
    switch (payload.kind) {
      case 'frame':
        void events.frame(connId, record(payload.frame), payload.transport === 'p2p' ? 'p2p' : 'relay' as RemoteTransport,
          payload.role === 'web' ? 'web' : 'device' as RemoteRole)
        return
      case 'client': {
        const client = payload.client ? record(payload.client) as unknown as RemoteClient : null
        if (client) clients.add(connId)
        else clients.delete(connId)
        events.client(connId, client)
        return
      }
      case 'disconnected':
        clients.delete(connId)
        void events.disconnected(connId)
        return
      case 'observer':
        void events.observer(connId, text(payload.type), record(payload.payload))
        return
      case 'toLocal':
        events.toLocal(connId, record(payload.frame))
        return
      case 'status':
        linkUp = payload.connected === true
        events.status(linkUp)
        return
      case 'linkDown':
        events.linkDown()
        return
      case 'commanders':
        events.commanders(Number(payload.count) || 0, typeof payload.active === 'number' ? payload.active : null, payload.recheck === true)
        return
      case 'commanderJoined':
        events.commanderJoined()
        return
      case 'meta':
        events.meta(record(payload.meta) as { name?: string | null; gridName?: string | null })
        return
      case 'notice':
        events.notice(record(payload.notice) as unknown as BackendNotice)
        return
      case 'revoked':
        events.revoked()
        return
      case 'busy':
        events.busy()
        return
      case 'device':
        void events.device(connId, record(payload.frame), payload.opened ? record(payload.opened) : null)
        return
      case 'deviceRevoked':
        events.deviceRevoked(text(payload.identity))
        return
      case 'toWindows':
        events.toWindows(record(payload.frame))
        return
      case 'windowOpened': {
        const window = windows.get(text(payload.id))
        if (!window?.opening) return
        const { resolve } = window.opening
        window.opening = null
        resolve(sessionOf(text(payload.id)))
        return
      }
      case 'windowFailed':
      case 'windowClosed':
        closeWindow(text(payload.id), typeof payload.code === 'number' ? payload.code : 1011, text(payload.reason) || 'relay failed')
        return
      case 'windowFrame':
        windows.get(text(payload.id))?.sink.sendFrame(record(payload.frame))
        return
      default:
        log(`[gateway] an unknown notice from the gateway was ignored: ${JSON.stringify(String(payload.kind)).slice(0, 80)}`)
    }
  }

  const binary = (raw: Uint8Array): void => {
    const decoded = decodeGatewayBinary(raw)
    if (!decoded) return
    if (decoded.kind === GatewayBinary.window) { windows.get(decoded.id)?.sink.sendBinary(decoded.bytes); return }
    const clear = decodeTerminalLocal(decoded.bytes)
    if (clear) void events.binary(decoded.id, clear)
  }

  /**
   * What the gateway asks the core (`service_query`): a token to dial with, the device key log's reads of
   * the backend, and the harnesses shared with this account (the Share relay finds a share among them
   * before it dials). Nothing else: the gateway is the relay, and the core's own REST reads are not its to
   * make. A refused token comes back as the session's own error, so the gateway can tell a session that
   * is over (stop for good) from one that could not be refreshed just now (try again).
   */
  const answer = async (query: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    // The gateway is the lane's seal, never a lane of its own: it is answered tokens, and no lane step.
    if (query === 'access_token') return (await answerAccountQuery({ accessToken: (options) => deps.tokens.accessToken(options), lane: LANE_OFF }, query, payload))!
    if (query === 'backend' && payload.method === 'GET' && (text(payload.path).startsWith('/api/device-keys') || payload.path === '/api/harness-shares')) {
      return { ...await deps.backend('GET', text(payload.path)) }
    }
    return { error: 'UNKNOWN_QUERY' }
  }

  return {
    port,
    ops,
    windowRelay,
    notice,
    binary,
    answer,
    /** The core is stopping: the gateway closes its link to the backend (its process is the master's to end). */
    stop: (): Promise<void> => port.stop(),
    /** The gateway's process connected: it starts from everything it is told here, each time. */
    connected(): void {
      // A gateway that connects again without the core having seen it go (its link replaced) started afresh
      // all the same: what the core kept of the last one goes first.
      if (up) this.disconnected()
      up = true
      // The account as the core reads it now (`start`), which is never older than the last one it said.
      send('start', { requestsOpen, dial, localClients, wifiService, reachable, ...deps.start() })
    },
    /** The gateway's process went: the relay with it, as far as everything in the core is concerned. */
    disconnected(): void {
      up = false
      for (const id of [...windows.keys()]) closeWindow(id, WINDOW_GATEWAY_GONE, 'the relay restarted')
      // Each remote client's connection ended with it: what it had open here goes (its terminals, its
      // viewers, the Wi-Fi device service's hold on it).
      for (const connId of [...clients]) { clients.delete(connId); void events.disconnected(connId) }
      events.linkDown()
      events.commanders(0, null)
      if (linkUp) { linkUp = false; events.status(false) }
    },
  }
}

export type GatewayLink = ReturnType<typeof createGatewayLink>

/** The lane's sessions as the core hands them to its services (`core.account.lane`): read from the gateway
 *  each time, because the core's API is built before the gateway is started. */
export function laneOf(gateway: () => LaneSeal): LaneSeal {
  return {
    hello: (machineId, peerPub) => gateway().hello(machineId, peerPub),
    welcome: (machineId, payload) => gateway().welcome(machineId, payload),
    rekey: (machineId, payload) => gateway().rekey(machineId, payload),
    seal: (machineId, frame) => gateway().seal(machineId, frame),
    open: (machineId, frame) => gateway().open(machineId, frame),
    drop: (machineId) => gateway().drop(machineId),
  }
}
