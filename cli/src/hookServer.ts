/**
 * Tiny localhost HTTP server for the Claude Code hook callbacks. `hook/notify.mjs` POSTs here on
 * SessionStart/SessionEnd (127.0.0.1:<PORT>). This replaces the old Fastify routes — the browser
 * UI is gone; only these two endpoints remain local.
 */

import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { readCodexRolloutMeta } from './engines/codex/rollout.js'
import { hermesSessionSource, isHermesInteractiveSource } from './engines/hermes/reader.js'
import { hermesDbPath, listHermesHomes } from './engines/hermes/home.js'
import { isRecentlyDeleted } from './lib/deletedSessions.js'
import { registry, type RegisterInput, type RegisteredSession } from './lib/registry.js'
import type { GateVerdict } from './lib/actionPolicy.js'
import { LOCAL_WEB_HTML } from './webui.js'
import { sid } from './lib/log.js'
import { VERSION } from './version.js'
import { env } from './config/env.js'
import { hookCredentialMatches, loadOrCreateHookCredential } from './lib/hookAuth.js'
import { routeStoreRequest, type StoreHandler } from './lib/storeProxy.js'
import type { HookTerminalHint } from './lib/terminalTypes.js'
import { ENGINES, type AgentEngine } from './engines/types.js'
import type { CommandBarService } from './lib/commandBar.js'
import { handleCommandBarHttp } from './lib/commandBarHttp.js'
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

export interface NativePromptContext { additionalContext: string; memoryReceiptId?: string }
type PromptContext = NativePromptContext | string | null

/** Optional recall must never hang an engine's prompt or expose a failed lookup as a hook failure. */
async function boundedPromptContext(read: () => PromptContext | Promise<PromptContext>): Promise<NativePromptContext | null> {
  let timer: NodeJS.Timeout | undefined
  try {
    const result = await Promise.race([Promise.resolve().then(read),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 225) })])
    const context = typeof result === 'string' ? { additionalContext: result } : result
    if (!context || typeof context.additionalContext !== 'string' || !context.additionalContext
      || Buffer.byteLength(context.additionalContext) > 8_000) return null
    return { additionalContext: context.additionalContext,
      ...(typeof context.memoryReceiptId === 'string' && /^[a-f0-9-]{36}$/.test(context.memoryReceiptId)
        ? { memoryReceiptId: context.memoryReceiptId } : {}) }
  } catch { return null } finally { if (timer) clearTimeout(timer) }
}

