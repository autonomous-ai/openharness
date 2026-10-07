/**
 * The gateway: everything between this machine and a remote client (docs/design/2026-10-06-core-boundary-next.md,
 * "Relay and E2EE — its own process", step 10). It holds the backend link (gateway/upstream.ts), the E2EE
 * manager with its sessions and keys, the terminals' P2P channels, and the Wi-Fi device's direct links,
 * which ride the same sessions. The core never sees a key: a remote client's frame reaches it opened, with
 * the role its session proved, and the core's frames for remote clients leave through here, sealed.
 *
 * Moved out of `BackendSocket` as it was (step 10, R1), still in the core's process; R2 runs it in a process
 * of its own, behind the same two interfaces (`GatewayPort`, what the core asks of it, and `GatewayEvents`,
 * what it tells the core, in core/api.ts). The rules it enforces are the ones the socket enforced, in the
 * same order and with the same words in the log: which frames only the backend may send, that a client's
 * frame is acted on only if it opens under that connection's session (default-deny), that a reply goes to
 * the requester alone and sealed, and that a content-bearing reply that cannot be sealed is a bare
 * E2EE_REQUIRED. backendSocket.spec.ts and gateway/gateway.spec.ts hold each of them.
 */
import { env } from '../config/env.js'
import type { GatewayEvents, GatewayPort, RemoteRole, RemoteTransport } from '../core/api.js'
import { deviceDump } from '../lib/autonomous-device/dump.js'
import type { AuthSessionManager } from '../lib/authSession.js'
import { shouldReplayCommander } from '../lib/commanderReplay.js'
import { DEVICE_RECENT_SAFE_FRAME_BYTES, fitRecentReplyPayloadForDevice } from '../lib/deviceRecentTrim.js'
import { encryptRpcResult, rpcResultType } from '../lib/e2ee/applicationFrames.js'
import { b64d, fingerprint, isWrapped } from '../lib/e2ee/core.js'
import { E2eeManager, type LinkedPeer, type PairResult } from '../lib/e2ee/manager.js'
import { MachinePeerStore } from '../lib/e2ee/machinePeers.js'
import { logFrame, sid } from '../lib/log.js'
import { BACKEND_ONLY_DOWN_TYPES, GATEWAY_REQUEST_TYPES, isLocalClientId, logSafeType } from '../lib/relayFrames.js'
import { encodeTerminalHop, TerminalHopDirection, type TerminalBinaryClear } from '../lib/terminalBinary.js'
import {
  TerminalP2pResponderPool,
  TERMINAL_P2P_DOWN_TYPES,
  TERMINAL_P2P_SIGNAL_TYPES,
  type TerminalP2pData,
  type TerminalP2pSignal,
} from '../lib/terminalP2p.js'
import { UpstreamLink } from './upstream.js'

type Frame = Record<string, unknown>

export interface RelayGatewayOptions {
  /** Backend-resolved machine id, persisted by the SSO login preflight; in isolated unit tests, the token. */
  machineId: string
  auth?: Pick<AuthSessionManager, 'accessToken'>
  computerId?: string
  autonomousEnv?: string
  /** The core, as the gateway tells it what happened. */
  core: GatewayEvents
}

export class RelayGateway implements GatewayPort {
  /** Web↔adapter E2EE: group-encrypts user events, runs the CPace pairing, holds per-conn sessions. */
  readonly e2ee: E2eeManager
  readonly machineId: string
  private readonly link: UpstreamLink
  private readonly core: GatewayEvents
  private readonly terminalP2p: TerminalP2pResponderPool
  private readonly p2pPendingOpens = new Map<string, Set<string>>()
  private readonly p2pStreams = new Map<string, Set<string>>()
  /**
   * The terminal streams each remote client has open, as the core's frames to it say: `terminal_ready`
   * opens one, `terminal_closed` ends it. A stream a client moves onto its P2P channel must be one it
   * has (the core's own `hasStream` answered this when the gateway ran inside the socket); a stream that
   * closed meanwhile is closed again by the `terminal_closed` that follows it, which takes it off P2P.
   */
  private readonly liveStreams = new Map<string, Set<string>>()
  /** Cross-instance commander (device) client count, from backend `__clients` frames. */
  private commanderCount = 0
  /** Subset of commanderCount whose device is ACTIVELY rendering this machine (multi-attach). null = the
   *  backend doesn't send the signal (old build). */
  private commanderActive: number | null = null
  private replayedCommanderGeneration: number | undefined
  private replayCommanderOnNextSnapshot = true
  /** Appends to the device key log waiting for the backend's answer, by requestId. */
  private readonly devlogAppends = new Map<string, (payload: Record<string, unknown> | null) => void>()
  private readonly downChains = new Map<string, Promise<void>>()
  /**
   * Remote clients' frames wait here until the core is ready (`openRequests`), each in its connection's own
   * order: the port answers long before start-up has wired every handler, and a request answered in
   * between met a handler that was not there yet.
   */
  private requestsOpen = true
  private openRequestGate: () => void = () => {}
  private requestGate: Promise<void> = Promise.resolve()
  private localClientCount = 0
  private readonly directDeviceSinks = new Map<string, (frame: Frame) => void>()
  private readonly directDevicePins = new Map<string, string>()
  /** The Wi-Fi device sessions whose app said hello to the device service (in the core), by connection:
   *  the ones told, sealed, that they were unpaired (`onIdentityRevoked`). */
  private readonly deviceClients = new Map<string, string>()

