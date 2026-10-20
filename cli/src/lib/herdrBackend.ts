/**
 * Herdr 0.9 / protocol 22, as a second terminal backend beside tmux.
 *
 * One daemon talks only to the herdr on its own machine; every other machine runs its own daemon.
 * This never passes `--remote`, never `attach --takeover`, and never `server stop`. Close and
 * respawn apply only to panes this daemon created.
 */
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import type { TerminalBackend } from './terminalBackend.js'
import { HerdrPaneStream } from './herdrStream.js'
import { cleanOmpTitle } from './sessionTitle.js'
import { terminalRouteKey } from './terminalRuntime.js'
import type {
  SubmitOptions,
  TerminalActionResult,
  TerminalCaptureOptions,
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalInventoryResult,
  TerminalLogicalKey,
  TerminalProcessExpectation,
  TerminalReadResult,
  TerminalRespawnRequest,
  TerminalStreamSink,
  TerminalStreamSize,
  HerdrRuntimeRef,
  RuntimeValidation,
} from './terminalTypes.js'

export const HERDR_PANE_RE = /^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/

export type HerdrRunResult = { code: number; stdout: string; stderr: string }
export type HerdrRun = (args: readonly string[]) => Promise<HerdrRunResult>

const failed = (reason: string): TerminalActionResult => ({ state: 'failed', dispatch: 'not_started', reason })
const ok = (): TerminalActionResult => ({ state: 'succeeded', dispatch: 'executed' })

export function herdrPane(value: string): HerdrRuntimeRef | null {
  return HERDR_PANE_RE.test(value) ? { backend: 'herdr', paneId: value } : null
}

/** The local `herdr` binary. Tests inject [run] and never reach this. */
export function defaultHerdrRun(args: readonly string[]): Promise<HerdrRunResult> {
  if (args.includes('--remote') || (args[0] === 'server' && args.includes('stop'))) {
    return Promise.resolve({ code: 1, stdout: '', stderr: 'refusing a herdr command that would take over or stop the server' })
  }
  return new Promise((resolve) => {
    execFile(process.env.HERDR_BIN || 'herdr', [...args], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const missing = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
      const code = typeof error?.code === 'number' ? error.code : error ? 1 : 0
      const said = missing ? 'herdr is not installed: no `herdr` on PATH, and HERDR_BIN is not set' : String(stderr ?? error?.message ?? '')
      resolve({ code, stdout: String(stdout ?? ''), stderr: said })
    })
  })
}

export class OwnedHerdrPanes {
  private readonly ids = new Set<string>()
  constructor(private readonly path?: string) {
    if (!path) return
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (Array.isArray(parsed)) for (const id of parsed) if (typeof id === 'string' && HERDR_PANE_RE.test(id)) this.ids.add(id)
    } catch { /* first run, or a missing file */ }
  }
  has(paneId: string): boolean { return this.ids.has(paneId) }
  add(paneId: string): void {
    this.ids.add(paneId)
    if (!this.path) return
    writeFileSync(this.path, JSON.stringify([...this.ids], null, 2), { mode: 0o600 })
  }
}

function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || !(key in value)) return undefined
  const record: Record<string, unknown> = Object(value)
  return record[key]
}

function jsonResult(stdout: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stdout)
    const result = field(parsed, 'result')
    return result && typeof result === 'object' ? result as Record<string, unknown> : null
  } catch {
    return null
  }
}

/**
 * What herdr said when a command failed. It prints `{"error":{"code","message"}}` on either stream,
 * e.g. `protocol_mismatch` for a client older than the server, `server_not_running` when no server
 * owns the socket, `pane_not_found`. Anything else is its stderr as written.
 */
export function herdrError(result: HerdrRunResult): { code: string | null; message: string } {
  for (const text of [result.stderr, result.stdout]) {
    for (const line of text.split('\n')) {
      try {
        const error = field(JSON.parse(line), 'error')
        const code = field(error, 'code')
        const message = field(error, 'message')
        if (typeof code === 'string' || typeof message === 'string') {
          return { code: typeof code === 'string' ? code : null, message: typeof message === 'string' ? message : String(code) }
        }
      } catch { /* not a JSON line */ }
    }
  }
  return { code: null, message: result.stderr.trim() || result.stdout.trim() || `herdr exited with ${result.code}` }
}