export interface HookServerHandlers {
  /** Context for a verified process-owned agent, only on its real user turn. */
  onPromptContext?: (agentId: string, prompt: string) => PromptContext | Promise<PromptContext>
  /** Shared recall for a live, process-verified native adapter. Scope always comes from the host. */
  onMemoryContext?: (agentId: string, prompt: string, adapter: { engine: AgentEngine; cliVersion: string }) => PromptContext | Promise<PromptContext>
  /** Called only for the same process-owned native session after its hook writes context to stdout. */
  onMemoryContextEmitted?: (agentId: string, receiptId: string) => Promise<boolean>
  /** Private, process-verified OpenCode request metadata. Never enters the session registry or clients. */
  onOpenCodeMemoryRuntime?: (agent: RegisteredSession, input: unknown) => Record<string, unknown>
  onCommandBar?: Pick<CommandBarService, 'status' | 'decide'>
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
  ) => void

  /** SessionEnd — a reconciliation hint only; it is never process-lifetime authority. */
  onSessionEnd: (sessionId: string, reason: string | undefined) => void
  /** Ensure a matching process-owned agent exists before a hook binds its mutable engine session. */
  resolveHookAgent?: (session: {
    engine: RegisteredSession['engine']
    tmuxPane?: string
    runtimeHints: HookTerminalHint[]
    callerPid?: number
  }) => Promise<RegisteredSession | null>
  /** A turn is now running (Command Code's PreToolUse — its only live turn-open signal). Idempotent:
   *  it fires once per tool call, and every call after the first in a turn must be a no-op. */
  onTurnStart?: (body: { sessionId: string }) => void
  onPromptSubmitted?: (agentId: string, prompt: string) => void
  onToolStart?: (body: {
    sessionId: string
    toolUseId: string
    toolName: string
    input: unknown
  }) => void | GateVerdict | Promise<void | GateVerdict>
  /** GET /api/attention: every agent's attention state for the bar widget and other local readers. */
  onAttention?: () => unknown
  /** GET /api/subscriptions: every plan's weekly used, banked, reset and the next-plan verdict. */
  onSubscriptions?: () => Promise<unknown>
  /** POST /api/stop-all: cancel every agent's turn except one (the panic stop). */
  onStopAll?: (exceptAgentId: string | null) => Promise<{ cancelled: string[] }>
  /** POST /api/fleet {action, ...args}: the local command surface behind the fleet `harness` commands. */
  onFleet?: (action: string, args: Record<string, unknown>) => Promise<unknown>
  onTurnStop?: (body: {
    sessionId: string
    status?: string
    transcriptPath?: string
  }) => void
  /** `harness pair <code>` from a second CLI process: run CPace toward the waiting browser. */
  onPair?: (code: string) => Promise<PairOutcome>
  /** `harness pairings` — list E2EE-paired browsers. */
  onListPairs?: () => PairOutcome
  /** `harness unpair <id>` — unpair one browser (by fingerprint/prefix/index). */
  onRevoke?: (id: string) => PairOutcome
  /** `harness unpair --all` — unpair every browser. */
  onRevokeAll?: () => PairOutcome
  /** `harness remote-password set` — stretch + persist a new persistent remote password on the
   *  running daemon's live E2EE state. */
  onSetRemotePassword?: (password: string) => Promise<PairOutcome>
  /** `harness remote-password clear` — remove the persistent remote password. */
  onClearRemotePassword?: () => PairOutcome
  /** `harness remote-password status` — whether one is set, and its fingerprint. */
  onRemotePasswordStatus?: () => PairOutcome
  /** `harness link connect` — the machine this one just linked pinned it back, so trust that machine
   *  here too (the mutual half of the link). Goes through the daemon: it holds paired.json in memory. */
  onTrustLinkedPeer?: (peer: { pub: string; machineId: string; label: string }) => PairOutcome
  /** `harness group list|sync|remove` — the trust group this machine belongs to (groupSyncer.ts). */
  onGroupList?: () => PairOutcome
  onGroupSync?: () => PairOutcome
  onGroupRemove?: (selector: string) => PairOutcome
  /** `harness devices list|remove|rebaseline` and the window's Devices list — the account's device key
   *  log as this machine verified it (lib/e2ee/deviceLogSyncer.ts). */
  onDevicesList?: () => Promise<PairOutcome>
  onDevicesRemove?: (pub: string) => Promise<PairOutcome>
  onDevicesRebaseline?: (confirm: boolean, head?: { seq: number; hash: string }) => Promise<PairOutcome>
  /** `harness devices history` and the window's History — every add and remove, as this machine verified it. */
  onDevicesHistory?: () => Promise<PairOutcome>
  /** `harness devices dismiss` and the window's "It's mine" / "Got it" — mark new devices as seen. */
  onDevicesDismiss?: (body: { pub?: string; pubs?: string[]; baseline?: boolean }) => PairOutcome
  /** Local dashboard status snapshot (GET /api/status). */
  onStatus?: () => Record<string, unknown> | Promise<Record<string, unknown>>
  /** Recent adapter log tail (GET /api/logs). */
  onLogs?: () => string
  /** Stop the adapter from the local dashboard (POST /api/stop). */
  onStop?: () => void
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
  /** GET /api/zoo — the account's daemons and eggs (daemons/README.md); proxied like the desk. */
  onZooRead?: () => Promise<PairOutcome>
  /** POST /api/zoo/ops — habits, hatches, pair and nickname, applied on the backend (its routes/zoo.ts),
   *  which alone draws; a local write, so CSRF-guarded like the desk's ops. */
  onZooOps?: (body: unknown) => Promise<PairOutcome>
  /** /api/store/* — proxy the Harness Store's ratings and reviews to backend the same way: reads
   *  ungated like the machine list, writes (PUT/DELETE) CSRF-guarded like a rename. See storeProxy.ts. */
  onStore?: StoreHandler
}