  /** Answers the trust group's roster exchange (`group_sync`); null until the daemon wires it. */
  groupSync: { handle: (peerPub: string, payload: Record<string, unknown>) => Record<string, unknown> } | null = null
  /** The account's device key log grew (lib/e2ee/deviceLogSyncer.ts): re-read it from this machine's head. */
  onDeviceKeysChanged: (() => void) | null = null
  /** This machine's key was taken out of the account's device key log (`machine_revoked` says so). */
  onDeviceRemoved: ((pub: string) => void) | null = null
  /** Whether [pub] is this machine's own device key. Set, a `machine_revoked` naming another key (an earlier
   *  install under the same machine id) does not sign this one out. Null: every removal signs out. */
  isOwnDeviceKey: ((pub: string) => boolean) | null = null
  /** The link to the backend just came up (each reconnect too). */
  onLinkUp: (() => void) | null = null
  onDirectDeviceRevoked?: (fingerprint: string) => void
  /** A peer linked here over the remote password (after it is trusted and, for a machine, pinned back). */
  onPeerLinked?: (peer: LinkedPeer) => void
  /** A person unpaired this identity here (not the trust group removing it). */
  onUnpaired?: (identityPub: string) => void
  /** A hello signed by a key not paired here: the account's device key log may name it (manager.ts
   *  `onUnknownHello`). The hello waits for this, a few seconds at most. */
  onUnknownHello: ((identityPub: string) => Promise<void>) | null = null

  constructor({ machineId, auth, computerId = '', autonomousEnv = 'prod', core }: RelayGatewayOptions) {
    this.machineId = machineId
    this.core = core
    this.link = new UpstreamLink({
      machineId, auth, computerId, autonomousEnv,
      events: {
        down: (frame, connId) => this.enqueueDown(frame, connId, 'relay'),
        binary: (connId, clientFrame) => this.enqueueTerminalBinary(connId, clientFrame),
        up: () => this.onLinkUp?.(),
        gone: () => this.linkGone(),
        status: (connected) => this.core.status(connected),
        revoked: () => this.core.revoked(),
        busy: () => this.core.busy(),
        localClients: () => this.localClientCount,
      },
    })
    this.e2ee = new E2eeManager({
      machineId: this.machineId,
      sendTo: (connId, frame) => this.sendTo(connId, frame),
      sendUser: (frame) => this.user(frame),
      isConnected: () => this.connected(),
      isConnectionAvailable: connId => this.directDeviceSinks.has(connId) || this.connected(),
      onIdentityPaired: (connId, pub) => { if (this.directDeviceSinks.has(connId)) this.directDevicePins.set(connId, pub) },
      onIdentityRevoked: identity => { this.deviceUnpaired(identity); this.onDirectDeviceRevoked?.(fingerprint(b64d(identity))) },
      onSessionOpened: (connId, role, identity) => this.core.client(connId, {
        role, label: this.e2ee.sessionLabel(connId), identity, direct: this.directDeviceSinks.has(connId),
      }),
      onSessionDropped: (connId) => this.core.client(connId, null),
      onPeerLinked: (peer) => {
        // The mutual half of a password link: a machine that proved this one's password is pinned back,
        // so this machine can dial it without that machine's own password.
        if (peer.kind === 'machine' && peer.machineId && peer.machineId !== this.machineId) {
          new MachinePeerStore().pin(peer.machineId, peer.pub, peer.label)
        }
        this.onPeerLinked?.(peer)
      },
      onUnpaired: (pub) => this.onUnpaired?.(pub),
      onUnknownHello: (pub) => this.onUnknownHello?.(pub) ?? Promise.resolve(),
    })
    this.terminalP2p = new TerminalP2pResponderPool({
      sendSignal: (connId, type, payload) => this.sendP2pSignal(connId, type, payload),
      onData: (connId, data) => this.handleP2pData(connId, data),
      onUnavailable: (connId, reason) => this.demoteP2pConnection(connId, reason),
    })
  }

  // ── the link ───────────────────────────────────────────────────────────────────────────────────

  connect(): void { this.link.connect() }
  serveThisComputerOnly(): void { this.link.serveThisComputerOnly() }
  connected(): boolean { return this.link.isConnected() }

  async stop(): Promise<void> {
    // No reconnect from here on, whatever the socket does while the channels below close.
    this.link.close()
    await this.terminalP2p.stop()
    this.link.stop()
  }

  /** The link went down: no device can be watching, and every remote client went with it. */
  private linkGone(): void {
    // While the backend link is down we can neither observe device presence nor deliver a card, so
    // default the recap gate to OFF (safe value) instead of holding a stale count — otherwise a turn
    // completing during the gap burns a `claude -p` recap that goes nowhere. attachAdapter always
    // re-pushes the true count via recomputeAndSendClients on reconnect (and 0→N re-fires the replay).
    this.core.linkDown()
    this.setCommanderCount(0, null) // active count is unknown until the next __clients snapshot
    void this.terminalP2p.stop()
    this.p2pPendingOpens.clear()
    this.p2pStreams.clear()
    this.liveStreams.clear()
    this.replayCommanderOnNextSnapshot = true
  }

  /** The ONE place commander presence changes. Both callers — the `__clients` snapshot and the link going
   *  down — mean the same thing when the count reaches zero: nobody is watching. They used to differ, and
   *  the link's forgot to drop the device's E2EE session, so `deviceE2eeConnected()` stayed true and the
   *  local dashboard kept a green "device connected" dot for a device long gone. */
  private setCommanderCount(commander: number, active: number | null): void {
    this.commanderCount = commander
    this.commanderActive = active
    this.core.commanders(commander, active)
    if (commander <= 0) {
      if (this.directDeviceSinks.size) this.e2ee.dropSessionsByRole('device', id => this.directDeviceSinks.has(id))
      else this.e2ee.dropSessionsByRole('device')
    }
  }

  holdRequests(): void {
    if (!this.requestsOpen) return
    this.requestsOpen = false
    this.requestGate = new Promise<void>((resolve) => { this.openRequestGate = resolve })
  }

  openRequests(): void {
    if (this.requestsOpen) return
    this.requestsOpen = true
    this.openRequestGate()
  }

  windowOpened(): void { this.link.sendAppPresence('open') }

