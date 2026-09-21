/**
 * Backend hub — remote-machine adapter endpoint (`/api/adapter-ws`).
 *
 * A "remote" machine has no manager/agent-node: the user's own COMPUTER runs the machine-adapter CLI,
 * which dials in here and occupies the NODE side of the machineId — the same role a manager socket
 * plays for a docker node:
 *   - down:{machineId} (client chat/RPC)  → forwarded to the adapter socket
 *   - adapter `up` frames (normalized claude events + `<x>_result` RPC replies) → publishUp(machineId)
 *   - presence key machine:{machineId}:mgr = 'remote' while connected → drives web node_status
 *
 * Auth: the first WebSocket subprotocol is the user's SSO access token. The stable `computer` query
 * parameter selects (or creates) that user's Remote machine; a managed machine never gains a second
 * writer for its down:{machineId} channel.
 */
import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import { WebSocket, type RawData } from 'ws'
import { createWss, WS_LIMITS } from './wsServer.js'
import { prisma } from './prisma.js'
import {
  publishUp, claimMachineOwner, releaseMachineOwner, publishDeviceE2eePair,
  publishTerminalUp, subscribeTerminalDown,
  setMachineAppState, clearMachineAppState, subscribeDeskChanged,
} from './bus.js'
import { trackSocketLiveness } from './hub.js'
import { guardedSend, guardedSendJson } from './wsSend.js'
import { attachNodeRole, PRESENCE_TTL_SEC } from './nodeRole.js'
import { presenceWriteDue, recordTurnStarted, touchMachineOnlineDay, touchUserOnlineDay, type PresenceWriteState } from './dailyTracking.js'
import { countryCodeFromHeaders } from './clientGeo.js'
import { recordCreatedAgent, recordDeletedAgent } from './agentTracker.js'
import type { Frame } from './tunnel.js'
import { logger } from '../utils/logger.js'
import { utcDayKey } from '../types/analytics.js'
import { machineBillingAllowsDataPlane } from './billingState.js'
import { normalizeComputerId } from './deviceAuth.js'
import { authenticateAccessToken, SsoAuthError } from './ssoAuth.js'
import { parseAutonomousEnvironment } from './autonomousEnvironment.js'
import { machineService } from '../services/MachineService.js'
import { AppError } from '../errors/index.js'
import {
  isEncryptedTerminalFrame,
  TERMINAL_ENVELOPE_MAX_BYTES,
  TERMINAL_UP_TYPES,
  terminalFrameBytes,
  TerminalRateGuard,
} from './terminalRelay.js'
import { decodeTerminalHop, TerminalBinaryKind, TerminalHopDirection } from './terminalBinary.js'
import {
  isEncryptedP2pFrame,
  P2P_SIGNAL_MAX_BYTES,
  P2P_UP_TYPES,
  p2pFrameBytes,
  P2pSignalRateGuard,
  terminalP2pPolicy,
} from './p2pSignaling.js'

const wss = createWss(WS_LIMITS.adapter, { echoFirstProtocol: true })

// machineId → the current adapter socket. One writer per machineId: down:{machineId} must have exactly
// one consumer, so a reconnecting adapter supersedes its predecessor (same as attachNode does).
const owners = new Map<string, WebSocket>()

/** Frames the adapter sends us. `up.frame` is opaque (ServerEvents / `<x>_result` replies /
 *  commander_event device cards). Eligibility is per-frame: web defaults true, commander defaults
 *  false — the adapter opts device frames in (mirrors the node's managerSocket.emitUp channels). */
type AdapterFrame =
  | { t: 'up'; frame: Frame; webEligible?: boolean; commanderEligible?: boolean; targetConnId?: string; userEligible?: boolean }
  | { t: 'ping' }