export { STORE_PATH_RE } from './lib/storeProxy.js'

const MAX_HOOK_BODY_BYTES = 256 * 1024
const HOOK_BODY_FIELDS = new Set([
  'engine', 'launcherId', 'sessionId', 'transcriptPath', 'cwd', 'source', 'tmuxPane', 'title', 'model',
  'cliVersion', 'runtimeHints', 'callerPid', 'hookEvent', 'pluginVersion', 'reason', 'status', 'toolUseId',
  'toolName', 'input', 'prompt', 'memoryReceiptId',
])

function optionalBoundedString(value: unknown, max: number): boolean {
  return value === undefined || value === null || (typeof value === 'string'
    && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value))
}

function optionalBoundedJson(value: unknown, max: number): boolean {
  if (value === undefined) return true
  try { return Buffer.byteLength(JSON.stringify(value)) <= max } catch { return false }
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
    || !optionalBoundedString(body.memoryReceiptId, 36)
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
  memoryReceiptId?: string
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
    ? processAgent
    : null
}

/**
 * Bind the localhost hook server on a FIXED `port` (no OS free-port fallback — a random fallback made
 * a leftover daemon un-findable by `lsof :<port>`). Rejects with EADDRINUSE if the port is taken (the
 * CLI reports it as "another adapter already running"). Resolves with the bound port.
 */
/** How long to keep waiting for an engine to write the transcript it just announced. */
const TRANSCRIPT_WAIT_MS = 500
const HERMES_KIND_TRIES = 6
const HERMES_KIND_WAIT_MS = 120
const TRANSCRIPT_WAIT_TRIES = 20

function registeredHookProcess(body: RegisterInput, engine: AgentEngine): RegisteredSession | undefined {
  if (body.processIdentity) {
    const processAgent = registry.byProcess(engine, body.processIdentity)
    if (processAgent) return processAgent
  }
  for (const runtime of body.runtimes ?? []) {
    const processAgent = registry.byRuntimeEngine(runtime, engine)
    if (processAgent) return processAgent
  }
  return body.tmuxPane ? registry.byPaneEngine(body.tmuxPane, engine) : undefined
}

/**
 * `claude --resume` from a folder other than the conversation's own: Claude Code announces a transcript
 * under the CURRENT cwd's project dir, then keeps writing the original file (measured: a resume of
 * 73f090ca from `cli/` announced `…-openharness-cli/73f090ca.jsonl`, and every later turn still landed
 * in `…-openharness/73f090ca.jsonl`). The announced file never appears, the hook is dropped, and the
 * resume is never confirmed — "Start failed" over a pane that is working. The row being resumed already
 * knows the real file; take it when it names this very conversation.
 */
export function knownTranscriptFor(body: RegisterInput, agent: RegisteredSession | undefined): string | undefined {
  const announced = body.transcriptPath
  if (!announced || existsSync(announced) || (body.engine ?? 'claude') !== 'claude') return announced
  const known = agent?.transcriptPath
  if (!known || !body.sessionId || agent.sessionId !== body.sessionId) return announced
  if (basename(known) !== `${body.sessionId}.jsonl` || !existsSync(known)) return announced
  return known
}

/**
 * Register once the announced transcript exists.
 *
 * Runs detached from the HTTP reply on purpose: this is a SessionStart hook, and the engine is blocked
 * until the response comes back. Bounded — an announcement whose file never appears is dropped, which is
 * the same outcome as before, just after giving the engine a fair chance to finish starting up.
 */
