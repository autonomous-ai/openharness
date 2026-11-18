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
import type { ProductUsageMetric } from '../lib/productUsageContract.js'
import type { Asker, GatewayAccount, GatewayEvents, UsageEvent, WindowRelaySession } from '../core/api.js'
import { localWindowsOf, windowSurfaceOf } from '../lib/windowSurfaces.js'
import { decodeGatewayBinary, encodeGatewayBinary, GatewayBinary, GATEWAY_CALLS } from '../lib/gatewayWire.js'
import { RelayConnectError } from '../lib/relayFrames.js'
import { decodeTerminalLocal, encodeTerminalLocal } from '../lib/terminalBinary.js'
import { answerTabKey } from '../lib/tabKeyWire.js'
import { answerTabRelay } from '../lib/tabRelayWire.js'
import { AuthSessionManager } from '../lib/authRefresh.js'
import { tokenAnswer, tokenOptionsOf } from '../lib/authSession.js'
import { backendHttpBase } from '../lib/backendHttpBase.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from '../services/process.js'
import { startGateway, type StartedGateway } from './start.js'
import { sharedPeers } from './sharedTrust.js'
import { env } from '../config/env.js'
import { VaultStore } from '../lib/connectors/vaultStore.js'
import { connectorsDir } from '../lib/connectors/store.js'
import { followLink } from '../services/followLink.js'
import { createCallbackReplay } from './callbackReplay.js'

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
  /** Swapped in tests for a renewal that reaches no backend. */
  tokens?: Pick<AuthSessionManager, 'accessToken'>
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const record = (value: unknown): Payload => (value && typeof value === 'object' && !Array.isArray(value) ? value as Payload : {})