// Which desktop app a remote computer drives, and whether it is running. Sent as an `up` frame with
// BOTH eligibility flags false, so it reaches the per-machine subscribeUp watchers (deviceWs) without
// ever being fanned out to an attached client — no existing firmware can see an unknown frame type.
const APP_ENGINES = new Set(['cursor'])
const APP_STATES = new Set(['open', 'closed', 'missing'])

// `?v=` is self-declared by the client, so it is never persisted raw: anything outside a plain
// semver-ish token (or longer than 64 chars) is dropped rather than stored.
const CLIENT_VERSION_RE = /^[A-Za-z0-9._+-]{1,64}$/

// Daily presence (`machine_daily_presence`): how often an OPEN adapter socket refreshes its row's
// `lastSeenAt`. Rides the node role's existing 15s heartbeat (plus every app ping) rather than a
// timer of its own — this is just the floor between two Mongo writes, so a machine that is up all
// day costs ~300 upserts, not ~6000. Connect and close always write regardless.
const MACHINE_PRESENCE_WRITE_MS = 5 * 60_000

// Daily presence of the PERSON (`user_daily_presence`): the daemon reports its own loopback clients —
// `open` the moment a desktop window attaches, `ping` on its 15s app-ping tick while one stays, at
// most once a minute (cli backendSocket sendAppPresence) — and this is the floor between two Mongo
// writes for the `ping` kind. `open` always writes — it is what `connections` counts. The web-ws upgrade
// used to be the source, but the desktop app never dials web-ws directly (only the daemon does, and
// only to relay a foreign machine), so a single-machine user was invisible there.
const USER_PRESENCE_WRITE_MS = 5 * 60_000
// `open` is not floored by the interval above (each one IS a session), but it is floored on its own:
// the window reconnects its local socket a few times a minute at worst during a daemon restart, and
// an adapter sending more than that is looping or lying — either way not a session per frame, and
// not a Mongo upsert per frame.
const USER_PRESENCE_OPEN_MS = 10_000
const APP_PRESENCE_KINDS = new Set(['open', 'ping'])

// `turn_started` tap (agent/machine daily presence). `agentId` is a plain token the CLI derives from
// its registry (a UUID, or the engine's own session id as fallback), so it is bounded and
// character-restricted before it becomes a Mongo index key — an oversized or exotic value would
// otherwise either fail the unique index (>1024-byte key) or let a misbehaving adapter mint an
// unbounded number of `agent_daily_presence` rows. The per-minute cap is the same idea for volume:
// a real turn is human-paced (a handful a minute across every agent on one machine), so anything
// past this is a bug or abuse and is dropped, never written.
const TURN_AGENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
const TURN_WRITES_PER_MINUTE = 120

function sanitizeClientVersion(raw: string | null): string | undefined {
  const v = raw?.trim()
  return v && CLIENT_VERSION_RE.test(v) ? v : undefined
}

/** Adapter authentication is SSO-only: accept precisely the first WS subprotocol, never x-api-key. */
function accessTokenFromProtocol(req: IncomingMessage): string | undefined {
  const raw = req.headers['sec-websocket-protocol']
  const first = (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0]?.trim()
  return first || undefined
}