async function awaitTranscript(body: RegisterInput, handlers: HookServerHandlers): Promise<void> {
  for (let i = 0; i < TRANSCRIPT_WAIT_TRIES; i++) {
    await new Promise((resolve) => { const t = setTimeout(resolve, TRANSCRIPT_WAIT_MS); t.unref?.() })
    const engine = body.engine ?? 'claude'
    const processAgent = registeredHookProcess(body, engine)
    if (!processAgent) return
    if (isRecentlyDeleted(body.sessionId)) return
    body.transcriptPath = knownTranscriptFor(body, processAgent)
    if (!body.transcriptPath || !existsSync(body.transcriptPath)) continue
    const result = registry.register(body)
    if (!result) return
    console.log(`[hooks] ${sid(result.entry.sessionId)} ${body.hookEvent ?? 'session-start'} · engine=${result.entry.engine}`
      + ` · isNew=${result.isNew} · after waiting ${((i + 1) * TRANSCRIPT_WAIT_MS) / 1000}s for its transcript`)
    handlers.onRegistered(result.entry, { isNew: result.isNew, evicted: result.evicted, rebound: result.rebound, orphaned: result.orphaned, hookEvent: body.hookEvent })
    return
  }
  console.warn(`[hooks] ${sid(body.sessionId ?? '?')} announced a transcript that never appeared: ${body.transcriptPath}`)
}

/**
 * Re-check a hermes session whose `sessions` row had not landed yet, then register it only if it turns
 * out to be the user's own CLI session. Bounded: if the row never appears we register anyway, which is
 * exactly the behaviour before this guard existed.
 */
async function awaitHermesKind(body: RegisterInput, handlers: HookServerHandlers): Promise<void> {
  // EVERY home, not just the default. A `hermes -p <name>` session's row lives in that profile's own
  // store, so asking the default one answered `null` (unknown) six times and fell through — and, worse,
  // the home found here is the one the whole row then reads its history from (openharness#191).
  const homes = await listHermesHomes()
  let hermesHome: string | undefined
  for (let i = 0; i < HERMES_KIND_TRIES; i++) {
    if (i > 0) await new Promise((resolve) => { const t = setTimeout(resolve, HERMES_KIND_WAIT_MS); t.unref?.() })
    if (!registeredHookProcess(body, 'hermes')) return
    if (isRecentlyDeleted(body.sessionId)) return
    let source: string | null = null
    for (const home of homes) {
      const answer = await hermesSessionSource(hermesDbPath(home), body.sessionId ?? '')
      if (answer === null) continue          // not in this store — try the next home
      source = answer
      if (home !== env.HERMES_HOME) hermesHome = home
      break
    }
    if (source === null) continue
    if (!isHermesInteractiveSource(source)) {
      console.log(`[hooks] ${sid(body.sessionId ?? '?')} ${body.hookEvent ?? 'session-start'} ignored · hermes_subagent`)
      return
    }
    break
  }
  const result = registry.register(hermesHome ? { ...body, hermesHome } : body)
  if (!result) return
  console.log(`[hooks] ${sid(result.entry.sessionId)} ${body.hookEvent ?? 'session-start'} · engine=hermes · isNew=${result.isNew} · after a source check${hermesHome ? ` · home=${hermesHome}` : ''}`)
  handlers.onRegistered(result.entry, { isNew: result.isNew, evicted: result.evicted, rebound: result.rebound, orphaned: result.orphaned, hookEvent: body.hookEvent })
}

export interface HookServerOptions {
  /** Also serve on this Unix socket (see lib/localSocket.ts). Null or absent: TCP only. */
  socketPath?: string | null
  /** A private socket identifies this user's daemon even when another OS user holds the TCP port. */
  allowPortFallback?: boolean
}