export function runGatewayService(options: GatewayServiceOptions): ServiceProcess {
  let core: CoreConnection | null = null
  let running: StartedGateway | null = null
  const follow = followLink({})
  const callbackReplay = createCallbackReplay()
  /** The windows on the core's side working on other machines through this gateway, by the core's id. */
  const windows = new Map<string, WindowRelaySession>()

  const notice = (kind: string, payload: Payload = {}): void => { core?.notice?.(kind, payload) }
  const events: GatewayEvents = {
    frame: (connId, frame, transport, role) => notice('frame', { connId, frame, transport, role }),
    binary: (connId, clear, raw) => {
      const local = raw ?? encodeTerminalLocal(clear)
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
    toWindows: (frame) => notice('toWindows', { frame }),
    tabFrame: (event) => notice('tabFrame', { event }),
    streamControl: (service, streamId, payload) => notice('clientStreamControl', { service, streamId, payload }),
  }

  /** This process renews the account's sign-in (lib/authRefresh.ts): one manager, so every start of the gateway and the
   *  core's asks share a renewal in flight. Until the core audit of 2026-11-12 the core renewed it, and this asked it. */
  const tokens = options.tokens ?? new AuthSessionManager(backendHttpBase())
  const connectorStore = new VaultStore(connectorsDir())

  /** The gateway stopped: its link closed, its windows' sessions let go. Not waited on here: what comes after it
   *  on the link (a new `start`) must not wait for the old link's goodbye. The process's own stop waits for it. */
  let pendingStart: Payload | null = null
  const stop = (): Promise<void> => {
    follow.disconnected()
    pendingStart = null
    const was = running
    running = null
    for (const session of windows.values()) session.detach()
    windows.clear()
    return was ? was.stop().catch((error: unknown) => console.warn(`[gateway] stopping: ${error instanceof Error ? error.message : String(error)}`)) : Promise.resolve()
  }

  const begin = (payload: Payload): void => {
    void stop()
    const original = core
    const started = (options.start ?? startGateway)({
      events, connectorStore, callbackReplay,
      agents: {
        follow: follow.follow,
        ofPane: async pane => {
          if (!original || core !== original || running !== started) return null
          const answer = await original.query('agent_of_pane', { pane }).catch(() => null)
          return core === original && running === started && typeof answer?.agentId === 'string'
            ? { agentId: answer.agentId, guest: answer.guest === true } : null
        },
      },
      peer: { composition: 'services', port: env.PORT, token: options.token },
      machineId: text(payload.machineId),
      computerId: text(payload.computerId),
      autonomousEnv: text(payload.autonomousEnv) || 'prod',
      signedIn: payload.signedIn === true,
      tokens,
      machineName: text(payload.machineName), hostname: text(payload.hostname),
      machines: (state) => notice('machines', { ...state }),
      account: (payload.account as GatewayAccount | null) ?? { machineId: null, signIn: null },
      // Only the core can ask for the Wi-Fi device's process (core/gatewayLink.ts `wifi_serving`).
      wifiServing: async () => {
        if (!original || core !== original || running !== started) return false
        const answer = await original.query('wifi_serving').catch(() => null)
        return core === original && running === started && answer?.serving === true
      },
    })
    running = started
    if (original) void follow.connected((query, payload) => original.query(query, payload))
    // Held first, so that nothing the link brings in is answered before the core is ready.
    if (payload.requestsOpen === false) started.port.holdRequests()
    started.port.localClients(localWindowsOf(payload.localClients))
    if (Array.isArray(payload.reachable)) started.ops.reachable(payload.reachable as string[])
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
    if (follow.heard(payload)) return
    const kind = text(payload.kind)
    // The core says start as it takes the link, a frame before it says `connected`: started then, the first
    // dial would ask the core for a token on a link this process does not know is up yet, and wait a second
    // to try again. Started once it knows.
    if (kind === 'start') { if (core) begin(payload); else pendingStart = payload; return }
    if (kind === 'stop') { void stop(); return }
    if (kind === 'windowOpen') { void openWindow(payload); return }
    const gateway = running
    if (!gateway) return
    const { port, ops } = gateway
    const connId = text(payload.connId)
    switch (kind) {
      case 'usage': port.usage?.(payload.event as UsageEvent); return
      case 'usageCounter':
        if ('service' in payload) {
          if (typeof payload.service === 'string' && typeof payload.metric === 'string') {
            port.usage?.({ kind: 'service', service: payload.service, metric: payload.metric })
          }
        } else port.usageCounter?.(payload.metric as ProductUsageMetric)
        return
      case 'connect': port.connect(); return
      case 'thisComputerOnly': port.serveThisComputerOnly(); return
      case 'hold': port.holdRequests(); return
      case 'open': port.openRequests(); return
      case 'broadcast': {
        // A guest's harness's event goes to the group (which cannot open it) and sealed to that guest's sessions.
        const guest = text(payload.guest)
        if (guest) port.broadcast(record(payload.frame), guest)
        else port.broadcast(record(payload.frame))
        return
      }
      case 'commander': port.commander(record(payload.frame)); return
      case 'user': port.user(record(payload.frame)); return
      case 'reply': port.reply(connId, text(payload.type), payload.requestId, record(payload.payload)); return
      case 'target': port.target(connId, text(payload.type), record(payload.payload)); return
      case 'terminal': port.terminal(connId, text(payload.type), record(payload.payload)); return
      case 'observer': port.observer(connId, text(payload.type), record(payload.payload)); return
      case 'windowOpened': port.windowOpened(windowSurfaceOf(payload.surface)); return
      case 'localClients': port.localClients(localWindowsOf(payload.windows)); return
      case 'localFrame': void port.local(connId, record(payload.frame)); return
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
    else running?.port.terminalBinary(decoded.id, decoded.bytes)
  }

  /** What the core asks of the gateway (`GatewayOps`), each answered from its gateway once that has started. */
  const ops = () => {
    if (!running) throw new Error('the gateway has not started')
    return running.ops
  }
  const requests = {
    // The core's ask, for itself and for the services that ask it (core/accountQueries.ts): the core calls no other host.
    [GATEWAY_CALLS.accessToken]: (p: Payload) => tokenAnswer(() => tokens.accessToken(tokenOptionsOf(p))),
    [GATEWAY_CALLS.backend]: async (p: Payload) => ({ ...await ops().backend(text(p.method), text(p.path), p.body) }),
    [GATEWAY_CALLS.machines]: async (p: Payload) => ({ ...await ops().machines(p.fallback === true) }),
    [GATEWAY_CALLS.mintGridName]: async () => ({ name: await ops().mintGridName() }),
    [GATEWAY_CALLS.status]: async () => ({ ...await ops().status() }),
    // Its routes of the door (gateway/start.ts `requests`): the Wi-Fi device's pairings and direct links, the account's and
    // the keys'.
    gateway_http: (p: Payload, asker: Asker) => {
      if (!running) throw new Error('the gateway has not started')
      return running.requests.gateway_http!(p, asker)
    },
    gateway_ws: (p: Payload, asker: Asker, closed?: AbortSignal) =>
      running?.requests.gateway_ws?.(p, asker, closed) ?? { error: 'SERVICE_UNAVAILABLE' },
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
    // Shared tabs' keys (gateway/tabKey.ts): one of the nine `TabKey` methods, answered `{ result }` or `{ error }`,
    // and `UNKNOWN_METHOD` for any other name (lib/tabKeyWire.ts). Taken in the order the core sent them, as the lane's.
    [GATEWAY_CALLS.tabKey]: (p: Payload): Promise<Payload> => answerTabKey(ops().tabKey, p),
    // Shared tabs' relay (gateway/tabRelay.ts): `open`, `send` or `close`, and `UNKNOWN_METHOD` for any other name
    // (lib/tabRelayWire.ts).
    [GATEWAY_CALLS.tabRelay]: (p: Payload): Promise<Payload> => answerTabRelay(ops().tabRelay, p),
    // Machines shared across accounts (gateway/sharedTrust.ts): the stores made to hold what was asked.
    [GATEWAY_CALLS.sharedTrust]: async (p: Payload): Promise<Payload> => {
      try {
        return { ...await ops().sharedTrust({ ...(p.pins !== undefined ? { pins: sharedPeers(p.pins) } : {}), ...(p.keys !== undefined ? { keys: sharedPeers(p.keys) } : {}) }) }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    // The account's connected services (lib/e2ee/connectorVault.ts): an envelope sealed, or one opened.
    [GATEWAY_CALLS.connectorVault]: async (p: Payload): Promise<Payload> => {
      try {
        if (p.op === 'sync') {
          if (typeof p.refresh !== 'boolean'
            || (p.requestId !== undefined && (typeof p.requestId !== 'string' || p.requestId.length > 128))
            || Object.keys(p).some(key => !['op', 'refresh', 'requestId'].includes(key))) return { error: 'UNKNOWN_OP' }
          const answer = await ops().connectorSync(p.refresh)
          return { shared: answer.shared }
        }
        // Old-core compatibility: retain for at least 30 days after the first published CLI release containing
        // this adapter; record that release-derived retirement date before removal. The new core has no vault operation.
        if (!running) return { error: 'CONNECTORS_SYNC_UNAVAILABLE' }
        const vault = running.legacyConnectorVault
        if (p.op === 'seal') return { envelope: await vault.seal(text(p.plaintext)) }
        if (p.op === 'open') { const opened = await vault.open(p.envelope); return opened === null ? {} : { ...opened } }
        return { error: 'UNKNOWN_OP' }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  }

  const service = (options.run ?? runServiceProcess)({
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
      void stop()
    },
  })
  return {
    // The process is going (the master's SIGTERM, the master gone, services/process.ts `leave`): the gateway and its
    // usage collector stop first, while the link is still up, and the process waits for them. Closing the link alone
    // left them to its close event, which the exit came before: the collector never wrote its clean exit, and
    // `harness stop`, updates, sign-in restarts, service installs and OS logouts all counted as unclean restarts
    // (health_cli_unclean_restart, 69 to 170 on 2026-10-16, production counters).
    stop: async () => {
      const stopping = stop()
      const callbacksStopped = callbackReplay.stop().then(() => null, () => new Error('CALLBACK_CLOSE_TIMEOUT'))
      await service.stop()
      await stopping
      const callbackFailure = await callbacksStopped
      if (callbackFailure) throw callbackFailure
    },
  }
}
