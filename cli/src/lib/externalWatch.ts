/**
 * External sessions: Claude Code and Codex sessions running in a terminal Harness did not start.
 *
 * Harness tracks the agents it finds in tmux. A session in any other terminal (a terminal window, an
 * editor's terminal, another multiplexer) still fires the machine's hooks, but `hook/notify.mjs`
 * returned at once because there was no `TMUX_PANE` to bind. With this switch on, those hooks are
 * posted to `/api/hook/external` instead, and each session becomes a READ-ONLY row in the agent list.
 *
 * Read-only means: the row lives in this module's memory only. It is never written to registry.json,
 * never resumed, moved, restarted or killed, and nothing is ever typed into its terminal. It has no
 * runtime, so every action that needs one already refuses it. It goes offline on SessionEnd, or when
 * the engine process that sent its hooks is gone, and is forgotten a while after that.
 *
 * Off by default. `harness external on|off|status` writes the switch file the hook script and the daemon
 * both read; `HARNESS_EXTERNAL_SESSIONS=1|0` overrides it.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { AgentFrame } from './agentFrame.js'
import type { AgentProject } from './agentProject.js'
import { resumeMode } from './resumeCapability.js'
import type { ProcessIdentity } from './terminalTypes.js'

export type ExternalEngine = 'claude' | 'codex'
export type ExternalEvent = 'SessionStart' | 'UserPromptSubmit' | 'Stop' | 'StopFailure' | 'Notification' | 'SessionEnd'
/** What the row says about the session. `needsYou` is a permission or input prompt on its screen. */
export type ExternalState = 'idle' | 'working' | 'done' | 'failed' | 'needsYou' | 'offline'

export interface ExternalHook {
  engine: ExternalEngine
  event: ExternalEvent
  sessionId: string
  cwd: string | null
  title: string | null
  model: string | null
  message: string
  notificationType: string
  callerPid: number | null
}

const ENGINES = new Set<string>(['claude', 'codex'])
const EVENTS = new Set<string>(['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification', 'SessionEnd'])
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(CONTROL, '').slice(0, max) : ''
}

function absolutePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\u0000')) return null
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) ? value : null
}

/** Validate a body from `hook/notify.mjs`. Keeps only the known fields, bounded. */
export function parseExternalHook(raw: unknown): { ok: true; hook: ExternalHook } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'body' }
  const body = raw as Record<string, unknown>
  if (typeof body.engine !== 'string' || !ENGINES.has(body.engine)) return { ok: false, reason: 'engine' }
  if (typeof body.event !== 'string' || !EVENTS.has(body.event)) return { ok: false, reason: 'event' }
  if (typeof body.sessionId !== 'string' || !SESSION_ID.test(body.sessionId)) return { ok: false, reason: 'sessionId' }
  if (body.cwd !== undefined && body.cwd !== null && !absolutePath(body.cwd)) return { ok: false, reason: 'cwd' }
  const pid = body.callerPid
  return {
    ok: true,
    hook: {
      engine: body.engine as ExternalEngine,
      event: body.event as ExternalEvent,
      sessionId: body.sessionId.toLowerCase(),
      cwd: absolutePath(body.cwd),
      title: text(body.title, 200) || null,
      model: text(body.model, 120) || null,
      message: text(body.message, 160),
      notificationType: text(body.notificationType, 40),
      callerPid: typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1 ? pid : null,
    },
  }
}

/**
 * The state a hook moves the row to, or null for "no change". Claude's Notification names its kind in
 * `notification_type` on current builds; older builds only have the message, so both are read.
 */
export function externalStateFor(hook: ExternalHook): { state: ExternalState; detail: string } | null {
  switch (hook.event) {
    case 'SessionStart': return { state: 'idle', detail: '' }
    case 'UserPromptSubmit': return { state: 'working', detail: '' }
    case 'Stop': return { state: 'done', detail: '' }
    case 'StopFailure': return { state: 'failed', detail: 'The turn ended with an error.' }
    case 'SessionEnd': return { state: 'offline', detail: '' }
    case 'Notification':
      if (hook.notificationType === 'permission_prompt' || hook.notificationType === 'elicitation_dialog'
        || /needs your (permission|input)/i.test(hook.message)) return { state: 'needsYou', detail: hook.message }
      return null
  }
}