/** Fastify/http upgrade hook for `/api/adapter-ws`. Auth = user SSO access token. */
export function handleAdapterUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  // Reject with an explicit HTTP 401 (not a silent destroy) so the adapter's ws client surfaces
  // "Unexpected server response: 401" — which it treats as a FATAL deauthorization (deleted/unknown
  // machine) and clears its saved token, instead of an ambiguous close-1006 it would retry forever.
  const deny = (): void => {
    try { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n') } catch { /* ignore */ }
    socket.destroy()
  }
  // One computer per machine: when a DIFFERENT computer already holds this machine, reject with an
  // explicit HTTP 409 (not 401 — the adapter treats 401/403 as deauth and would WIPE its valid token).
  // The adapter surfaces 409 as an info message ("already connected from another computer") and stops.
  const denyBusy = (): void => {
    try { socket.write('HTTP/1.1 409 Conflict\r\nConnection: close\r\nContent-Length: 0\r\n\r\n') } catch { /* ignore */ }
    socket.destroy()
  }
  // Billing suspension is retryable: unlike 401/403, the adapter must retain its token so it can
  // reconnect automatically after the owner renews or re-subscribes.
  const denyPayment = (): void => {
    try { socket.write('HTTP/1.1 402 Payment Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n') } catch { /* ignore */ }
    socket.destroy()
  }
  const accessToken = accessTokenFromProtocol(req)
  if (!accessToken) { deny(); return }
  // The adapter sends its computer's hostname as `?label=`, a stable `?computer=` id, its version,
  // and the selected Autonomous environment. `computer` is required: without it the backend has no
  // safe way to choose between a user's Remote machines.
  let label: string | undefined
  let computerId: string | undefined
  let clientVersion: string | undefined
  let claimedMachineId: string | undefined
  let autonomousEnv: 'prod' | 'stag' = 'prod'
  try {
    const params = new URL(req.url ?? '', 'http://x').searchParams
    label = params.get('label') || undefined
    computerId = normalizeComputerId(params.get('computer') ?? '') ?? undefined
    // The machine id this daemon still believes it is. Optional: a freshly logged-in CLI has none
    // yet. When present it lets `resolveOrCreateForComputer` tell a REVOKED daemon apart from a
    // first-time pairing, instead of silently minting it a replacement machine.
    claimedMachineId = params.get('machine') || undefined
    clientVersion = sanitizeClientVersion(params.get('v'))
    autonomousEnv = parseAutonomousEnvironment(params.get('autonomousEnv'))
  } catch { deny(); return }
  if (!computerId) { deny(); return }
  // Where this computer is, per Cloudflare (absent off-Cloudflare). Read once here, at the only point
  // that still has the upgrade request, and carried into the machine row + its daily presence.
  const countryCode = countryCodeFromHeaders(req.headers)
  void (async () => {
    let user
    try { user = await authenticateAccessToken(accessToken, autonomousEnv) } catch (err) {
      if (err instanceof SsoAuthError && (err.code === 'AUTONOMOUS_ENV_MISMATCH' || err.code === 'AUTONOMOUS_ENV_NOT_ALLOWED')) {
        try { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n') } catch { /* ignore */ }
        socket.destroy()
        return
      }
      deny()
      return
    }
    const resolved = await machineService.resolveOrCreateForComputer(user.sub, user.autonomousEnv, computerId, label ?? 'computer', claimedMachineId)
    const machine = resolved.machine
    const machineId = machine.machineId
    if (!machineBillingAllowsDataPlane(machine)) { denyPayment(); return }
    // Single-computer claim BEFORE upgrade/attach, so a rejected second computer never supersedes the first.
    if (!(await claimMachineOwner(machineId, computerId, PRESENCE_TTL_SEC))) { denyBusy(); return }
    wss.handleUpgrade(req, socket, head, (ws) => void attachAdapter(ws, machineId, machine.userId, machine.name, label, computerId, clientVersion, countryCode))
  })().catch((err) => {
    if (err instanceof AppError) {
      // 403 is the revoked-machine answer from `resolveOrCreateForComputer`; the CLI keys off the
      // numeric status, but sending it under the wrong reason phrase would mislead anyone reading a
      // packet capture or a proxy log.
      const text = err.statusCode === 403 ? 'Forbidden' : err.statusCode === 409 ? 'Conflict' : 'Service Unavailable'
      try { socket.write(`HTTP/1.1 ${err.statusCode} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`) } catch { /* ignore */ }
      socket.destroy()
      return
    }
    logger.warn('adapter-ws upgrade failed', { error: String(err) })
    socket.destroy()
  })
}

async function attachAdapter(ws: WebSocket, machineId: string, userId: string, currentName: string | null, label?: string, computerId?: string, clientVersion?: string, countryCode?: string): Promise<void> {
  // A different computer was already rejected at the upgrade (denyBusy), so this only closes our OWN
  // stale local socket on a same-computer reconnect landing on this worker.
  owners.get(machineId)?.close(4000, 'superseded')
  owners.set(machineId, ws)
  const send = (obj: unknown): boolean => guardedSendJson(ws, obj, 'must', { machineId, kind: 'adapter' })
  logger.info('adapter connected', { machineId, computer: label })
  send({ t: 'connected', machineId })
  // The account's tabs changed on some worker: this computer's app re-fetches `/api/desk` through its
  // daemon (backendSocket.ts relays `desk_changed` to the window). One frame, no payload beyond the
  // revision — the doc itself is fetched, so a burst of edits collapses into one read.
  const deskUnsub = await subscribeDeskChanged(userId, (msg) => {
    send({ t: 'down', connId: '', frame: { type: 'desk_changed', payload: { revision: msg.revision } } })
  })

  // Last desktop-app state THIS socket asserted. Socket-scoped on purpose: a new adapter connection
  // starts with no claim and must re-assert, so a fresh value can never renew a stale one.
  let appState: { engine: string; state: string } | undefined
  const terminalRate = new TerminalRateGuard()
  // Fixed one-minute window for the `turn_started` tap — two integers, no timer, no allocation.
  let turnWindowStart = 0
  let turnWindowCount = 0
  const allowTurnWrite = (nowMs: number): boolean => {
    if (nowMs - turnWindowStart >= 60_000) { turnWindowStart = nowMs; turnWindowCount = 0 }
    return ++turnWindowCount <= TURN_WRITES_PER_MINUTE
  }
  const p2pSignalRate = new P2pSignalRateGuard()

  // Buffer messages from RIGHT NOW, because the real handler cannot be installed until after the
  // `await attachNodeRole(...)` below — and `ws` drops any message emitted with no listener attached.
  // An adapter that (reasonably) sends as soon as its socket opens therefore lost its FIRST frame,
  // every time. That was invisible for a long while because the CLI's first frame is a resend-on-tick,
  // so it just looked like a one-tick delay; an adapter whose first frame is one-shot state lost it
  // outright. Buffer, then replay in order once the handler exists.
  const preHandlerQueue: Array<[RawData, boolean]> = []
  let onMessage: ((raw: RawData, isBinary: boolean) => void) | null = null
  ws.on('message', (raw: RawData, isBinary: boolean) => {
    if (onMessage) onMessage(raw, isBinary)
    else if (preHandlerQueue.length < 64) preHandlerQueue.push([raw, isBinary])
  })

  // Two separate fields, deliberately: `hostname` tracks whichever computer connected LAST, while
  // `name` is the user-editable display name and is only ever SEEDED here — a connect must never
  // clobber a name the owner set. Best-effort; never blocks the connection.
  const seededName = !currentName?.trim() && label ? label.slice(0, 120) : null
  // Normalized on the way to Mongo so this column matches what the device-auth grant stamps — the
  // reuse lookup is an equality match on it. The RAW `computerId` keeps driving the Redis owner claim
  // (see the upgrade handler): that key is a self-consistent liveness token nothing joins against, and
  // re-keying it would 409 every already-connected adapter until its old claim aged out.
  const boundComputer = computerId ? normalizeComputerId(computerId) : null
  if (label || seededName || clientVersion || boundComputer || countryCode) {
    void prisma.machine.update({
      where: { machineId },
      data: {
        ...(label ? { hostname: label.slice(0, 120) } : {}),
        ...(seededName ? { name: seededName } : {}),
        // Same overwrite-every-connect rule as `hostname`; absent (old client) leaves the last value.
        ...(clientVersion ? { clientVersion } : {}),
        ...(boundComputer ? { computerId: boundComputer } : {}),
        // Same rule again; absent (not behind Cloudflare) leaves the last value.
        ...(countryCode ? { countryCode } : {}),
      },
    }).catch(() => { /* best effort */ })
  }
  // Tell the adapter its machine's display name (it mirrors it locally for `harness status`); null when
  // unnamed so a stale mirror clears. Renames while connected arrive the same way (machine_meta).
  // The account's private harness grid, carried on the frame the adapter already gets on connect.
  // Minted and remembered by `routes/grid.ts`; read-only here. A user who has never signed in since
  // the route shipped simply has none yet, and the daemon treats that as "no grid" rather than an
  // error — the next `harness login` mints it.
  const gridName = (await prisma.user.findUnique({ where: { id: userId }, select: { gridName: true } })
    .catch(() => null))?.gridName ?? null
  send({ t: 'down', connId: '', frame: { type: 'machine_meta', payload: { name: currentName?.trim() || seededName, gridName } } })

  // Daily presence row for the machine, mirroring the user/device variants in webWs/deviceWs. The
  // guard only advances on a SUCCESSFUL write, so a transient DB failure is retried on the next
  // heartbeat instead of being silently skipped until the interval elapses again. Heartbeats also
  // skip while a write is still in flight: `onHeartbeat` fires from two 15s sources (node role
  // interval + app ping), and before the connect write lands `presenceWriteDue` would say "due" —
  // without this a slow Mongo gets a second concurrent upsert precisely when it is already slow.
  const lastMachinePresence: PresenceWriteState = { dayKey: null, wroteAt: 0 }
  let machinePresenceInFlight = false
  const touchMachinePresence = (kind: 'connect' | 'heartbeat' | 'close'): void => {
    const now = new Date()
    if (kind === 'heartbeat' && (machinePresenceInFlight || !presenceWriteDue(lastMachinePresence, now, MACHINE_PRESENCE_WRITE_MS))) return
    machinePresenceInFlight = true
    touchMachineOnlineDay(userId, machineId, now, { isNewConnection: kind === 'connect', countryCode })
      .then(() => { lastMachinePresence.dayKey = utcDayKey(now); lastMachinePresence.wroteAt = now.getTime() })
      .catch((err) => logger.warn('machine presence tracking failed', { machineId, kind, error: String(err) }))
      .finally(() => { machinePresenceInFlight = false })
  }
  // Same shape for the person behind the app: `open` bypasses the interval the way `connect` does
  // above, `ping` is rate-floored. `userId` is the machine's owner — the only person a desktop app
  // on this computer can be signed in as. The row is keyed by THIS machine too, so the same person
  // on a second computer lands in a second row rather than in this one.
  const lastUserPresence: PresenceWriteState = { dayKey: null, wroteAt: 0 }
  let userPresenceInFlight = false
  let lastUserOpenAt = 0
  const touchUserPresence = (kind: 'open' | 'ping'): void => {
    const now = new Date()
    if (kind === 'ping' && (userPresenceInFlight || !presenceWriteDue(lastUserPresence, now, USER_PRESENCE_WRITE_MS))) return
    if (kind === 'open') {
      if (now.getTime() - lastUserOpenAt < USER_PRESENCE_OPEN_MS) return
      lastUserOpenAt = now.getTime()
    }
    userPresenceInFlight = true
    touchUserOnlineDay(userId, machineId, now, { isNewConnection: kind === 'open' })
      .then(() => { lastUserPresence.dayKey = utcDayKey(now); lastUserPresence.wroteAt = now.getTime() })
      .catch((err) => logger.warn('user presence tracking failed', { machineId, userId, kind, error: String(err) }))
      .finally(() => { userPresenceInFlight = false })
  }

  // The node role — down subscription, presence, `__clients` resync, node_status — is shared with
  // every other backer of a machine and lives in nodeRole.ts. Only the delivery and teardown are
  // adapter-specific, so only those are passed in.
  const role = await attachNodeRole({
    machineId,
    owner: 'remote',
    offlineReason: 'remote computer offline',
    deliver: (msg) => {
      if (ws.readyState !== WebSocket.OPEN) return
      send({ t: 'down', connId: msg.connId, frame: msg.frame })
      // `machine_revoked` used to be pushed and nothing more, leaving the socket open and the machine
      // still serving if the client ignored it — an old CLI, a dropped frame. Close it ourselves right
      // after the send so revocation does not depend on the client cooperating. Same shape as
      // onBillingSuspended below; the close must happen HERE rather than in MachineService because the
      // socket may live on another backend instance, reachable only through the Redis fan-out.
      if ((msg.frame as { type?: string } | undefined)?.type === 'machine_revoked') {
        try { ws.close(4004, 'machine revoked') } catch { /* ignore */ }
      }
    },
    onBillingSuspended: () => {
      // Close the live machine session WITHOUT revoking its saved token: the adapter's normal retry
      // loop then receives HTTP 402 until billing is restored, and reconnects by itself afterwards.
      try { ws.close(4003, 'subscription required') } catch { /* ignore */ }
    },
    onHeartbeat: () => {
      if (computerId) void claimMachineOwner(machineId, computerId, PRESENCE_TTL_SEC) // renew the one-computer claim
      // Same tick renews the app-state key, so it shares presence's TTL and can never outlive it.
      if (appState) void setMachineAppState(machineId, appState.engine, appState.state, PRESENCE_TTL_SEC)
      touchMachinePresence('heartbeat') // throttled inside — see MACHINE_PRESENCE_WRITE_MS
    },
  })
  touchMachinePresence('connect')
  const terminalDownUnsub = await subscribeTerminalDown(machineId, (packet) => {
    // Terminal input toward the adapter is 'must': dropping keystrokes is not recoverable client-side.
    guardedSend(ws, packet, 'must', { machineId, kind: 'adapter' })
  })

  // Liveness. The previous implementation pinged every 25 s and terminated on a single missed PONG —
  // and counted pongs only, so an adapter that was actively sending application traffic could still
  // be killed if one pong went missing. `trackSocketLiveness` counts message/ping/pong against a time
  // deadline instead, which is the same fix already applied to the hub's own sockets.
  const releaseLiveness = trackSocketLiveness(ws)

  onMessage = (raw: RawData, isBinary: boolean): void => {
    if (isBinary) {
      const hop = decodeTerminalHop(new Uint8Array(raw as Buffer))
      if (!hop || hop.direction !== TerminalHopDirection.up
        || (hop.kind !== TerminalBinaryKind.output && hop.kind !== TerminalBinaryKind.keyframe
          && hop.kind !== TerminalBinaryKind.sync)
        || !terminalRate.allow(
          hop.kind === TerminalBinaryKind.output
            ? 'terminal_output'
            : hop.kind === TerminalBinaryKind.keyframe ? 'terminal_keyframe' : 'terminal_sync',
          hop.clientFrame.length,
        )) return
      void publishTerminalUp(machineId, Buffer.from(raw as Buffer))
      return
    }
    let env: AdapterFrame
    try { env = JSON.parse(raw.toString()) as AdapterFrame } catch { return }
    if (env.t === 'ping') {
      role.touch() // refreshes presence and renews the machine claim
      return
    }
    if (env.t === 'up' && env.frame) {
      const terminalType = env.frame.type as string | undefined
      if (typeof terminalType === 'string' && terminalType.startsWith('terminal_')) {
        if (!TERMINAL_UP_TYPES.has(terminalType)) return
        const bytes = terminalFrameBytes(env.frame)
        if (!env.targetConnId || bytes > TERMINAL_ENVELOPE_MAX_BYTES
          || !isEncryptedTerminalFrame(env.frame) || !terminalRate.allow(terminalType, bytes)) return
        void publishUp(machineId, {
          webEligible: true,
          commanderEligible: false,
          targetConnId: env.targetConnId,
          targetKind: 'web',
          frame: env.frame,
        })
        return
      }
      if (typeof terminalType === 'string' && terminalType.startsWith('p2p_')) {
        const bytes = p2pFrameBytes(env.frame)
        if (!P2P_UP_TYPES.has(terminalType) || !env.targetConnId
          || !terminalP2pPolicy(userId, machineId).enabled
          || bytes > P2P_SIGNAL_MAX_BYTES || !isEncryptedP2pFrame(env.frame)
          || !p2pSignalRate.allow(bytes)) return
        void publishUp(machineId, {
          webEligible: true,
          commanderEligible: false,
          targetConnId: env.targetConnId,
          targetKind: 'web',
          frame: env.frame,
        })
        return
      }
      // Desktop-app presence. Handled in full here and NEVER falls through to the generic publish:
      // the eligibility flags are forced false locally rather than trusted from the frame, so no
      // adapter can fan an unknown frame type out to web clients or devices. Validated against a
      // closed vocabulary so an arbitrary string can never reach the enum the firmware parses.
      // Unchanged values are suppressed (the heartbeat keeps the TTL alive), which caps a chatty
      // adapter at the heartbeat rate.
      const app = env.frame as { type?: string; payload?: { engine?: unknown; state?: unknown } }
      if (app.type === 'machine_app_status') {
        const engine = typeof app.payload?.engine === 'string' ? app.payload.engine : ''
        const state = typeof app.payload?.state === 'string' ? app.payload.state : ''
        if (!APP_ENGINES.has(engine) || !APP_STATES.has(state)) return
        if (appState?.engine === engine && appState.state === state) return
        appState = { engine, state }
        void setMachineAppState(machineId, engine, state, PRESENCE_TTL_SEC)
        void publishUp(machineId, {
          webEligible: false,
          commanderEligible: false,
          frame: { type: 'machine_app_status', payload: { engine, state } } as unknown as Frame,
        })
        return
      }
      // The daemon saying a desktop window is attached to it (cli backendSocket sendAppPresence).
      // Bookkeeping only — absorbed here, never published: no client has any use for it and an
      // unknown frame type must not reach the firmware.
      if (app.type === 'app_presence') {
        const kind = (app.payload as { kind?: unknown } | undefined)?.kind
        if (typeof kind !== 'string' || !APP_PRESENCE_KINDS.has(kind)) return
        touchUserPresence(kind as 'open' | 'ping')
        return
      }
      // Hub tap (mirrors managerWs): keep `machine_agents` in sync from the adapter's agent
      // lifecycle frames. Needed so the device voice path's agent-ownership check
      // (deviceWs: `machineAgent.findFirst`) recognizes remote tmux sessions.
      const f = env.frame as { type?: string; agentId?: unknown; replay?: unknown; payload?: { agent?: unknown; agentId?: unknown; machineId?: unknown } }
      if (f.type === 'agent_synced') {
        void recordCreatedAgent(machineId, f.payload?.agent as { id?: unknown; name?: unknown } | undefined)
      } else if (f.type === 'agent_deleted' && typeof f.payload?.agentId === 'string') {
        // Every producer sends `agentId` (machine-adapter cli.ts, machine-node websocket.ts/agents.ts).
        // Reading `machineId` here meant no deletion was EVER recorded, so machine_agents grew a row per
        // agent forever — and that table is what the plan cap counts.
        void recordDeletedAgent(machineId, f.payload.agentId)
      } else if (f.type === 'turn_started' && f.replay !== true) {
        // Usage signal for machine_daily_presence / agent_daily_presence. Only the plaintext `type`,
        // top-level `agentId` and `replay` (set by the CLI's correlateAgentEvent / emitSessionEvents)
        // are read — the payload is E2EE ciphertext (cli e2ee/core.ts ENCRYPTED_UP_TYPES) and stays
        // opaque here. The CLI already dedupes engines that re-announce one turn (cursor/agy/copilot,
        // cli.ts), so one frame == one turn. `replay: true` is the CLI saying this one did NOT start
        // now — a turn resumed at attach, or a prompt re-read from a transcript already on disk
        // (measured 2026-09-17: 42 such frames in one second credited to one agent). It still relays,
        // it is just not a turn today. A frame with no (or a malformed) agentId has nothing to
        // attribute the turn to and is not counted.
        const now = new Date()
        const agentId = typeof f.agentId === 'string' && TURN_AGENT_ID_RE.test(f.agentId) ? f.agentId : undefined
        if (agentId && allowTurnWrite(now.getTime())) {
          void recordTurnStarted(userId, machineId, agentId, now)
            .catch((err) => logger.warn('turn tracking failed', { machineId, agentId, error: String(err) }))
        }
      }
      if (env.userEligible) {
        void publishUserDeviceE2eePair(userId, machineId, env.frame).catch((err) => {
          logger.warn('adapter user-level e2ee pair publish failed', { machineId, userId, error: String(err) })
        })
        if (env.webEligible === false && env.commanderEligible !== true && !env.targetConnId) return
      }
      // No originPid: the hub's Redis loopback must deliver to this instance's own web clients too
      // (there's no manager-ws local fast-path on this route).
      void publishUp(machineId, {
        webEligible: env.webEligible !== false, // default true (plain event/RPC frames)
        commanderEligible: env.commanderEligible === true, // devices get only opted-in frames
        ...(env.targetConnId ? { targetConnId: env.targetConnId } : {}), // E2EE per-client push
        frame: env.frame,
      })
    }
  }
  // Drain whatever arrived while the role was being attached, in the order it was sent.
  for (const [raw, isBinary] of preHandlerQueue) onMessage(raw, isBinary)
  preHandlerQueue.length = 0

  const cleanup = (): void => {
    releaseLiveness()
    terminalDownUnsub()
    void deskUnsub()
    // Only the CURRENT owner tears the role down — a superseded socket must not mark the fresh
    // connection offline. A superseded socket still releases its own liveness tracking above.
    if (owners.get(machineId) === ws) {
      owners.delete(machineId)
      void role.detach()
      if (computerId) void releaseMachineOwner(machineId, computerId) // free the claim (compare-and-delete)
      // Drop the app claim with the socket. role.detach() already publishes node_status{online:false},
      // and every row builder omits the app keys when offline, so the device converges on that frame;
      // this delete is what stops a reconnect from briefly re-reading the dead value.
      void clearMachineAppState(machineId)
      touchMachinePresence('close') // exact lastSeenAt at disconnect; a superseded socket must not stamp it
      logger.info('adapter disconnected', { machineId })
    }
  }
  ws.on('close', cleanup)
  ws.on('error', cleanup)
}

async function publishUserDeviceE2eePair(userId: string, machineId: string, frame: Frame): Promise<void> {
  const type = frame.type as string | undefined
  if (type !== 'device_e2ee_pair_pending' && type !== 'device_e2ee_pair_cleared') return
  const p = (frame.payload ?? {}) as Record<string, unknown>
  const pairId = typeof p.pairId === 'string' ? p.pairId : ''
  if (!pairId) return

  const machine = await prisma.machine.findUnique({
    where: { machineId },
    select: { name: true },
  })
  const base = {
    machineId,
    machineName: machine?.name ?? null,
    pairId,
    computerFingerprint: typeof p.computerFingerprint === 'string' ? p.computerFingerprint : null,
  }

  if (type === 'device_e2ee_pair_pending') {
    await publishDeviceE2eePair(userId, {
      kind: 'pending',
      ...base,
      label: typeof p.label === 'string' ? p.label : 'Device',
      expiresAt: typeof p.expiresAt === 'number' ? p.expiresAt : Date.now() + 60_000,
    })
    return
  }

  const result = p.result === 'paired' || p.result === 'failed' || p.result === 'cancelled' ? p.result : 'failed'
  await publishDeviceE2eePair(userId, { kind: 'cleared', ...base, result })
}
