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
import { HERMES_HOMES, HERMES_SESSION_PANE, HERMES_SOURCE } from './engines/hermes/contract.js'
import { readStorePool } from './engines/kit/storePool.js'
import { homeIsAbsolute } from './engines/kit/homeAdoption.js'
import { isInteractiveSource, rowSessionSource, storeSourceQuery } from './engines/kit/storeSource.js'
import { IdentityReadUnavailable } from './engines/kit/identityScan.js'
import { createPendingAdmissions, type AdmissionDecision } from './core/engines/pendingAdmission.js'
import { paneReadIdentity } from './core/transcripts/readIdentity.js'
import { processIdentityKey } from './lib/terminalRuntime.js'
import { isRecentlyDeleted } from './lib/deletedSessions.js'
import { registry, type RegisterInput, type RegisteredSession } from './lib/registry.js'
import { sid } from './lib/log.js'
import { VERSION } from './version.js'
import { env } from './config/env.js'
import { hookCredentialMatches, loadOrCreateHookCredential, loadOrCreateHookToken } from './lib/hookAuth.js'
import { peerIsThisAccount, type PeerAccount } from './lib/peerAccount.js'
import { LOCAL_CREDENTIAL_REQUIRED, localCredentialMatches, PEER_LOOKUP_UNANSWERED, PEER_LOOKUP_UNANSWERED_MESSAGE } from './lib/localCredential.js'
import type { HookTerminalHint } from './lib/terminalTypes.js'
import { ENGINES, type AgentEngine } from './engines/types.js'
import { isLoopbackRequest, loopbackHosts } from './lib/loopbackRequest.js'
import { isTrustedLocal, listenLocalSocket, type LocalSocketServer } from './lib/localSocket.js'
import { PTY_HOST_INSTANCE, PTY_HOST_PANE } from './lib/ptyHost/instance.js'
import type { HttpAnswer } from './core/api.js'
import type { DoorRequest } from './core/serviceRoutes.js'

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
export function chooseHookAgent<T>(byAncestry: readonly T[], byRuntimeOnly: readonly T[], engine: AgentEngine, bySessionPane = false): {
  agent: T | null
  reason: 'ancestry' | 'runtime' | 'ambiguous' | 'none'
} {
  if (byAncestry.length === 1) return { agent: byAncestry[0], reason: 'ancestry' }
  if (byAncestry.length > 1) return { agent: null, reason: 'ambiguous' }
  // A Hermes hook from its shared gateway names the pane its session was created from, read from Hermes' own store
  // (`hermesSessionHint`), not from the caller: that pane is the evidence, as Cursor's hinted pane is.
  if (engine !== 'cursor' && !bySessionPane) return { agent: null, reason: 'none' }
  if (byRuntimeOnly.length === 1) return { agent: byRuntimeOnly[0], reason: 'runtime' }
  return { agent: null, reason: byRuntimeOnly.length ? 'ambiguous' : 'none' }
}

export interface PairOutcome {
  status: number
  body: Record<string, unknown>
  /** A busy backend's Retry-After, passed on where an answer is forwarded whole (the usage report). */
  retryAfterMs?: number
}

