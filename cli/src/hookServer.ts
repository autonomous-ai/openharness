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
  /** Retain an uncorrelated native Stop before attaching a newly admitted conversation. */
  onAdmissionStop?: (entry: RegisteredSession, unmatched: boolean) => boolean
  /** Captured before a same-conversation registration waits; Cancel or forget supersedes that Stop. */
  captureAdmissionStop?: (entry: RegisteredSession) => () => boolean
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
  /** The account's Experimental switches, proxied with the daemon's own identity. */
  onExperimentalRead?: () => Promise<PairOutcome>
  onExperimentalWrite?: (body: unknown) => Promise<PairOutcome>
  /** /api/store/* — proxy the Harness Store's ratings and reviews to backend the same way: reads
   *  ungated like the machine list, writes (PUT/DELETE) CSRF-guarded like a rename. See storeProxy.ts. */
  onStore?: StoreHandler
}

export { STORE_PATH_RE } from './lib/storeProxy.js'

const MAX_HOOK_BODY_BYTES = 256 * 1024
const HOOK_BODY_FIELDS = new Set([
  'engine', 'launcherId', 'sessionId', 'transcriptPath', 'cwd', 'source', 'tmuxPane', 'title', 'model',
  'cliVersion', 'runtimeHints', 'callerPid', 'hookEvent', 'pluginVersion', 'reason', 'status', 'toolUseId',
  'toolName', 'input', 'prompt',
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

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    let bytes = 0
    let oversized = false
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > MAX_HOOK_BODY_BYTES) { oversized = true; data = ''; return }
      data += chunk
    })
    req.on('end', () => resolve(oversized ? '' : data))
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
  prompt?: string
  sessionId?: string
  reason?: string
  status?: string
  toolUseId?: string
  toolName?: string
  input?: unknown
}

async function verifiedBoundMutation(
  body: BoundHookBody,
  handlers: HookServerHandlers,
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
}