// ── the switch ─────────────────────────────────────────────────────────────────────────────────────

export const EXTERNAL_SESSIONS_FILE = 'external-sessions.json'

export interface ExternalSessionsSwitch {
  enabled: boolean
  source: 'env' | 'file' | 'default'
}

type Env = Record<string, string | undefined>

function envFlag(value: string | undefined): boolean | null {
  const v = value?.trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false
  return null
}

/** The environment wins; then the switch file; otherwise off. An unreadable file is off. */
export function readExternalSessionsSwitch(dataDir: string, env: Env = process.env): ExternalSessionsSwitch {
  const forced = envFlag(env.HARNESS_EXTERNAL_SESSIONS)
  if (forced !== null) return { enabled: forced, source: 'env' }
  const file = join(dataDir, EXTERNAL_SESSIONS_FILE)
  if (!existsSync(file)) return { enabled: false, source: 'default' }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { enabled?: unknown } | null
    return { enabled: parsed?.enabled === true, source: 'file' }
  } catch {
    return { enabled: false, source: 'file' }
  }
}

export function writeExternalSessionsSwitch(dataDir: string, enabled: boolean): void {
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, EXTERNAL_SESSIONS_FILE)
  writeFileSync(`${file}.tmp`, JSON.stringify({ enabled }) + '\n', { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
}

/** `harness external on|off|status [--json]`. Returns the exit code. */
export function externalCommand(deps: {
  argv: string[]
  dataDir: string
  env?: Env
  output: (line: string) => void
  error: (line: string) => void
}): number {
  const json = deps.argv.includes('--json')
  const verb = deps.argv.find((a) => !a.startsWith('-')) ?? 'status'
  if (verb !== 'on' && verb !== 'off' && verb !== 'status') {
    deps.error(`Unknown command: external ${verb}`)
    deps.error('usage: harness external on|off|status [--json]')
    return 1
  }
  if (verb !== 'status') writeExternalSessionsSwitch(deps.dataDir, verb === 'on')
  const state = readExternalSessionsSwitch(deps.dataDir, deps.env)
  if (json) deps.output(JSON.stringify(state))
  else {
    deps.output(`external sessions: ${state.enabled ? 'on' : 'off'}${state.source === 'env' ? ' (set by HARNESS_EXTERNAL_SESSIONS)' : ''}`)
    if (verb === 'on' && state.enabled) {
      deps.output('Sessions outside tmux appear with their next hook. Restart the daemon (harness stop, then harness start) to also install the Notification hook that reports permission prompts.')
    }
    if (verb !== 'status' && state.source === 'env' && state.enabled !== (verb === 'on')) {
      deps.error('HARNESS_EXTERNAL_SESSIONS overrides the saved switch in this environment.')
    }
  }
  return 0
}

// ── the rows ───────────────────────────────────────────────────────────────────────────────────────

export interface ExternalSession {
  agentId: string
  sessionId: string
  engine: ExternalEngine
  cwd: string | null
  title: string | null
  model: string | null
  state: ExternalState
  detail: string
  /** The engine process that sent the hooks, when it was found; liveness is checked against it. */
  process: ProcessIdentity | null
  createdAt: number
  updatedAt: number
}

/** How long an offline row stays listed before it is forgotten. */
export const EXTERNAL_OFFLINE_KEEP_MS = 10 * 60_000

/** In-memory rows, keyed by engine session id. Nothing here touches the disk. */
export class ExternalWatchRows {
  private readonly rows = new Map<string, ExternalSession>()

  list(): ExternalSession[] { return [...this.rows.values()] }
  bySession(sessionId: string): ExternalSession | undefined { return this.rows.get(sessionId.toLowerCase()) }
  byAgent(agentId: string): ExternalSession | undefined { return this.list().find((row) => row.agentId === agentId) }

  /**
   * Apply one hook. Returns the row it changed, or null when there is nothing to show (a SessionEnd
   * or a Notification for a session never seen). A later hook for an offline row brings it back.
   */
  apply(hook: ExternalHook, opts: { now: number; process?: ProcessIdentity | null }): ExternalSession | null {
    const next = externalStateFor(hook)
    let row = this.rows.get(hook.sessionId)
    if (!row) {
      if (hook.event === 'SessionEnd' || hook.event === 'Notification') return null
      row = {
        agentId: randomUUID(), sessionId: hook.sessionId, engine: hook.engine, cwd: null, title: null, model: null,
        state: 'idle', detail: '', process: null, createdAt: opts.now, updatedAt: opts.now,
      }
      this.rows.set(hook.sessionId, row)
    }
    if (hook.cwd) row.cwd = hook.cwd
    if (hook.title) row.title = hook.title
    if (hook.model) row.model = hook.model
    if (opts.process) row.process = opts.process
    if (next) { row.state = next.state; row.detail = next.detail }
    else if (row.state === 'offline') { row.state = 'idle'; row.detail = '' }
    row.updatedAt = opts.now
    return row
  }

  /**
   * Mark rows whose engine process is gone as offline, and forget rows offline for longer than
   * {@link EXTERNAL_OFFLINE_KEEP_MS}. `alive` answers for one process; a row with no known process is
   * only ended by its SessionEnd hook.
   */
  sweep(alive: (process: ProcessIdentity) => boolean, now: number): { offline: ExternalSession[]; removed: ExternalSession[] } {
    const offline: ExternalSession[] = []
    const removed: ExternalSession[] = []
    for (const row of this.list()) {
      if (row.state === 'offline') {
        if (now - row.updatedAt >= EXTERNAL_OFFLINE_KEEP_MS) { this.rows.delete(row.sessionId); removed.push(row) }
        continue
      }
      if (row.process && !alive(row.process)) {
        row.state = 'offline'; row.detail = ''; row.updatedAt = now
        offline.push(row)
      }
    }
    return { offline, removed }
  }

  /** Forget every row (the switch went off). Returns what was removed. */
  clear(): ExternalSession[] {
    const all = this.list()
    this.rows.clear()
    return all
  }
}

/**
 * The engine process behind a hook: the nearest ancestor of the hook's caller that the engine matcher
 * accepts. The hook runs under a shell the engine spawned, so the caller itself is rarely the engine.
 */
export function engineAncestor<Row extends ProcessIdentity & { parentPid: number }>(
  rows: readonly Row[],
  callerPid: number,
  isEngine: (row: Row) => boolean,
): ProcessIdentity | null {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  let pid = callerPid
  for (let depth = 0; depth < 16 && pid > 1; depth++) {
    const row = byPid.get(pid)
    if (!row) return null
    if (isEngine(row)) return { pid: row.pid, executable: row.executable, startMarker: row.startMarker }
    pid = row.parentPid
  }
  return null
}

/**
 * One external row in the shape every client already reads (lib/agentFrame.ts), plus `external`.
 * No terminal, no close, no fork: a client that does not know `external` still shows a row with
 * nothing to act on.
 */
export function externalAgentFrame(row: ExternalSession, project: AgentProject | null): AgentFrame {
  const name = row.cwd ? basename(row.cwd) || row.cwd : row.sessionId.slice(0, 8)
  const at = new Date(row.updatedAt).toISOString()
  return {
    id: row.agentId,
    sessionId: row.sessionId,
    userId: '',
    name,
    title: row.title && row.title !== name ? row.title : null,
    status: row.state === 'offline' ? 'offline' : 'active',
    activity: null,
    closePlan: null,
    closeSupported: false,
    launch: { state: 'ready' },
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: at,
    lastOpenedAt: null,
    tokenUsage: null,
    outputStats: null,
    tmuxPane: null,
    terminal: { available: false, primary: '', runtimes: [] },
    engine: row.engine,
    selectedModel: row.model,
    grid: null,
    codexHome: null,
    project,
    gitContext: { state: 'unavailable', current: null, observedAt: null, locations: [], pullRequests: [], truncated: false },
    dsh: null,
    dshName: null,
    viewerUrl: null,
    viewerName: null,
    verdict: null,
    forkedFrom: null,
    forkable: false,
    resumeMode: resumeMode(row.engine),
    permissionMode: null,
    bypassPermission: null,
    namedAgent: null,
    external: { state: row.state, ...(row.detail ? { detail: row.detail } : {}) },
  }
}

// ── the daemon side ────────────────────────────────────────────────────────────────────────────────

type ProcessTableRow = ProcessIdentity & { parentPid: number }

/** Whether `pid` is `ancestor` or one of its descendants in the process table. */
function descendsFrom(rows: readonly ProcessTableRow[], pid: number, ancestor: number): boolean {
  const parent = new Map(rows.map((row) => [row.pid, row.parentPid]))
  const seen = new Set<number>()
  for (let at = pid; at > 0 && !seen.has(at); at = parent.get(at) ?? 0) {
    if (at === ancestor) return true
    seen.add(at)
  }
  return false
}

export interface ExternalWatchDeps<Row extends ProcessTableRow> {
  dataDir: string
  env?: Env
  /** True when the registry already owns this engine session (a tmux agent): never duplicated. */
  owned: (sessionId: string) => boolean
  /** The process table, or null when it could not be read. */
  processes: () => Promise<Row[] | null>
  isEngine: (row: Row, engine: ExternalEngine) => boolean
  /** This daemon's pid: an engine it spawned itself (a recap or summary run) is never a row. */
  selfPid: number
  project: (cwd: string) => Promise<AgentProject | null>
  /** A row appeared or changed: push it to the app and the web. */
  publish: (frame: AgentFrame) => void
  /** A row is gone. */
  remove: (agentId: string) => void
  now?: () => number
  log?: (line: string) => void
}

/** The hook route, the sweep and the list, around one {@link ExternalWatchRows}. */
export function createExternalWatch<Row extends ProcessTableRow>(deps: ExternalWatchDeps<Row>) {
  const sessions = new ExternalWatchRows()
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => console.log(line))
  const enabled = (): boolean => readExternalSessionsSwitch(deps.dataDir, deps.env).enabled
  const frame = async (row: ExternalSession): Promise<AgentFrame> =>
    externalAgentFrame(row, row.cwd ? await deps.project(row.cwd).catch(() => null) : null)
  const publish = async (row: ExternalSession): Promise<void> => { deps.publish(await frame(row)) }

  const dropAll = (): void => { for (const row of sessions.clear()) deps.remove(row.agentId) }

  return {
    sessions,
    async hook(raw: unknown): Promise<Record<string, unknown>> {
      if (!enabled()) { dropAll(); return { ignored: true, reason: 'off' } }
      const parsed = parseExternalHook(raw)
      if (!parsed.ok) return { ignored: true, reason: parsed.reason }
      const { hook } = parsed
      if (deps.owned(hook.sessionId)) return { ignored: true, reason: 'owned' }
      let process: ProcessIdentity | null = null
      if (hook.callerPid && !sessions.bySession(hook.sessionId)?.process) {
        const rows = await deps.processes()
        if (rows && descendsFrom(rows, hook.callerPid, deps.selfPid)) return { ignored: true, reason: 'harness_child' }
        if (rows) process = engineAncestor(rows, hook.callerPid, (row) => deps.isEngine(row, hook.engine))
      }
      const isNew = !sessions.bySession(hook.sessionId)
      const row = sessions.apply(hook, { now: now(), process })
      if (!row) return { ignored: true, reason: 'unknown_session' }
      if (isNew) log(`[external] ${row.engine} session ${row.sessionId.slice(0, 8)} · ${row.cwd ?? '?'}`)
      await publish(row)
      return { ok: true, agentId: row.agentId, state: row.state }
    },
    /** Offline when the engine process is gone; forgotten later; everything dropped when switched off. */
    async sweep(): Promise<void> {
      if (!enabled()) { dropAll(); return }
      if (!sessions.list().some((row) => row.process || row.state === 'offline')) return
      const rows = await deps.processes()
      if (!rows) return
      const live = new Set(rows.map((row) => `${row.pid}\u0000${row.startMarker}`))
      const { offline, removed } = sessions.sweep((p) => live.has(`${p.pid}\u0000${p.startMarker}`), now())
      for (const row of offline) await publish(row)
      for (const row of removed) deps.remove(row.agentId)
    },
    /** The rows for an `agents_list` reply. */
    frames(): Promise<AgentFrame[]> {
      return enabled() ? Promise.all(sessions.list().map(frame)) : Promise.resolve([])
    },
  }
}