/** What to do about a failure herdr names, beyond its own words. */
const HERDR_FIXES: Readonly<Record<string, string>> = {
  // herdr's message says to upgrade; the daemon may simply be finding an older copy first on its PATH.
  protocol_mismatch: 'set HERDR_BIN to the herdr that matches the running server',
}

function paneIdOf(value: unknown): string | null {
  const id = field(value, 'pane_id')
  return typeof id === 'string' && HERDR_PANE_RE.test(id) ? id : null
}

export class HerdrBackend implements TerminalBackend<HerdrRuntimeRef> {
  readonly name = 'herdr' as const
  readonly instanceId = 'herdr:local'
  constructor(
    private readonly run: HerdrRun = defaultHerdrRun,
    private readonly owned = new OwnedHerdrPanes(),
    private readonly log: (line: string) => void = (line) => console.warn(line),
  ) {}

  /** The snapshot failure already logged: a broken herdr is said once, not on every sweep. */
  private reported: string | null = null

  /**
   * One `herdr api snapshot`. A failure carries herdr's own words, logged once until it changes or
   * clears, so a client older than the server or a stopped server is never a silent empty list.
   */
  private async snapshot(): Promise<{ ok: true; snapshot: unknown; panes: unknown[] } | { ok: false; reason: string }> {
    const snap = await this.run(['api', 'snapshot'])
    if (snap.code !== 0) {
      const { code, message } = herdrError(snap)
      const fix = code ? HERDR_FIXES[code] : undefined
      const reason = fix ? `${message} · ${fix}` : message
      if (reason !== this.reported) {
        this.reported = reason
        this.log(`[herdr] unavailable · ${reason}`)
      }
      return { ok: false, reason }
    }
    if (this.reported !== null) {
      this.reported = null
      this.log('[herdr] available again')
    }
    const snapshot = field(jsonResult(snap.stdout), 'snapshot')
    const panes = field(snapshot, 'panes')
    if (!Array.isArray(panes)) return { ok: false, reason: 'herdr snapshot has no panes' }
    return { ok: true, snapshot, panes }
  }

  /** Whether this daemon created the pane (and so may close, respawn or restore it). */
  owns(paneId: string): boolean { return this.owned.has(paneId) }

  private refuse(runtime: HerdrRuntimeRef): TerminalActionResult | null {
    return herdrPane(runtime.paneId) ? null : failed(`refusing herdr target ${runtime.paneId}`)
  }

  async inventory(): Promise<TerminalInventoryResult> {
    const snap = await this.snapshot()
    if (!snap.ok) return { state: 'unavailable', reason: snap.reason }
    const panes = snap.panes
    const roots = []
    for (const pane of panes) {
      const paneId = paneIdOf(pane)
      if (!paneId) continue
      const info = await this.run(['pane', 'process-info', '--pane', paneId])
      if (info.code !== 0) continue
      const processInfo = field(jsonResult(info.stdout), 'process_info')
      const shellPid = field(processInfo, 'shell_pid')
      const cwd = field(pane, 'cwd')
      if (typeof shellPid !== 'number' || !Number.isSafeInteger(shellPid) || shellPid <= 0) continue
      roots.push({
        runtime: { backend: 'herdr' as const, paneId },
        rootPid: shellPid,
        cwd: typeof cwd === 'string' && cwd ? cwd : '/',
      })
    }
    return { state: 'available', roots }
  }

  /**
   * The boot restore's survey: every pane id in the snapshot, and how many checks failed — the
   * snapshot itself, or any pane's process-info (error, timeout, or no shell pid). Unlike
   * `inventory()`, a pane that fails its check is still counted as present AND as a failed check,
   * so restore can refuse to act on a partial picture.
   */
  async restoreSurvey(): Promise<{ livePaneIds: Set<string> | null; failedChecks: number }> {
    const snap = await this.snapshot()
    if (!snap.ok) return { livePaneIds: null, failedChecks: 1 }
    const panes = snap.panes
    const livePaneIds = new Set<string>()
    let failedChecks = 0
    for (const pane of panes) {
      const paneId = paneIdOf(pane)
      if (!paneId) continue
      livePaneIds.add(paneId)
      const info = await this.run(['pane', 'process-info', '--pane', paneId])
      const shellPid = info.code === 0 ? field(field(jsonResult(info.stdout), 'process_info'), 'shell_pid') : undefined
      if (typeof shellPid !== 'number' || !Number.isSafeInteger(shellPid) || shellPid <= 0) failedChecks++
    }
    return { livePaneIds, failedChecks }
  }