export interface HookServerHandlers {
  /** A paneless agent's hook event (core/observedHook.ts): checked, rate limited and forwarded, never kept. */
  onObserved?: (body: unknown) => 'ok' | 'invalid' | 'dropped'
  /** The mod's held poll for a spoken prompt (core/deviceHookCalls.ts). `gone` aborts when the client goes before its
   *  answer. */
  onInbox?: (body: unknown, gone: AbortSignal) => Promise<'invalid' | 'off' | { text?: string }>
  /** A route a service answers, once the door let its request in (core/serviceRoutes.ts): its answer, or null when no
   *  service answers `path`. */
  onServiceRoute?: (path: string, request: DoorRequest, localOk: boolean, socket: boolean) => Promise<HttpAnswer> | null

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
    /** The hints are the pane the hook's session was opened from (`hermesSessionHint`), not the caller's: the agent on
     *  that pane is the evidence, and the caller's process ancestry, which is a shared process's, is not. */
    bySessionPane?: boolean
    /** Called once the resolution has to wait for the agent to record its process
     *  (core/engines/hooks.ts): the hook is answered then, before the wait. */
    onWait?: () => void
  }) => Promise<RegisteredSession | null>
  /** Whether the hook's caller descends from a process that serves every pane (Hermes 0.22+'s gateway), whose
   *  pane and ancestry say nothing about the session the hook is for (core/engines/hooks.ts). */
  hookViaSharedProcess?: (query: { engine: RegisteredSession['engine']; callerPid: number }) => Promise<boolean>
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
  /** The engine waits on the person: a permission, a question. */
  onPersonWait?: (body: { sessionId: string; firedAt?: number }) => void
  /** A subagent of the session started, or stopped, and when its engine ran the hook. */
  onSubagent?: (body: { sessionId: string; started: boolean; firedAt?: number }) => void
  /** For the end-to-end suite only: how long a Stop hook is held before it is acted on, as the hook's own
   *  verification can take under load (`HARNESSD_TEST_STOP_HOOK_DELAY_MS`). */
  stopHookDelayMs?: number
  /** The daemon's status (GET /api/status): what `harness status`, the desktop's discovery and scripts read. */
  onStatus?: () => Record<string, unknown> | Promise<Record<string, unknown>>
  /** GET /api/machines — the user's full machine list from the backend, through this daemon's own sign-in, so a local
   *  GUI client never needs a token of its own: the core's, which answers it from its own copy while the gateway is away
   *  and signed out without starting it (core/gatewayLink.ts `machines`). */
  onMachinesList?: () => Promise<PairOutcome>
  /** POST /api/daemon/stop — `harness stop` on Windows (core/daemonStopRoute.ts). Trusted local only: over TCP any
   *  process on the machine, another user's included, could stop this user's daemon. Given on Windows only; without
   *  it the route does not exist (404), as before on a Mac or Linux. */
  onDaemonStop?: () => Promise<PairOutcome>
  onSharedHarnesses?: () => Promise<PairOutcome>
  /** GET/PATCH /api/agent-settings — what the person lets agents do (lib/agentSettings.ts): the account's experiments
   *  as this computer keeps them, and a change written through to the account (`harness settings`, and an older
   *  window's Settings ▸ Agents). The write is CSRF-guarded like the others. */
  onAgentSettingsRead?: () => Promise<PairOutcome>
  onAgentSettingsWrite?: (body: unknown) => Promise<PairOutcome>
  /** The account's Experimental switches, proxied with the daemon's own identity; what they say of agents is kept
   *  here too (core/experiments.ts `createAgentSettingsSync`). */
  onExperimentalRead?: () => Promise<PairOutcome>
  onExperimentalWrite?: (body: unknown) => Promise<PairOutcome>
}

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

const GATEWAY_HEADER = 'x-harness-hook-gateway', CODEX_HOME_HEADER = 'x-harness-hook-codex-home'

/**
 * What a hook says of its own environment, in two headers: a daemon that does not read a header ignores it, where it
 * refuses a body with a field it does not list. Each is judged alone: a refused one is named, never the request.
 */
