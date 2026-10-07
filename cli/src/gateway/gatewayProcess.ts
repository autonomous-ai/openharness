/**
 * The gateway in its own process (`harness __service gateway`; the core's side is core/gatewayLink.ts):
 * the relay, the E2EE sessions and every key this machine holds, where a crash, a hang, a leak or a
 * hostile frame costs the remote clients and nothing else (docs/design/2026-10-06-core-boundary-next.md,
 * step 10, R2). Network, crypto and WebRTC in pure JavaScript all run here, off the core's event loop.
 *
 * It does nothing until a core takes its link and says `start`: a core that does not run the gateway out
 * of its process (an older one, under a newer master) keeps its own relay, and two links to the backend
 * for one machine would fight over its claim. Each `start` builds the gateway afresh (gateway/start.ts),
 * and the core going away stops it: a core's restart is the relay's, as it always was, so a remote client
 * that kept its socket opens a new session, as it did when both ran in one process.
 */
import type { GatewayAccount, GatewayEvents, WindowRelaySession } from '../core/api.js'
import { decodeGatewayBinary, encodeGatewayBinary, GatewayBinary, GATEWAY_CALLS } from '../lib/gatewayWire.js'
import { RelayConnectError } from '../lib/relayFrames.js'
import { decodeTerminalLocal, encodeTerminalLocal } from '../lib/terminalBinary.js'
import { accountLink } from '../services/accountLink.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from '../services/process.js'
import { startGateway, type StartedGateway } from './start.js'

type Payload = Record<string, unknown>

export interface GatewayServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests for a gateway that dials nothing. */
  start?: typeof startGateway
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const record = (value: unknown): Payload => (value && typeof value === 'object' && !Array.isArray(value) ? value as Payload : {})