  /**
   * Every pane's title from ONE `herdr api snapshot` (never per-pane process-info: this runs on every
   * title sweep). omp's "π ⠴ 󰣳 Topic" is cleaned to "Topic" here so spinner frames never retitle it.
   */
  async titles(): Promise<TerminalReadResult<Map<string, string>>> {
    const snap = await this.snapshot()
    if (!snap.ok) return { state: 'failed', reason: snap.reason }
    const titles = new Map<string, string>()
    for (const pane of snap.panes) {
      const paneId = paneIdOf(pane)
      if (!paneId) continue
      const raw = field(pane, 'terminal_title_stripped') ?? field(pane, 'terminal_title')
      const title = typeof raw === 'string' ? cleanOmpTitle(raw) : null
      if (title) titles.set(terminalRouteKey({ backend: 'herdr', paneId }), title)
    }
    return { state: 'succeeded', value: titles }
  }

  async capture(runtime: HerdrRuntimeRef, options?: TerminalCaptureOptions): Promise<TerminalReadResult<string>> {
    const refused = this.refuse(runtime)
    if (refused?.state === 'failed') return { state: 'failed', reason: refused.reason }
    const lines = String(options?.historyLines ?? 200)
    const read = await this.run(['pane', 'read', runtime.paneId, '--source', 'recent-unwrapped', '--lines', lines, '--format', 'text'])
    if (read.code !== 0) return { state: 'failed', reason: read.stderr.trim() || 'herdr pane read failed' }
    return { state: 'succeeded', value: read.stdout }
  }

  async validate(runtime: HerdrRuntimeRef, expected: TerminalProcessExpectation): Promise<RuntimeValidation> {
    if (!herdrPane(runtime.paneId)) return { state: 'gone', reason: 'not a herdr pane id' }
    const info = await this.run(['pane', 'process-info', '--pane', runtime.paneId])
    if (info.code !== 0) {
      // herdr's own answer that the pane does not exist is proof it is gone, not an unreadable backend:
      // left as 'unknown', a closed pane's row stayed listed as a live harness forever.
      if (herdrError(info).code === 'pane_not_found') return { state: 'gone', reason: `herdr has no pane ${runtime.paneId}` }
      return { state: 'unknown', reason: herdrError(info).message || 'herdr process-info failed' }
    }
    const processInfo = field(jsonResult(info.stdout), 'process_info')
    const shellPid = field(processInfo, 'shell_pid')
    if (typeof shellPid !== 'number') return { state: 'gone', reason: `herdr has no pane ${runtime.paneId}` }
    const wanted = expected.processIdentity?.pid
    if (wanted === undefined) return { state: 'alive' }
    const foreground = field(processInfo, 'foreground_processes')
    const rows = Array.isArray(foreground) ? foreground : []
    const pids = new Set<number>([shellPid])
    for (const row of rows) {
      const pid = field(row, 'pid')
      if (typeof pid === 'number') pids.add(pid)
    }
    return pids.has(wanted) ? { state: 'alive' } : { state: 'gone', reason: 'process is not in the herdr pane', replaced: true }
  }

  async typeLiteral(runtime: HerdrRuntimeRef, text: string): Promise<TerminalActionResult> {
    const refused = this.refuse(runtime)
    if (refused) return refused
    const sent = await this.run(['pane', 'send-text', runtime.paneId, text])
    return sent.code === 0 ? ok() : failed(sent.stderr.trim() || 'herdr send-text failed')
  }

  async submitText(runtime: HerdrRuntimeRef, text: string, _options?: SubmitOptions): Promise<TerminalActionResult> {
    const typed = await this.typeLiteral(runtime, text)
    if (typed.state !== 'succeeded') return typed
    return this.sendKey(runtime, 'enter')
  }