export function hookFacts(req: Pick<http.IncomingMessage, 'headers'>, platform?: NodeJS.Platform): { gateway?: 'ori' | null; codexHome?: string; refused: string[] } {
  const facts: { gateway?: 'ori' | null; codexHome?: string; refused: string[] } = { refused: [] }
  const gateway = req.headers[GATEWAY_HEADER]
  if (gateway === 'ori') facts.gateway = 'ori'
  else if (gateway === 'none') facts.gateway = null
  else if (gateway !== undefined) facts.refused.push(GATEWAY_HEADER)
  const home = req.headers[CODEX_HOME_HEADER]
  if (home !== undefined) {
    // Percent-encoded by the hook: Node refuses a header value above U+00FF, and a path may hold any character.
    let decoded: string | undefined
    try { decoded = typeof home === 'string' ? decodeURIComponent(home) : undefined } catch { decoded = undefined }
    // Absolute as agent_create takes a home: on Windows a drive's path. A share's or a device's would have the core's
    // realpath open another computer's folder on every registration.
    if (decoded !== undefined && homeIsAbsolute(decoded, platform) && decoded.length <= 1_024 && !/[\u0000-\u001f\u007f]/.test(decoded)) facts.codexHome = decoded
    else facts.refused.push(CODEX_HOME_HEADER)
  }
  return facts
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
      } else if (hint.backend === 'ptyhost') {
        // A Harness pty host pane, as its shell names itself (`HARNESS_PANE=<instance>:%N`, hook/notify.mjs): the
        // instance and the pane, nothing else.
        if (Object.keys(hint).some((field) => !['backend', 'instance', 'paneId'].includes(field))
          || typeof hint.instance !== 'string' || !PTY_HOST_INSTANCE.test(hint.instance)
          || typeof hint.paneId !== 'string' || !/^%\d{1,9}$/.test(hint.paneId)) return false
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

function readBody(req: http.IncomingMessage, maximum = MAX_HOOK_BODY_BYTES): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    let bytes = 0
    let oversized = false
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > maximum) { oversized = true; data = ''; return }
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
      else if (hint?.backend === 'ptyhost' && PTY_HOST_INSTANCE.test(hint.instance) && /^%\d{1,9}$/.test(hint.paneId)) {
        hints.push({ backend: 'ptyhost', instance: hint.instance, paneId: hint.paneId })
      }
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
async function inspectHermesKind(sessionId: string, knownHome?: string, capture?: (verify: () => void) => void): Promise<AdmissionDecision<string | undefined>> {
  if (!HERMES_SOURCE.id.test(sessionId)) return { kind: 'accept', value: undefined }
  try {
    const found = await readStorePool(HERMES_HOMES, env.HERMES_HOME, {
      sql: columns => storeSourceQuery(HERMES_SOURCE, columns), params: [sessionId], maxRows: 1, maxBuffer: HERMES_SOURCE.maxBuffer,
      columns: ['id', 'source'], pointKey: 'id', knownHome, capture,
    })
    if (!found.length) return { kind: 'hold', reason: 'Waiting for the Hermes session source record; keeping the current conversation.' }
    if (found.length !== 1) return { kind: 'hold', reason: 'Hermes session source is ambiguous across homes; keeping the current conversation.' }
    const { home, aliases, row } = found[0]
    if (knownHome && !aliases.includes(knownHome)) return { kind: 'hold', reason: 'Waiting for the Hermes source in its known home; keeping the current conversation.' }
    // A unified-runtime row names its creator separately; an unstamped one waits like a row not written yet.
    const source = rowSessionSource(HERMES_SOURCE, row)
    if (source === null) return { kind: 'hold', reason: 'Waiting for the Hermes session creator to be recorded; keeping the current conversation.' }
    if (typeof source !== 'string' || source.length > 128) throw new IdentityReadUnavailable('the Hermes source record is invalid')
    if (!isInteractiveSource(HERMES_SOURCE, source)) return { kind: 'reject', reason: 'hermes_subagent' }
    return { kind: 'accept', value: knownHome ?? (home === env.HERMES_HOME ? undefined : home) }
  } catch (error) {
    if (!(error instanceof IdentityReadUnavailable)) throw error
    return { kind: 'hold', reason: `Hermes session source is unavailable; keeping the current conversation. ${error.message}` }
  }
}

/**
 * The pane a client environment names, as the hook names its own (hook/notify.mjs `ptyHostPane`): a tmux pane's
 * `TMUX_PANE` first, else a pty host pane's `HARNESS_PANE=<instance>:%N`.
 */
export function clientEnvPane(clientEnv: unknown): HookTerminalHint | null {
  if (typeof clientEnv !== 'string' || clientEnv.length > HERMES_SESSION_PANE.maxBuffer) return null
  let parsed: unknown
  try { parsed = JSON.parse(clientEnv) } catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const { TMUX_PANE: tmuxPane, HARNESS_PANE: ptyPane } = parsed as Record<string, unknown>
  if (typeof tmuxPane === 'string' && tmuxPane) return /^%\d+$/.test(tmuxPane) ? { backend: 'tmux', paneId: tmuxPane } : null
  const pty = typeof ptyPane === 'string' ? PTY_HOST_PANE.exec(ptyPane) : null
  return pty ? { backend: 'ptyhost', instance: pty[1]!, paneId: pty[2]! } : null
}

/** The pane Hermes froze with [sessionId] when it was created (`HERMES_SESSION_PANE`), or null: none, or unreadable. */
async function hermesCreationPane(sessionId: string, capture?: (verify: () => void) => void): Promise<HookTerminalHint | null> {
  try {
    const found = await readStorePool(HERMES_HOMES, env.HERMES_HOME, {
      sql: HERMES_SESSION_PANE.query, params: [HERMES_SESSION_PANE.key(sessionId), sessionId], maxRows: 1,
      maxBuffer: HERMES_SESSION_PANE.maxBuffer, columns: ['id'], pointKey: 'id', capture,
    })
    return found.length === 1 ? clientEnvPane(found[0].row.client_env) : null
  } catch (error) {
    if (!(error instanceof IdentityReadUnavailable)) throw error
    console.log(`[hooks] ${sid(sessionId)} hermes session pane unreadable · ${error.message}`)
    return null
  }
}