export function startHookServer(
  port: number,
  handlers: HookServerHandlers,
  options: HookServerOptions = {},
): Promise<{ server: http.Server; port: number; localSocket: LocalSocketServer | null }> {
  const hookCredential = loadOrCreateHookCredential(env.ADAPTER_DATA_DIR)
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
      // simple request (it forces a CORS preflight we never allow), so only our same-origin dashboard
      // (and the CLI, which sends it too) can trigger actions. A local process could still call it —
      // same trust level as the CLI, which is acceptable on loopback.
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

      if (await handleCommandBarHttp(req, res, handlers.onCommandBar)) return

      // Local dashboard (self-contained page) + its read-only status/logs.
      if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(LOCAL_WEB_HTML); return
      }
      if (req.method === 'GET' && url === '/api/status') {
        json(200, handlers.onStatus ? await handlers.onStatus() : { supported: false }); return
      }
      // Attention snapshot for the bar widget and any local reader: loopback only, read-only, no
      // secrets (names, engines, states). Same trust as /api/status.
      if (req.method === 'GET' && url === '/api/attention') {
        json(200, handlers.onAttention ? handlers.onAttention() : { agents: [] }); return
      }
      if (req.method === 'GET' && (url === '/api/subscriptions' || url.startsWith('/api/subscriptions?'))) {
        if (!handlers.onSubscriptions) { json(503, { error: 'UNAVAILABLE' }); return }
        try { json(200, await handlers.onSubscriptions()) } catch (e) { json(500, { error: e instanceof Error ? e.message : 'INTERNAL' }) }
        return
      }
      // Panic stop: every agent's turn is cancelled except the one named. Mutating, so the same
      // same-origin guard as the other local mutations.
      if (req.method === 'POST' && url === '/api/stop-all') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onStopAll) { json(503, { error: 'UNAVAILABLE' }); return }
        let body: { except?: string } = {}
        try { const raw = await readBody(req); body = raw ? JSON.parse(raw) as { except?: string } : {} } catch { json(400, { error: 'bad json' }); return }
        try { json(200, await handlers.onStopAll(typeof body.except === 'string' && body.except ? body.except : null)) }
        catch (e) { json(500, { error: e instanceof Error ? e.message : 'INTERNAL' }) }
        return
      }
      if (req.method === 'POST' && url === '/api/fleet') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onFleet) { json(503, { error: 'UNAVAILABLE' }); return }
        let body: { action?: unknown } & Record<string, unknown>
        try { body = JSON.parse(await readBody(req)) as typeof body } catch { json(400, { error: 'bad json' }); return }
        if (typeof body.action !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/.test(body.action)) { json(400, { error: 'MISSING_ACTION' }); return }
        const { action, ...args } = body
        try { json(200, { ok: true, result: await handlers.onFleet(action, args) }) }
        catch (e) { json(400, { ok: false, error: e instanceof Error ? e.message : String(e) }) }
        return
      }
      if (req.method === 'GET' && url === '/api/logs') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(handlers.onLogs ? handlers.onLogs() : ''); return
      }
      if (req.method === 'POST' && url === '/api/stop') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        json(200, { ok: true }); handlers.onStop?.(); return
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
        const ignore = (reason: string): void => {
          console.log(`[hooks] ${sid(body.sessionId ?? '?')} ${body.hookEvent ?? 'session-start'} ignored · ${reason}`)
          json(200, { ignored: true, reason })
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
        const processAgent = handlers.resolveHookAgent
          ? await handlers.resolveHookAgent({
            engine,
            tmuxPane: body.tmuxPane,
            runtimeHints,
            callerPid: Number.isSafeInteger(body.callerPid) && body.callerPid! > 0 ? body.callerPid : undefined,
          })
          : body.tmuxPane ? registry.byPaneEngine(body.tmuxPane, engine) ?? null : null
        if (!processAgent || processAgent.engine !== engine) { ignore('no_matching_engine_process'); return }
        // The process scanner is authoritative. Never accept a hook's legacy launcher id or a stale PID.
        body.processIdentity = processAgent.processIdentity ?? undefined
        body.runtimes = processAgent.runtimes
        body.primaryRuntimeKey = processAgent.primaryRuntimeKey
        body.transcriptPath = knownTranscriptFor(body, processAgent)
        // Deleting an agent no longer kills its pane, so the engine lives on for a moment and its catch
        // hook still fires — and the exact process may remain alive during SIGTERM grace. Without
        // this the tile the user just deleted re-registers itself and comes back.
        if (isRecentlyDeleted(body.sessionId)) { ignore('deleted'); return }
        if (body.engine === 'codex' && body.transcriptPath && readCodexRolloutMeta(body.transcriptPath)?.isSubagent) {
          ignore('codex_subagent')
          return
        }
        // Same story for hermes, which reaches here through its own hooks rather than a transcript file:
        // every delegated sub-agent is a hermes session that runs those hooks from the parent's pane.
        if (body.engine === 'hermes' && body.sessionId) {
          // Settled off the HTTP path entirely: the answer needs a SQLite read, and the row may not even
          // be written yet (measured: a child's hook beat its own INSERT by 110ms). Registering
          // optimistically would hand the parent's pane to a sub-agent.
          json(200, { pending: true })
          void awaitHermesKind(body, handlers)
          return
        }
        if (body.hookEvent === 'UserPromptSubmit') {
          handlers.onPromptSubmitted?.(processAgent.agentId, body.prompt ?? '')
        }
        let result = registry.register(body)
        if (!result && body.transcriptPath && !existsSync(body.transcriptPath)) {
          // The engine announced the session BEFORE writing its transcript. Measured on claude: the hook
          // arrived at 13:03:31 and the file appeared at 13:03:34, so registration was refused (a session
          // is only accepted with a real file behind it) and the agent stayed off the list until something
          // else noticed it. Wait for the file instead of dropping the announcement — in the background,
          // because a SessionStart hook blocks the CLI that is waiting on this reply.
          json(200, { pending: true })
          void awaitTranscript(body, handlers)
          return
        }
        if (!result) {
          console.warn(`[hooks] ${sid(body.sessionId ?? '?')} REJECTED · engine=${body.engine} pane=${body.tmuxPane}`)
          json(400, { error: 'invalid session registration' })
          return
        }
        console.log(`[hooks] ${sid(result.entry.sessionId)} ${body.hookEvent ?? 'session-start'} · engine=${result.entry.engine} · isNew=${result.isNew}`)
        handlers.onRegistered(result.entry, { isNew: result.isNew, evicted: result.evicted, rebound: result.rebound, orphaned: result.orphaned, hookEvent: body.hookEvent })
        const context = body.hookEvent === 'UserPromptSubmit' && (engine === 'claude' || engine === 'codex') && handlers.onPromptContext
          ? await boundedPromptContext(() => handlers.onPromptContext!(result.entry.agentId, body.prompt ?? '')) : null
        json(200, { ok: true, ...context })
        return
      }

      if (req.method === 'POST' && url === '/api/hook/opencode-memory-runtime') {
        if (!hookOk) { json(401, { error: 'UNAUTHORIZED' }); return }
        let body: BoundHookBody
        try {
          const parsed: unknown = JSON.parse(await readBody(req))
          if (!validHookBody(parsed) || parsed.engine !== 'opencode' || !parsed.callerPid
            || !optionalBoundedJson(parsed.input, 50_000)) { json(400, { error: 'invalid hook body' }); return }
          body = parsed
        } catch { json(400, { error: 'bad json' }); return }
        // Unlike discovery fallback, credentials always require the host's live ancestry resolver.
        const agent = handlers.resolveHookAgent ? await verifiedBoundMutation(body, handlers) : null
        if (!agent?.processIdentity) { json(403, { error: 'UNBOUND_HOOK' }); return }
        json(200, handlers.onOpenCodeMemoryRuntime?.(agent, body.input) ?? { observe: false }); return
      }

      if (req.method === 'POST' && url === '/api/hook/memory-context') {
        if (!hookOk) { json(401, { error: 'UNAUTHORIZED' }); return }
        let body: BoundHookBody
        try {
          const parsed: unknown = JSON.parse(await readBody(req))
          if (!validHookBody(parsed) || !['claude', 'codex', 'opencode'].includes(parsed.engine ?? '')
            || !parsed.callerPid || !parsed.cliVersion || typeof parsed.prompt !== 'string'
            || !parsed.prompt.trim() || parsed.prompt.length > 4_000) { json(400, { error: 'invalid hook body' }); return }
          body = parsed
        } catch { json(400, { error: 'bad json' }); return }
        const agent = handlers.resolveHookAgent ? await verifiedBoundMutation(body, handlers) : null
        if (!agent?.processIdentity) { json(403, { error: 'UNBOUND_HOOK' }); return }
        const context = handlers.onMemoryContext ? await boundedPromptContext(() => handlers.onMemoryContext!(
          agent.agentId, body.prompt!, { engine: agent.engine, cliVersion: body.cliVersion! })) : null
        json(200, { ok: true, ...context }); return
      }

      if (req.method === 'POST' && url === '/api/hook/memory-emitted') {
        if (!hookOk) { json(401, { error: 'UNAUTHORIZED' }); return }
        let body: BoundHookBody
        try {
          const parsed: unknown = JSON.parse(await readBody(req))
          if (!validHookBody(parsed) || !/^[a-f0-9-]{36}$/.test(parsed.memoryReceiptId ?? '')
            || !['claude', 'codex', 'opencode'].includes(parsed.engine ?? '')
            || (parsed.engine === 'opencode' && !parsed.callerPid)) { json(400, { error: 'invalid hook body' }); return }
          body = parsed
        } catch { json(400, { error: 'bad json' }); return }
        const agent = body.engine === 'opencode' && !handlers.resolveHookAgent ? null : await verifiedBoundMutation(body, handlers)
        if (!agent || (body.engine === 'opencode' && !agent.processIdentity)) { json(403, { error: 'UNBOUND_HOOK' }); return }
        const recorded = await handlers.onMemoryContextEmitted?.(agent.agentId, body.memoryReceiptId!).catch(() => false) ?? false
        json(200, { ok: true, recorded, delivery: 'unverified' }); return
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
        let gate: GateVerdict | undefined
        if (body.sessionId && body.toolUseId && body.toolName) {
          console.log(`[hooks] ${sid(body.sessionId)} tool-start · tool=${body.toolName}`)
          try {
            const verdict = await handlers.onToolStart?.({
              sessionId: body.sessionId,
              toolUseId: body.toolUseId,
              toolName: body.toolName,
              input: body.input,
            })
            if (verdict && verdict.decision !== 'allow') gate = verdict
          } catch (e) {
            console.error('[hooks] tool-start handler failed:', e instanceof Error ? e.message : e)
          }
        }
        // The gate verdict rides back to the hook script, which turns it into the engine's own
        // permission prompt. Allow is the absence of the field, so an older script sees `{ok:true}`.
        json(200, gate ? { ok: true, gate } : { ok: true })
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
        if (!await verifiedBoundMutation(body, handlers)) { json(403, { error: 'UNBOUND_HOOK' }); return }
        if (body.sessionId) {
          console.log(`[hooks] ${sid(body.sessionId)} turn-stop${body.status ? ` · status=${body.status}` : ''}`)
          handlers.onTurnStop?.({
            sessionId: body.sessionId,
            status: body.status,
            transcriptPath: body.transcriptPath,
          })
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
        const out = handlers.onClearRemotePassword(); json(out.status, out.body); return
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
        const out = handlers.onTrustLinkedPeer({ pub: body.pub as string, machineId: body.machineId, label })
        json(out.status, out.body); return
      }

      // `harness group list` → the trust group's members. Read-only (keys and labels, no secrets).
      if (req.method === 'GET' && url === '/api/group') {
        if (!handlers.onGroupList) { json(503, { error: 'UNAVAILABLE' }); return }
        const out = handlers.onGroupList(); json(out.status, out.body); return
      }
      // `harness group sync` → compare rosters with every reachable member now.
      if (req.method === 'POST' && url === '/api/group/sync') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onGroupSync) { json(503, { error: 'UNAVAILABLE' }); return }
        const out = handlers.onGroupSync(); json(out.status, out.body); return
      }
      // `harness group remove <id|#|fp>` / `harness link unlink` → drop a member everywhere.
      if (req.method === 'POST' && url === '/api/group/remove') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onGroupRemove) { json(503, { error: 'UNAVAILABLE' }); return }
        let body: { selector?: unknown }
        try { body = JSON.parse(await readBody(req)) as typeof body } catch { json(400, { error: 'bad json' }); return }
        if (typeof body.selector !== 'string' || !body.selector.trim()) { json(400, { error: 'MISSING_SELECTOR' }); return }
        const out = handlers.onGroupRemove(body.selector.trim()); json(out.status, out.body); return
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
        const out = handlers.onDevicesDismiss({
          ...(typeof body.pub === 'string' ? { pub: body.pub } : {}),
          ...(Array.isArray(body.pubs) ? { pubs: body.pubs as string[] } : {}),
          ...(body.baseline === true ? { baseline: true } : {}),
        }); json(out.status, out.body); return
      }

      // `harness remote-password status` → whether one is set, and its fingerprint. Read-only, same
      // gating tier as /api/pairs.
      if (req.method === 'GET' && url === '/api/remote-password/status') {
        if (!handlers.onRemotePasswordStatus) { json(503, { error: 'UNAVAILABLE' }); return }
        const out = handlers.onRemotePasswordStatus(); json(out.status, out.body); return
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
      if (req.method === 'GET' && url === '/api/zoo') {
        if (!handlers.onZooRead) { json(503, { error: 'UNAVAILABLE' }); return }
        await proxied(handlers.onZooRead); return
      }
      if (req.method === 'POST' && url === '/api/zoo/ops') {
        // Any local process that sets the header can send an op here, `zoo.autonomy` and `zoo.consent`
        // included: the account's dial is only a REQUEST to each daemon, which acts above `suggest` only
        // after the person confirms it at a window (pair/gate.ts, daemons/BRAIN.md "Security").
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onZooOps) { json(503, { error: 'UNAVAILABLE' }); return }
        let body: unknown
        try { body = JSON.parse(await readBody(req)) } catch { json(400, { error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }); return }
        await proxied(() => handlers.onZooOps!(body)); return
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
        const out = handlers.onListPairs(); json(out.status, out.body); return
      }

      // `harness unpair <id>` — unpair one browser; signals it (if online) to re-pair.
      if (req.method === 'POST' && url === '/api/revoke') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onRevoke) { json(503, { error: 'UNAVAILABLE' }); return }
        let body: { id?: string }
        try { body = JSON.parse(await readBody(req)) as { id?: string } } catch { json(400, { error: 'bad json' }); return }
        if (!body.id) { json(400, { error: 'MISSING_ID' }); return }
        const out = handlers.onRevoke(body.id); json(out.status, out.body); return
      }

      // `harness unpair --all` — unpair every browser.
      if (req.method === 'POST' && url === '/api/revoke-all') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onRevokeAll) { json(503, { error: 'UNAVAILABLE' }); return }
        const out = handlers.onRevokeAll(); json(out.status, out.body); return
      }

      json(404, { error: 'not found' })
    })()
  }
  const server = http.createServer(handle)

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