  async sendKey(runtime: HerdrRuntimeRef, key: TerminalLogicalKey): Promise<TerminalActionResult> {
    const refused = this.refuse(runtime)
    if (refused) return refused
    const sent = await this.run(['pane', 'send-keys', runtime.paneId, key === 'escape' ? 'esc' : key === 'ctrl-c' ? 'ctrl+c' : key === 'ctrl-d' ? 'ctrl+d' : key])
    return sent.code === 0 ? ok() : failed(sent.stderr.trim() || 'herdr send-keys failed')
  }

  async setTitle(runtime: HerdrRuntimeRef, title: string): Promise<TerminalActionResult> {
    const refused = this.refuse(runtime)
    if (refused) return refused
    // A token, not a rename. A rename would change the label other herdr clients show.
    const sent = await this.run(['pane', 'report-metadata', runtime.paneId, '--source', 'harness', '--token', `title=${title.slice(0, 80)}`])
    return sent.code === 0 ? ok() : failed(sent.stderr.trim() || 'herdr report-metadata failed')
  }

  async notify(): Promise<TerminalActionResult> {
    return ok()
  }

  async create(request: TerminalCreateRequest): Promise<TerminalCreateResult<HerdrRuntimeRef>> {
    if (request.current && !request.current()) return { state: 'failed', dispatch: 'not_started', reason: 'cancelled' }
    const args = ['workspace', 'create', '--no-focus']
    if (request.cwd) args.push('--cwd', request.cwd)
    if (request.label) args.push('--label', request.label)
    const created = await this.run(args)
    if (created.code !== 0) return { state: 'failed', dispatch: 'not_started', reason: created.stderr.trim() || 'herdr workspace create failed' }
    const result = jsonResult(created.stdout)
    const paneId = paneIdOf(result?.root_pane)
    if (!paneId) return { state: 'unknown', dispatch: 'possibly_executed', reason: 'herdr created a workspace but returned no pane id' }
    this.owned.add(paneId)
    request.onDispatch?.()
    if (request.command?.length) {
      const command = request.command.map(part => `'${part.replaceAll("'", "'\\''")}'`).join(' ')
      const started = await this.run(['pane', 'run', paneId, command])
      if (started.code !== 0) return { state: 'unknown', dispatch: 'possibly_executed', reason: started.stderr.trim() || 'herdr pane run failed' }
    }
    return { state: 'succeeded', dispatch: 'executed', runtime: { backend: 'herdr', paneId } }
  }

  async kill(runtime: HerdrRuntimeRef): Promise<TerminalActionResult> {
    const refused = this.refuse(runtime)
    if (refused) return refused
    if (!this.owned.has(runtime.paneId)) return failed('refusing to close a herdr pane this daemon did not create')
    const closed = await this.run(['pane', 'close', runtime.paneId])
    return closed.code === 0 ? ok() : failed(closed.stderr.trim() || 'herdr pane close failed')
  }

  async openStream(
    runtime: HerdrRuntimeRef,
    _expected: TerminalProcessExpectation,
    size: TerminalStreamSize,
    sink: TerminalStreamSink,
    readOnly = false,
  ): Promise<TerminalReadResult<HerdrPaneStream>> {
    const refused = this.refuse(runtime)
    if (refused?.state === 'failed') return { state: 'failed', reason: refused.reason }
    const stream = new HerdrPaneStream(runtime, this.run, sink, readOnly, size)
    stream.start()
    return { state: 'succeeded', value: stream }
  }

  async holdOpen(runtime: HerdrRuntimeRef): Promise<TerminalActionResult> {
    const refused = this.refuse(runtime)
    return refused ?? ok()
  }

  async respawn(runtime: HerdrRuntimeRef, request: TerminalRespawnRequest): Promise<TerminalActionResult> {
    const refused = this.refuse(runtime)
    if (refused) return refused
    if (!this.owned.has(runtime.paneId)) return failed('refusing to respawn a herdr pane this daemon did not create')
    if (request.current && !request.current()) return failed('cancelled')
    const stopped = await this.run(['pane', 'send-keys', runtime.paneId, 'ctrl+c'])
    if (stopped.code !== 0) return failed(stopped.stderr.trim() || 'herdr send-keys failed')
    const command = request.command.map(part => `'${part.replaceAll("'", "'\\''")}'`).join(' ')
    const started = await this.run(['pane', 'run', runtime.paneId, command])
    return started.code === 0 ? ok() : failed(started.stderr.trim() || 'herdr pane run failed')
  }
}

