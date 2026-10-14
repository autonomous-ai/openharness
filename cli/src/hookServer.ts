import { PRODUCT_FEEDBACK } from './lib/productUsageContract.js'
import { isAppProductUsageReport } from './lib/appProductUsageReport.js'
/**
 * Tiny localhost HTTP server for the Claude Code hook callbacks. `hook/notify.mjs` POSTs here on
 * SessionStart/SessionEnd (127.0.0.1:<PORT>). This replaces the old Fastify routes — the browser
 * UI is gone; only these two endpoints remain local.
 */

import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { admitHook, hooksFor } from './engines/hooks.js'
import { HERMES_HOMES, HERMES_SOURCE } from './engines/hermes/contract.js'
import { readStorePool } from './engines/kit/storePool.js'
import { isInteractiveSource } from './engines/kit/storeSource.js'
import { IdentityReadUnavailable } from './engines/kit/identityScan.js'
import { createPendingAdmissions, type AdmissionDecision } from './core/engines/pendingAdmission.js'
import { paneReadIdentity } from './core/transcripts/readIdentity.js'
import { processIdentityKey } from './lib/terminalRuntime.js'
import { isRecentlyDeleted } from './lib/deletedSessions.js'
import { registry, type RegisterInput, type RegisteredSession } from './lib/registry.js'
import { sid } from './lib/log.js'
import { VERSION } from './version.js'
import { env } from './config/env.js'
import { hookCredentialMatches, loadOrCreateHookCredential } from './lib/hookAuth.js'
import { routeStoreRequest, type StoreHandler } from './lib/storeProxy.js'
import type { HookTerminalHint } from './lib/terminalTypes.js'
import { ENGINES, type AgentEngine } from './engines/types.js'
import { isLoopbackRequest, loopbackHosts } from './lib/loopbackRequest.js'
import { isTrustedLocal, listenLocalSocket, type LocalSocketServer } from './lib/localSocket.js'
import { currentBootId } from './lib/bootId.js'
import { secureStateDirectory } from './lib/secureState.js'
import type { NativeHookClaim, NativeHookDelivery } from './engines/kit/nativeHookJournal.js'
import type { CapturedStop, CapturedStopOutcome, StopHook } from './core/turns/turnHooks.js'
import { openNativeHookStorage, type NativeHookStorage } from './engines/kit/nativeHookStorage.js'
import { createNativeHookReplay } from './engines/kit/nativeHookReplay.js'
import { sendNativeHookRequest } from './engines/kit/nativeHookTransport.js'
import { bundledProcessImageHelper, invalidateProcessImageHelper } from './lib/nativeProcessImages.js'
import { inspectNativeHookOrigin, inspectNativeHookOriginHeader, NATIVE_HOOK_ORIGIN_UNAVAILABLE,
  nativeHookOriginCaller } from './engines/kit/nativeHookOrigin.js'
import { nativeHookAcknowledgement, nativeHookWireIdentity, type NativeHookAcknowledgement,
  type NativeHookWireIdentity } from './engines/kit/nativeHookClientProtocol.js'
import type { NativeHookCaller, NativeHookCallerReader, NativeHookOwner, NativeHookOwnerProof, NativeHookOwnerReader } from './engines/kit/nativeHookOwner.js'

/**
 * Which agent does a hook belong to, given the two grades of evidence?
 *
 * Caller ancestry — the hook's process descends from the engine we registered — is the strong one and
 * always wins. It is not always available: Cursor posts its hooks from outside the pane's process tree,
 * so requiring ancestry rejected every hook that engine ever sent and no session bound at all.
 *
 * Only Cursor may use the weaker runtime evidence: the hook named a pane carrying exactly one Cursor
 * agent, and the caller already proved it can read the 0600 hook credential. Other engines must match
 * ancestry. A delayed hook from an exited Codex process can name a pane now running a NEW Codex
 * session; trusting that pane alone binds the old transcript to the replacement agent.
 * Two candidates is not a tie to break, so we answer nothing.
 */
export function chooseHookAgent<T>(byAncestry: readonly T[], byRuntimeOnly: readonly T[], engine: AgentEngine): {
  agent: T | null
  reason: 'ancestry' | 'runtime' | 'ambiguous' | 'none'
} {
  if (byAncestry.length === 1) return { agent: byAncestry[0], reason: 'ancestry' }
  if (byAncestry.length > 1) return { agent: null, reason: 'ambiguous' }
  if (engine !== 'cursor') return { agent: null, reason: 'none' }
  if (byRuntimeOnly.length === 1) return { agent: byRuntimeOnly[0], reason: 'runtime' }
  return { agent: null, reason: byRuntimeOnly.length ? 'ambiguous' : 'none' }
}

export interface PairOutcome {
  status: number
  body: Record<string, unknown>
}

export interface HookServerHandlers {
  onAutonomousDeviceRequest?: (method: string, target: string, body?: unknown) => Promise<{ status: number; body: unknown }>

  onRegistered: (
    entry: RegisteredSession,
    meta: {
      isNew: boolean
      evicted: string | null
      rebound: string | null
      /** An agent this bind left with no session and no process — see registry.register. */
      orphaned?: { agentId: string; sessionId: string } | null
      hookEvent?: string
    },
  ) => void | Promise<void>

  /** SessionEnd — a reconciliation hint only; it is never process-lifetime authority. */
  onSessionEnd: (sessionId: string, reason: string | undefined) => void
  /** Ensure a matching process-owned agent exists before a hook binds its mutable engine session. */
  resolveHookAgent?: (session: {
    engine: RegisteredSession['engine']
    tmuxPane?: string
    runtimeHints: HookTerminalHint[]
    callerPid?: number
    nativeCaller?: NativeHookCaller
    /** Called once the resolution has to wait for the agent to record its process
     *  (core/engines/hooks.ts): the hook is answered then, before the wait. */
    onWait?: () => void
  }) => Promise<RegisteredSession | null>
  /** A turn is now running (Command Code's PreToolUse — its only live turn-open signal). Idempotent:
   *  it fires once per tool call, and every call after the first in a turn must be a no-op. */
  onTurnStart?: (body: { sessionId: string }) => void
  /** Core lifecycle admission fence; Stop owns the pane before its first asynchronous capture. */
  hookAdmissionBlocked?: (agentId: string) => boolean
  onAdmissionHeld?: (agentId: string, reason: string | undefined) => void
  /** The process's confirmed hook frontier is restored; a held attach can resume. */
  onNativeRecoveryReady?: (entry: RegisteredSession) => void | Promise<void>
  /** An independently bound transcript can be followed without recovering an uncertain hook effect. */
  onNativeTranscriptReady?: (entry: RegisteredSession) => void | Promise<void>
  /** Production supplies precise kernel evidence; fixture-only servers inject their own process resolver. */
  readNativeHookOwner?: NativeHookOwnerReader
  captureNativeHookCaller?: NativeHookCallerReader
  /** Retain an uncorrelated native Stop before attaching a newly admitted conversation. */
  onAdmissionStop?: (entry: RegisteredSession, unmatched: boolean) => boolean
  /** Captured before a same-conversation registration waits; Cancel or forget supersedes that Stop. */
  captureAdmissionStop?: (entry: RegisteredSession) => () => boolean
  /** Snapshot the original turn before admission yields; completion covers the whole Stop effect. */
  captureTurnStop?: (entry: RegisteredSession, body: StopHook) => CapturedStop
  onPromptSubmitted?: (agentId: string, prompt: string) => void
  /** A session's UserPromptSubmit hook, and when its engine ran it (`X-Harness-Hook-Fired-At`): what a Stop
   *  that arrives late is told apart from the turn the prompt opened by (core/turns/turnHooks.ts). */
  onPromptHook?: (sessionId: string, firedAt: number) => void
  onToolStart?: (body: {
    sessionId: string
    toolUseId: string
    toolName: string
    input: unknown
  }) => void
  onTurnStop?: (body: {
    sessionId: string
    status?: string
    transcriptPath?: string
    /** When the engine ran the hook; absent from a hook client too old to say. */
    firedAt?: number
  }) => void
  /** For the end-to-end suite only: how long a Stop hook is held before it is acted on, as the hook's own
   *  verification can take under load (`HARNESSD_TEST_STOP_HOOK_DELAY_MS`). */
  stopHookDelayMs?: number
  /** `harness pair <code>` from a second CLI process: run CPace toward the waiting browser. */
  onPair?: (code: string) => Promise<PairOutcome>
  /** `harness pairings` — list E2EE-paired browsers. */
  onListPairs?: () => PairOutcome | Promise<PairOutcome>
  /** `harness unpair <id>` — unpair one browser (by fingerprint/prefix/index). */
  onRevoke?: (id: string) => PairOutcome | Promise<PairOutcome>
  /** `harness unpair --all` — unpair every browser. */
  onRevokeAll?: () => PairOutcome | Promise<PairOutcome>
  /** `harness remote-password set` — stretch + persist a new persistent remote password on the
   *  running daemon's live E2EE state. */
  onSetRemotePassword?: (password: string) => Promise<PairOutcome>
  /** `harness remote-password clear` — remove the persistent remote password. */
  onClearRemotePassword?: () => PairOutcome | Promise<PairOutcome>
  /** `harness remote-password status` — whether one is set, and its fingerprint. */
  onRemotePasswordStatus?: () => PairOutcome | Promise<PairOutcome>
  /** `harness link connect` — the machine this one just linked pinned it back, so trust that machine
   *  here too (the mutual half of the link). Goes through the daemon: it holds paired.json in memory. */
  onTrustLinkedPeer?: (peer: { pub: string; machineId: string; label: string }) => PairOutcome | Promise<PairOutcome>
  /** `harness group list|sync|remove` — the trust group this machine belongs to (groupSyncer.ts). */
  onGroupList?: () => PairOutcome | Promise<PairOutcome>
  onGroupSync?: () => PairOutcome | Promise<PairOutcome>
  onGroupRemove?: (selector: string) => PairOutcome | Promise<PairOutcome>
  /** `harness devices list|remove|rebaseline` and the window's Devices list — the account's device key
   *  log as this machine verified it (lib/e2ee/deviceLogSyncer.ts). */
  onDevicesList?: () => Promise<PairOutcome>
  onDevicesRemove?: (pub: string) => Promise<PairOutcome>
  onDevicesRebaseline?: (confirm: boolean, head?: { seq: number; hash: string }) => Promise<PairOutcome>
  /** `harness devices history` and the window's History — every add and remove, as this machine verified it. */
  onDevicesHistory?: () => Promise<PairOutcome>
  /** `harness devices dismiss` and the window's "It's mine" / "Got it" — mark new devices as seen. */
  onDevicesDismiss?: (body: { pub?: string; pubs?: string[]; baseline?: boolean }) => PairOutcome | Promise<PairOutcome>
  /** The daemon's status (GET /api/status): what `harness status`, the desktop's discovery and scripts read. */
  onStatus?: () => Record<string, unknown> | Promise<Record<string, unknown>>
  /** GET /api/machines — proxy the user's full machine list from backend using this daemon's own
   *  saved SSO session, so a local GUI client never needs a token of its own. */
  onMachinesList?: () => Promise<PairOutcome>
  /** PATCH /api/machines/:machineId — proxy a rename to backend the same way. */
  onMachineRename?: (machineId: string, name: string) => Promise<PairOutcome>
  /** DELETE /api/machines/:machineId — proxy a delete to backend the same way. */
  onMachineDelete?: (machineId: string) => Promise<PairOutcome>
  /** GET /api/auth/me — proxy the signed-in user's profile from backend. */
  onAuthMe?: () => Promise<PairOutcome>
  /** POST /api/auth/handoff — a one-time code that signs a phone in to this account (the desktop's
   *  Add Phone QR), minted by backend against this daemon's own session. */
  onAuthHandoff?: () => Promise<PairOutcome>
  onSharedHarnesses?: () => Promise<PairOutcome>
  /** GET /api/desk — the account's tabs, the same on every computer; proxied like the machine list. */
  onDeskRead?: () => Promise<PairOutcome>
  /** POST /api/desk/ops — the window's tab edits, applied on the backend (its routes/desk.ts); a
   *  local write, so CSRF-guarded like a rename. */
  onDeskOps?: (body: unknown) => Promise<PairOutcome>
  /** GET /api/agent-messages — the account's tabs and who is in each (docs/design/2026-10-10-agent-messages.md),
   *  proxied like the desk without starting the experiment's process. An older window draws each tab's chat icon
   *  from its flag, which no daemon reads now: the account's experiment decides (lib/agentSettings.ts). */
  onAgentMessagesRead?: () => Promise<PairOutcome>
  /** PATCH /api/agent-messages/tabs/:tabId — an older window's tab switch, passed to the backend so it gets the
   *  answer it expects, and deciding nothing; a local write, so CSRF-guarded like the desk's ops. */
  onAgentMessagesWrite?: (tabId: string, body: unknown) => Promise<PairOutcome>
  /** GET/PATCH /api/agent-settings — what the person lets agents do (lib/agentSettings.ts): the account's experiments
   *  as this computer keeps them, and a change written through to the account (`harness settings`, and an older
   *  window's Settings ▸ Agents). The write is CSRF-guarded like the others. */
  onAgentSettingsRead?: () => Promise<PairOutcome>
  onAgentSettingsWrite?: (body: unknown) => Promise<PairOutcome>
  /** The account's Experimental switches, proxied with the daemon's own identity; what they say of agents is kept
   *  here too (core/experiments.ts `createAgentSettingsSync`). */
  onExperimentalRead?: () => Promise<PairOutcome>
  onExperimentalWrite?: (body: unknown) => Promise<PairOutcome>
  onProductFeedback?: (body: unknown) => Promise<PairOutcome>
  onProductUsageReport?: (body: unknown) => Promise<PairOutcome>
  onProductUsageRead?: () => Promise<PairOutcome>
  onProductUsageWrite?: (body: unknown) => Promise<PairOutcome>
  /** /api/store/* — proxy the Harness Store's ratings and reviews to backend the same way: reads
   *  ungated like the machine list, writes (PUT/DELETE) CSRF-guarded like a rename. See storeProxy.ts. */
  onStore?: StoreHandler
}

export { STORE_PATH_RE } from './lib/storeProxy.js'

const MAX_HOOK_BODY_BYTES = 256 * 1024
const HOOK_BODY_FIELDS = new Set([
  'engine', 'launcherId', 'sessionId', 'transcriptPath', 'cwd', 'source', 'tmuxPane', 'title', 'model',
  'cliVersion', 'runtimeHints', 'callerPid', 'hookEvent', 'pluginVersion', 'reason', 'status', 'toolUseId',
  'toolName', 'input', 'prompt', 'nativeOrigin',
])

function optionalBoundedString(value: unknown, max: number): boolean {
  return value === undefined || value === null || (typeof value === 'string'
    && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value))
}

function optionalBoundedJson(value: unknown, max: number): boolean {
  if (value === undefined) return true
  try { return Buffer.byteLength(JSON.stringify(value)) <= max } catch { return false }
}

/**
 * When the engine ran a hook: the hook process's own start (hook/notify.mjs sends it as a header, which a
 * daemon that does not read it ignores, where an unknown body field is refused). Undefined from a client too
 * old to say. Not the hook's arrival: under load a hook reached the daemon seconds after its engine had
 * moved on to the next prompt (found by the soak run, e2e/endurance.e2e.ts).
 */