  localClients(count: number): void {
    this.localClientCount = count
    if (count === 0) this.link.noLocalClients()
  }

  // ── out, to remote clients ───────────────────────────────────────────────────────────────────────

  /** User-content events are group-encrypted (E2EE) here; system frames pass through as plaintext. */
  broadcast(frame: Frame): void {
    if (this.link.servesThisComputerOnly()) return
    this.link.enqueue({ t: 'up', frame: this.e2ee.wrapUp(frame) })
  }

  /** A DEVICE-audience frame (commanderEligible, not web). User/data frames are group-encrypted (E2EE)
   *  here so the backend relays only ciphertext; system/presence frames pass through. */
  commander(frame: Frame): void {
    deviceDump.record('out', 'commander', undefined, frame)
    if (this.link.servesThisComputerOnly()) return
    this.link.enqueue({ t: 'up', webEligible: false, commanderEligible: true, frame: this.e2ee.wrapCommander(frame) })
  }

  /** Send a user-level notification to every logged-in browser that owns this machine. */
  user(frame: Frame): void {
    this.link.enqueue({ t: 'up', userEligible: true, webEligible: false, frame })
  }

  /** Send an up-frame to exactly ONE web connection (E2EE pairing/welcome + targeted RPC replies). */
  observer(connId: string, type: string, payload: Record<string, unknown>): boolean {
    return this.link.sendBestEffort({ t: 'up', targetConnId: connId, webEligible: false, commanderEligible: false, frame: { type, payload } })
  }

  /** A frame to one connection as it is: a device's direct link, a window on this computer (an answer to
   *  something it asked here), or the relay. */
  private sendTo(connId: string, frame: Frame): void {
    // Handshake frames only: device RPC, legacy replies and broadcasts are recorded in the clear where built.
    if (typeof frame.type === 'string' && frame.type.startsWith('e2e_') && deviceDump.enabled && this.isDeviceConn(connId)) deviceDump.record('out', 'wire', connId, frame)
    const direct = this.directDeviceSinks.get(connId)
    if (direct) { direct(frame); return }
    // Only its own socket ever reached a window on this computer: the core has it, or it has gone. Queued
    // for the relay, the frame would wait for a connection the backend has never heard of.
    if (isLocalClientId(connId)) { this.core.toLocal(connId, frame); return }
    this.link.enqueue({ t: 'up', targetConnId: connId, frame })
  }

  /** Pairwise-encrypt a connection-targeted non-RPC frame (a viewer's); false with no session or no link. */
  target(connId: string, type: string, payload: Record<string, unknown>): boolean {
    if (!this.connected()) return false
    const frame = this.e2ee.wrapTarget(connId, type, payload)
    if (!frame) return false
    this.sendTo(connId, frame)
    return true
  }

  /** Pairwise terminal output is never queued across reconnect: the stream/lease is closed on link loss. */
  terminal(connId: string, type: string, payload: Record<string, unknown>): boolean {
    const frame = this.e2ee.wrapTarget(connId, type, payload)
    if (!frame) return false
    this.noteLiveStream(connId, type, payload)
    if (this.routeTerminalOutputToP2p(connId, type, payload)) {
      if (this.terminalP2p.send(connId, JSON.stringify(frame))) return true
      this.demoteP2pConnection(connId, 'send_failed')
    }
    return this.link.sendBestEffort({
      t: 'up',
      targetConnId: connId,
      webEligible: true,
      commanderEligible: false,
      frame,
    })
  }

  /** Pairwise-encrypted binary terminal output/keyframe. The hop prefix exposes
   * only connId and direction to the opaque backend relay. */
  terminalBinary(connId: string, clear: TerminalBinaryClear): boolean {
    const clientFrame = this.e2ee.wrapTerminalBinary(connId, clear)
    if (!clientFrame) return false
    if (this.p2pStreams.get(connId)?.has(clear.streamId)) {
      if (this.terminalP2p.send(connId, Buffer.from(clientFrame))) return true
      this.demoteP2pConnection(connId, 'send_failed')
    }
    const packet = encodeTerminalHop(TerminalHopDirection.up, connId, clientFrame)
    if (!packet) return false
    return this.link.sendBinary(packet)
  }

  /**
   * The reply to a remote client's request. For an E2EE-session requester whose result carries user
   * content, the reply is encrypted with that connection's session key and delivered ONLY to it.
   * Content-bearing adapter data is never returned plaintext: even legacy backend nodeRequest
   * (`connId === ''`) gets only an error.
   */
  reply(connId: string, type: string, requestId: unknown, payload: Record<string, unknown>): void {
    const resultType = rpcResultType(type)
    // A window on this computer asked the gateway (`local`): it has the plain reply it always had.
    if (isLocalClientId(connId)) { this.core.toLocal(connId, { type: resultType, payload: { requestId, ...payload } }); return }
    if (connId && deviceDump.enabled && this.e2ee.sessionRole(connId) === 'device') deviceDump.record('out', 'legacy', connId, { type: resultType, payload: { requestId, ...payload } })
    if (connId && this.e2ee.hasSession(connId) && encryptRpcResult(resultType)) {
      let replyPayload = payload
      // ⚠️ The DIAL's frame budget, so only a dial's reply is fitted to it. The phone app and a remote
      // desktop are `web` sessions and search this reply for the agent's latest answer: fitted, a reply
      // over ~15KB dropped to one event without its `fullText`, so any agent doing real work — long
      // answers — could not be found by what it had just said.
      if (resultType === 'agent_recent_result' && this.e2ee.sessionRole(connId) === 'device') {
        const trim = fitRecentReplyPayloadForDevice(
          payload,
          (candidate) => this.e2ee.rpcReplyFrameBytes(connId, resultType, requestId, candidate),
        )
        replyPayload = trim.payload
        if (trim.trimmed) {
          console.warn(
            `[recent-trim] agent=${String(payload.agentId ?? '')} originalFrame=${trim.originalBytes ?? 'unknown'} ` +
            `finalFrame=${trim.finalBytes ?? 'unknown'} target=${DEVICE_RECENT_SAFE_FRAME_BYTES} ` +
            `textBytes=${trim.textBytes} recapBytes=${trim.recapBytes}`,
          )
        }
      }
      const wrapped = this.e2ee.wrapRpcReply(connId, resultType, requestId, replyPayload)
      if (wrapped) { this.sendTo(connId, wrapped); return }
    }
    // Enforcement ("no E2EE ⇒ no adapter data"): a content-bearing reply that could not be sealed is a
    // bare E2EE_REQUIRED, never its content in the clear. Either way it goes to the requester alone:
    // broadcast, a reply went to every web client of this machine and every window on it, though each
    // app takes a reply by its own request id and ignores the rest (ws_conn.dart in the desktop and
    // phone apps, hn's daemon.rs, the CLI's relay pool). The backend's own nodeRequest (`connId === ''`)
    // has no connection to be answered on: it hears the reply on the bus, and fails closed on the error;
    // the windows on this computer hear it too, as they did when it went out with every event.
    const reply = { type: resultType, payload: encryptRpcResult(resultType) ? { requestId, error: 'E2EE_REQUIRED' } : { requestId, ...payload } }
    if (connId) { this.sendTo(connId, reply); return }
    this.core.toLocal('', reply)
    this.broadcast(reply)
  }