export function startHookServer(
  port: number,
  handlers: HookServerHandlers,
  options: HookServerOptions = {},
): Promise<{ server: http.Server; port: number; localSocket: LocalSocketServer | null }> {
  const hookCredential = loadOrCreateHookCredential(env.ADAPTER_DATA_DIR)
  const admissions = createPendingAdmissions({ isProcessCurrent: (key, scope) => admissionProcessScope(registry.byAgent(key)) === scope })
  let admissionArrival = 0
  const admissionHolds = new Map<string, Map<string, string>>()
  type StopAcknowledgement = { status: number; reply: unknown }
  type LinkedStop = (body: BoundHookBody, firedAt: number | undefined) => StopAcknowledgement | Promise<StopAcknowledgement>
  type Receipt = { fingerprint: string; status: number; reply: unknown; pending: boolean; bytes: number; linkedStop?: LinkedStop }
  const admissionReceipts = new Map<string, { scope: string; records: Map<string, Receipt> }>()
  const resolvingStops = new Map<string, { fingerprint: string; stop: LinkedStop }>()
  let receiptCount = 0, receiptBytes = 0
  const saveReceipt = (records: Map<string, Receipt>, id: string, next?: Receipt) => {
    const before = records.get(id)
    if (before) { receiptCount--; receiptBytes -= before.bytes }
    if (next) { records.set(id, next); receiptCount++; receiptBytes += next.bytes }
    else records.delete(id)
  }
  const receiptCapacity = options.admissionReceiptCapacity ?? 65_536
  const bytesCapacity = options.admissionBytesCapacity ?? 16 * 1024 * 1024
  // Filled in once the port is bound: the Host a request must name is the port actually taken.
  let hosts: ReadonlySet<string> = new Set()
  let lastRefusalLogAt = 0
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

      // SessionStart AND UserPromptSubmit both POST here (the catch hook re-registers so a session
      // whose SessionStart the adapter missed still shows up on its first prompt).
      if (req.method === 'POST' && url === '/api/hook/session-start') {
        if (!hookOk) { json(401, { error: 'UNAUTHORIZED' }); return }
        let body: BoundHookBody
        try {
          const parsed = JSON.parse(await readBody(req)) as unknown
          if (!validHookBody(parsed)) { json(400, { error: 'invalid hook body' }); return }
          body = parsed
        } catch { json(400, { error: 'bad json' }); return }
        // Every rejection below says WHY, out loud. They used to be silent, and a hook that arrives and
        // is dropped looks exactly like a hook that never fired — which is precisely the confusion behind
        // "the agent is running in my terminal but the list does not show it".
        // Answered once: a hook answered before its resolution waited is only logged after it.
        let answered = false
        const answer = (code: number, reply: unknown): void => {
          if (answered) return
          answered = true
          json(code, reply)
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
        const admissionOrder = { firedAt: hookFiredAt(req), arrival: ++admissionArrival }
        const fingerprint = createHash('sha256').update(JSON.stringify([body, admissionOrder.firedAt])).digest('hex')
        const deliveryHeader = req.headers['x-harness-hook-delivery-id']
        const nativeDeliveryId = typeof deliveryHeader === 'string' && /^[a-zA-Z0-9_-]{16,96}$/.test(deliveryHeader) ? deliveryHeader : undefined
        const deliveryId = nativeDeliveryId ?? randomUUID()
        const carriesStop = !!nativeDeliveryId && (engine === 'cursor' && body.hookEvent === 'stop'
          || engine === 'commandcode' && (body.hookEvent === 'Stop' || body.hookEvent === 'StopFailure'))
        const stopProvenance = (value: BoundHookBody, firedAt: number | undefined) => JSON.stringify([
          value.engine, value.sessionId, value.callerPid, normalizedRuntimeHints(value), firedAt, value.status,
        ])
        const originalStop = stopProvenance(body, admissionOrder.firedAt)
        const conflict = { status: 409, reply: { pending: false, error: 'HOOK_DELIVERY_CONFLICT' } }
        const scopeOf = (row: RegisteredSession | undefined) => row && JSON.stringify([
          row.agentId, row.engine, row.processIdentity ? processIdentityKey(row.engine, row.processIdentity) : null,
        ])
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
        const stopWitness = stopScope ? handlers.captureAdmissionStop?.(preliminary!) : undefined
        let deferred = false
        if (carriesStop) resolvingStops.set(deliveryId, { fingerprint, stop: (stop, firedAt) => {
          if (stopProvenance(stop, firedAt) !== originalStop) return conflict
          deferred = true
          return { status: 202, reply: { pending: false, retry: true, detail: 'Waiting for the engine process record; Stop admission is not queued yet.' } }
        } })
        let processAgent: RegisteredSession | null
        try { processAgent = handlers.resolveHookAgent
          ? await handlers.resolveHookAgent({
            engine,
            tmuxPane: body.tmuxPane,
            runtimeHints,
            callerPid: Number.isSafeInteger(body.callerPid) && body.callerPid! > 0 ? body.callerPid : undefined,
            // A relaunch records its engine's process a moment after the engine starts, and a hook in that
            // moment waits for the record, up to 20s. Its client does not: the engine's hook command gives
            // up on a reply after 500ms and then writes the registry itself, as for a daemon that is down
            // (hook/notify.mjs, fallbackRegister), with a row of its own in place of the agent's, which
            // the running daemon's next save took in. Told the registration is pending, it writes nothing,
            // as for a transcript not yet written below, and the wait goes on here.
            // Hermes admission has a separate bounded queue after resolution. Do not
            // claim a slot before one exists: its hook client can retry this live hold.
            onWait: () => { deferred = true; answer(202, { pending: false, retry: true, detail: 'Waiting for the engine process record; admission is not queued yet.' }) },
          })
          : body.tmuxPane ? registry.byPaneEngine(body.tmuxPane, engine) ?? null : null
        } finally { if (carriesStop) resolvingStops.delete(deliveryId) }
        if (!processAgent || processAgent.engine !== engine) { ignore('no_matching_engine_process'); return }
        // Own the process incarnation. Each inspection refreshes its routing,
        // but can never follow the original hinted pane to a replacement process.
        body.processIdentity = processAgent.processIdentity ? { ...processAgent.processIdentity } : undefined
        body.runtimes = processAgent.runtimes.map(runtime => ({ ...runtime }))
        body.primaryRuntimeKey = processAgent.primaryRuntimeKey
        if (isRecentlyDeleted(body.sessionId)) { ignore('deleted'); return }
        const scope = scopeOf(processAgent)!
        if (carriesStop && stopScope !== scope) deferred = true
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
        const completed = history.records.get(deliveryId)
        if (completed) {
          if (completed.fingerprint === fingerprint) answer(completed.status, completed.reply)
          else answer(409, { pending: false, error: 'HOOK_DELIVERY_CONFLICT' })
          return
        }
        // Strings can occupy two bytes per code unit; include the immutable
        // process snapshot and fixed closure/record overhead in this admission budget.
        const retainedBytes = 2 * (JSON.stringify(body).length + JSON.stringify(processAgent).length) + 2_048
        if (receiptCount >= receiptCapacity || receiptBytes + retainedBytes > bytesCapacity) {
          answer(429, { pending: false, error: 'HOOK_ADMISSION_BUSY', detail: 'Hook acknowledgement storage is full; this delivery was not queued.' })
          return
        }
        let inspectionIdentity: string | undefined
        let prepared: RegisterInput = body
        let committed: ReturnType<typeof registry.register> = null
        let settled = false, stopRetained = false, stopUnmatched = false, stopInvocationClaimed = false
        const stopCurrent = processAgent.sessionId === body.sessionId && stopScope === scope ? stopWitness : undefined
        let followupFingerprint: string | undefined, committedIdentity: string | undefined
        const live = () => registry.byAgent(processAgent.agentId)
        const current = () => !isRecentlyDeleted(processAgent.agentId) && !isRecentlyDeleted(body.sessionId)
          && live()?.active !== false && scopeOf(live()) === scope
        const publishHold = () => {
          const reason = [...admissionHolds.get(processAgent.agentId)?.values() ?? []].at(-1)
          try { handlers.onAdmissionHeld?.(processAgent.agentId, reason) }
          catch (error) { console.warn('[hooks] admission status notification failed', error) }
        }
        const held = (reason: string) => {
          deferred = true
          const holds = admissionHolds.get(processAgent.agentId) ?? new Map<string, string>()
          holds.set(deliveryId, reason); admissionHolds.set(processAgent.agentId, holds)
          publishHold()
          console.log(`[hooks] ${sid(body.sessionId ?? '?')} ${body.hookEvent ?? 'session-start'} held · ${reason}`)
          answer(200, { pending: true })
        }
        const clearHold = () => {
          const holds = admissionHolds.get(processAgent.agentId)
          if (!holds?.delete(deliveryId)) return
          if (!holds.size) admissionHolds.delete(processAgent.agentId)
          publishHold()
        }
        const completedReply = (status: number, reply: unknown) => {
          // A pruned old process cannot reinsert its receipts from a late callback.
          if (admissionReceipts.get(processAgent.agentId) === history) saveReceipt(history.records, deliveryId,
            { ...history.records.get(deliveryId)!, status, reply, pending: false, bytes: carriesStop ? retainedBytes : 0 })
          settled = true
          answer(status, reply)
        }
        const linkedStop: LinkedStop = async (stop, firedAt) => {
          if (stopProvenance(stop, firedAt) !== originalStop) return conflict
          const sent = createHash('sha256').update(JSON.stringify(stop)).digest('hex')
          if (followupFingerprint && sent !== followupFingerprint) return conflict
          followupFingerprint = sent
          // The registration itself owns this native Stop, even if its second
          // HTTP delivery outruns source recovery. Never close a later live turn.
          if (!settled || stopRetained) {
            deferred = true
            return { status: 200, reply: { pending: true } }
          }
          if (stopCurrent && !stopCurrent()) stopInvocationClaimed = true
          if (stopInvocationClaimed) return { status: 200, reply: { ok: true, duplicate: true } }
          const owner = await verifiedBoundMutation(stop, handlers)
          if (stopCurrent && !stopCurrent()) stopInvocationClaimed = true
          if (stopInvocationClaimed) return { status: 200, reply: { ok: true, duplicate: true } }
          if (stopRetained) return { status: 200, reply: { pending: true } }
          if (!current() || live()?.sessionId !== body.sessionId) {
            return { status: 403, reply: { error: 'UNBOUND_HOOK' } }
          }
          if (!owner || paneReadIdentity(owner) !== committedIdentity) {
            // The original delivery still belongs to this process/conversation,
            // but its parser or routing was rebuilt. Preserve completion without
            // applying it to whichever turn the replacement happened to load.
            stopRetained = handlers.onAdmissionStop?.(live()!, true) ?? false
            return stopRetained ? { status: 200, reply: { pending: true } }
              : { status: 202, reply: { pending: false, retry: true, detail: 'Waiting for core ownership of the unmatched Stop.' } }
          }
          if (!stopInvocationClaimed) {
            // Claim after the final authority fence, before optional async drains.
            stopInvocationClaimed = true
            handlers.onTurnStop?.({ sessionId: owner.sessionId, status: stop.status,
              transcriptPath: stop.transcriptPath, ...(firedAt ? { firedAt } : {}) })
            return { status: 200, reply: { ok: true } }
          }
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
          const prior = live()
          const before = prior && { sessionId: prior.sessionId, transcriptPath: prior.transcriptPath,
            held: !!(prior.identityHold || prior.interpretationHold) }
          committed = registry.register(hermesHome ? { ...prepared, hermesHome } : prepared, { verifiedNativeSource: true })
          if (stopCurrent && !stopCurrent()) stopInvocationClaimed = true
          if (committed && carriesStop && !stopRetained && !stopInvocationClaimed) {
            stopUnmatched ||= deferred || before?.sessionId !== committed.entry.sessionId
              || before?.transcriptPath !== committed.entry.transcriptPath || before?.held === true
            if (!handlers.onAdmissionStop && stopUnmatched) return { kind: 'hold', reason: 'Waiting for core ownership of the unmatched Stop.' }
            stopRetained = handlers.onAdmissionStop?.(committed.entry, stopUnmatched) ?? false
            if (stopUnmatched && !stopRetained) return { kind: 'hold', reason: 'Waiting for core ownership of the unmatched Stop.' }
          }
          if (committed) committedIdentity = paneReadIdentity(committed.entry)
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
            inspect: async () => prepare() ?? (engine === 'hermes' && body.sessionId
              ? await inspectHermesKind(body.sessionId, live()?.hermesHome ?? undefined) : { kind: 'accept', value: undefined }),
            commit,
            held,
            reject: reason => {
              clearHold()
              console.log(`[hooks] ${sid(body.sessionId ?? '?')} ${body.hookEvent ?? 'session-start'} ignored · ${reason}`)
              if (reason === 'invalid_session_registration') completedReply(400, { error: 'invalid session registration' })
              else completedReply(200, { ignored: true, reason })
            },
            accept: () => { completedReply(200, { ok: true }); notify() },
          })
          if (queued) {
            // Synchronous native admission settles in this turn's microtasks. A
            // queued predecessor or asynchronous source gets an owned pending reply.
            if (engine === 'hermes') answer(200, { pending: true })
            else setImmediate(() => { if (!settled) deferred = true; answer(200, { pending: true }) })
          } else {
            saveReceipt(history.records, deliveryId)
            const detail = 'Too many unverified hooks are pending; this hook was not queued. Retry after recovery.'
            console.log(`[hooks] ${sid(body.sessionId ?? '?')} held · ${detail}`)
            answer(429, { pending: false, error: 'HOOK_ADMISSION_BUSY', detail })
          }
        }
        enqueue()
        return
      }

      if (req.method === 'POST' && url === '/api/hook/session-end') {
        if (!hookOk) { json(401, { error: 'UNAUTHORIZED' }); return }
        let body: BoundHookBody
        try {
          const parsed = JSON.parse(await readBody(req)) as unknown
          if (!validHookBody(parsed)) { json(400, { error: 'invalid hook body' }); return }
          body = parsed
        } catch { json(400, { error: 'bad json' }); return }
        if (!await verifiedBoundMutation(body, handlers)) { json(403, { error: 'UNBOUND_HOOK' }); return }
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
          if (!validHookBody(parsed)) { json(400, { error: 'invalid hook body' }); return }
          body = parsed
        } catch { json(400, { error: 'bad json' }); return }
        if (!await verifiedBoundMutation(body, handlers)) { json(403, { error: 'UNBOUND_HOOK' }); return }
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
          if (!validHookBody(parsed)) { json(400, { error: 'invalid hook body' }); return }
          body = parsed
        } catch { json(400, { error: 'bad json' }); return }
        if (!await verifiedBoundMutation(body, handlers)) { json(403, { error: 'UNBOUND_HOOK' }); return }
        if (body.sessionId) handlers.onTurnStart?.({ sessionId: body.sessionId })
        json(200, { ok: true })
        return
      }

      if (req.method === 'POST' && url === '/api/hook/turn-stop') {
        if (!hookOk) { json(401, { error: 'UNAUTHORIZED' }); return }
        let body: BoundHookBody
        try {
          const parsed = JSON.parse(await readBody(req)) as unknown
          if (!validHookBody(parsed)) { json(400, { error: 'invalid hook body' }); return }
          body = parsed
        } catch { json(400, { error: 'bad json' }); return }
        const delivery = req.headers['x-harness-hook-delivery-id']
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
        const owner = await verifiedBoundMutation(body, handlers)
        if (!owner) { json(403, { error: 'UNBOUND_HOOK' }); return }
        if (body.sessionId) {
          const identity = paneReadIdentity(owner)
          console.log(`[hooks] ${sid(body.sessionId)} turn-stop${body.status ? ` · status=${body.status}` : ''}`)
          const fired = hookFiredAt(req)
          const stop = { sessionId: body.sessionId, status: body.status, transcriptPath: body.transcriptPath, ...(fired ? { firedAt: fired } : {}) }
          if (handlers.stopHookDelayMs) setTimeout(() => {
            if (paneReadIdentity(registry.byAgent(owner.agentId)) === identity) handlers.onTurnStop?.(stop)
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
        let body: { pub?: unknown; pubs?: unknown; baseline?: unknown }
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
      if (req.method === 'GET' && url === '/api/experimental-settings') {
        if (!handlers.onExperimentalRead) { json(503, { error: 'UNAVAILABLE' }); return }
        await proxied(handlers.onExperimentalRead); return
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
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'INTERNAL' }))
      } else if (!res.writableEnded) res.end()
    })
  }
  const server = http.createServer(handle)
  server.once('close', () => admissions.close())

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
      const socketPath = options.socketPath
      if (!socketPath) { resolve({ server, port: actual, localSocket: null }); return }
      // The private socket is mandatory when opting into multi-user startup. A duplicate daemon
      // must not survive on a random port while another one owns this user's socket.
      listenLocalSocket(handle, socketPath).then(
        (localSocket) => {
          console.log(`[hooks] listening on ${socketPath}`)
          resolve({ server, port: actual, localSocket })
        },
        (error: unknown) => {
          if (options.allowPortFallback) {
            server.closeAllConnections()
            server.close()
            reject(error)
            return
          }
          console.warn(`[hooks] local socket unavailable (${socketPath}): ${error instanceof Error ? error.message : error}`)
          resolve({ server, port: actual, localSocket: null })
        },
      )
    })
    server.listen(port, '127.0.0.1')
  })
}