export function hookFiredAt(req: Pick<http.IncomingMessage, 'headers'>): number | undefined {
  const value = Number(req.headers['x-harness-hook-fired-at'])
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function validHookBody(value: unknown): value is BoundHookBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const body = value as Record<string, unknown>
  if (body.prompt !== undefined && (typeof body.prompt !== 'string' || Buffer.byteLength(body.prompt) > 128 * 1024)) return false
  if (!optionalBoundedJson(body.nativeOrigin, 8_192)) return false
  if (Object.keys(body).some((field) => !HOOK_BODY_FIELDS.has(field))) return false
  if (body.engine !== undefined && (typeof body.engine !== 'string' || !ENGINES.includes(body.engine as AgentEngine))) return false
  if (!optionalBoundedString(body.launcherId, 200)
    || !optionalBoundedString(body.sessionId, 200)
    || !optionalBoundedString(body.transcriptPath, 4_096)
    || !optionalBoundedString(body.cwd, 4_096)
    || !optionalBoundedString(body.source, 1_000)
    || !optionalBoundedString(body.tmuxPane, 32)
    || !optionalBoundedString(body.title, 1_000)
    || !optionalBoundedString(body.model, 200)
    || !optionalBoundedString(body.cliVersion, 200)
    || !optionalBoundedString(body.hookEvent, 100)
    || !optionalBoundedString(body.pluginVersion, 100)
    || !optionalBoundedString(body.reason, 500)
    || !optionalBoundedString(body.status, 100)
    || !optionalBoundedString(body.toolUseId, 200)
    || !optionalBoundedString(body.toolName, 200)
    || !optionalBoundedJson(body.input, 128 * 1024)) return false
  if (body.callerPid !== undefined
    && (!Number.isSafeInteger(body.callerPid) || (body.callerPid as number) <= 0)) return false
  if (body.runtimeHints !== undefined) {
    if (!Array.isArray(body.runtimeHints) || body.runtimeHints.length > 4) return false
    for (const value of body.runtimeHints) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      const hint = value as Record<string, unknown>
      if (hint.backend === 'tmux') {
        if (Object.keys(hint).some((field) => field !== 'backend' && field !== 'paneId')
          || typeof hint.paneId !== 'string' || !/^%\d+$/.test(hint.paneId)) return false
      } else if (hint.backend === 'herdr') {
        // A hook script installed by an earlier build still sends these from inside a Herdr pane. The
        // backend is retired and `normalizedRuntimeHints` drops the hint, but the rest of the body is
        // still good evidence, so the shape stays accepted rather than failing the whole request.
        if (Object.keys(hint).some((field) => !['backend', 'paneId', 'sessionName', 'socketPath'].includes(field))
          || !optionalBoundedString(hint.paneId, 200) || !hint.paneId
          || !optionalBoundedString(hint.sessionName, 64)
          || !optionalBoundedString(hint.socketPath, 4_096)) return false
      } else return false
    }
  }
  return true
}

function readBody(req: http.IncomingMessage, exact = false, maximum = MAX_HOOK_BODY_BYTES): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    let bytes = 0
    let oversized = false
    let buffers: Buffer[] = []
    if (!exact) req.setEncoding('utf8')
    req.on('data', (chunk: string | Buffer) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > maximum) { oversized = true; data = ''; buffers = []; return }
      if (exact) buffers.push(Buffer.from(chunk))
      else data += chunk
    })
    req.on('end', () => {
      try { resolve(oversized ? '' : exact ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(buffers)) : data) }
      catch { resolve('') }
    })
    req.on('error', () => resolve(''))
  })
}

function normalizedRuntimeHints(body: RegisterInput): HookTerminalHint[] {
  const hints: HookTerminalHint[] = []
  if (Array.isArray(body.runtimeHints) && body.runtimeHints.length <= 4) {
    for (const hint of body.runtimeHints) {
      if (hint?.backend === 'tmux' && /^%\d+$/.test(hint.paneId)) hints.push({ backend: 'tmux', paneId: hint.paneId })
    }
  }
  if (body.tmuxPane && /^%\d+$/.test(body.tmuxPane)
    && !hints.some((hint) => hint.backend === 'tmux' && hint.paneId === body.tmuxPane)) {
    hints.push({ backend: 'tmux', paneId: body.tmuxPane })
  }
  return hints
}

type BoundHookBody = RegisterInput & {
  nativeOrigin?: unknown
  prompt?: string
  sessionId?: string
  reason?: string
  status?: string
  toolUseId?: string
  toolName?: string
  input?: unknown
}

function legacyHookBody(input: unknown, originHeader: unknown): BoundHookBody | null {
  if (!validHookBody(input)) return null
  if (originHeader === undefined) return input
  if (input.nativeOrigin !== undefined) return null
  try {
    const nativeOrigin = inspectNativeHookOriginHeader(originHeader)
    return nativeOrigin.callerPid === input.callerPid ? { ...input, nativeOrigin } : null
  } catch { return null }
}

async function verifiedBoundMutation(
  body: BoundHookBody,
  handlers: HookServerHandlers,
  nativeCaller?: NativeHookCaller,
): Promise<RegisteredSession | null> {
  if (!body.sessionId || !body.engine) return null
  const initial = registry.bySession(body.sessionId)
  if (!initial || initial.engine !== body.engine) return null
  const identity = paneReadIdentity(initial)
  const runtimeHints = normalizedRuntimeHints(body)
  if (!runtimeHints.length) return null
  const processAgent = handlers.resolveHookAgent
    ? await handlers.resolveHookAgent({
      engine: body.engine,
      tmuxPane: body.tmuxPane,
      runtimeHints,
      callerPid: Number.isSafeInteger(body.callerPid) && body.callerPid! > 0 ? body.callerPid : undefined,
      nativeCaller,
    })
    : body.tmuxPane ? registry.byPaneEngine(body.tmuxPane, body.engine) ?? null : null
  return processAgent?.engine === body.engine && processAgent.sessionId === body.sessionId
    && processAgent.agentId === initial.agentId && paneReadIdentity(processAgent) === identity
    && paneReadIdentity(registry.byAgent(initial.agentId)) === identity
    ? registry.byAgent(initial.agentId)!
    : null
}

/**
 * Bind the localhost hook server on a FIXED `port` (no OS free-port fallback — a random fallback made
 * a leftover daemon un-findable by `lsof :<port>`). Rejects with EADDRINUSE if the port is taken (the
 * CLI reports it as "another adapter already running"). Resolves with the bound port.
 */
function admissionProcessScope(session: RegisteredSession | undefined): string | undefined {
  if (!session?.active) return undefined
  return session.processIdentity ? processIdentityKey(session.engine, session.processIdentity) : session.agentId
}

/** A failed native correction is incomplete evidence, never the original announcement. */
export function knownTranscriptFor(body: RegisterInput, agent: RegisteredSession | undefined): string | undefined {
  return hooksFor(body.engine ?? 'claude')?.transcriptFor?.(body, agent) ?? body.transcriptPath
}

/** Read source evidence without binding. Unreadable stores never authorize a conversation. */
async function inspectHermesKind(sessionId: string, knownHome?: string): Promise<AdmissionDecision<string | undefined>> {
  if (!HERMES_SOURCE.id.test(sessionId)) return { kind: 'accept', value: undefined }
  try {
    const found = await readStorePool(HERMES_HOMES, env.HERMES_HOME, {
      sql: HERMES_SOURCE.query, params: [sessionId], maxRows: 1, maxBuffer: HERMES_SOURCE.maxBuffer,
      columns: ['id', 'source'], pointKey: 'id', knownHome,
    })
    if (!found.length) return { kind: 'hold', reason: 'Waiting for the Hermes session source record; keeping the current conversation.' }
    if (found.length !== 1) return { kind: 'hold', reason: 'Hermes session source is ambiguous across homes; keeping the current conversation.' }
    const { home, aliases, row } = found[0]
    if (knownHome && !aliases.includes(knownHome)) return { kind: 'hold', reason: 'Waiting for the Hermes source in its known home; keeping the current conversation.' }
    const source = row[HERMES_SOURCE.column]
    if (typeof source !== 'string' || source.length > 128) throw new IdentityReadUnavailable('the Hermes source record is invalid')
    if (!isInteractiveSource(HERMES_SOURCE, source)) return { kind: 'reject', reason: 'hermes_subagent' }
    return { kind: 'accept', value: knownHome ?? (home === env.HERMES_HOME ? undefined : home) }
  } catch (error) {
    if (!(error instanceof IdentityReadUnavailable)) throw error
    return { kind: 'hold', reason: `Hermes session source is unavailable; keeping the current conversation. ${error.message}` }
  }
}

export interface HookServerOptions {
  /** Also serve on this Unix socket (see lib/localSocket.ts). Null or absent: TCP only. */
  socketPath?: string | null
  /** A private socket identifies this user's daemon even when another OS user holds the TCP port. */
  allowPortFallback?: boolean
  /** Completed acknowledgements are retained for a live process, never evicted to admit another hook. */
  admissionReceiptCapacity?: number
  /** Bound native payload and provenance retained by pending admission or linked Stop. */
  admissionBytesCapacity?: number
  /** Production starts recovery only after the core readiness announcement. */
  deferNativeRecovery?: boolean
  /** The installed client has no outbox. Enable replay only with durable client activation. */
  nativeClientReplay?: boolean
}