  /**
   * Append one entry to the account's device key log, over this machine's own socket — the backend
   * ties a machine's entries to the machine that sent them. Resolves to the backend's answer
   * (`{head}` or `{error, head?}`), or null when it did not come in time.
   */
  appendDeviceLog(entry: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown> | null> {
    const requestId = `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.devlogAppends.delete(requestId); resolve(null) }, timeoutMs)
      timer.unref?.()
      this.devlogAppends.set(requestId, (payload) => { clearTimeout(timer); resolve(payload) })
      this.link.enqueue({ t: 'up', webEligible: false, frame: { type: 'devlog_append', payload: { requestId, entry } } })
    })
  }

  // ── in, from remote clients ──────────────────────────────────────────────────────────────────────

  private enqueueDown(frame: Frame, connId: string, transport: RemoteTransport): void {
    const key = connId || '__backend__'
    const previous = this.downChains.get(key) ?? Promise.resolve()
    const next = previous
      .catch(() => { /* prior failure is already logged */ })
      .then(() => this.requestGate)
      .then(() => this.dispatchDown(frame, connId, transport))
      .catch((err) => {
        console.error('[backend] down-frame dispatch failed:', err instanceof Error ? err.message : err)
      })
      .finally(() => {
        if (this.downChains.get(key) === next) this.downChains.delete(key)
      })
    this.downChains.set(key, next)
  }

  private enqueueTerminalBinary(connId: string, raw: Uint8Array): void {
    const key = connId || '__backend__'
    const previous = this.downChains.get(key) ?? Promise.resolve()
    const next = previous
      .catch(() => { /* prior failure is already logged */ })
      .then(async () => {
        const clear = this.e2ee.unwrapTerminalBinary(connId, raw)
        if (clear) await this.core.binary(connId, clear)
        else { const gone = this.e2ee.terminalSessionGone(connId, raw); if (gone) this.sendTo(connId, gone) }
      })
      .catch((err) => {
        console.error('[backend] binary terminal dispatch failed:', err instanceof Error ? err.message : err)
      })
      .finally(() => {
        if (this.downChains.get(key) === next) this.downChains.delete(key)
      })
    this.downChains.set(key, next)
  }

  /**
   * One frame from the relay or a client's P2P channel, in its connection's order. What the gateway
   * answers itself (the handshake, the backend's control frames, the pairings) it answers here; a client's
   * request goes on to the core opened, with the role of the session it opened under.
   */
  async dispatchDown(frame: Frame, connId: string, transport: RemoteTransport = 'relay'): Promise<void> {
    const type = frame.type as string | undefined
    if (!type) return
    // A relayed connection never names a window on this computer: the backend's connection ids are its
    // own UUIDs (backend/src/lib/hub.ts), and a window's is minted by the local socket. Read as local, a
    // relayed frame on a live window's id would take that window's trust; the gateway never lets one
    // that far.
    if (isLocalClientId(connId)) {
      console.warn(`[backend] ignoring ${logSafeType(type)} from ${transport} on a local connection id`)
      return
    }
    // ⚠️ The backend's own instructions, refused from anywhere else. See BACKEND_ONLY_DOWN_TYPES.
    // `transport === 'relay'` rather than "not local", so this keeps holding if the p2p allowlist
    // (`TERMINAL_P2P_DOWN_TYPES`) ever widens.
    //
    // Deliberately ABOVE the observer hand-off below. A genuine observer frame is `relay`, so this
    // never intercepts one; but placed after it, a forged `observer:` connId on a p2p frame would be
    // swallowed by Share and returned without ever reaching this line — silently, with no warning. The
    // grid-name incident was exactly a bypass nobody could see.
    if (transport !== 'relay' && BACKEND_ONLY_DOWN_TYPES.has(type)) {
      console.warn(`[backend] ignoring ${type} from ${transport} (${connId}) — only the backend may send it`)
      return
    }
    if (connId.startsWith('observer:')) {
      await this.core.observer(connId, type, (frame.payload ?? {}) as Record<string, unknown>)
      return
    }
    if (type.startsWith('observer_')) return
    // E2EE control frames (pairing/handshake) are handled by the manager, never as node RPCs.
    if (type.startsWith('e2e_')) {
      const deviceBefore = deviceDump.enabled && (this.isDeviceConn(connId) || (type === 'e2e_pair_intent' && (frame.payload as { role?: unknown } | undefined)?.role === 'device'))
      if (deviceBefore) deviceDump.record('in', 'wire', connId, frame)
      this.e2ee.handleFrame(connId, frame)
      // A reconnecting device is only known as one once its hello has been accepted.
      if (!deviceBefore && deviceDump.enabled && this.isDeviceConn(connId)) deviceDump.record('in', 'wire', connId, frame)
      return
    }
    if (type === 'autonomous_device_request') {
      await this.deviceRequest(connId, frame)
      return
    }
    // ⚠️ Default-deny: the relay is NOT trusted. A frame is acted on only if it opens under this connId's
    // E2EE session — whatever its type — or is one of the backend's own plaintext frames. A list of
    // "sensitive" types to check instead fails open: every type missing from it, including ones added
    // later, would be taken in the clear.
    //
    // The backend's own control frames are the mirror image: only ever plaintext, because the backend
    // holds no key — so one that arrives SEALED was sealed by a paired client, and opening it would let
    // that client speak as the backend (`machine_meta` repoints this computer's grid).
    const from = `${transport} (${connId ? `conn:${sid(connId)}` : 'backend'})`
    const wrapped = isWrapped(frame.payload)
    if (type.startsWith('__') || BACKEND_ONLY_DOWN_TYPES.has(type)) {
      // And only on the backend's OWN address: it sends these with `connId: ''`, while every frame a
      // client sends arrives stamped with that client's connId — so a client-shaped one was relayed, not
      // written by the backend, whichever socket let it through. `__client_disconnected` is the one the
      // hub addresses to a client's own connId; it only tears down that connection's state.
      if (transport !== 'relay' || wrapped || (connId !== '' && type !== '__client_disconnected')) {
        console.warn(`[backend] ignoring ${logSafeType(type)} from ${from} — only the backend sends it, and only in the clear`)
        return
      }
      if (deviceDump.enabled && this.e2ee.sessionRole(connId) === 'device') deviceDump.record('in', 'legacy', connId, frame)
      this.logRequest(connId, frame)
      await this.backendControl(type, frame, connId)
      return
    }
    if (!wrapped) {
      console.warn(`[backend] refusing plaintext ${logSafeType(type)} from ${from} — E2EE required`)
      const requestId = (frame.payload as { requestId?: unknown } | undefined)?.requestId
      if (requestId !== undefined) this.reply(connId, type, requestId, { error: 'E2EE_REQUIRED' })
      return
    }
    const opened = this.e2ee.unwrapDown(connId, frame)
    // Sealed for a session this process never had: told, rather than dropped without a word.
    if (!opened) { const gone = this.e2ee.sessionGone(connId, frame); if (gone) this.sendTo(connId, gone); return }
    // Opened under this connection's session, so it has one: its role is who asked.
    const role = this.e2ee.sessionRole(connId) as RemoteRole
    if (deviceDump.enabled && role === 'device') deviceDump.record('in', 'legacy', connId, opened)
    if (TERMINAL_P2P_SIGNAL_TYPES.has(type)) {
      await this.terminalP2p.handleSignal(connId, type, opened.payload)
      return
    }
    const payload = (opened.payload ?? {}) as Record<string, unknown>
    // Trust-group roster exchange: only over an E2EE session, from the identity that session proved —
    // the roster carries the keys this machine trusts, and the peer's own entry must be that identity.
    if (type === 'group_sync') {
      this.logRequest(connId, opened)
      const peerPub = this.e2ee.sessionIdentity(connId)
      if (!peerPub || role !== 'web' || !this.groupSync) { this.reply(connId, type, payload.requestId, { error: 'UNSUPPORTED' }); return }
      try { this.reply(connId, type, payload.requestId, this.groupSync.handle(peerPub, payload)) } catch { this.reply(connId, type, payload.requestId, { error: 'GROUP_SYNC_FAILED' }) }
      return
    }
    if (GATEWAY_REQUEST_TYPES.has(type)) {
      this.logRequest(connId, opened)
      await this.manage(connId, type, payload)
      return
    }
    if (type.startsWith('terminal_')) this.noteTerminalInputRoute(connId, type, payload, transport)
    await this.core.frame(connId, opened, transport, role)
  }

  /** The backend's own control frames, checked by the caller: in the clear, over the relay, on its own address. */
  private async backendControl(type: string, frame: Frame, connId: string): Promise<void> {
    // Cross-instance client snapshot. Generation detects leave/join cycles that coalesce to the same
    // count; count rise remains the compatibility fallback for older backends.
    if (type === '__clients') {
      const payload = (frame.payload ?? {}) as { commander?: number; commanderActive?: number; commanderJoinGeneration?: number }
      const commander = Number(payload.commander ?? 0)
      const rawGeneration = payload.commanderJoinGeneration
      const generation = typeof rawGeneration === 'number' && Number.isSafeInteger(rawGeneration) && rawGeneration >= 0
        ? rawGeneration
        : undefined
      const replay = shouldReplayCommander(
        this.commanderCount,
        commander,
        this.replayedCommanderGeneration,
        generation,
        this.replayCommanderOnNextSnapshot,
      )
      this.setCommanderCount(commander, payload.commanderActive != null ? Number(payload.commanderActive) : null)
      if (replay) {
        this.replayCommanderOnNextSnapshot = false
        if (generation != null) this.replayedCommanderGeneration = generation
        this.core.commanderJoined()
      }
      return
    }
    if (type === '__client_disconnected') {
      // The backend is authoritative for the outer connId. Drop both kinds of
      // connection-scoped state immediately; otherwise a dead Desktop keeps a
      // terminal controller lease until the 30-second heartbeat timeout.
      this.deviceClients.delete(connId)
      this.e2ee.dropSession(connId)
      await this.terminalP2p.closeConnection(connId, 'client_disconnected', false)
      this.p2pPendingOpens.delete(connId)
      this.p2pStreams.delete(connId)
      this.liveStreams.delete(connId)
      await this.core.disconnected(connId)
      return
    }
    // Other backend-hub internal control frames (__clients_dirty) — not for us; drop silently.
    if (type.startsWith('__')) return

    // The machine was deleted/revoked from the web → stop for good (don't reconnect) and let the CLI
    // clear the saved token. Closing the link blocks the reconnect that would otherwise fire on socket drop.
    if (type === 'machine_revoked') {
      const p = (typeof frame.payload === 'object' && frame.payload !== null ? frame.payload : {}) as { reason?: unknown; pub?: unknown }
      // Another key under this machine id was removed — an earlier install of this computer that this one
      // waits behind (`device_conflict`). The frame goes to the machine id, so it reaches this install too:
      // that removal is what lets this key register, not a sign-out. Re-read the log instead.
      if (p.reason === 'device_removed' && typeof p.pub === 'string' && this.isOwnDeviceKey && !this.isOwnDeviceKey(p.pub)) {
        this.onDeviceKeysChanged?.()
        return
      }
      this.link.close()
      // Removed from the account's device key log (not just signed out): the key itself is spent.
      if (p.reason === 'device_removed' && typeof p.pub === 'string') {
        try { this.onDeviceRemoved?.(p.pub) } catch { /* signing out still happens */ }
      }
      this.core.revoked()
      return
    }

    // The account's tabs changed on another computer (or in another window of this one): hand the
    // window the revision and let it fetch `/api/desk` through this daemon. Backend-only, like
    // machine_meta — a local client cannot make the window re-read anything by sending this.
    if (type === 'desk_changed' || type === 'zoo_changed') {
      const revision = (typeof frame.payload === 'object' && frame.payload !== null ? (frame.payload as { revision?: unknown }).revision : undefined)
      this.core.notice({ type, revision: typeof revision === 'number' ? revision : 0 })
      return
    }

    // The account's device key log grew: this daemon re-reads and verifies it (deviceLogSyncer.ts), and
    // the window re-reads its Devices list. Backend-only for the same reason as desk_changed.
    if (type === 'device_keys_changed') {
      this.onDeviceKeysChanged?.()
      this.core.notice({ type: 'device_keys_changed' })
      return
    }
    // The backend's answer to this machine's own append to the device key log.
    if (type === 'devlog_append_result') {
      const p = (typeof frame.payload === 'object' && frame.payload !== null ? frame.payload : {}) as Record<string, unknown>
      const done = typeof p.requestId === 'string' ? this.devlogAppends.get(p.requestId) : undefined
      if (done) { this.devlogAppends.delete(p.requestId as string); done(p) }
      return
    }

    // The account's machine list changed on some worker — a machine created / renamed / deleted, or a
    // shared harness invited / taken back. The window re-reads `/api/machines` through this daemon; this
    // push is why it does not have to poll for that. Backend-only for the same reason as desk_changed.
    if (type === 'machines_changed') {
      const reason = (typeof frame.payload === 'object' && frame.payload !== null ? (frame.payload as { reason?: unknown }).reason : undefined)
      this.core.notice({ type: 'machines_changed', reason: typeof reason === 'string' ? reason : 'updated' })
      return
    }

    // Machine display name (seed on connect + web renames) — mirrored locally for `harness status`.
    if (type === 'machine_meta') {
      // ⚠️ The BACKEND's frame and nobody else's. It carries this machine's display name and, more
      // to the point, the account's private grid — the grid every agent on this computer is then
      // pointed at. Accepted from any transport, it let a process that could open the daemon's local
      // port redirect the account's inference somewhere of its choosing, and a leftover test script
      // doing exactly that by accident cost hours to find. No client sends this frame; there is
      // nothing to be compatible with. The source check is in the caller.
      //
      // A malformed/hostile frame's payload need not be an object; `'gridName' in meta` would throw
      // on a primitive (and drop the whole frame). Guard the type first, the way the plain property
      // reads elsewhere in this dispatcher tolerate one.
      const meta = (typeof frame.payload === 'object' && frame.payload !== null ? frame.payload : {}) as { name?: unknown; gridName?: unknown }
      // The account's private grid, pushed on connect. Held in memory only: it is the backend's
      // value, and a daemon that cached it on disk would keep answering with a stale one after the
      // account's grid changed. Only ACT on the key when it is present: the connect frame always
      // carries it (a string or null), but a rename pushes `{name}` alone — and treating that
      // absence as null used to WIPE a grid name a moment after it was set, leaving the picker
      // empty. Absent ⇒ unchanged; null ⇒ this account has none; a string ⇒ that grid.
      const said: { name?: string | null; gridName?: string | null } = {}
      if ('gridName' in meta) said.gridName = typeof meta.gridName === 'string' && meta.gridName.trim() ? meta.gridName.trim() : null
      // The same rule for the name: a frame that does not carry it leaves it as it was.
      if ('name' in meta) said.name = typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : null
      this.core.meta(said)
    }
  }

  /** A request the gateway answers itself, logged as the core logs the ones it answers. */
  private logRequest(connId: string, frame: Frame): void {
    const type = String(frame.type)
    if (env.LOG_FRAMES && type !== 'phone_pair' && !type.startsWith('pair')) logFrame('←', connId ? `conn:${sid(connId)}` : 'backend', frame)
  }

  /** A local connection's E2EE management request, handed over by the core. */
  async local(connId: string, frame: Frame): Promise<void> {
    const type = typeof frame.type === 'string' ? frame.type : ''
    if (!GATEWAY_REQUEST_TYPES.has(type)) return
    await this.manage(connId, type, (frame.payload ?? {}) as Record<string, unknown>)
  }

  /** The E2EE management requests (GATEWAY_REQUEST_TYPES), from a remote client or a window here. */
  private async manage(connId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    try {
      switch (type) {
        case 'device_e2ee_pair':
          await this.e2ee.pairDeviceFromTrustedWeb(connId, payload)
          return
        case 'phone_pair':
          // CPace waits for another connection. Do not block this browser's terminal queue.
          void this.e2ee.pairPhoneFromTrustedWeb(connId, payload)
          return
        case 'e2ee_pairings_list':
          this.reply(connId, type, payload.requestId, { pairs: this.e2ee.listPaired(connId) })
          return
        case 'e2ee_pairing_unpair':
          this.e2ee.revokeFromTrustedWeb(connId, payload)
          return
        default: // e2ee_pairings_unpair_all
          this.e2ee.revokeAllFromTrustedWeb(connId, payload.requestId)
          return
      }
    } catch (err) {
      console.error(`[backend] dispatch ${type} failed:`, err)
      if (payload.requestId !== undefined) this.reply(connId, type, payload.requestId, { error: 'INTERNAL' })
    }
  }

  // ── P2P terminal channels ────────────────────────────────────────────────────────────────────────

  private sendP2pSignal(connId: string, type: string, payload: TerminalP2pSignal): void {
    const frame = this.e2ee.wrapTarget(connId, type, { ...payload })
    if (frame) this.sendTo(connId, frame)
  }

  private handleP2pData(connId: string, data: TerminalP2pData): void {
    if (typeof data === 'string') {
      if (Buffer.byteLength(data, 'utf8') > 512 * 1024) return
      let frame: Frame
      try { frame = JSON.parse(data) as Frame } catch { return }
      if (typeof frame.type !== 'string' || !TERMINAL_P2P_DOWN_TYPES.has(frame.type)) return
      this.enqueueDown(frame, connId, 'p2p')
      return
    }
    if (data.length > 512 * 1024) return
    this.enqueueTerminalBinary(connId, data)
  }

  /** What the core has told a remote client about its terminal streams: one opened, one closed. */
  private noteLiveStream(connId: string, type: string, payload: Record<string, unknown>): void {
    const streamId = typeof payload.streamId === 'string' ? payload.streamId : ''
    if (!streamId) return
    if (type === 'terminal_ready') {
      let streams = this.liveStreams.get(connId)
      if (!streams) { streams = new Set(); this.liveStreams.set(connId, streams) }
      streams.add(streamId)
    } else if (type === 'terminal_closed') {
      const streams = this.liveStreams.get(connId)
      streams?.delete(streamId)
      if (streams?.size === 0) this.liveStreams.delete(connId)
    }
  }

  private noteTerminalInputRoute(
    connId: string,
    type: string,
    payload: Record<string, unknown>,
    transport: RemoteTransport,
  ): void {
    if (type === 'terminal_open' && typeof payload.requestId === 'string') {
      let pending = this.p2pPendingOpens.get(connId)
      if (!pending) { pending = new Set(); this.p2pPendingOpens.set(connId, pending) }
      if (transport === 'p2p') pending.add(payload.requestId)
      else pending.delete(payload.requestId)
      return
    }
    const streamId = typeof payload.streamId === 'string' ? payload.streamId : ''
    // Live-migration promotion: the client's remoteRelay.ts sends a SECOND terminal_resync over p2p
    // (after the first one, over relay, already drained/snapshotted the stream) once its own p2p
    // channel is ready — arriving here is our signal to start routing this stream's OUTPUT over p2p
    // too, mirroring what the client just did on its side. The live-stream check guards against
    // promoting a streamId whose pane was closed in the same instant the migration was in flight.
    if (type === 'terminal_resync' && transport === 'p2p' && streamId
      && this.liveStreams.get(connId)?.has(streamId)) {
      let streams = this.p2pStreams.get(connId)
      if (!streams) { streams = new Set(); this.p2pStreams.set(connId, streams) }
      streams.add(streamId)
      return
    }
    if (transport !== 'p2p' && streamId) this.p2pStreams.get(connId)?.delete(streamId)
  }

  private routeTerminalOutputToP2p(connId: string, type: string, payload: Record<string, unknown>): boolean {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
    const streamId = typeof payload.streamId === 'string' ? payload.streamId : ''
    const pending = this.p2pPendingOpens.get(connId)
    if ((type === 'terminal_ready' || type === 'terminal_error') && requestId && pending?.has(requestId)) {
      pending.delete(requestId)
      if (pending.size === 0) this.p2pPendingOpens.delete(connId)
      if (type === 'terminal_ready' && streamId) {
        let streams = this.p2pStreams.get(connId)
        if (!streams) { streams = new Set(); this.p2pStreams.set(connId, streams) }
        streams.add(streamId)
      }
      return true
    }
    const streams = this.p2pStreams.get(connId)
    const selected = !!streamId && streams?.has(streamId) === true
    if (selected && type === 'terminal_closed') {
      streams!.delete(streamId)
      if (streams!.size === 0) this.p2pStreams.delete(connId)
    }
    return selected
  }

  private demoteP2pConnection(connId: string, reason: string): void {
    this.p2pPendingOpens.delete(connId)
    this.p2pStreams.delete(connId)
    console.warn(`[terminal-p2p] conn=${sid(connId)} fallback=relay reason=${reason}`)
  }

  // ── the Wi-Fi device's direct links, which ride the same E2EE sessions ──────────────────────────

  /** A connection that is, or is pairing as, an Autonomous device — what the device dump records. */
  private isDeviceConn(connId: string): boolean {
    return this.directDeviceSinks.has(connId) || this.e2ee.sessionRole(connId) === 'device'
      || (this.e2ee.pendingConnection() === connId && this.e2ee.pendingPair()?.role === 'device')
  }
  attachDirectDevice(connId: string, send: (frame: Frame) => void): void { this.directDeviceSinks.set(connId, send) }
  detachDirectDevice(connId: string): void {
    this.directDeviceSinks.delete(connId); this.directDevicePins.delete(connId); this.deviceClients.delete(connId); this.e2ee.dropSession(connId)
    void this.core.disconnected(connId)
    this.core.commanders(this.commanderCount, this.commanderActive, true)
  }
  pairedDirectFingerprint(connId: string): string | null { const pub = this.directDevicePins.get(connId); return pub ? fingerprint(b64d(pub)) : null }
  async receiveDirectDevice(connId: string, frame: Frame, pairingAllowed: boolean): Promise<void> {
    if (!this.directDeviceSinks.has(connId)) return
    const type = frame.type
    if (type !== 'autonomous_device_request') deviceDump.record('in', 'wire', connId, frame) // requests: decrypted in the relay
    if (type === 'machine_selected') return
    if (type === 'autonomous_device_request') { await this.deviceRequest(connId, frame); return }
    const controls = pairingAllowed ? ['e2e_pair_intent', 'e2e_pair_cancel', 'e2e_pake', 'e2e_hello', 'e2e_status'] : ['e2e_hello', 'e2e_status']
    if ((type === 'e2e_pake' || type === 'e2e_pair_cancel') && this.e2ee.pendingConnection() !== connId) return
    if (typeof type === 'string' && controls.includes(type)) this.e2ee.handleFrame(connId, frame)
  }

  /**
   * A Wi-Fi device's request, for the device service's relay in the core (lib/autonomous-device/relay.ts),
   * opened here under the session that sealed it. Opened only when the relay would open it (a device's
   * session, a sealed frame, no session id beside it), so its replay window moves exactly as it did when
   * the relay opened the frame itself.
   */
  private async deviceRequest(connId: string, frame: Frame): Promise<void> {
    const opens = !!this.e2ee.sessionIdentity(connId) && this.e2ee.sessionRole(connId) === 'device' && isWrapped(frame.payload) && frame.dbSessionId === undefined
    await this.core.device(connId, frame, opens ? this.e2ee.unwrapDown(connId, frame) : null)
  }

  /** The device service's answer or event for one Wi-Fi device session, sealed to it. */
  device(connId: string, type: string, payload: Record<string, unknown>): boolean {
    const wrapped = this.e2ee.wrapTarget(connId, type, payload)
    if (!wrapped) return false
    this.sendTo(connId, wrapped)
    return true
  }

  deviceClient(connId: string, identity: string | null): void {
    if (identity) this.deviceClients.set(connId, identity)
    else this.deviceClients.delete(connId)
  }

  /**
   * App-side revoke: tell the device while its authenticated session still exists (the E2eeManager drops
   * the session right after this), so it clears its own pin instead of showing "paired / disconnected"
   * forever. The device service's relay did this itself when it shared this process; the core is now a
   * frame away, and the session would be gone by the time it answered, so the gateway sends the same frame
   * to the same sessions here, and the service hears of the unpairing once they are gone. Best-effort: a
   * device that is offline learns it on reconnect, when its e2e_hello gets e2e_denied.
   */
  private deviceUnpaired(identity: string): void {
    for (const [connId, client] of [...this.deviceClients]) {
      if (client !== identity) continue
      this.deviceClients.delete(connId)
      if (this.e2ee.sessionIdentity(connId) !== identity || this.e2ee.sessionRole(connId) !== 'device') continue
      const event = { type: 'pair.revoke', machineId: this.machineId }
      try {
        deviceDump.record('out', 'rpc', connId, { type: 'autonomous_device_event', payload: event })
        this.device(connId, 'autonomous_device_event', event)
      } catch { /* Local removal must proceed regardless. */ }
    }
    // After the sessions are dropped, which the manager does once this returns: the service's relay then
    // finds none left to tell, and only forgets the identity.
    setImmediate(() => this.core.deviceRevoked(identity))
  }

  // ── the pairings, for the daemon's own commands (`harness pair`, `unpair`, `remote-password`, …) ──

  /** True after a paired device has completed the E2EE hello/welcome session. */
  deviceE2eeConnected(): boolean { return this.e2ee.deviceConnected() }
  /** A browser waiting to pair (`/api/status`), or null. */
  pendingPair(): ReturnType<E2eeManager['pendingPair']> { return this.e2ee.pendingPair() }
  /** Run CPace pairing for a code entered via `harness pair <code>` (delegated to the manager). */
  pair(code: string): Promise<PairResult> { return this.e2ee.onPair(code) }
  fingerprint(): string { return this.e2ee.fingerprint() }
  /** `harness pairings` — list paired clients. */
  listPairs(): ReturnType<E2eeManager['listPaired']> { return this.e2ee.listPaired() }
  /** `harness unpair <id>` — unpair one client (signals it to re-pair if online). */
  revoke(id: string): ReturnType<E2eeManager['revoke']> { return this.e2ee.revoke(id) }
  /** `harness unpair --all` — unpair every client. */
  revokeAll(): ReturnType<E2eeManager['revokeAll']> { return this.e2ee.revokeAll() }
  /** `harness remote-password set` — stretch + persist a new persistent remote password. */
  setRemotePassword(password: string): ReturnType<E2eeManager['setRemotePassword']> { return this.e2ee.setRemotePassword(password) }
  /** `harness remote-password clear` — remove the persistent remote password. */
  clearRemotePassword(): void { this.e2ee.clearRemotePassword() }
  /** `harness link connect` — trust the machine this one just linked as a client too (mutual link). */
  trustPeer(peer: LinkedPeer): void { this.e2ee.trustPeer(peer) }
  /** Stop trusting `pub` here (unlink / trust-group removal); true when it was trusted. */
  untrustPeer(pub: string): boolean { return this.e2ee.untrustPeer(pub) }
  pairedPeers(): ReturnType<E2eeManager['pairedPeers']> { return this.e2ee.pairedPeers() }
  /** `harness remote-password status` — whether one is set, and its fingerprint. */
  remotePasswordStatus(): ReturnType<E2eeManager['remotePasswordStatus']> { return this.e2ee.remotePasswordStatus() }
}