/**
 * Where a hook that came through Hermes' shared gateway belongs. The pane its session was created from, while a Hermes
 * agent is on it; else the pane of the agent the session is already bound to (a restore or resume opens the same
 * conversation in a new pane, and Hermes keeps the creation policy); else the creation pane, for an agent that is still
 * opening there. Null: neither is known, so nothing says which pane the session is.
 */
async function hermesSessionHint(sessionId: string, capture?: (verify: () => void) => void): Promise<HookTerminalHint | null> {
  const created = await hermesCreationPane(sessionId, capture)
  if (created && registry.byRuntimeEngine(created, 'hermes')) return created
  const bound = registry.bySession(sessionId)
  const runtime = bound?.engine === 'hermes' ? bound.runtimes[0] : undefined
  if (runtime) return runtime.backend === 'tmux' ? { backend: 'tmux', paneId: runtime.paneId }
    : { backend: 'ptyhost', instance: runtime.instance, paneId: runtime.paneId }
  return created
}

export interface HookServerOptions {
  /** Controls only the HTTP reply grace; persistence and request deadlines retain their own clocks. */
  replyClock?: { after: (milliseconds: number, callback: () => void) => () => void }
  /** Whether a TCP caller runs as this OS account (lib/peerAccount.ts). A test's stand-in for another account. */
  peerAccount?: PeerAccount
  /** Also serve on this Unix socket, or with pipeToken the Windows pipe (see lib/localSocket.ts). Null or absent: TCP only. */
  socketPath?: string | null
  /** Windows: the daemon's token. When given, `socketPath` is a pipe whose every request proves it (lib/localSocket.ts). */
  pipeToken?: Buffer | null
  /** A private socket identifies this user's daemon even when another OS user holds the TCP port. */
  allowPortFallback?: boolean
  /** Completed acknowledgements are retained for a live process, never evicted to admit another hook. */
  admissionReceiptCapacity?: number
  /** Bound native payload and provenance retained by pending admission or linked Stop. */
  admissionBytesCapacity?: number
}

/** The `/api/status` fields a caller without the local credential is answered. */
// Which daemon this is (its pid and computer, as a takeover or a status check compares) and where its socket
// is — never the account, its folders or its connections.
const PUBLIC_STATUS_FIELDS = ['version', 'pid', 'corePid', 'computerId', 'localWs', 'localSocket', 'supported'] as const

function publicStatus(status: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { credentialRequired: true }
  for (const key of PUBLIC_STATUS_FIELDS) if (key in status) out[key] = status[key]
  return out
}