export function startHookServer(
  port: number,
  handlers: HookServerHandlers,
  options: HookServerOptions = {},
): Promise<{ server: http.Server; port: number; localSocket: LocalSocketServer | null; startRecovery(): void;
  stopRecovery(): void; drainAndStopRecovery(): Promise<void>; recoveryReady(row: RegisteredSession): boolean;
  transcriptReady(row: RegisteredSession): boolean }> {
  const hookCredential = loadOrCreateHookCredential(env.ADAPTER_DATA_DIR)
  const admissions = createPendingAdmissions({ isProcessCurrent: (key, scope) => admissionProcessScope(registry.byAgent(key)) === scope })
  let admissionArrival = 0
  const admissionHolds = new Map<string, Map<string, string>>()
  const recoveryHolds = new Map<string, string>()
  type StopAcknowledgement = { status: number; reply: unknown }
  type LinkedStop = (body: BoundHookBody, firedAt: number | undefined) => StopAcknowledgement | Promise<StopAcknowledgement>
  type PreparingIntake = { body: BoundHookBody; firedAt?: number; arrival: number; wire?: NativeHookWireIdentity; attempted: boolean }
  type Receipt = { fingerprint: string; status: number; reply: unknown; pending: boolean; bytes: number; linkedStop?: LinkedStop;
    legacyOwner?: { agentId: string; scope: string };
    legacyCapture?: Promise<unknown>;
    preparing?: { stopEffect?: CapturedStop; stopCurrent?: () => boolean; intake?: PreparingIntake } }
  const admissionReceipts = new Map<string, { scope: string; records: Map<string, Receipt> }>()
  const legacyStops = new Map<string, Receipt>(), legacyStopRetries = new Map<string, () => void>()
  let runningLegacyStops = 0
  const resolvingStops = new Map<string, { fingerprint: string; stop: LinkedStop }>()
  let receiptCount = 0, receiptBytes = 0
  const intakeReservations = new Set<string>()
  const saveReceipt = (records: Map<string, Receipt>, id: string, next?: Receipt) => {
    const before = records.get(id)
    if (before) { receiptCount--; receiptBytes -= before.bytes }
    if (next) { records.set(id, next); receiptCount++; receiptBytes += next.bytes }
    else records.delete(id)
  }
  const receiptCapacity = options.admissionReceiptCapacity ?? 65_536
  const bytesCapacity = options.admissionBytesCapacity ?? 16 * 1024 * 1024
  let closed = false, quiescing = false, boot: string | undefined
  const terminalWrites = new Set<Promise<void>>()
  const finishTerminal = (claim: NativeHookClaim, result: Record<string, unknown>) => {
    const writing = claim.finish(result)
    terminalWrites.add(writing)
    void writing.then(() => terminalWrites.delete(writing), () => terminalWrites.delete(writing))
    return writing
  }
  const durableDirectory = join(env.ADAPTER_DATA_DIR, 'native-hook-deliveries')
  type Journal = Awaited<ReturnType<NativeHookStorage['effects']>>
  let nativeStorage: NativeHookStorage | undefined
  let openingStorage: Promise<NativeHookStorage> | undefined
  let closingStorage: Promise<void> | undefined
  const storage = (): Promise<NativeHookStorage> => {
    if (closed) return Promise.reject(new IdentityReadUnavailable('native hook storage is closed'))
    if (nativeStorage) return Promise.resolve(nativeStorage)
    return openingStorage ??= (async () => {
      secureStateDirectory(durableDirectory)
      const opened = await openNativeHookStorage(durableDirectory, {
        prepare: () => bundledProcessImageHelper({ retryUnavailable: true }), invalidate: invalidateProcessImageHelper,
      })
      nativeStorage = opened
      if (closed) throw new IdentityReadUnavailable('native hook storage closed during opening')
      return opened
    })().finally(() => { openingStorage = undefined })
  }
  const closeStorage = () => closingStorage ??= (async () => {
    const opened = nativeStorage ?? await openingStorage?.catch(() => undefined)
    await (opened ?? nativeStorage)?.close()
  })().catch(error => { closingStorage = undefined; throw error })
  type DurableProcess = { key: string; journal: Journal; restored: Set<string>; claims: Map<string, NativeHookClaim>;
    ready: boolean; confirming: number; owner?: NativeHookOwner;
    transcript?: { identity: string; verify(): void } }
  const durableProcesses = new Map<string, DurableProcess>()
  const openingProcesses = new Map<string, Promise<DurableProcess>>()
  const nativeKeys = new Map<string, string>()
  const waitingAttaches = new Set<string>()
  const waitingTranscripts = new Set<string>()
  const admissionHeld = (agentId: string, reason: string | undefined) => {
    try { handlers.onAdmissionHeld?.(agentId, reason) }
    catch (error) { console.warn('[hooks] admission status notification failed', error) }
  }
  const publishHold = (agentId: string) => admissionHeld(agentId,
    [...admissionHolds.get(agentId)?.values() ?? []].at(-1) ?? recoveryHolds.get(agentId))
  const recoveryHeld = (agentId: string, reason: string | undefined) => {
    if (reason) recoveryHolds.set(agentId, reason)
    else if (!recoveryHolds.delete(agentId)) return
    publishHold(agentId)
  }
  const durableKey = (row: RegisteredSession): string => {
    if (!row.processIdentity) throw new IdentityReadUnavailable('the original native process identity is unavailable')
    if (handlers.readNativeHookOwner) {
      const key = nativeKeys.get(processIdentityKey(row.engine, row.processIdentity))
      if (!key) throw new IdentityReadUnavailable('the precise native process incarnation has not been restored')
      return key
    }
    boot ??= currentBootId()
    if (boot.startsWith('time:')) { boot = undefined; throw new IdentityReadUnavailable('the kernel boot identity is unavailable') }
    return `${boot}\u0000${processIdentityKey(row.engine, row.processIdentity)}`
  }
  const durableProcess = async (row: RegisteredSession, native?: NativeHookOwnerProof): Promise<DurableProcess> => {
    if (native) {
      native.verify()
      nativeKeys.set(processIdentityKey(row.engine, row.processIdentity!), native.key)
    }
    const key = durableKey(row), known = durableProcesses.get(key)
    const verify = (context: DurableProcess) => {
      native?.verify()
      if (closed) throw new IdentityReadUnavailable('native hook recovery is closed')
      if (native && context.owner?.evidence !== native.evidence) throw new IdentityReadUnavailable('the native process image changed')
      return context
    }
    if (known) return verify(known)
    const opening = openingProcesses.get(key)
    if (opening) return verify(await opening)
    if (durableProcesses.size + openingProcesses.size >= 256) throw new IdentityReadUnavailable('native hook process recovery is at capacity')
    const current = () => !closed && registry.list().some(candidate => candidate.active && candidate.processIdentity
      && (handlers.readNativeHookOwner ? nativeKeys.get(processIdentityKey(candidate.engine, candidate.processIdentity))
        : `${boot}\u0000${processIdentityKey(candidate.engine, candidate.processIdentity)}`) === key)
    const pending = (async (): Promise<DurableProcess> => {
      const opened = await storage()
      native?.verify()
      if (!current()) throw new IdentityReadUnavailable('the original native process changed while opening storage')
      const journal = await opened.effects(key, current)
      try {
        native?.verify()
        if (!current()) throw new IdentityReadUnavailable('the original native process changed during allocation')
        const context = { key, journal, restored: new Set<string>(), claims: new Map<string, NativeHookClaim>(), ready: false, confirming: 0,
          ...(native ? { owner: { key: native.key, evidence: native.evidence } } : {}) }
        durableProcesses.set(key, context)
        return context
      } catch (error) { journal.close(); throw error }
    })()
    openingProcesses.set(key, pending)
    try { return verify(await pending) } finally { openingProcesses.delete(key) }
  }
  const ready = (context: DurableProcess, value: boolean) => {
    // A legacy client may have exited before the first journal snapshot. Its
    // bounded local request still needs intake even when the journal is empty.
    const waiting = value && registry.list().some(row => {
      const history = admissionReceipts.get(row.agentId)
      try { return durableKey(row) === context.key && history && history.scope === scopeOf(row)
        && [...history.records.values()].some(receipt => receipt.preparing?.intake) }
      catch { return false }
    })
    context.ready = value && !closed && !quiescing && !waiting
    if (!context.ready) { recovered.delete(context.key); return }
    recovered.add(context.key)
    for (const row of registry.list()) {
      try { if (durableKey(row) === context.key) recoveryHeld(row.agentId, undefined) } catch { /* Independent owner. */ }
    }
    for (const agentId of waitingAttaches) {
      const row = registry.byAgent(agentId)
      if (!row?.active || !row.processIdentity) { waitingAttaches.delete(agentId); continue }
      try { if (durableKey(row) !== context.key) continue } catch { continue }
      waitingAttaches.delete(agentId)
      try { void Promise.resolve(handlers.onNativeRecoveryReady?.(row)).catch(error => console.warn('[hooks] recovery notification failed', error)) }
      catch (error) { console.warn('[hooks] recovery notification failed', error) }
    }
    notifyTranscripts(context)
  }
  const recoveryReady = (row: RegisteredSession): boolean => {
    if (row.engine === 'terminal') return true
    if (closed || quiescing) return false
    if (!closed && recoveryStarted) {
      try { if (durableProcesses.get(durableKey(row))?.ready) return true } catch { /* This process remains held. */ }
    }
    waitingAttaches.add(row.agentId)
    return false
  }
  const transcriptReady = (row: RegisteredSession): boolean => {
    if (row.engine === 'terminal') return true
    if (closed || quiescing) return false
    if (recoveryStarted) {
      try {
        const context = durableProcesses.get(durableKey(row))
        if (context?.ready) return true
        if (context?.transcript && context.transcript.identity === paneReadIdentity(row)
          && context.transcript.identity === paneReadIdentity(registry.byAgent(row.agentId))) {
          const grant = context.transcript
          grant.verify()
          if (!closed && !quiescing && context.transcript === grant && grant.identity === paneReadIdentity(row)
            && grant.identity === paneReadIdentity(registry.byAgent(row.agentId))) return true
        }
      } catch { /* A changed frontier or unavailable owner must be confirmed again. */ }
    }
    waitingTranscripts.add(row.agentId)
    return false
  }
  const notifyTranscripts = (context: DurableProcess) => {
    for (const agentId of waitingTranscripts) {
      const row = registry.byAgent(agentId)
      if (!row?.active || !row.processIdentity) { waitingTranscripts.delete(agentId); continue }
      try { if (durableKey(row) !== context.key || !transcriptReady(row)) continue } catch { continue }
      waitingTranscripts.delete(agentId)
      try { void Promise.resolve(handlers.onNativeTranscriptReady?.(row)).catch(error => console.warn('[hooks] transcript notification failed', error)) }
      catch (error) { console.warn('[hooks] transcript notification failed', error) }
    }
  }
  const restoreDeliveryOrder = (context: DurableProcess, row: RegisteredSession, deliveries: ReadonlyMap<string, NativeHookDelivery>) => {
    for (const [id, delivery] of deliveries) {
      const result = delivery.result
      if (!result) continue
      if (result.accepted === true) {
        admissions.restore(row.agentId, delivery.intake.conversationId, {
          scope: admissionProcessScope(row) ?? row.agentId, firedAt: delivery.intake.firedAt, arrival: Number(result.arrival) || 0,
        })
        if (!context.restored.has(id) && delivery.intake.firedAt && delivery.intake.payload.hookEvent === 'UserPromptSubmit') {
          handlers.onPromptHook?.(delivery.intake.conversationId, delivery.intake.firedAt)
        }
      }
      context.restored.add(id)
    }
  }
  const confirmedSnapshot = async (context: DurableProcess, row: RegisteredSession, ownerVerified?: (verify: () => void) => void) => {
    const identity = paneReadIdentity(row)
    let verifyOwner: (() => void) | undefined
    ready(context, false)
    context.confirming++
    try {
    const snapshot = await context.journal.snapshot()
    // Visible bytes can be the last write of a crashed publisher. Restore
    // control facts only after both copies and the namespace are durable.
    await snapshot.confirm()
    if (handlers.readNativeHookOwner) {
      if (!context.owner) throw new IdentityReadUnavailable('the original native process evidence is unavailable')
      for (const delivery of snapshot.deliveries.values()) {
        if (delivery.intake.owner?.key !== context.owner.key || delivery.intake.owner.evidence !== context.owner.evidence) {
          throw new IdentityReadUnavailable('the retained native hook process evidence changed or is missing')
        }
      }
      const native = await handlers.readNativeHookOwner(row, context.owner)
      native.verify()
      verifyOwner = native.verify
      ownerVerified?.(native.verify)
    }
    snapshot.verify()
    const owner = registry.byAgent(row.agentId)
    if (closed || quiescing || !owner?.active || durableKey(owner) !== context.key) {
      throw new IdentityReadUnavailable('the native hook recovery owner changed')
    }
    restoreDeliveryOrder(context, row, snapshot.deliveries)
    ready(context, !snapshot.active && [...snapshot.deliveries.values()].every(delivery => delivery.result))
    context.transcript = undefined
    if (snapshot.active && context.claims.get(snapshot.active.id)?.token !== snapshot.active.token
      && context.journal.pendingClaim()?.token !== snapshot.active.token) {
      recoveryHeld(row.agentId, 'Waiting for an authoritative outcome of a native hook interrupted by the previous core.')
      // An update can interrupt a prompt registration after this conversation
      // was already bound. The claim stays unknown; it must not prevent the
      // same native process's transcript from advancing ordinary turn state.
      // Require an earlier accepted registration, never client clock order.
      const deliveries = [...snapshot.deliveries.values()]
      const sameBinding = (delivery: NativeHookDelivery) => {
        const body = delivery.intake.payload
        return delivery.intake.agentId === row.agentId && delivery.intake.conversationId === row.sessionId
          && validHookBody(body) && (body.engine ?? 'claude') === row.engine && body.sessionId === row.sessionId
          && (!body.transcriptPath || body.transcriptPath === row.transcriptPath)
          && (!delivery.intake.wire || delivery.intake.wire.path === '/api/hook/session-start')
      }
      const firstPending = deliveries.findIndex(delivery => !delivery.result)
      if (verifyOwner && (row.engine === 'claude' || row.engine === 'codex') && row.sessionId && row.transcriptPath
        && !row.identityHold && identity === paneReadIdentity(registry.byAgent(row.agentId))
        && firstPending > 0 && deliveries.slice(0, firstPending).some(delivery => delivery.result?.accepted === true && sameBinding(delivery))
        && deliveries.slice(firstPending).every(delivery => delivery.result
          || sameBinding(delivery) && delivery.intake.payload.hookEvent === 'UserPromptSubmit')) {
        const owner = verifyOwner
        context.transcript = { identity, verify: () => {
          owner(); snapshot.verify()
          const history = admissionReceipts.get(row.agentId)
          if (context.claims.size || context.journal.pendingClaim()
            || [...intakeReservations].some(key => key.startsWith(`${context.key}\u0000`))
            || history && history.scope === scopeOf(row) && [...history.records].some(([id, receipt]) => receipt.preparing?.intake
              || receipt.pending && !snapshot.deliveries.has(id) || receipt.linkedStop)
            || [...legacyStops.values()].some(receipt => receipt.legacyOwner?.agentId === row.agentId
              && receipt.legacyOwner.scope === admissionProcessScope(row) && receipt.status !== 200)
            || handlers.hookAdmissionBlocked?.(row.agentId)) {
            throw new IdentityReadUnavailable('the transcript is waiting for current native hook intake')
          }
          owner()
        } }
        notifyTranscripts(context)
      }
    }
    return snapshot
    } catch (error) { context.transcript = undefined; throw error }
    finally { context.confirming-- }
  }
  const scopeOf = (row: RegisteredSession | undefined) => row && JSON.stringify([
    row.agentId, row.engine, row.processIdentity ? processIdentityKey(row.engine, row.processIdentity) : null,
    handlers.readNativeHookOwner && row.processIdentity ? nativeKeys.get(processIdentityKey(row.engine, row.processIdentity)) : null,
  ])
  const verifiedMutation = async (body: BoundHookBody, retained?: { caller: NativeHookCaller | undefined },
    confirmed?: (verify: () => void) => void): Promise<RegisteredSession | null> => {
    if (closed || quiescing) return null
    const caller = retained ? retained.caller : await captureCaller(body)
    const owner = await verifiedBoundMutation(body, handlers, caller)
    if (closed || quiescing || !owner) return null
    const identity = paneReadIdentity(owner)
    try {
      const native = await handlers.readNativeHookOwner?.(owner, caller?.owner(owner))
      const context = await durableProcess(owner, native), history = admissionReceipts.get(owner.agentId)
      // A local unfinished admission already denies this mutation. Confirming
      // its journal again competes with the writer and prolongs its hold. This
      // shortcut only refuses; every possible acceptance still needs fresh proof.
      if (context.confirming || context.claims.size
        || history && history.scope === scopeOf(owner) && [...history.records.values()].some(receipt => receipt.pending || receipt.preparing)
        || [...intakeReservations].some(key => key.startsWith(`${context.key}\u0000`))) {
        throw new IdentityReadUnavailable('an earlier native hook has no confirmed outcome')
      }
      let verifyOwner = () => {}
      const snapshot = await confirmedSnapshot(context, owner, verify => { verifyOwner = verify })
      if (snapshot.active || [...snapshot.deliveries.values()].some(delivery => !delivery.result)) {
        throw new IdentityReadUnavailable('an earlier native hook has no confirmed outcome')
      }
      confirmed?.(() => { verifyOwner(); snapshot.verify() })
    } catch (error) {
      const reason = `Waiting for native hook recovery: ${error instanceof Error ? error.message : 'storage unavailable'}`.slice(0, 1024)
      try { const context = durableProcesses.get(durableKey(owner)); if (context) ready(context, false) } catch { /* Not restored yet. */ }
      recoveryHeld(owner.agentId, reason)
      throw new IdentityReadUnavailable(reason)
    }
    return !closed && !quiescing && paneReadIdentity(registry.byAgent(owner.agentId)) === identity ? registry.byAgent(owner.agentId)! : null
  }
  // Filled in once the port is bound: the Host a request must name is the port actually taken.
  let hosts: ReadonlySet<string> = new Set()
  let lastRefusalLogAt = 0
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined, recoveryStarted = false, recoveryCursor = 0
  const recovering = new Set<string>(), recovered = new Set<string>()
  const captureCaller = (body: BoundHookBody) => {
    if (body.nativeOrigin !== undefined) {
      if (!handlers.readNativeHookOwner) throw new IdentityReadUnavailable('the native hook origin verifier is unavailable')
      const origin = inspectNativeHookOrigin(body.nativeOrigin)
      if (origin.callerPid !== body.callerPid) throw new IdentityReadUnavailable('the original native hook caller changed')
      return nativeHookOriginCaller(origin)
    }
    return handlers.captureNativeHookCaller?.(body.callerPid ?? 0,
      body.engine === 'cursor' ? [...new Map(normalizedRuntimeHints(body).flatMap(hint => {
        const row = registry.byRuntimeEngine({ backend: 'tmux', paneId: hint.paneId }, 'cursor')
        return row ? [[row.agentId, structuredClone(row)] as const] : []
      })).values()] : [])
  }
  const retainLegacyStop = async (body: BoundHookBody, id: string, firedAt: number | undefined): Promise<StopAcknowledgement> => {
    if (closed || quiescing) return { status: 202, reply: { pending: false, retry: true, detail: 'Waiting for the daemon to finish stopping.' } }
    const fingerprint = createHash('sha256').update(JSON.stringify([body, firedAt])).digest('hex')
    const previous = legacyStops.get(id)
    if (previous) {
      if (previous.fingerprint !== fingerprint) return { status: 409, reply: { pending: false, error: 'HOOK_DELIVERY_CONFLICT' } }
      await previous.legacyCapture
      const receipt = legacyStops.get(id) ?? previous
      return { status: receipt.status, reply: receipt.reply }
    }
    const owner = body.sessionId ? registry.bySession(body.sessionId) : undefined
    if (!owner?.active || owner.engine !== body.engine || !owner.processIdentity) {
      return { status: 403, reply: { error: 'UNBOUND_HOOK' } }
    }
    for (const [delivery, receipt] of legacyStops) {
      const retained = receipt.legacyOwner!, row = registry.byAgent(retained.agentId)
      if (admissionProcessScope(row) !== retained.scope) {
        legacyStopRetries.delete(delivery); saveReceipt(legacyStops, delivery)
      }
    }
    const bytes = 2 * (JSON.stringify(body).length + JSON.stringify(owner).length) + 2_048
    if (receiptCount >= receiptCapacity || receiptBytes + bytes > bytesCapacity) {
      return { status: 429, reply: { pending: false, error: 'HOOK_ADMISSION_BUSY', detail: 'Hook acknowledgement storage is full; this Stop was not retained.' } }
    }
    const legacyOwner = { agentId: owner.agentId, scope: admissionProcessScope(owner)! }, sessionId = body.sessionId!
    // Capture core turn authority synchronously before native ownership or journal
    // admission waits. No retry may borrow the turn that replaced this one.
    const notCancelled = handlers.captureAdmissionStop?.(owner) ?? (() => true)
    const effect = handlers.captureTurnStop!(structuredClone(owner), { sessionId, status: body.status, firedAt })
    const original = structuredClone(body)
    const caller = (async () => ({ caller: await captureCaller(original) }))().catch(error => ({ error }))
    let running = false, started = false, reported = false
    const current = () => !closed && !quiescing && !isRecentlyDeleted(owner.agentId) && !isRecentlyDeleted(sessionId)
      && admissionProcessScope(registry.byAgent(owner.agentId)) === legacyOwner.scope
      && registry.byAgent(owner.agentId)?.sessionId === sessionId
    const holdKey = `legacy-stop:${id}`
    const hold = (detail: string) => {
      if (!current()) return
      const reply = { pending: false, retry: true, detail: detail.slice(0, 1024) }
      saveReceipt(legacyStops, id, { fingerprint, status: 202, reply, pending: false, bytes, legacyOwner, legacyCapture: caller })
      const holds = admissionHolds.get(owner.agentId) ?? new Map<string, string>()
      if (holds.get(holdKey) !== reply.detail) {
        holds.set(holdKey, reply.detail); admissionHolds.set(owner.agentId, holds); publishHold(owner.agentId)
      }
    }
    const finish = () => {
      legacyStopRetries.delete(id)
      saveReceipt(legacyStops, id, { fingerprint, status: 200, reply: { ok: true, duplicate: true }, pending: false, bytes: 256, legacyOwner })
      const holds = admissionHolds.get(owner.agentId)
      if (holds?.delete(holdKey)) {
        if (!holds.size) admissionHolds.delete(owner.agentId)
        publishHold(owner.agentId)
      }
    }
    let verify: () => void = () => { throw new IdentityReadUnavailable('the original Stop admission is not confirmed') }
    const confirm = async () => {
      const captured = await caller
      if ('error' in captured) throw captured.error
      if (!current()) throw new IdentityReadUnavailable('the original Stop owner changed')
      const fresh = await verifiedMutation(original, captured, proof => { verify = () => {
        if (!current()) throw new IdentityReadUnavailable('the original Stop owner changed')
        proof()
      } })
      if (!fresh || fresh.agentId !== owner.agentId || !current()) throw new IdentityReadUnavailable('the original Stop owner changed')
      verify()
    }
    const attempt = () => {
      if (closed || quiescing || running || runningLegacyStops >= 4) return
      if (!current() || !notCancelled()) { finish(); return }
      legacyStopRetries.delete(id); legacyStopRetries.set(id, attempt)
      running = true; runningLegacyStops++
      void (async () => {
        try {
          if (!started || effect.retryable?.()) {
            await confirm()
            if (!reported) {
              reported = true
              console.log(`[hooks] ${sid(sessionId)} turn-stop${body.status ? ` · status=${body.status}` : ''}`)
              if (handlers.stopHookDelayMs) await new Promise(resolve => setTimeout(resolve, handlers.stopHookDelayMs))
            }
            if (!current() || !notCancelled()) { finish(); return }
            if (handlers.stopHookDelayMs) await confirm()
            if (!notCancelled()) { finish(); return }
            started = true
          }
          const outcome = await effect({ current, verify: () => verify(), confirm })
          if (closed || quiescing) return
          if (outcome === 'completed' || outcome === 'superseded') finish()
          else hold('Waiting for the original Stop turn to be confirmed; Cancel can resolve this hold.')
        } catch (error) {
          if (!notCancelled()) finish()
          else hold(`Waiting for the original Stop admission: ${error instanceof Error ? error.message : 'native evidence unavailable'}`)
        } finally { running = false; runningLegacyStops-- }
      })()
    }
    hold('Waiting for the original Stop admission; this notification is retained only by this core.')
    legacyStopRetries.set(id, attempt); attempt()
    // Replying ends notify.mjs and its short-lived shell on Linux. Keep that
    // ancestry alive for the one original capture; a retry cannot reconstruct it.
    await caller
    const receipt = legacyStops.get(id)
    return receipt ? { status: receipt.status, reply: receipt.reply } : { status: 403, reply: { error: 'UNBOUND_HOOK' } }
  }
  /** A completed phase needs no live engine. This lookup has no allocation or
   * dispatch capability and cannot upgrade a legacy receipt into the v1 protocol. */
  const answerCompletedNativeRegistration = async (body: BoundHookBody, id: string, firedAt: number,
    wire: NativeHookWireIdentity, answer: (status: number, reply: unknown) => void, receipt: NativeHookAcknowledgement,
  ): Promise<boolean> => {
    const origin = inspectNativeHookOrigin(body.nativeOrigin), engine = body.engine ?? 'claude'
    const candidates = [...origin.ancestry, ...(engine === 'cursor' && origin.runtime ? [origin.runtime.process] : [])]
      .map(row => `${origin.boot}\u0000${engine}\u0000${row.pid}\u0000${row.birth}`)
    const deadline = performance.now() + 4500, current = () => !closed && performance.now() < deadline
    const check = () => { if (!current()) throw new IdentityReadUnavailable('native receipt recovery exceeded its deadline') }
    const opened = await storage()
    check()
    const journals = await opened.readEffects(candidates, current)
    try {
      const snapshots: Array<Awaited<ReturnType<Journal['snapshot']>>> = []
      const matches: Array<{ key: string; delivery: NativeHookDelivery }> = []
      for (const [key, journal] of journals) {
        check()
        const snapshot = await journal.snapshot()
        await snapshot.confirm(); check(); snapshot.verify()
        snapshots.push(snapshot)
        const delivery = snapshot.deliveries.get(id)
        if (delivery) matches.push({ key, delivery })
      }
      if (!matches.length) return false
      if (matches.length !== 1) throw new IdentityReadUnavailable('native receipt has ambiguous original namespaces')
      const { key, delivery } = matches[0]!, intake = delivery.intake
      const fingerprint = createHash('sha256').update(JSON.stringify([body, firedAt, wire])).digest('hex')
      // Do not authorize a different body, phase or time from an older intake's
      // terminal flag, even if its visible JSON otherwise appears equivalent.
      if (intake.fingerprint !== fingerprint || intake.firedAt !== firedAt
        || JSON.stringify(intake.wire) !== JSON.stringify(wire)) {
        snapshots.forEach(snapshot => snapshot.verify()); check()
        answer(409, { pending: false, error: 'HOOK_DELIVERY_CONFLICT' }); return true
      }
      if (!delivery.result) return false
      if (intake.owner?.key !== key || intake.conversationId !== (body.sessionId ?? '')
        || typeof delivery.result.accepted !== 'boolean' || typeof delivery.result.status !== 'number' || !delivery.result.reply) {
        throw new IdentityReadUnavailable('the retained native receipt is incomplete')
      }
      snapshots.forEach(snapshot => snapshot.verify()); check()
      answer(200, receipt)
      return true
    } finally { for (const journal of journals.values()) journal.close() }
  }
  const admitStart = async (body: BoundHookBody, native: { firedAt?: number; deliveryId?: string | string[]; arrival?: number;
    recovery?: { agentId: string; key: string; owner?: NativeHookOwner }; wire?: NativeHookWireIdentity },
    respond: (status: number, reply: unknown, ownership?: NativeHookAcknowledgement['outcome']) => void,
  ): Promise<void> => {
    if (closed || quiescing) {
      respond(202, { pending: false, retry: true, detail: 'Waiting for the daemon to finish stopping.' }); return
    }
    // Every rejection below says WHY, out loud. They used to be silent, and a hook that arrives and
    // is dropped looks exactly like a hook that never fired — which is precisely the confusion behind
    // "the agent is running in my terminal but the list does not show it".
    // Answered once: a hook answered before its resolution waited is only logged after it.
    let answered = false
    let ownership: NativeHookAcknowledgement['outcome'] | undefined
    let verifyOwnership: (() => void) | undefined
    const answer = (code: number, reply: unknown): void => {
      if (answered) return
      if (native.wire && ownership) {
        try {
          if (closed || !verifyOwnership) throw new IdentityReadUnavailable('native acknowledgement authority is unavailable')
          verifyOwnership()
        } catch (error) {
          ownership = undefined; code = 202
          reply = { pending: false, retry: true, detail: `Waiting for confirmed native acknowledgement: ${error instanceof Error ? error.message : 'receipt unavailable'}`.slice(0, 1024) }
        }
      }
      answered = true
      respond(code, reply, ownership)
    }
    const ignore = (reason: string): void => {
      console.log(`[hooks] ${sid(body.sessionId ?? '?')} ${body.hookEvent ?? 'session-start'} ignored · ${reason}`)
      answer(200, { ignored: true, reason })
    }
    const runtimeHints = normalizedRuntimeHints(body)
    if (!runtimeHints.length) { ignore('not_in_terminal'); return }
    // A plugin/extension is loaded ONCE per engine process, so a pane opened before an update keeps
    // running the old copy — silently, and for hours. Measured on amp: a pane started at 11:49 was
    // still writing transcripts with no tool calls long after the fix reached disk. The engines that
    // use shell hooks re-read the file on every call and cannot drift like this; these three can, so
    // they stamp their build and the mismatch is said out loud instead of being discovered later.
    const pluginVersion = (body as { pluginVersion?: unknown }).pluginVersion
    if (typeof pluginVersion === 'string' && pluginVersion && pluginVersion !== VERSION) {
      console.warn(`[hooks] ${sid(body.sessionId ?? '?')} ${body.engine ?? '?'} plugin is v${pluginVersion}`
        + ` but this machine is v${VERSION} — that pane loaded an older copy.`)
      console.warn('[hooks] restart the pane (or reload its plugins) to pick up the current build')
    }
    const engine = body.engine ?? 'claude'
    // Capture before process resolution yields. Native time is unchanged across client retries.
    const admissionOrder = { firedAt: native.firedAt, arrival: native.arrival ?? ++admissionArrival }
    const fingerprint = createHash('sha256').update(native.wire
      ? JSON.stringify([body, admissionOrder.firedAt, native.wire]) : JSON.stringify([body, admissionOrder.firedAt])).digest('hex')
    const originalBody = structuredClone(body)
    const deliveryHeader = native.deliveryId
    const nativeDeliveryId = typeof deliveryHeader === 'string' && /^[a-zA-Z0-9_-]{16,96}$/.test(deliveryHeader) ? deliveryHeader : undefined
    const deliveryId = nativeDeliveryId ?? randomUUID()
    const carriesStop = !!nativeDeliveryId && (engine === 'cursor' && body.hookEvent === 'stop'
      || engine === 'commandcode' && (body.hookEvent === 'Stop' || body.hookEvent === 'StopFailure'))
    const stopProvenance = (value: BoundHookBody, firedAt: number | undefined) => JSON.stringify([
      value.engine, value.sessionId, value.callerPid, normalizedRuntimeHints(value), firedAt, value.status, value.nativeOrigin,
    ])
    const originalStop = stopProvenance(body, admissionOrder.firedAt)
    const conflict = { status: 409, reply: { pending: false, error: 'HOOK_DELIVERY_CONFLICT' } }
    const resolving = resolvingStops.get(deliveryId)
    if (resolving) {
      const reply = resolving.fingerprint === fingerprint ? await resolving.stop(body, admissionOrder.firedAt) : conflict
      answer(reply.status, reply.reply); return
    }
    // A preliminary lookup grants no binding authority. It only remembers
    // cancellation before process resolution yields; the proved owner below
    // must match this exact process/conversation before the witness applies.
    const preliminary = carriesStop && body.sessionId ? registry.bySession(body.sessionId) : undefined
    const stopScope = preliminary?.engine === engine ? scopeOf(preliminary) : undefined
    const priorReceipt = preliminary && admissionReceipts.get(preliminary.agentId)?.records.get(deliveryId)
    const stopWitness = priorReceipt?.preparing?.stopCurrent
      ?? (stopScope && !priorReceipt ? handlers.captureAdmissionStop?.(preliminary!) : undefined)
    let stopEffect = priorReceipt?.preparing?.stopEffect ?? (stopScope && !priorReceipt && !native.recovery ? handlers.captureTurnStop?.(preliminary!, {
      sessionId: body.sessionId!, status: body.status, firedAt: admissionOrder.firedAt,
    }) : undefined)
    if (carriesStop) resolvingStops.set(deliveryId, { fingerprint, stop: (stop, firedAt) => {
      if (stopProvenance(stop, firedAt) !== originalStop) return conflict
      return { status: 202, reply: { pending: false, retry: true, detail: 'Waiting for the engine process record; Stop admission is not queued yet.' } }
    } })
    let processAgent: RegisteredSession | null
    let caller: NativeHookCaller | undefined
    const recoveredOwner = native.recovery && registry.byAgent(native.recovery.agentId)
    if (native.recovery && (!recoveredOwner?.active || durableKey(recoveredOwner) !== native.recovery.key)) return
    try {
      if (!native.recovery) caller = await captureCaller(body)
      processAgent = handlers.resolveHookAgent
      ? await handlers.resolveHookAgent({
        engine,
        tmuxPane: body.tmuxPane,
        runtimeHints,
        callerPid: recoveredOwner?.processIdentity?.pid
          ?? (Number.isSafeInteger(body.callerPid) && body.callerPid! > 0 ? body.callerPid : undefined),
        nativeCaller: caller,
        // A relaunch records its engine's process a moment after the engine starts, and a hook in that
        // moment waits for the record, up to 20s. Its client does not: the engine's hook command gives
        // up on a reply after 500ms and then writes the registry itself, as for a daemon that is down
        // (hook/notify.mjs, fallbackRegister), with a row of its own in place of the agent's, which
        // the running daemon's next save took in. Told the registration is pending, it writes nothing,
        // as for a transcript not yet written below, and the wait goes on here.
        // Hermes admission has a separate bounded queue after resolution. Do not
        // claim a slot before one exists: its hook client can retry this live hold.
        onWait: () => { answer(202, { pending: false, retry: true, detail: 'Waiting for the engine process record; admission is not queued yet.' }) },
      })
      : body.tmuxPane ? registry.byPaneEngine(body.tmuxPane, engine) ?? null : null
    } finally { if (carriesStop) resolvingStops.delete(deliveryId) }
    if (!processAgent || processAgent.engine !== engine) { ignore('no_matching_engine_process'); return }
    if (native.recovery && (processAgent.agentId !== native.recovery.agentId || durableKey(processAgent) !== native.recovery.key)) return
    // Own the process incarnation. Each inspection refreshes its routing,
    // but can never follow the original hinted pane to a replacement process.
    body.processIdentity = processAgent.processIdentity ? { ...processAgent.processIdentity } : undefined
    body.runtimes = processAgent.runtimes.map(runtime => ({ ...runtime }))
    body.primaryRuntimeKey = processAgent.primaryRuntimeKey
    if (isRecentlyDeleted(body.sessionId)) { ignore('deleted'); return }
    let context: DurableProcess
    try {
      if (closed || quiescing) return
      const owner = await handlers.readNativeHookOwner?.(processAgent, native.recovery?.owner ?? caller?.owner(processAgent))
      context = await durableProcess(processAgent, owner)
      if (native.recovery && context.key !== native.recovery.key) return
    } catch (error) {
      const detail = `Waiting for native hook ownership: ${error instanceof Error ? error.message : 'process unavailable'}`.slice(0, 1024)
      recoveryHeld(processAgent.agentId, detail)
      answer(202, { pending: false, retry: true, detail }); return
    }
    const scope = scopeOf(processAgent)!
    if (stopScope !== scope || processAgent.sessionId !== body.sessionId) stopEffect = undefined
    if (scopeOf(registry.byAgent(processAgent.agentId)) !== scope) { ignore('stale_hook'); return }
    // Pending jobs and completed receipts survive routing observations within
    // this process incarnation. Native hints are rechecked before every commit.
    const receiptScope = scopeOf
    for (const [id, history] of admissionReceipts) if (receiptScope(registry.byAgent(id)) !== history.scope) {
      for (const delivery of history.records.keys()) saveReceipt(history.records, delivery)
      admissionReceipts.delete(id)
    }
    const history = admissionReceipts.get(processAgent.agentId) ?? { scope: receiptScope(processAgent)!, records: new Map() }
    admissionReceipts.set(processAgent.agentId, history)
    // Include the retained process snapshot and closure overhead, and reserve
    // against concurrent HTTP requests before any intake becomes daemon-owned.
    const retainedBytes = 2 * (JSON.stringify(body).length + JSON.stringify(processAgent).length) + 2_048
    const cached = history.records.get(deliveryId)
    if (cached && cached.fingerprint !== fingerprint) { answer(conflict.status, conflict.reply); return }
    const provisional = !cached && receiptCount < receiptCapacity && receiptBytes + retainedBytes <= bytesCapacity
    if (provisional) {
      // Reserve before the first fallible snapshot, not merely before retain().
      // Otherwise a concurrent startup publication loses a one-shot legacy prompt.
      saveReceipt(history.records, deliveryId, { fingerprint, status: 202,
        reply: { pending: false, retry: true, detail: 'Waiting for the original native hook intake to be confirmed.' },
        pending: false, bytes: retainedBytes, preparing: { stopEffect,
          stopCurrent: processAgent.sessionId === body.sessionId && stopScope === scope ? stopWitness : undefined,
          intake: { body: originalBody, ...admissionOrder, ...(native.wire ? { wire: native.wire } : {}), attempted: false } } })
    }
    const preparing = history.records.get(deliveryId)?.preparing
    if (preparing?.intake) admissionOrder.arrival = preparing.intake.arrival
    let reservation: string | undefined
    let durable: NativeHookDelivery, earlierPreparing = false
    try {
      if (closed || quiescing) return
      if (preparing) {
        ready(context, false)
        reservation = `${context.key}\u0000${deliveryId}`
        if (intakeReservations.has(reservation)) {
          reservation = undefined
          throw new IdentityReadUnavailable('the original native hook intake is still being confirmed')
        }
        intakeReservations.add(reservation)
      }
      const snapshot = await confirmedSnapshot(context, processAgent)
      if (!snapshot.active && ![...history.records.values()].some(receipt => receipt.preparing?.intake)
        && [...snapshot.deliveries.values()].every(item => item.result || history.records.has(item.intake.id))) recovered.add(context.key)
      const known = snapshot.deliveries.get(deliveryId)
      if (known && (known.intake.fingerprint !== fingerprint || known.intake.agentId !== processAgent.agentId
        || known.intake.conversationId !== (body.sessionId ?? ''))) {
        if (provisional || preparing?.intake) saveReceipt(history.records, deliveryId)
        answer(conflict.status, conflict.reply); return
      }
      // A newly reserved local slot is not evidence that a cold Stop originated
      // here. Only a prior local retention attempt may carry its live effect.
      // The cancellation witness can only revoke a Stop; it cannot close a turn.
      if (known && preparing?.intake && !preparing.intake.attempted) {
        preparing.stopEffect = undefined; stopEffect = undefined
      }
      if (!known?.result && !cached && !preparing) {
        if (known) {
          recovered.delete(context.key)
          recoveryHeld(processAgent.agentId, 'Waiting for capacity to resume this retained native hook.')
          ownership = 'owned'; verifyOwnership = () => { snapshot.verifyAuthority(); known.verify() }
          answer(200, { pending: true })
        } else answer(429, { pending: false, error: 'HOOK_ADMISSION_BUSY', detail: 'Hook acknowledgement storage is full; this delivery was not queued.' })
        return
      }
      if (!known && [...history.records].slice(0, [...history.records.keys()].indexOf(deliveryId))
        .some(([id, receipt]) => receipt.preparing?.intake && !snapshot.deliveries.has(id))) {
        throw new IdentityReadUnavailable('an earlier local native hook intake is still being confirmed')
      }
      for (const [id, delivery] of snapshot.deliveries) {
        if (id === deliveryId) break
        if (!delivery.result && (!history.records.has(id) || history.records.get(id)?.preparing)) earlierPreparing = true
      }
      if (!known?.result) ready(context, false)
      if (preparing?.intake) preparing.intake.attempted = true
      durable = await context.journal.retain({ id: deliveryId, fingerprint, agentId: processAgent.agentId,
        conversationId: body.sessionId ?? '', ...(admissionOrder.firedAt ? { firedAt: admissionOrder.firedAt } : {}),
        ...(context.owner ? { owner: context.owner } : {}),
        ...(native.wire ? { wire: native.wire } : {}),
        payload: { ...originalBody } })
      // A retry/recovery may find an intake from before this core existed. Its current parser cannot
      // become the original turn witness. An existing local receipt below keeps its original latch.
      if (!durable.created) stopEffect = history.records.get(deliveryId)?.preparing?.stopEffect
      ownership = 'owned'
      verifyOwnership = () => { snapshot.verifyAuthority(); durable.verify() }
    } catch (error) {
      if (error instanceof Error && error.message.includes('HOOK_DELIVERY_CONFLICT')) answer(conflict.status, conflict.reply)
      else {
        const detail = `Waiting for durable native hook intake: ${error instanceof Error ? error.message : 'storage unavailable'}`.slice(0, 1024)
        recoveryHeld(processAgent.agentId, detail)
        answer(202, { pending: false, retry: true, detail })
      }
      return
    } finally {
      if (reservation) intakeReservations.delete(reservation)
    }
    if (durable.result) {
      if (typeof durable.result.status !== 'number' || !durable.result.reply) {
        ownership = undefined
        answer(202, { pending: false, retry: true, detail: 'Waiting for a complete native hook outcome.' }); return
      }
      if (carriesStop && (history.records.has(deliveryId) || receiptCount < receiptCapacity
        && receiptBytes + retainedBytes <= bytesCapacity)) saveReceipt(history.records, deliveryId, {
        fingerprint, status: durable.result.status, reply: durable.result.reply, pending: false, bytes: retainedBytes,
        linkedStop: (stop, firedAt) => {
          if (stopProvenance(stop, firedAt) !== originalStop || stop.transcriptPath !== originalBody.transcriptPath) return conflict
          return durable.result!.stop === 'completed' || durable.result!.stop === 'superseded'
            ? { status: 200, reply: { ok: true, duplicate: true } }
            : { status: 202, reply: { pending: false, retry: true, detail: 'Waiting for the original Stop outcome.' } }
        },
      })
      else if (preparing?.intake) saveReceipt(history.records, deliveryId)
      ownership = 'complete'; answer(durable.result.status, durable.result.reply); return
    }
    const completed = history.records.get(deliveryId)
    if (completed && !completed.preparing) {
      if (completed.fingerprint === fingerprint) answer(completed.status, completed.reply)
      else answer(409, { pending: false, error: 'HOOK_DELIVERY_CONFLICT' })
      return
    }
    // A later same-conversation intake must not enter the live queue ahead of a retained input
    // whose first confirmation failed. Otherwise it waits for that predecessor while occupying
    // the predecessor's queue position. Recovery admits preparing inputs in their durable order.
    if (earlierPreparing) {
      recovered.delete(context.key)
      recoveryHeld(processAgent.agentId, 'Waiting for the earlier retained native hook intake to be confirmed.')
      answer(200, { pending: true }); return
    }
    let inspectionIdentity: string | undefined
    let prepared: RegisterInput = body
    let preparedRegistration: ReturnType<typeof registry.prepareRegistration> = null
    let committed: ReturnType<typeof registry.register> = null
    let claim: NativeHookClaim | undefined, notified = false
    let verifyNativeOwner = () => {}
    let settled = false, stopRetained = false
    let stopOutcome: CapturedStopOutcome | undefined, terminalResult: Record<string, unknown> | undefined
    const stopCurrent = processAgent.sessionId === body.sessionId && stopScope === scope ? stopWitness : undefined
    let followupFingerprint: string | undefined
    const live = () => registry.byAgent(processAgent.agentId)
    const current = () => !closed && !quiescing && !isRecentlyDeleted(processAgent.agentId) && !isRecentlyDeleted(body.sessionId)
      && live()?.active !== false && scopeOf(live()) === scope
    const held = (reason: string) => {
      const holds = admissionHolds.get(processAgent.agentId) ?? new Map<string, string>()
      holds.set(deliveryId, reason); admissionHolds.set(processAgent.agentId, holds)
      publishHold(processAgent.agentId)
      console.log(`[hooks] ${sid(body.sessionId ?? '?')} ${body.hookEvent ?? 'session-start'} held · ${reason}`)
      answer(200, { pending: true })
    }
    const clearHold = () => {
      const holds = admissionHolds.get(processAgent.agentId)
      if (!holds?.delete(deliveryId)) return
      if (!holds.size) admissionHolds.delete(processAgent.agentId)
      publishHold(processAgent.agentId)
    }
    const completedReply = (status: number, reply: unknown) => {
      // A pruned old process cannot reinsert its receipts from a late callback.
      if (admissionReceipts.get(processAgent.agentId) === history) saveReceipt(history.records, deliveryId,
        { ...history.records.get(deliveryId)!, status, reply, pending: false, bytes: carriesStop ? retainedBytes : 0 })
      settled = true
      answer(status, reply)
    }
    const linkedStop: LinkedStop = async (stop, firedAt) => {
      if (stopProvenance(stop, firedAt) !== originalStop || stop.transcriptPath !== originalBody.transcriptPath) return conflict
      const sent = createHash('sha256').update(JSON.stringify(stop)).digest('hex')
      if (followupFingerprint && sent !== followupFingerprint) return conflict
      followupFingerprint = sent
      // Confirmation only. Registration owns the single Stop effect; an ordinary ok would also make
      // the legacy client delete every queued task for this session, including a successor turn's.
      if (!settled || stopOutcome !== 'completed' && stopOutcome !== 'superseded') return { status: 200, reply: { pending: true } }
      return { status: 200, reply: { ok: true, duplicate: true } }
    }
    const prepare = (): AdmissionDecision<string | undefined> | null => {
      if (!current()) return { kind: 'reject', reason: 'stale_hook' }
      if (handlers.hookAdmissionBlocked?.(processAgent.agentId)) return { kind: 'hold', reason: 'Waiting for Stop to settle before admitting the hook.' }
      const row = live()!
      if (!runtimeHints.some(hint => row.runtimes.some(runtime => runtime.backend === hint.backend && runtime.paneId === hint.paneId))) {
        return { kind: 'hold', reason: 'Waiting for the original hook pane to belong to its engine process.' }
      }
      inspectionIdentity = paneReadIdentity(row)
      prepared = { ...body, processIdentity: row.processIdentity ? { ...row.processIdentity } : undefined,
        runtimes: row.runtimes.map(runtime => ({ ...runtime })), primaryRuntimeKey: row.primaryRuntimeKey,
        transcriptPath: knownTranscriptFor(body, row) }
      const admission = admitHook(engine, prepared)
      if (!admission.accepted) return admission.reason === 'engine_hook_failed'
        ? { kind: 'hold', reason: 'Waiting for complete native hook evidence.' } : { kind: 'reject', reason: admission.reason }
      return null
    }
    const commit = (hermesHome: string | undefined): AdmissionDecision<string | undefined> => {
      if (!current() || paneReadIdentity(live()) !== inspectionIdentity) return { kind: 'hold', reason: 'Waiting for fresh evidence after the binding changed.' }
      if (handlers.hookAdmissionBlocked?.(processAgent.agentId)) return { kind: 'hold', reason: 'Waiting for Stop to settle before admitting the hook.' }
      committed = preparedRegistration!.commit(() => {
        if (!current() || paneReadIdentity(live()) !== inspectionIdentity || handlers.hookAdmissionBlocked?.(processAgent.agentId)) {
          throw new IdentityReadUnavailable('the native hook owner changed before binding')
        }
        claim!.verify()
        verifyNativeOwner()
      })
      return committed ? { kind: 'accept', value: hermesHome } : { kind: 'reject', reason: 'invalid_session_registration' }
    }
    const notify = () => {
      const result = committed!
      clearHold()
      console.log(`[hooks] ${sid(result.entry.sessionId)} ${body.hookEvent ?? 'session-start'} · engine=${result.entry.engine} · isNew=${result.isNew}`
        + (engine === 'hermes' ? ` · after a source check${result.entry.hermesHome ? ` · home=${result.entry.hermesHome}` : ''}` : ''))
      const optional = (call: () => void | Promise<void>) => {
        try { void Promise.resolve(call()).catch(error => console.warn('[hooks] committed admission notification failed', error)) }
        catch (error) { console.warn('[hooks] committed admission notification failed', error) }
      }
      // Native prompt credit follows the durable bind, never an attempted one.
      if (body.hookEvent === 'UserPromptSubmit') {
        optional(() => handlers.onPromptSubmitted?.(result.entry.agentId, body.prompt ?? ''))
        if (admissionOrder.firedAt && body.sessionId) optional(() => handlers.onPromptHook?.(body.sessionId!, admissionOrder.firedAt!))
      }
      optional(() => handlers.onRegistered(result.entry, { isNew: result.isNew, evicted: result.evicted, rebound: result.rebound,
        orphaned: result.orphaned, hookEvent: body.hookEvent }))
    }
    const enqueue = () => {
      saveReceipt(history.records, deliveryId, { fingerprint, status: 200, reply: { pending: true }, pending: true, bytes: retainedBytes,
        ...(carriesStop ? { linkedStop } : {}) })
      const queued = admissions.submit(processAgent.agentId, deliveryId, {
        conversationId: body.sessionId,
        order: { ...admissionOrder, scope: admissionProcessScope(processAgent) ?? processAgent.agentId },
        binding: () => { const row = live(); return row && { id: row.sessionId, at: row.boundAt } },
        current,
        ownsEffect: () => !!claim,
        pendingClaim: () => context.journal.pendingClaim()?.id === deliveryId,
        inspect: async () => prepare() ?? (engine === 'hermes' && body.sessionId
          ? await inspectHermesKind(body.sessionId, live()?.hermesHome ?? undefined) : { kind: 'accept', value: undefined }),
        conclude: async decision => {
          const changed = () => decision.kind === 'accept' && !committed
            && (!current() || paneReadIdentity(live()) !== inspectionIdentity)
          const refresh = { kind: 'hold' as const, reason: 'Waiting for fresh evidence after the binding changed.' }
          // A source read may already have lost its owner. Do not reserve an
          // effect for that stale observation and only discover this after fsync.
          if (changed()) return refresh
          const snapshot = await confirmedSnapshot(context, processAgent)
          if (changed()) return refresh
          if (claim && decision.kind === 'reject') {
            return { kind: 'hold', reason: 'Waiting for the original native hook effect to be reconciled before its intent can change.' }
          }
          if (decision.kind === 'accept' && !committed && !claim) {
            const order = admissions.status(processAgent.agentId, body.sessionId ?? deliveryId,
              { ...admissionOrder, scope: admissionProcessScope(processAgent) ?? processAgent.agentId })
            if (order === 'older') decision = { kind: 'reject', reason: 'stale_hook' }
            if (order === 'ambiguous') return { kind: 'hold', reason: 'Waiting for unambiguous durable native hook order.' }
            if (decision.kind === 'accept' && context.journal.pendingClaim()?.id !== deliveryId) {
              let before = true
              for (const [id, delivery] of snapshot.deliveries) {
                if (id === deliveryId) { before = false; continue }
                if (delivery.result) continue
                const prior = delivery.intake
                // Other cores do not share this queue. Their unresolved inputs
                // participate in the same native-time decision before any claim.
                const sameConversation = prior.conversationId === (body.sessionId ?? '')
                if (sameConversation ? before : prior.firedAt === undefined || admissionOrder.firedAt === undefined
                  || prior.firedAt >= admissionOrder.firedAt) {
                  return { kind: 'hold', reason: 'Waiting for the earlier or ambiguous retained native hook to be resolved.' }
                }
              }
            }
          }
          if (decision.kind === 'accept' && !committed) {
            preparedRegistration = registry.prepareRegistration(decision.value ? { ...prepared, hermesHome: decision.value } : prepared,
              { verifiedNativeSource: true })
            if (!preparedRegistration) decision = { kind: 'reject', reason: 'invalid_session_registration' }
          }
          claim ??= await context.journal.claim(deliveryId, processAgent.agentId, { previous: snapshot.previous })
          context.claims.set(deliveryId, claim)
          if (decision.kind === 'accept' && !committed) {
            // Disk confirmation may outlive the engine. The precise native
            // re-observation is the last await before the synchronous commit.
            if (handlers.readNativeHookOwner) {
              if (!durable.intake.owner) throw new IdentityReadUnavailable('the retained native hook has no process evidence')
              verifyNativeOwner = (await handlers.readNativeHookOwner(processAgent, durable.intake.owner)).verify
            }
            const result = commit(decision.value)
            if (result.kind === 'hold') return result
            decision = result
          }
          if (decision.kind === 'accept' && carriesStop && !terminalResult) {
            if (stopCurrent && !stopCurrent()) stopOutcome = 'superseded'
            else if (stopEffect) {
              claim.verify()
              stopOutcome = await stopEffect({ current, verify: () => claim!.verify() })
            }
            if (!current()) return { kind: 'hold', reason: 'Waiting for the original native hook owner.' }
            if (stopOutcome !== 'completed' && stopOutcome !== 'superseded') {
              if (!stopRetained) stopRetained = handlers.onAdmissionStop?.(committed!.entry, true) ?? false
              return { kind: 'hold', reason: 'Waiting for the original Stop turn to be confirmed; Cancel can resolve this hold.' }
            }
          }
          // A rejected claim can also outlive the shutdown cutoff. The drain
          // owns only writes already dispatched, never a new terminal outcome.
          if (closed || quiescing) return { kind: 'hold', reason: 'Waiting for the daemon to finish stopping.' }
          const status = decision.kind === 'accept' || decision.reason !== 'invalid_session_registration' ? 200 : 400
          const reply = decision.kind === 'accept' ? { ok: true } : status === 400 ? { error: 'invalid session registration' }
            : { ignored: true, reason: decision.reason }
          // Registration callbacks synchronously settle ownership and initiate
          // interpretation. Dispatch them while this effect still owns the slot,
          // before a successor can confirm its terminal record and overtake it.
          if (decision.kind === 'accept' && !notified) { claim.verify(); notified = true; notify() }
          terminalResult ??= { status, reply, accepted: decision.kind === 'accept', arrival: admissionOrder.arrival,
            ...(carriesStop && decision.kind === 'accept' ? { stop: stopOutcome } : {}) }
          await finishTerminal(claim, terminalResult)
          // Graceful shutdown may retain this write, never its callbacks or a
          // fresh attachment. Abrupt shutdown still revokes the journal itself.
          if (closed || quiescing) return { kind: 'hold', reason: 'Waiting for the daemon to finish stopping.' }
          ownership = undefined
          context.claims.delete(deliveryId); context.restored.add(deliveryId)
          // Completion is final even if restoring the next frontier fails. A
          // concurrent intake can have arrived while this result was syncing;
          // only its freshly confirmed frontier can reopen interpretation.
          try {
            const completed = await confirmedSnapshot(context, processAgent), receipt = completed.deliveries.get(deliveryId)
            if (!receipt?.result) throw new IdentityReadUnavailable('the native completion receipt is unavailable')
            ownership = 'complete'; verifyOwnership = () => { completed.verifyAuthority(); receipt.verify() }
          }
          catch (error) {
            recoveryHeld(processAgent.agentId,
              `Waiting for native hook recovery: ${error instanceof Error ? error.message : 'storage unavailable'}`.slice(0, 1024))
          }
          return decision
        },
        held,
        reject: reason => {
          clearHold()
          console.log(`[hooks] ${sid(body.sessionId ?? '?')} ${body.hookEvent ?? 'session-start'} ignored · ${reason}`)
          if (reason === 'invalid_session_registration') completedReply(400, { error: 'invalid session registration' })
          else completedReply(200, { ignored: true, reason })
        },
        accept: () => { completedReply(200, { ok: true }) },
      })
      if (queued) {
        // Synchronous native admission settles in this turn's microtasks. A
        // queued predecessor or asynchronous source gets an owned pending reply.
        if (engine === 'hermes') answer(200, { pending: true })
        else setTimeout(() => { answer(200, { pending: true }) }, 100)
      } else {
        saveReceipt(history.records, deliveryId, { fingerprint, status: 200, reply: { pending: true }, pending: false,
          bytes: retainedBytes, preparing: { stopEffect, stopCurrent } })
        recovered.delete(context.key)
        const detail = 'Waiting for capacity to resume this retained native hook.'
        recoveryHeld(processAgent.agentId, detail)
        console.log(`[hooks] ${sid(body.sessionId ?? '?')} held · ${detail}`)
        answer(200, { pending: true })
      }
    }
    enqueue()
  }
  const recover = async (row: RegisteredSession, context: DurableProcess): Promise<void> => {
    recovering.add(context.key)
    try {
      const snapshot = await confirmedSnapshot(context, row)
      if (snapshot.active && context.claims.get(snapshot.active.id)?.token !== snapshot.active.token
        && context.journal.pendingClaim()?.token !== snapshot.active.token) {
        recoveryHeld(row.agentId, 'Waiting for an authoritative outcome of a native hook interrupted by the previous core.')
        return
      }
      const pending = [...snapshot.deliveries.values()].find(delivery => !delivery.result
        && (!admissionReceipts.get(delivery.intake.agentId)?.records.has(delivery.intake.id)
          || admissionReceipts.get(delivery.intake.agentId)?.records.get(delivery.intake.id)?.preparing))
      if (!pending) {
        const history = admissionReceipts.get(row.agentId)
        const local = history && history.scope === scopeOf(row)
          ? [...history.records].find(([, receipt]) => receipt.preparing?.intake) : undefined
        if (!local) { recovered.add(context.key); return }
        const [id, receipt] = local, input = receipt.preparing!.intake!
        await admitStart(structuredClone(input.body), { deliveryId: id, firedAt: input.firedAt, arrival: input.arrival,
          ...(input.wire ? { wire: input.wire } : {}),
          recovery: { agentId: row.agentId, key: context.key, owner: context.owner } }, () => {})
        return
      }
      if (!validHookBody(pending.intake.payload)) throw new IdentityReadUnavailable('the retained native hook body is invalid')
      await admitStart(structuredClone(pending.intake.payload), { deliveryId: pending.intake.id, firedAt: pending.intake.firedAt,
        ...(pending.intake.wire ? { wire: pending.intake.wire } : {}),
        recovery: { agentId: pending.intake.agentId, key: context.key, owner: pending.intake.owner } }, () => {})
    } catch (error) {
      context.transcript = undefined
      if (!closed) recoveryHeld(row.agentId,
        `Waiting for native hook recovery: ${error instanceof Error ? error.message : 'storage unavailable'}`.slice(0, 1024))
    } finally { recovering.delete(context.key) }
  }
  const recoveryPass = () => {
    if (closed || quiescing) return
    for (const retry of [...legacyStopRetries.values()]) { if (runningLegacyStops >= 4) break; retry() }
    {
      const rows = registry.list().filter(row => row.active && row.processIdentity && row.engine !== 'terminal')
      for (let offset = 0; offset < rows.length && recovering.size < 4; offset++) {
        const row = rows[recoveryCursor++ % rows.length]!
        try {
          const scope = processIdentityKey(row.engine, row.processIdentity!)
          let known = nativeKeys.get(scope)
          if (!handlers.readNativeHookOwner) known = durableKey(row)
          const context = known && durableProcesses.get(known)
          const receipts = [...admissionReceipts.get(row.agentId)?.records.values() ?? []]
          // The live queue already retries its retained inputs. A second local
          // recovery writer must not confirm an in-flight claim underneath it.
          if (recovering.has(scope) || known && (recovering.has(known) || recovered.has(known))
            || context && (context.confirming || context.claims.size > 0)
            || receipts.some(receipt => receipt.pending) && !receipts.some(receipt => receipt.preparing)
            || known && [...intakeReservations].some(key => key.startsWith(`${known}\u0000`))) continue
          recovering.add(scope)
          void (async () => {
            const native = await handlers.readNativeHookOwner?.(row)
            if (closed || quiescing) return
            const context = await durableProcess(row, native)
            if (!closed && !quiescing && !recovering.has(context.key) && !recovered.has(context.key)) await recover(row, context)
          })().catch(error => {
            if (context) context.transcript = undefined
            if (!closed) recoveryHeld(row.agentId, `Waiting for native hook recovery: ${error instanceof Error ? error.message : 'process unavailable'}`.slice(0, 1024))
          }).finally(() => { recovering.delete(scope) })
        } catch (error) {
          recoveryHeld(row.agentId,
            `Waiting for native hook recovery: ${error instanceof Error ? error.message : 'process unavailable'}`.slice(0, 1024))
        }
      }
    }
    recoveryTimer = setTimeout(recoveryPass, 500); recoveryTimer.unref()
  }
  const replayHolds = new Map<number, string>()
  const clientReplay = createNativeHookReplay({
    readOutbox: async (shard, current) => (await storage()).readOutbox(shard, current),
    send: (request, current, remainingMs) => sendNativeHookRequest(request, hookCredential, () => !closed && !quiescing && current(), remainingMs),
    onHeld: (shard, id, reason) => {
      if (!reason) { replayHolds.delete(shard); return }
      const detail = `${id ?? `shard ${shard}`}: ${reason}`
      if (replayHolds.get(shard) === detail) return
      replayHolds.set(shard, detail)
      console.warn(`[hooks] retained client delivery held · ${detail}`)
    },
  })
  const startRecovery = () => {
    if (closed || quiescing || recoveryStarted) return
    recoveryStarted = true
    recoveryTimer = setTimeout(recoveryPass, 0); recoveryTimer.unref()
    if (options.nativeClientReplay) clientReplay.start()
  }
  const handle: http.RequestListener = (req, res) => {
    void (async () => {
      const url = (req.url ?? '').split('?')[0]
      const json = (code: number, body: unknown): void => {
        res.writeHead(code, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      // Over the daemon's own socket the filesystem already said who this is, and no browser can get
      // there; everything else must prove it was addressed to this loopback server.
      const trustedLocal = isTrustedLocal(req)
      // Before any route, reads included. See lib/loopbackRequest.ts.
      if (!trustedLocal && !isLoopbackRequest(req, hosts)) {
        // At most one line a minute: enough to explain a client that was refused, not a lever for a
        // page to flood the log. Host and Origin are the sender's, so they are escaped and bounded.
        if (Date.now() - lastRefusalLogAt > 60_000) {
          lastRefusalLogAt = Date.now()
          const shown = (v: unknown) => JSON.stringify(String(v ?? '').slice(0, 80))
          console.warn(`[hooks] refused ${req.method} ${url.slice(0, 80)} · host=${shown(req.headers.host)} origin=${shown(req.headers.origin)}`)
        }
        json(403, { error: 'FORBIDDEN_HOST' }); return
      }
      // A handler that throws must still answer: this whole function is a void-discarded async, so
      // a throw here is an unhandledRejection and a request that hangs until the caller gives up —
      // which, for the desktop app, is a 30s timeout that names Dio instead of the fault.
      const proxied = async (call: () => Promise<{ status: number; body: unknown }>): Promise<void> => {
        try { const out = await call(); json(out.status, out.body) }
        catch (e) {
          console.error(`[hook] ${req.method} ${url} failed:`, e instanceof Error ? e.message : e)
          json(502, { success: false, error: { code: 'PROXY_FAILED', message: e instanceof Error ? e.message : 'INTERNAL' } })
        }
      }
      // CSRF guard for mutating endpoints: a cross-origin browser page cannot set a custom header on a
      // simple request (it forces a CORS preflight we never allow), so only the CLI and the apps, which
      // send it, can trigger actions. A local process could still call it — same trust level as the
      // CLI, which is acceptable on loopback.
      const localOk = req.headers['x-adapter-local'] === '1'
      const hookOk = hookCredentialMatches(hookCredential, req.headers['x-harness-hook-token'])
      if (hookOk && (closed || quiescing) && (url.startsWith('/api/hook/') || url.startsWith('/api/native-hook/'))) {
        json(202, { pending: false, retry: true, detail: 'Waiting for the daemon to finish stopping.' }); return
      }
      if (hookOk && url.startsWith('/api/hook/') && req.headers['x-harness-hook-origin'] === NATIVE_HOOK_ORIGIN_UNAVAILABLE) {
        const detail = 'Waiting for the original native hook caller to be confirmed; this delivery was not retained.'
        console.warn(`[hooks] ${url} held · ${detail}`)
        json(202, { pending: false, retry: true, detail }); return
      }

      if (url.startsWith('/api/autonomous-device/')) {
        const peer = req.socket.remoteAddress
        const loopback = trustedLocal || peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1'
        const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined
        if (!loopback || req.headers.origin || !hookCredentialMatches(hookCredential, bearer)) {
          json(403, { error: { code: 'FORBIDDEN', message: 'Authenticated native loopback client required' } }); return
        }
        if (!handlers.onAutonomousDeviceRequest) { json(503, { error: { code: 'UNAVAILABLE', message: 'Autonomous device service unavailable' } }); return }
        let body: unknown
        if (req.method !== 'GET') {
          try { body = JSON.parse(await readBody(req)) } catch { json(400, { error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }); return }
        }
        const result = await handlers.onAutonomousDeviceRequest(req.method ?? '', req.url ?? '', body)
        json(result.status, result.body); return
      }
      if (req.method === 'GET' && url === '/api/health') {
        json(200, { ok: true, version: VERSION }); return
      }

      // The local web dashboard that `GET /` served, with its log tail (`/api/logs`) and stop button
      // (`/api/stop`), is gone: no app, website, script or the backend opened it, and the web client
      // it linked from retired with the browser setup links (#348). `harness stop` stops the daemon
      // through its pid, never through here.
      if (req.method === 'GET' && url === '/api/status') {
        json(200, handlers.onStatus ? await handlers.onStatus() : { supported: false }); return
      }

      if (req.method === 'POST' && url === '/api/native-hook/v1/session-start') {
        if (!hookOk) { json(401, { error: 'UNAUTHORIZED' }); return }
        const raw = await readBody(req, true), id = req.headers['x-harness-hook-delivery-id'], fired = req.headers['x-harness-hook-fired-at']
        const firedAt = hookFiredAt(req)
        let body: BoundHookBody
        try {
          const parsed: unknown = JSON.parse(raw)
          if (!validHookBody(parsed) || typeof id !== 'string' || !/^[a-zA-Z0-9_-]{16,96}$/.test(id)
            || typeof fired !== 'string' || !/^[1-9]\d{0,15}$/.test(fired) || !firedAt) throw Error('invalid native envelope')
          const origin = inspectNativeHookOrigin(parsed.nativeOrigin)
          if (origin.callerPid !== parsed.callerPid) throw Error('native caller changed')
          body = parsed
        } catch { json(400, { error: 'invalid native hook envelope' }); return }
        // Validated above; the explicit local values also prevent any legacy
        // random-ID, missing-time or live-caller recapture fallback.
        const delivery = { id: id as string, firedAt: firedAt! }, phase = { name: 'registration' as const,
          path: '/api/hook/session-start' as const, body: raw }, wire = nativeHookWireIdentity(phase.path, raw)
        try {
          if (await answerCompletedNativeRegistration(body, delivery.id, delivery.firedAt, wire, json,
            nativeHookAcknowledgement(delivery, phase, 'complete'))) return
        } catch (error) {
          json(202, { pending: false, retry: true,
            detail: `Waiting for native receipt recovery: ${error instanceof Error ? error.message : 'storage unavailable'}`.slice(0, 1024) }); return
        }
        if (body.engine === 'cursor' && body.hookEvent === 'stop'
          || body.engine === 'commandcode' && (body.hookEvent === 'Stop' || body.hookEvent === 'StopFailure')) {
          json(202, { pending: false, retry: true, detail: 'Waiting for durable linked Stop admission.' }); return
        }
        await admitStart(body, { deliveryId: delivery.id, firedAt: delivery.firedAt, wire }, (status, reply, ownership) => {
          if (ownership && (status >= 200 && status < 300 || ownership === 'complete' && status === 400)) {
            json(200, nativeHookAcknowledgement(delivery, phase, ownership))
          } else if (status >= 200 && status < 300) {
            const detail = (reply as { detail?: string; reason?: string })?.detail ?? (reply as { reason?: string })?.reason
              ?? 'Waiting for confirmed native hook ownership.'
            json(202, { pending: false, retry: true, detail })
          } else json(status, reply)
        })
        return
      }

      // SessionStart AND UserPromptSubmit both POST here (the catch hook re-registers so a session
      // whose SessionStart the adapter missed still shows up on its first prompt).
      if (req.method === 'POST' && url === '/api/hook/session-start') {
        if (!hookOk) { json(401, { error: 'UNAUTHORIZED' }); return }
        let body: BoundHookBody
        try {
          const parsed = JSON.parse(await readBody(req)) as unknown
          const legacy = legacyHookBody(parsed, req.headers['x-harness-hook-origin'])
          if (!legacy) { json(400, { error: 'invalid hook body' }); return }
          body = legacy
        } catch { json(400, { error: 'bad json' }); return }
        await admitStart(body, { firedAt: hookFiredAt(req), deliveryId: req.headers['x-harness-hook-delivery-id'] }, json)
        return
      }

      if (req.method === 'POST' && url === '/api/hook/session-end') {
        if (!hookOk) { json(401, { error: 'UNAUTHORIZED' }); return }
        let body: BoundHookBody
        try {
          const parsed = JSON.parse(await readBody(req)) as unknown
          const legacy = legacyHookBody(parsed, req.headers['x-harness-hook-origin'])
          if (!legacy) { json(400, { error: 'invalid hook body' }); return }
          body = legacy
        } catch { json(400, { error: 'bad json' }); return }
        if (!await verifiedMutation(body)) { json(403, { error: 'UNBOUND_HOOK' }); return }
        if (body.sessionId) {
          console.log(`[hooks] ${sid(body.sessionId)} session-end${body.reason ? ` · reason=${body.reason}` : ''}`)
          handlers.onSessionEnd(body.sessionId, body.reason)
        }
        json(200, { ok: true })
        return
      }

      if (req.method === 'POST' && url === '/api/hook/tool-start') {
        if (!hookOk) { json(401, { error: 'UNAUTHORIZED' }); return }
        let body: BoundHookBody
        try {
          const parsed = JSON.parse(await readBody(req)) as unknown
          const legacy = legacyHookBody(parsed, req.headers['x-harness-hook-origin'])
          if (!legacy) { json(400, { error: 'invalid hook body' }); return }
          body = legacy
        } catch { json(400, { error: 'bad json' }); return }
        if (!await verifiedMutation(body)) { json(403, { error: 'UNBOUND_HOOK' }); return }
        if (body.sessionId && body.toolUseId && body.toolName) {
          console.log(`[hooks] ${sid(body.sessionId)} tool-start · tool=${body.toolName}`)
          handlers.onToolStart?.({
            sessionId: body.sessionId,
            toolUseId: body.toolUseId,
            toolName: body.toolName,
            input: body.input,
          })
        }
        json(200, { ok: true })
        return
      }

      if (req.method === 'POST' && url === '/api/hook/turn-start') {
        if (!hookOk) { json(401, { error: 'UNAUTHORIZED' }); return }
        let body: BoundHookBody
        try {
          const parsed = JSON.parse(await readBody(req)) as unknown
          const legacy = legacyHookBody(parsed, req.headers['x-harness-hook-origin'])
          if (!legacy) { json(400, { error: 'invalid hook body' }); return }
          body = legacy
        } catch { json(400, { error: 'bad json' }); return }
        if (!await verifiedMutation(body)) { json(403, { error: 'UNBOUND_HOOK' }); return }
        if (body.sessionId) handlers.onTurnStart?.({ sessionId: body.sessionId })
        json(200, { ok: true })
        return
      }

      if (req.method === 'POST' && url === '/api/hook/turn-stop') {
        if (!hookOk) { json(401, { error: 'UNAUTHORIZED' }); return }
        let body: BoundHookBody
        try {
          const parsed = JSON.parse(await readBody(req)) as unknown
          const legacy = legacyHookBody(parsed, req.headers['x-harness-hook-origin'])
          if (!legacy) { json(400, { error: 'invalid hook body' }); return }
          body = legacy
        } catch { json(400, { error: 'bad json' }); return }
        const delivery = req.headers['x-harness-hook-delivery-id']
        if (body.engine === 'claude' && handlers.captureTurnStop && typeof delivery === 'string'
          && /^[a-zA-Z0-9_-]{16,96}$/.test(delivery)) {
          const reply = await retainLegacyStop(body, delivery, hookFiredAt(req))
          json(reply.status, reply.reply); return
        }
        if (typeof delivery === 'string') {
          const pending = resolvingStops.get(delivery)?.stop ?? [...admissionReceipts.values()]
            .map(history => history.records.get(delivery)?.linkedStop).find(Boolean)
          const acknowledgement = await pending?.(body, hookFiredAt(req))
          if (acknowledgement) { json(acknowledgement.status, acknowledgement.reply); return }
          if (/^[a-zA-Z0-9_-]{16,96}$/.test(delivery) && (body.engine === 'cursor' || body.engine === 'commandcode')) {
            // These native clients register this same delivery before Stop. A
            // refused queue or a restarted core has no completion authority yet.
            json(202, { pending: false, retry: true, detail: 'Waiting for the linked Stop registration to be admitted.' }); return
          }
        }
        const owner = await verifiedMutation(body)
        if (!owner) { json(403, { error: 'UNBOUND_HOOK' }); return }
        if (body.sessionId) {
          const identity = paneReadIdentity(owner)
          console.log(`[hooks] ${sid(body.sessionId)} turn-stop${body.status ? ` · status=${body.status}` : ''}`)
          const fired = hookFiredAt(req)
          const stop = { sessionId: body.sessionId, status: body.status, transcriptPath: body.transcriptPath, ...(fired ? { firedAt: fired } : {}) }
          if (handlers.stopHookDelayMs) setTimeout(() => {
            if (!closed && !quiescing && paneReadIdentity(registry.byAgent(owner.agentId)) === identity) handlers.onTurnStop?.(stop)
          }, handlers.stopHookDelayMs)
          else handlers.onTurnStop?.(stop)
        }
        json(200, { ok: true })
        return
      }

      // `harness pair <code>` → run CPace toward the browser that is waiting to pair. Long-polls until
      // the handshake completes/fails (bounded by the manager's round timers). Loopback-only; the PAKE
      // itself is the security (a local process can trigger, but only the real code completes pairing).
      if (req.method === 'POST' && url === '/api/pair') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onPair) { json(503, { error: 'PAIRING_UNAVAILABLE' }); return }
        let body: { code?: string }
        try { body = JSON.parse(await readBody(req)) as { code?: string } } catch { json(400, { error: 'bad json' }); return }
        if (!body.code) { json(400, { error: 'MISSING_CODE' }); return }
        try { const out = await handlers.onPair(body.code); json(out.status, out.body) }
        catch (e) { json(500, { error: e instanceof Error ? e.message : 'INTERNAL' }) }
        return
      }

      // `harness remote-password set` → stretch + persist a new persistent remote password on the
      // running daemon's live E2EE state (so an in-progress `harness link connect` from another
      // machine sees it immediately, with no daemon restart needed).
      if (req.method === 'POST' && url === '/api/remote-password/set') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onSetRemotePassword) { json(503, { error: 'UNAVAILABLE' }); return }
        let body: { password?: string }
        try { body = JSON.parse(await readBody(req)) as { password?: string } } catch { json(400, { error: 'bad json' }); return }
        if (!body.password) { json(400, { error: 'MISSING_PASSWORD' }); return }
        try { const out = await handlers.onSetRemotePassword(body.password); json(out.status, out.body) }
        catch (e) { json(500, { error: e instanceof Error ? e.message : 'INTERNAL' }) }
        return
      }

      // `harness remote-password clear` → remove the persistent remote password.
      if (req.method === 'POST' && url === '/api/remote-password/clear') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onClearRemotePassword) { json(503, { error: 'UNAVAILABLE' }); return }
        const out = await handlers.onClearRemotePassword(); json(out.status, out.body); return
      }

      // `harness link connect` → trust the machine just linked back, on the daemon's live E2EE state.
      if (req.method === 'POST' && url === '/api/link/trust-peer') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onTrustLinkedPeer) { json(503, { error: 'UNAVAILABLE' }); return }
        let body: { pub?: unknown; machineId?: unknown; label?: unknown }
        try { body = JSON.parse(await readBody(req)) as typeof body } catch { json(400, { error: 'bad json' }); return }
        const isKey = typeof body.pub === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(body.pub) // 32-byte Ed25519, base64
        if (!isKey || typeof body.machineId !== 'string' || !/^[a-f0-9]{32}$/.test(body.machineId)) { json(400, { error: 'BAD_PEER' }); return }
        const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 60) : body.machineId
        const out = await handlers.onTrustLinkedPeer({ pub: body.pub as string, machineId: body.machineId, label })
        json(out.status, out.body); return
      }

      // `harness group list` → the trust group's members. Read-only (keys and labels, no secrets).
      if (req.method === 'GET' && url === '/api/group') {
        if (!handlers.onGroupList) { json(503, { error: 'UNAVAILABLE' }); return }
        const out = await handlers.onGroupList(); json(out.status, out.body); return
      }
      // `harness group sync` → compare rosters with every reachable member now.
      if (req.method === 'POST' && url === '/api/group/sync') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onGroupSync) { json(503, { error: 'UNAVAILABLE' }); return }
        const out = await handlers.onGroupSync(); json(out.status, out.body); return
      }
      // `harness group remove <id|#|fp>` / `harness link unlink` → drop a member everywhere.
      if (req.method === 'POST' && url === '/api/group/remove') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onGroupRemove) { json(503, { error: 'UNAVAILABLE' }); return }
        let body: { selector?: unknown }
        try { body = JSON.parse(await readBody(req)) as typeof body } catch { json(400, { error: 'bad json' }); return }
        if (typeof body.selector !== 'string' || !body.selector.trim()) { json(400, { error: 'MISSING_SELECTOR' }); return }
        const out = await handlers.onGroupRemove(body.selector.trim()); json(out.status, out.body); return
      }

      // `harness devices list` / the window's Devices list → the account's devices, as this machine's
      // verified copy of the device key log has them. Read-only (public keys and labels).
      if (req.method === 'GET' && url === '/api/devices') {
        if (!handlers.onDevicesList) { json(503, { error: 'UNAVAILABLE' }); return }
        const out = await handlers.onDevicesList(); json(out.status, out.body); return
      }
      // `harness devices remove <fp>` / Remove in the window → out of the log, signed by this machine.
      if (req.method === 'POST' && url === '/api/devices/remove') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onDevicesRemove) { json(503, { error: 'UNAVAILABLE' }); return }
        let body: { pub?: unknown }
        try { body = JSON.parse(await readBody(req)) as typeof body } catch { json(400, { error: 'bad json' }); return }
        if (typeof body.pub !== 'string' || !body.pub) { json(400, { error: 'MISSING_PUB' }); return }
        const out = await handlers.onDevicesRemove(body.pub); json(out.status, out.body); return
      }
      // `harness devices rebaseline` → what trusting the backend's log again would change; `confirm`
      // does it (the only way out of a frozen log).
      if (req.method === 'POST' && url === '/api/devices/rebaseline') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onDevicesRebaseline) { json(503, { error: 'UNAVAILABLE' }); return }
        let body: { confirm?: unknown; head?: unknown }
        try { body = JSON.parse(await readBody(req)) as typeof body } catch { json(400, { error: 'bad json' }); return }
        if (!body || typeof body !== 'object') { json(400, { error: 'bad json' }); return }
        // The head the person was shown in the preview: a confirm only goes ahead on that same list.
        let head: { seq: number; hash: string } | undefined
        if (body.head !== undefined) {
          const h = body.head as { seq?: unknown; hash?: unknown } | null
          if (!h || typeof h !== 'object' || typeof h.seq !== 'number' || !Number.isSafeInteger(h.seq) || h.seq < 0
            || typeof h.hash !== 'string' || h.hash.length > 128) { json(400, { error: 'BAD_HEAD' }); return }
          head = { seq: h.seq, hash: h.hash }
        }
        const out = await handlers.onDevicesRebaseline(body.confirm === true, head); json(out.status, out.body); return
      }

      // `harness devices history` → the log's adds and removes, newest first. Local only: it is the
      // account's whole device story, and the fetch behind it is a backend call as this machine.
      if (req.method === 'GET' && url === '/api/devices/history') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onDevicesHistory) { json(503, { error: 'UNAVAILABLE' }); return }
        const out = await handlers.onDevicesHistory(); json(out.status, out.body); return
      }
      // `harness devices dismiss [<fp>]` / "It's mine" / "Got it" → new devices marked as seen here.
      if (req.method === 'POST' && url === '/api/devices/dismiss') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onDevicesDismiss) { json(503, { error: 'UNAVAILABLE' }); return }
        let body: { pub?: unknown; pubs?: unknown; baseline?: unknown; confirm?: unknown }
        try { body = JSON.parse(await readBody(req)) as typeof body } catch { json(400, { error: 'bad json' }); return }
        if (!body || typeof body !== 'object') { json(400, { error: 'bad json' }); return }
        if (body.pub !== undefined && (typeof body.pub !== 'string' || !body.pub)) { json(400, { error: 'MISSING_PUB' }); return }
        // The keys a window displayed, so a key accepted since the window read the list is not cleared unseen.
        if (body.pubs !== undefined && (!Array.isArray(body.pubs) || body.pubs.length > 256
          || body.pubs.some((k) => typeof k !== 'string' || !k || k.length > 256))) { json(400, { error: 'BAD_PUBS' }); return }
        const out = await handlers.onDevicesDismiss({
          ...(typeof body.pub === 'string' ? { pub: body.pub } : {}),
          ...(Array.isArray(body.pubs) ? { pubs: body.pubs as string[] } : {}),
          ...(body.baseline === true ? { baseline: true } : {}),
          // "It's mine" for one device: the account's other devices are told too (deviceLogSyncer `dismiss`).
          ...(body.confirm === true ? { confirm: true } : {}),
        }); json(out.status, out.body); return
      }

      // `harness remote-password status` → whether one is set, and its fingerprint. Read-only, same
      // gating tier as /api/pairs.
      if (req.method === 'GET' && url === '/api/remote-password/status') {
        if (!handlers.onRemotePasswordStatus) { json(503, { error: 'UNAVAILABLE' }); return }
        const out = await handlers.onRemotePasswordStatus(); json(out.status, out.body); return
      }

      // Local GUI clients (e.g. the desktop app): read the full machine list / rename or delete one /
      // read the signed-in profile through this daemon's own SSO session, so the local caller never
      // holds a bearer token itself — loopback trust does the authenticating. Reads are ungated (same
      // tier as /api/status); the rename/delete mutations are CSRF-guarded like every other local write.
      if (req.method === 'GET' && url === '/api/machines') {
        const list = handlers.onMachinesList
        if (!list) { json(503, { error: 'UNAVAILABLE' }); return }
        await proxied(list); return
      }
      if (req.method === 'GET' && url === '/api/harness-shares') {
        if (!handlers.onSharedHarnesses) { json(503, { error: 'UNAVAILABLE' }); return }
        await proxied(handlers.onSharedHarnesses); return
      }
      if (req.method === 'GET' && url === '/api/desk') {
        if (!handlers.onDeskRead) { json(503, { error: 'UNAVAILABLE' }); return }
        await proxied(handlers.onDeskRead); return
      }
      if (req.method === 'POST' && url === '/api/desk/ops') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onDeskOps) { json(503, { error: 'UNAVAILABLE' }); return }
        let body: unknown
        try { body = JSON.parse(await readBody(req)) } catch { json(400, { error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }); return }
        await proxied(() => handlers.onDeskOps!(body)); return
      }
      if (req.method === 'GET' && url === '/api/agent-messages') {
        if (!handlers.onAgentMessagesRead) { json(503, { error: 'UNAVAILABLE' }); return }
        await proxied(handlers.onAgentMessagesRead); return
      }
      const agentMessagesTab = req.method === 'PATCH' ? /^\/api\/agent-messages\/tabs\/([A-Za-z0-9_-]{1,64})$/.exec(url) : null
      if (agentMessagesTab) {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onAgentMessagesWrite) { json(503, { error: 'UNAVAILABLE' }); return }
        let body: unknown
        try { body = JSON.parse(await readBody(req)) } catch { json(400, { error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }); return }
        await proxied(() => handlers.onAgentMessagesWrite!(agentMessagesTab[1], body)); return
      }
      if (req.method === 'GET' && url === '/api/agent-settings') {
        if (!handlers.onAgentSettingsRead) { json(503, { error: 'UNAVAILABLE' }); return }
        await proxied(handlers.onAgentSettingsRead); return
      }
      if (req.method === 'PATCH' && url === '/api/agent-settings') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onAgentSettingsWrite) { json(503, { error: 'UNAVAILABLE' }); return }
        let body: unknown
        try { body = JSON.parse(await readBody(req)) } catch { json(400, { error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }); return }
        await proxied(() => handlers.onAgentSettingsWrite!(body)); return
      }
      if (req.method === 'GET' && url === '/api/experimental-settings') {
        if (!handlers.onExperimentalRead) { json(503, { error: 'UNAVAILABLE' }); return }
        await proxied(handlers.onExperimentalRead); return
      }
      if (req.method === 'POST' && url === '/api/product-usage/report') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onProductUsageReport) { json(503, { error: 'UNAVAILABLE' }); return }
        let body: unknown
        try {
          const raw = await readBody(req, false, 8192)
          body = JSON.parse(raw)
        } catch { json(400, { error: 'BAD_REQUEST' }); return }
        if (!isAppProductUsageReport(body)) {
          json(400, { error: 'BAD_REQUEST' }); return
        }
        try {
          const result = await handlers.onProductUsageReport(body)
          json(result.status, result.body)
        } catch { json(502, { success: false, error: { code: 'USAGE_UNAVAILABLE', message: 'Product usage unavailable' } }) }
        return
      }
      if (req.method === 'POST' && url === '/api/product-usage/feedback') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onProductFeedback) { json(503, { error: 'UNAVAILABLE' }); return }
        let body: unknown
        try { body = JSON.parse(await readBody(req)) } catch { json(400, { error: 'BAD_REQUEST' }); return }
        const feedback = body as { answer?: unknown; id?: unknown } | null
        if (!feedback || typeof feedback !== 'object' || Object.keys(feedback).length !== 2
            || !PRODUCT_FEEDBACK.includes(feedback.answer as never) || typeof feedback.id !== 'string'
            || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(feedback.id)) {
          json(400, { error: 'BAD_REQUEST' }); return
        }
        await proxied(() => handlers.onProductFeedback!(feedback)); return
      }
      if (req.method === 'GET' && url === '/api/product-usage/settings') {
        if (!handlers.onProductUsageRead) { json(503, { error: 'UNAVAILABLE' }); return }
        await proxied(handlers.onProductUsageRead); return
      }
      if (req.method === 'POST' && url === '/api/product-usage/settings') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onProductUsageWrite) { json(503, { error: 'UNAVAILABLE' }); return }
        let body: unknown
        try { body = JSON.parse(await readBody(req)) } catch { json(400, { error: 'BAD_REQUEST' }); return }
        if (!body || typeof body !== 'object' || Object.keys(body).length !== 1 || typeof (body as { enabled?: unknown }).enabled !== 'boolean') {
          json(400, { error: 'BAD_REQUEST' }); return
        }
        await proxied(() => handlers.onProductUsageWrite!(body)); return
      }
      if (req.method === 'PATCH' && url === '/api/experimental-settings') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onExperimentalWrite) { json(503, { error: 'UNAVAILABLE' }); return }
        let body: unknown
        try { body = JSON.parse(await readBody(req)) } catch { json(400, { error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }); return }
        await proxied(() => handlers.onExperimentalWrite!(body)); return
      }
      if (req.method === 'GET' && url === '/api/auth/me') {
        const me = handlers.onAuthMe
        if (!me) { json(503, { error: 'UNAVAILABLE' }); return }
        await proxied(me); return
      }
      // Add Phone: a code that SIGNS A PHONE IN to this account — the one local route whose answer is
      // a credential. So not the CSRF header, which any local process can send, but the daemon's
      // owner-only socket: the filesystem has already said this is the user who signed in. Another
      // account on a shared computer reaches the loopback port, never the socket. A client on TCP is
      // refused, and the Add Phone QR goes without the code (the phone asks for an emailed one).
      if (req.method === 'POST' && url === '/api/auth/handoff') {
        if (!trustedLocal || !localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onAuthHandoff) { json(503, { error: 'UNAVAILABLE' }); return }
        await proxied(handlers.onAuthHandoff); return
      }
      if (req.method === 'PATCH' && url.startsWith('/api/machines/')) {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        const rename = handlers.onMachineRename
        if (!rename) { json(503, { error: 'UNAVAILABLE' }); return }
        const machineId = decodeURIComponent(url.slice('/api/machines/'.length))
        if (!machineId) { json(400, { error: 'MISSING_MACHINE_ID' }); return }
        let body: { name?: string }
        try { body = JSON.parse(await readBody(req)) as { name?: string } } catch { json(400, { error: 'bad json' }); return }
        const name = body.name
        if (!name) { json(400, { error: 'MISSING_NAME' }); return }
        await proxied(() => rename(machineId, name)); return
      }
      if (req.method === 'DELETE' && url.startsWith('/api/machines/')) {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        const remove = handlers.onMachineDelete
        if (!remove) { json(503, { error: 'UNAVAILABLE' }); return }
        const machineId = decodeURIComponent(url.slice('/api/machines/'.length))
        if (!machineId) { json(400, { error: 'MISSING_MACHINE_ID' }); return }
        await proxied(() => remove(machineId)); return
      }

      // The Harness Store: ratings and reviews in the backend, through this daemon's own session. The
      // rules (reads ungated, writes behind the local header, the paths it forwards) are storeProxy.ts's.
      if (url.startsWith('/api/store/')) {
        // A request an http.Server hands over always has its url; `url` above is it without the query.
        const route = await routeStoreRequest({ method: req.method, url: req.url as string, localOk, readBody: () => readBody(req) }, handlers.onStore)
        if ('forward' in route) await proxied(route.forward)
        else json(route.status, route.body)
        return
      }

      // `harness pairings` — list paired browsers.
      if (req.method === 'GET' && url === '/api/pairs') {
        if (!handlers.onListPairs) { json(503, { error: 'UNAVAILABLE' }); return }
        const out = await handlers.onListPairs(); json(out.status, out.body); return
      }

      // `harness unpair <id>` — unpair one browser; signals it (if online) to re-pair.
      if (req.method === 'POST' && url === '/api/revoke') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onRevoke) { json(503, { error: 'UNAVAILABLE' }); return }
        let body: { id?: string }
        try { body = JSON.parse(await readBody(req)) as { id?: string } } catch { json(400, { error: 'bad json' }); return }
        if (!body.id) { json(400, { error: 'MISSING_ID' }); return }
        const out = await handlers.onRevoke(body.id); json(out.status, out.body); return
      }

      // `harness unpair --all` — unpair every browser.
      if (req.method === 'POST' && url === '/api/revoke-all') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onRevokeAll) { json(503, { error: 'UNAVAILABLE' }); return }
        const out = await handlers.onRevokeAll(); json(out.status, out.body); return
      }

      json(404, { error: 'not found' })
    })().catch((error: unknown) => {
      // Whatever a handler throws, the request is answered: an engine's hook that waits on this server
      // holds up that engine's turn until its own timeout, and the desktop waits out thirty seconds.
      console.error(`[hooks] ${req.method} ${(req.url ?? '').split('?')[0].slice(0, 80)} failed:`, error instanceof Error ? error.message : error)
      if (!res.headersSent) {
        const held = error instanceof IdentityReadUnavailable
        res.writeHead(held ? 202 : 500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(held ? { pending: false, retry: true, detail: error.message } : { error: 'INTERNAL' }))
      } else if (!res.writableEnded) res.end()
    })
  }
  const server = http.createServer(handle)
  const quiesce = () => {
    quiescing = true; clearTimeout(recoveryTimer); admissions.close(); waitingAttaches.clear(); waitingTranscripts.clear()
    legacyStopRetries.clear()
    void clientReplay.close().catch(error => console.warn('[hooks] client replay cleanup remains held', error))
  }
  let drained: Promise<void> | undefined, endDrain: (() => void) | undefined
  const stopRecovery = () => {
    closed = true; quiesce(); endDrain?.()
    for (const context of durableProcesses.values()) context.journal.close()
    void closeStorage().catch(error => console.warn('[hooks] storage cleanup remains held', error))
  }
  const drainAndStopRecovery = (): Promise<void> => {
    if (drained) return drained
    quiesce()
    // Only exact terminal writes already dispatched can finish. No new effect,
    // retry, worker or cold claim participates in this bounded shutdown grace.
    const pending = [...terminalWrites]
    let timer: ReturnType<typeof setTimeout>
    drained = new Promise<void>(done => {
      endDrain = done
      timer = setTimeout(done, 1_000)
      void Promise.allSettled(pending).then(() => done())
      if (closed) done()
    }).finally(() => { clearTimeout(timer); endDrain = undefined; stopRecovery() })
    return drained
  }
  const close = server.close.bind(server)
  server.close = callback => {
    stopRecovery()
    return close(error => {
      void Promise.all([clientReplay.close(), closeStorage()]).then(() => callback?.(error), failure => callback?.(error ?? (failure instanceof Error ? failure : new Error(String(failure)))))
    })
  }
  server.once('close', stopRecovery)

  return new Promise((resolve, reject) => {
    let fellBack = false
    const failed = (err: NodeJS.ErrnoException): void => {
      if (err.code === 'EADDRINUSE' && !fellBack && options.allowPortFallback && options.socketPath) {
        fellBack = true
        console.log(`[hooks] control port ${port} unavailable; assigning a separate port for this user`)
        server.once('error', failed)
        server.listen(0, '127.0.0.1')
        return
      }
      if (err.code === 'EADDRINUSE') {
        console.error(`[hooks] 127.0.0.1:${port} is already in use — another adapter is probably running.`)
        console.error('        Use a different PORT; no other user\'s daemon was stopped.')
      } else {
        console.error('[hooks] listen failed:', err)
      }
      reject(err)
    }
    server.once('error', failed)
    server.once('listening', () => {
      const actual = (server.address() as AddressInfo).port
      hosts = loopbackHosts(actual)
      console.log(`[hooks] listening on 127.0.0.1:${actual} (SessionStart/SessionEnd callbacks)`)
      if (!options.deferNativeRecovery) startRecovery()
      const socketPath = options.socketPath
      if (!socketPath) { resolve({ server, port: actual, localSocket: null, startRecovery, stopRecovery, drainAndStopRecovery, recoveryReady, transcriptReady }); return }
      // The private socket is mandatory when opting into multi-user startup. A duplicate daemon
      // must not survive on a random port while another one owns this user's socket.
      listenLocalSocket(handle, socketPath).then(
        (localSocket) => {
          console.log(`[hooks] listening on ${socketPath}`)
          resolve({ server, port: actual, localSocket, startRecovery, stopRecovery, drainAndStopRecovery, recoveryReady, transcriptReady })
        },
        (error: unknown) => {
          if (options.allowPortFallback) {
            server.closeAllConnections()
            server.close()
            reject(error)
            return
          }
          console.warn(`[hooks] local socket unavailable (${socketPath}): ${error instanceof Error ? error.message : error}`)
          resolve({ server, port: actual, localSocket: null, startRecovery, stopRecovery, drainAndStopRecovery, recoveryReady, transcriptReady })
        },
      )
    })
    server.listen(port, '127.0.0.1')
  })
}