export function runGatewayService(options: GatewayServiceOptions): ServiceProcess {
  let core: CoreConnection | null = null
  let running: StartedGateway | null = null
  /** The windows on the core's side working on other machines through this gateway, by the core's id. */
  const windows = new Map<string, WindowRelaySession>()

  const notice = (kind: string, payload: Payload = {}): void => { core?.notice?.(kind, payload) }
  const events: GatewayEvents = {
    frame: (connId, frame, transport, role) => notice('frame', { connId, frame, transport, role }),
    binary: (connId, clear) => {
      const local = encodeTerminalLocal(clear)
      const bytes = local && encodeGatewayBinary(GatewayBinary.remote, connId, local)
      if (bytes) core?.sendBinary?.(bytes)
    },
    client: (connId, client) => notice('client', { connId, client }),
    disconnected: (connId) => notice('disconnected', { connId }),
    observer: (connId, type, payload) => notice('observer', { connId, type, payload }),
    toLocal: (connId, frame) => notice('toLocal', { connId, frame }),
    status: (connected) => notice('status', { connected }),
    linkDown: () => notice('linkDown'),
    commanders: (count, active, recheck) => notice('commanders', { count, active, recheck: recheck === true }),
    commanderJoined: () => notice('commanderJoined'),
    meta: (meta) => notice('meta', { meta }),
    notice: (backendNotice) => notice('notice', { notice: backendNotice }),
    revoked: () => notice('revoked'),
    busy: () => notice('busy'),
    device: (connId, frame, opened) => notice('device', { connId, frame, opened }),
    deviceRevoked: (identity) => notice('deviceRevoked', { identity }),
    toWindows: (frame) => notice('toWindows', { frame }),
  }

  /** The account's tokens, from the core (`core.account`, services/accountLink.ts): a refusal comes back as
   *  the session's own error. */
  const { accessToken } = accountLink((query, payload) => (core ? core.query(query, payload) : Promise.reject(new Error('not connected to the core'))))

  /** The gateway stopped: its link closed, its windows' sessions let go. Not waited on: what comes after it
   *  on the link (a new `start`) must not wait for the old link's goodbye. */
  let pendingStart: Payload | null = null
  const stop = (): void => {
    pendingStart = null
    const was = running
    running = null
    for (const session of windows.values()) session.detach()
    windows.clear()
    void was?.stop().catch((error: unknown) => console.warn(`[gateway] stopping: ${error instanceof Error ? error.message : String(error)}`))
  }

  const begin = (payload: Payload): void => {
    stop()
    const started = (options.start ?? startGateway)({
      events,
      machineId: text(payload.machineId),
      computerId: text(payload.computerId),
      autonomousEnv: text(payload.autonomousEnv) || 'prod',
      signedIn: payload.signedIn === true,
      tokens: { accessToken },
      backend: async (method, path) => {
        if (!core) return { status: 502, body: { success: false, error: { code: 'BACKEND_UNREACHABLE', message: 'not connected to the core' } } }
        const answer = await core.query('backend', { method, path })
        return { status: typeof answer.status === 'number' ? answer.status : 502, body: record(answer.body) }
      },
      account: (payload.account as GatewayAccount | null) ?? { machineId: null, signIn: null },
    })
    running = started
    // Held first, so that nothing the link brings in is answered before the core is ready.
    if (payload.requestsOpen === false) started.port.holdRequests()
    started.port.localClients(Number(payload.localClients) || 0)
    if (Array.isArray(payload.reachable)) started.ops.reachable(payload.reachable as string[])
    if (payload.wifiService === true) started.ops.wifiService(true)
    if (payload.dial === 'connect') started.port.connect()
    else if (payload.dial === 'local') started.port.serveThisComputerOnly()
  }

  const openWindow = async (payload: Payload): Promise<void> => {
    const id = text(payload.id)
    const pool = running?.windowRelay
    try {
      if (!pool) throw new RelayConnectError('the relay is restarting', 1013)
      const sink = {
        sendFrame: (frame: Payload) => { notice('windowFrame', { id, frame }); return true },
        sendBinary: (bytes: Uint8Array) => {
          const framed = encodeGatewayBinary(GatewayBinary.window, id, bytes)
          return !!framed && !!core?.sendBinary?.(framed)
        },
      }
      const onClosed = (code: number, reason: string): void => {
        windows.delete(id)
        notice('windowClosed', { id, code, reason })
      }
      const machineId = text(payload.machineId)
      const acquire = typeof payload.share === 'string' ? () => pool.acquireShare(machineId, text(payload.share), sink, onClosed)
        : payload.isolated === true ? () => pool.acquireIsolated(machineId, text(payload.autonomousEnv), record(payload.frame), sink, onClosed)
        : () => pool.acquire(machineId, text(payload.autonomousEnv), record(payload.frame), sink, onClosed)
      const session = await acquire()
      windows.set(id, session)
      notice('windowOpened', { id })
    } catch (error) {
      notice('windowFailed', {
        id,
        ...(error instanceof RelayConnectError && error.closeCode ? { code: error.closeCode } : {}),
        reason: error instanceof Error ? error.message : 'relay failed',
      })
    }
  }

  /**
   * What the core tells the gateway (`service_event`). Each is taken as it arrives, in order: the service
   * link hands them on without waiting on the last, so nothing here waits either, or a later frame would
   * overtake it. What takes time (a window's dial) runs on, and says when it is done.
   */
  const onEvent = (payload: Payload): void => {
    const kind = text(payload.kind)
    // The core says start as it takes the link, a frame before it says `connected`: started then, the first
    // dial would ask the core for a token on a link this process does not know is up yet, and wait a second
    // to try again. Started once it knows.
    if (kind === 'start') { if (core) begin(payload); else pendingStart = payload; return }
    if (kind === 'stop') { stop(); return }
    if (kind === 'windowOpen') { void openWindow(payload); return }
    const gateway = running
    if (!gateway) return
    const { port, ops } = gateway
    const connId = text(payload.connId)
    switch (kind) {
      case 'connect': port.connect(); return
      case 'thisComputerOnly': port.serveThisComputerOnly(); return
      case 'hold': port.holdRequests(); return
      case 'open': port.openRequests(); return
      case 'broadcast': port.broadcast(record(payload.frame)); return
      case 'commander': port.commander(record(payload.frame)); return
      case 'user': port.user(record(payload.frame)); return
      case 'reply': port.reply(connId, text(payload.type), payload.requestId, record(payload.payload)); return
      case 'target': port.target(connId, text(payload.type), record(payload.payload)); return
      case 'terminal': port.terminal(connId, text(payload.type), record(payload.payload)); return
      case 'observer': port.observer(connId, text(payload.type), record(payload.payload)); return
      case 'windowOpened': port.windowOpened(); return
      case 'localClients': port.localClients(Number(payload.count) || 0); return
      case 'localFrame': void port.local(connId, record(payload.frame)); return
      case 'device': port.device(connId, text(payload.type), record(payload.payload)); return
      case 'deviceClient': port.deviceClient(connId, typeof payload.identity === 'string' ? payload.identity : null); return
      case 'wifiService': ops.wifiService(payload.on === true); return
      case 'revokeIdentity': ops.revokeIdentity(text(payload.identity)); return
      case 'account': ops.account(payload.account as GatewayAccount); return
      case 'reachable': ops.reachable(Array.isArray(payload.machineIds) ? payload.machineIds as string[] : null); return
      case 'windowSend': void windows.get(text(payload.id))?.send(record(payload.frame)); return
      case 'windowDetach': { const id = text(payload.id); windows.get(id)?.detach(); windows.delete(id); return }
      case 'windowInvalidate':
        if (payload.isolated === true) gateway.windowRelay.invalidateIsolated(text(payload.machineId))
        else gateway.windowRelay.invalidate(text(payload.machineId))
        return
      default:
        console.warn(`[gateway] an unknown event from the core was ignored: ${JSON.stringify(kind).slice(0, 80)}`)
    }
  }

  /** The core's terminal bytes for a remote client, or for a window's session on another machine. */
  const onBinary = (raw: Uint8Array): void => {
    const decoded = decodeGatewayBinary(raw)
    const clear = decoded && decodeTerminalLocal(decoded.bytes)
    if (!decoded || !clear) return
    if (decoded.kind === GatewayBinary.window) void windows.get(decoded.id)?.sendBinary(clear)
    else running?.port.terminalBinary(decoded.id, clear)
  }

  /** The core's commands about the keys (`GatewayOps`), answered as their routes answer them. */
  const ops = () => {
    if (!running) throw new Error('the gateway has not started')
    return running.ops
  }
  const requests = {
    [GATEWAY_CALLS.status]: async () => ({ ...await ops().status() }),
    [GATEWAY_CALLS.pair]: async (p: Payload) => ({ ...await ops().pair(text(p.code)) }),
    [GATEWAY_CALLS.listPairs]: async () => ({ ...await ops().listPairs() }),
    [GATEWAY_CALLS.revoke]: async (p: Payload) => ({ ...await ops().revoke(text(p.id)) }),
    [GATEWAY_CALLS.revokeAll]: async () => ({ ...await ops().revokeAll() }),
    [GATEWAY_CALLS.setRemotePassword]: async (p: Payload) => ({ ...await ops().setRemotePassword(text(p.password)) }),
    [GATEWAY_CALLS.clearRemotePassword]: async () => ({ ...await ops().clearRemotePassword() }),
    [GATEWAY_CALLS.remotePasswordStatus]: async () => ({ ...await ops().remotePasswordStatus() }),
    [GATEWAY_CALLS.trustLinkedPeer]: async (p: Payload) => ({ ...await ops().trustLinkedPeer(record(p.peer) as { pub: string; machineId: string; label: string }) }),
    [GATEWAY_CALLS.groupList]: async () => ({ ...await ops().groupList() }),
    [GATEWAY_CALLS.groupSync]: async () => ({ ...await ops().groupSync() }),
    [GATEWAY_CALLS.groupRemove]: async (p: Payload) => ({ ...await ops().groupRemove(text(p.selector)) }),
    [GATEWAY_CALLS.devicesList]: async () => ({ ...await ops().devicesList() }),
    [GATEWAY_CALLS.devicesRemove]: async (p: Payload) => ({ ...await ops().devicesRemove(text(p.pub)) }),
    [GATEWAY_CALLS.devicesHistory]: async () => ({ ...await ops().devicesHistory() }),
    [GATEWAY_CALLS.devicesDismiss]: async (p: Payload) => ({ ...await ops().devicesDismiss(record(p.body)) }),
    [GATEWAY_CALLS.devicesRebaseline]: async (p: Payload) => ({
      ...await ops().devicesRebaseline(p.confirm === true, p.head as { seq: number; hash: string } | undefined),
    }),
    [GATEWAY_CALLS.wifi]: async (p: Payload) => ({
      ...await ops().wifi({ op: text(p.op) as 'discover' | 'pair' | 'pairStatus' | 'list' | 'revoke', device: text(p.device), code: text(p.code), id: text(p.id) }),
    }),
    // The fleet's lane's sessions (gateway/lane.ts). Each is answered from what it holds at once, so they
    // are taken in the order the core sent them.
    [GATEWAY_CALLS.lane]: async (p: Payload): Promise<Payload> => {
      const lane = ops().lane
      const machineId = text(p.machineId)
      switch (p.op) {
        case 'hello': return { frame: await lane.hello(machineId, text(p.peerPub)) }
        case 'welcome': return { ok: await lane.welcome(machineId, record(p.payload)) }
        case 'rekey': await lane.rekey(machineId, record(p.payload)); return {}
        case 'seal': return { ...await lane.seal(machineId, record(p.frame)) }
        case 'open': return { ...await lane.open(machineId, record(p.frame)) }
        case 'drop': lane.drop(machineId); return {}
        default: return { error: 'UNKNOWN_OP' }
      }
    },
    // Share's owner's key (gateway/observerKey.ts): its public half, or a welcome signed.
    [GATEWAY_CALLS.observerKey]: async (p: Payload): Promise<Payload> => {
      const key = ops().observerKey
      try {
        if (p.op === 'public') return { key: await key.publicKey() }
        return { key: await key.signWelcome(text(p.machineId), text(p.shareId), text(p.peer), text(p.ephemeral)) }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  }

  return (options.run ?? runServiceProcess)({
    name: 'gateway',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests,
    onEvent,
    onBinary,
    onConnected: (connection) => {
      core = connection
      const start = pendingStart
      pendingStart = null
      if (start) begin(start)
    },
    onDisconnected: () => {
      core = null
      stop()
    },
  })
}