export function startHookServer(
  port: number,
  handlers: HookServerHandlers,
  options: HookServerOptions = {},
): Promise<{ server: http.Server; port: number; localSocket: LocalSocketServer | null }> {
  const hookCredential = loadOrCreateHookCredential(env.ADAPTER_DATA_DIR)
  const hookToken = loadOrCreateHookToken(env.ADAPTER_DATA_DIR)
  const peerAccount: PeerAccount = options.peerAccount ?? peerIsThisAccount
  const replyClock = options.replyClock ?? { after: (milliseconds: number, callback: () => void) => {
    const timer = setTimeout(callback, milliseconds)
    timer.unref()
    return () => clearTimeout(timer)
  } }
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
  /** Apart from a refused host's minute: a pane whose binding went stale, refused every turn, never hides one. */
  let lastUnboundLogAt = 0
  const handle: http.RequestListener = (req, res) => {
    void (async () => {
      const url = (req.url ?? '').split('?')[0]
      const json = (code: number, body: unknown): void => {
        res.writeHead(code, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      // Over the daemon's own socket the filesystem already said who this is, and over its Windows pipe the request
      // proved the daemon's token; no browser can get to either. Everything else must prove it was addressed to
      // this loopback server.
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
      /** A route a service answers (core/serviceRoutes.ts), written as it answered, with the headers its route declares:
       *  false when no service answers this path and method. Whether a write carries the local header, and whether it came
       *  over the daemon's own socket, is its route's to ask, and its body is read only then, up to its route's bound. */
      const serviceRoute = async (): Promise<boolean> => {
        const routed = handlers.onServiceRoute?.(url, { method: req.method ?? '', target: req.url ?? '', readBody: (max) => readBody(req, max) }, localOk, trustedLocal)
        if (!routed) return false
        const result = await routed
        for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value)
        json(result.status, result.body)
        return true
      }
      // An engine hook's token, which opens these hook routes and nothing else (lib/hookAuth.ts). The credential
      // is still taken here: an engine's loaded plugin keeps the copy it started with until its pane restarts. A
      // guest's harness will carry a token scoped to its own agent (docs/plans/2026-10-19-guest-machine-sharing-plan.md).
      // Over TCP either may have been heard by another account that held this port during a restart (audit H1), which
      // could then forge session ends or turn stops here, so it counts only from this one. Asked only once it matched.
      const suppliedHookToken = req.headers['x-harness-hook-token']
      // One answer per request: a lookup that gave no answer is not kept on the socket (lib/peerAccount.ts), and the two
      // checks below asking it twice waited out a slow lsof twice and could disagree.
      let callerAnswer: Promise<boolean | 'unanswered'> | undefined
      const callerIsThisAccount = async () => await (callerAnswer ??= peerAccount(req.socket)) === true
      const hookOk = trustedLocal || ((hookCredentialMatches(hookToken, suppliedHookToken) || hookCredentialMatches(hookCredential, suppliedHookToken)) && await callerIsThisAccount())
      // The loopback port takes any local OS user's process, so over TCP every route but the few below
      // wants the daemon's local credential (lib/localCredential.ts): the 0600 file only this OS user can
      // read. Over the daemon's Unix socket the filesystem already said who this is. Over TCP the credential may have
      // been heard by another account that held this port during a restart (audit H1), so it counts only from this one.
      const credentialOk = trustedLocal || (localCredentialMatches(hookCredential, req) && await callerIsThisAccount())
      // A secret matched, but who is calling could not be looked up in time (a slow lsof, a busy Windows): not a refusal.
      // The client asks again (lib/localTransport.ts). Liveness and the public status answer as ever.
      if (callerAnswer && await callerAnswer === 'unanswered' && !(req.method === 'GET' && (url === '/api/health' || url === '/api/status'))) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' })
        res.end(JSON.stringify({ error: PEER_LOOKUP_UNANSWERED, message: PEER_LOOKUP_UNANSWERED_MESSAGE })); return
      }
      // Open without it: liveness, the status a discovery reads (cut down, below), the hook routes (their
      // own token, above) and the native device routes (their own bearer, just below).
      const open = (req.method === 'GET' && (url === '/api/health' || url === '/api/status'))
        || url.startsWith('/api/hook/') || url.startsWith('/api/autonomous-device/')
      if (!credentialOk && !open) { json(401, { error: LOCAL_CREDENTIAL_REQUIRED }); return }

      if (url.startsWith('/api/autonomous-device/')) {
        const peer = req.socket.remoteAddress
        const loopback = trustedLocal || peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1'
        const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined
        if (!loopback || req.headers.origin || !hookCredentialMatches(hookCredential, bearer) || !credentialOk) {
          json(403, { error: { code: 'FORBIDDEN', message: 'Authenticated native loopback client required' } }); return
        }
        // The Wi-Fi device's services', as the client sent it: the gateway's, its service's and the machine add-ons'.
        if (!await serviceRoute()) json(503, { error: { code: 'UNAVAILABLE', message: 'Autonomous device service unavailable' } })
        return
      }
      if (req.method === 'GET' && url === '/api/health') {
        json(200, { ok: true, version: VERSION }); return
      }

      // The local web dashboard that `GET /` served, with its log tail (`/api/logs`) and stop button
      // (`/api/stop`), is gone: no app, website, script or the backend opened it, and the web client
      // it linked from retired with the browser setup links (#348). `harness stop` stops the daemon
      // through its pid, never through here.
      if (req.method === 'GET' && url === '/api/status') {
        const status = handlers.onStatus ? await handlers.onStatus() : { supported: false }
        // Without the credential, only what says a daemon is here and where its socket is: nothing about
        // the account, its folders or its connections.
        json(200, credentialOk ? status : publicStatus(status)); return
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
        // Only a refused header's name is logged: its value is a path or a word of the hook's own environment.
        const refusedHeader = (name: string) => console.warn(`[hooks] ${sid(body.sessionId ?? '?')} ${body.hookEvent ?? 'session-start'} header refused · ${name}`)
        const { refused, ...taken } = hookFacts(req)
        for (const name of refused) refusedHeader(name)
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
        let runtimeHints = normalizedRuntimeHints(body)
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
        // A Hermes 0.22+ hook runs in the shared gateway, with the gateway's pane (or none) and ancestry. Those named
        // the first Hermes pane for every session (DESKTOP-0TFH0OJ, 2026-11-09: `5afb24e8 rebound local-fc`, a
        // conversation typed in another pane). Its session's own pane replaces them, and is the only evidence.
        // After the order and fingerprint are taken: they are the delivery's as it was sent.
        let bySessionPane = false
        if (engine === 'hermes' && body.callerPid && handlers.hookViaSharedProcess
          && await handlers.hookViaSharedProcess({ engine, callerPid: body.callerPid })) {
          const hint = body.sessionId ? await hermesSessionHint(body.sessionId) : null
          if (!hint) { ignore('hermes_gateway_session_has_no_pane'); return }
          runtimeHints = [hint]
          bySessionPane = true
          body.tmuxPane = hint.backend === 'tmux' ? hint.paneId : undefined
        }
        if (!runtimeHints.length) { ignore('not_in_terminal'); return }
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
            ...(bySessionPane ? { bySessionPane } : {}),
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
        let committed: Awaited<ReturnType<typeof registry.register>> = null
        let cancelReplyTimer: (() => void) | undefined
        let committing = false, settled = false, stopRetained = false, stopUnmatched = false, stopInvocationClaimed = false
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
          cancelReplyTimer?.()
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
          cancelReplyTimer?.()
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
          if (!runtimeHints.some(hint => row.runtimes.some(runtime => runtime.backend === hint.backend && runtime.paneId === hint.paneId
            // A paneId is only unique within one pty host.
            && (hint.backend !== 'ptyhost' || (runtime.backend === 'ptyhost' && runtime.instance === hint.instance))))) {
            return { kind: 'hold', reason: 'Waiting for the original hook pane to belong to its engine process.' }
          }
          inspectionIdentity = paneReadIdentity(row)
          prepared = { ...body, ...taken, processIdentity: row.processIdentity ? { ...row.processIdentity } : undefined,
            runtimes: row.runtimes.map(runtime => ({ ...runtime })), primaryRuntimeKey: row.primaryRuntimeKey,
            transcriptPath: knownTranscriptFor(body, row) }
          const admission = admitHook(engine, prepared)
          if (!admission.accepted) return admission.reason === 'engine_hook_failed'
            ? { kind: 'hold', reason: 'Waiting for complete native hook evidence.' } : { kind: 'reject', reason: admission.reason }
          return null
        }
        const commit = async (hermesHome: string | undefined, admissionCurrent: () => boolean): Promise<AdmissionDecision<string | undefined>> => {
          if (!current() || paneReadIdentity(live()) !== inspectionIdentity) return { kind: 'hold', reason: 'Waiting for fresh evidence after the binding changed.' }
          if (handlers.hookAdmissionBlocked?.(processAgent.agentId)) return { kind: 'hold', reason: 'Waiting for Stop to settle before admitting the hook.' }
          const prior = live()
          const before = prior && { sessionId: prior.sessionId, transcriptPath: prior.transcriptPath,
            held: !!(prior.identityHold || prior.interpretationHold) }
          let verifySource: (() => void) | undefined, verifyPane: (() => void) | undefined
          committing = true
          try {
            committed = await registry.register(hermesHome ? { ...prepared, hermesHome } : prepared, { verifiedNativeSource: true,
              ...(engine === 'hermes' && body.sessionId ? { refresh: async () => {
                if (bySessionPane) {
                  const hint = await hermesSessionHint(body.sessionId!, verify => { verifyPane = verify })
                  if (JSON.stringify(hint) !== JSON.stringify(runtimeHints[0])) {
                    throw new IdentityReadUnavailable('the Hermes session pane changed during registration')
                  }
                }
                const refreshed = await inspectHermesKind(body.sessionId!, live()?.hermesHome ?? undefined, verify => { verifySource = verify })
                if (refreshed.kind !== 'accept' || refreshed.value !== hermesHome) {
                  throw new IdentityReadUnavailable('the Hermes session source changed during registration')
                }
              } } : {}),
              current: () => {
                verifyPane?.()
                verifySource?.()
                return admissionCurrent() && current() && paneReadIdentity(live()) === inspectionIdentity
                  && !handlers.hookAdmissionBlocked?.(processAgent.agentId)
              } })
          } finally { committing = false }
          if (committed?.refusedHome) refusedHeader(CODEX_HOME_HEADER)
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
          const owner = live()
          if (!owner || !current() || paneReadIdentity(owner) !== committedIdentity) {
            console.warn('[hooks] committed admission notification skipped: owner changed')
            return
          }
          // Core cleared the live admission hold; the durable commit reply is a detached snapshot.
          result.entry = structuredClone(owner)
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
            // A registry commit has its own bounded deadline and owns its reply.
            // A queued predecessor or asynchronous source still answers pending.
            if (engine === 'hermes') answer(200, { pending: true })
            else setImmediate(() => {
              if (settled) return
              const pending = () => { if (!settled) deferred = true; answer(200, { pending: true }) }
              if (committing) {
                // The hook process itself has a five-second timeout. Slow durable
                // preparation retains the delivery while its caller leaves promptly.
                cancelReplyTimer = replyClock.after(250, pending)
              } else pending()
            })
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

      /** 403 to a hook its session's process did not send. Said at most once a minute, as a refused host is, in a minute
       *  of its own: a pane whose binding went stale sends one every turn. */
      const refuseUnbound = (sessionId: string | undefined, route: string): void => {
        if (Date.now() - lastUnboundLogAt > 60_000) {
          lastUnboundLogAt = Date.now()
          console.warn(`[hooks] ${sid(sessionId ?? '?')} ${route} refused · unbound`)
        }
        json(403, { error: 'UNBOUND_HOOK' })
      }
      /** A hook read, checked and bound to its session's process, and what `takes` says of its body: null once refused. */
      const boundHook = async (route: string, takes = (_: BoundHookBody) => true): Promise<BoundHookBody & { sessionId: string } | null> => {
        if (!hookOk) { json(401, { error: 'UNAUTHORIZED' }); return null }
        let body: BoundHookBody
        try {
          const parsed = JSON.parse(await readBody(req)) as unknown
          if (!validHookBody(parsed) || !takes(parsed)) { json(400, { error: 'invalid hook body' }); return null }
          body = parsed
        } catch { json(400, { error: 'bad json' }); return null }
        const owner = await verifiedBoundMutation(body, handlers)
        if (!owner) { refuseUnbound(body.sessionId, route); return null }
        return { ...body, sessionId: owner.sessionId }
      }

      if (req.method === 'POST' && url === '/api/hook/session-end') {
        const hook = await boundHook('session-end')
        if (!hook) return
        console.log(`[hooks] ${sid(hook.sessionId)} session-end${hook.reason ? ` · reason=${hook.reason}` : ''}`)
        handlers.onSessionEnd(hook.sessionId, hook.reason)
        json(200, { ok: true })
        return
      }

      if (req.method === 'POST' && url === '/api/hook/tool-start') {
        const hook = await boundHook('tool-start')
        if (!hook) return
        if (hook.toolUseId && hook.toolName) {
          console.log(`[hooks] ${sid(hook.sessionId)} tool-start · tool=${hook.toolName}`)
          handlers.onToolStart?.({ sessionId: hook.sessionId, toolUseId: hook.toolUseId, toolName: hook.toolName, input: hook.input })
        }
        json(200, { ok: true })
        return
      }

      if (req.method === 'POST' && url === '/api/hook/turn-start') {
        const hook = await boundHook('turn-start')
        if (!hook) return
        handlers.onTurnStart?.({ sessionId: hook.sessionId })
        json(200, { ok: true })
        return
      }

      if (req.method === 'POST' && url === '/api/hook/observed') {
        if (!hookOk) { json(401, { error: 'UNAUTHORIZED' }); return }
        let body: unknown
        // 4 KB: an event is a few ids and paths. Over the limit readBody gives '', which is not JSON.
        try { body = JSON.parse(await readBody(req, 4096)) as unknown } catch { json(400, { error: 'bad json' }); return }
        // A dropped event (rate limited, or the devices not there) is not the hook's error: it never retries.
        if (handlers.onObserved?.(body) === 'invalid') { json(400, { error: 'invalid observed body' }); return }
        json(200, { ok: true })
        return
      }

      if (req.method === 'POST' && url === '/api/hook/inbox') {
        if (!hookOk) { json(401, { error: 'UNAUTHORIZED' }); return }
        // Before the body is read: a mod whose Claude Code quit holds no poll the devices should still answer.
        const gone = new AbortController()
        res.once('close', () => { if (!res.writableEnded) gone.abort() })
        // The caller check was awaited above: a client that went during it closed before this listened, and is gone already.
        if (req.socket.destroyed) return
        let body: unknown
        // 1 KB: a session id.
        try { body = JSON.parse(await readBody(req, 1024)) as unknown } catch { json(400, { error: 'bad json' }); return }
        const answer = handlers.onInbox ? await handlers.onInbox(body, gone.signal) : 'off'
        if (gone.signal.aborted) return
        if (answer === 'invalid') { json(400, { error: 'invalid inbox body' }); return }
        // No device is not an empty hold: the mod asks again in 60 s, not at once.
        if (answer === 'off') { json(503, { error: 'NO_DEVICE' }); return }
        json(200, answer)
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
        if (!owner) { refuseUnbound(body.sessionId, 'turn-stop'); return }
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

      if (req.method === 'POST' && url === '/api/hook/wait') {
        // That the engine waits and when, never on what: what the person is asked stays in the pane.
        const hook = await boundHook('wait', (body) => body.input === undefined && body.prompt === undefined)
        if (!hook) return
        const firedAt = hookFiredAt(req)
        handlers.onPersonWait?.({ sessionId: hook.sessionId, ...(firedAt ? { firedAt } : {}) })
        json(200, { ok: true })
        return
      }

      if (req.method === 'POST' && url === '/api/hook/subagent') {
        const hook = await boundHook('subagent', (body) => body.hookEvent === 'SubagentStart' || body.hookEvent === 'SubagentStop')
        if (!hook) return
        const firedAt = hookFiredAt(req)
        handlers.onSubagent?.({ sessionId: hook.sessionId, started: hook.hookEvent === 'SubagentStart', ...(firedAt ? { firedAt } : {}) })
        json(200, { ok: true })
        return
      }

      // Local GUI clients (the desktop app): the full machine list and the harnesses shared with this account, through this
      // daemon's own sign-in, so the local caller never holds a bearer token itself. The account's other routes are the
      // gateway's (below, `onServiceRoute`).
      if (req.method === 'GET' && url === '/api/machines') {
        const list = handlers.onMachinesList
        if (!list) { json(503, { error: 'UNAVAILABLE' }); return }
        await proxied(list); return
      }
      if (req.method === 'GET' && url === '/api/harness-shares') {
        if (!handlers.onSharedHarnesses) { json(503, { error: 'UNAVAILABLE' }); return }
        await proxied(handlers.onSharedHarnesses); return
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
      if (req.method === 'PATCH' && url === '/api/experimental-settings') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onExperimentalWrite) { json(503, { error: 'UNAVAILABLE' }); return }
        let body: unknown
        try { body = JSON.parse(await readBody(req)) } catch { json(400, { error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }); return }
        await proxied(() => handlers.onExperimentalWrite!(body)); return
      }
      // Stopping the daemon ends every agent's link to it: like the phone's sign-in code (`ServiceHttpRoute.door`), the
      // daemon's own trusted endpoint only (the owner's socket; on Windows its pipe, with the token's proof, lib/localSocket.ts).
      // Windows only: the route exists when its handler is given (core/daemonStopRoute.ts daemonStopRoute).
      if (req.method === 'POST' && url === '/api/daemon/stop' && handlers.onDaemonStop) {
        if (!trustedLocal || !localOk) { json(403, { error: 'FORBIDDEN' }); return }
        await proxied(handlers.onDaemonStop); return
      }
      // A route a service answers (core/api.ts `SERVICE_HTTP_ROUTES`): the account's (the desk, Agent Messages' tabs, the
      // account's name, the phone half of a sign-in and the phone's sign-in code, the usage reports and choice, a machine's
      // rename and delete, the Store's ratings and reviews) and the keys' (`harness pair`, `unpair`, `remote-password`,
      // `link connect`, `group`, `devices`), each the gateway's. The door's checks above are done. Never one of the paths
      // open without the local credential (a hook's): a caller that has not shown it reaches no service here.
      if (credentialOk && await serviceRoute()) return
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
      // The permission hook (deviceClaude/asked.ts) and the mod's voice poll post only over the socket, so without one the
      // person sees why the dial shows no waiting prompt and takes no voice.
      const tcpOnly = (): void => {
        console.warn('[hooks] the dial\'s waiting prompts and voice from the Claude Code plugin are off: no Unix socket')
        resolve({ server, port: actual, localSocket: null })
      }
      const socketPath = options.socketPath
      if (!socketPath) { tcpOnly(); return }
      // The private socket is mandatory when opting into multi-user startup. A duplicate daemon
      // must not survive on a random port while another one owns this user's socket.
      listenLocalSocket(handle, socketPath, { token: options.pipeToken ?? undefined }).then(
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
          tcpOnly()
        },
      )
    })
    server.listen(port, '127.0.0.1')
  })
}
