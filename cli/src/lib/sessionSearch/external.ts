/**
 * Conversations on this machine that Harness did not start: Claude Code and Codex sessions run in a
 * terminal or in their own desktop apps. Found where each engine keeps them, so Cmd-P can find them
 * and open one in Harness (`agent_create` with `resumeSessionId`).
 *
 * Only what a person started, told apart by what each engine records at the top of the file:
 *  - Claude Code's `entrypoint`: `cli` (a terminal) or `claude-desktop` (the Claude app). `sdk-cli`
 *    is a program driving Claude — Harness's own summaries among them — and a sub-agent's file lives
 *    in a folder of its own.
 *  - Codex's `source`: `cli` (a terminal) or `vscode` (the Codex app, which says so in `originator`,
 *    and the editor extensions). `exec` is a script and a `subagent` source is another thread's helper.
 *
 * A file's first lines never change, so each file is read once, however often it is scanned.
 */

import { execFile } from 'node:child_process'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export type ExternalOrigin = 'terminal' | 'claude-app' | 'codex-app' | 'editor'
export type ExternalEngine = 'claude' | 'codex'

export interface ExternalSession {
  sessionId: string
  engine: ExternalEngine
  transcriptPath: string
  /** The folder it ran in, and so the folder it resumes in. */
  cwd: string
  origin: ExternalOrigin
  /** Codex's thread name (`session_index.jsonl`); Claude's comes from the transcript as it is indexed. */
  title: string
  /** When the file last changed, epoch ms. */
  mtime: number
}

type Head = Pick<ExternalSession, 'sessionId' | 'engine' | 'cwd' | 'origin'>

/** How much of a file is read to classify it: a Claude file's first lines, a Codex file's first line. */
const CLAUDE_HEAD_BYTES = 256 * 1024
const CODEX_HEAD_BYTES = 1024 * 1024
const SESSION_ID = /^[A-Za-z0-9-]{8,80}$/

export interface ExternalSessionsOptions {
  claudeProjectsDir: string
  codexHome: string
}

export class ExternalSessions {
  /** A verdict per file: its head, or null for a file that is not a person's conversation. */
  private readonly heads = new Map<string, Head | null>()
  private found: ExternalSession[] = []
  private byId = new Map<string, ExternalSession>()
  private scanning: Promise<ExternalSession[]> | null = null

  constructor(private readonly opts: ExternalSessionsOptions) {}

  /** What the last scan found, newest first. */
  list(): readonly ExternalSession[] { return this.found }

  get(sessionId: string): ExternalSession | undefined { return this.byId.get(sessionId) }

  /** Looks again. One scan at a time: a second caller shares the one in progress. */
  scan(): Promise<ExternalSession[]> {
    this.scanning ??= this.scanOnce().finally(() => { this.scanning = null })
    return this.scanning
  }

  private async scanOnce(): Promise<ExternalSession[]> {
    const found: ExternalSession[] = []
    const seen = new Set<string>()
    const consider = async (path: string, read: (path: string) => Promise<Head | null>, title = (_id: string) => '') => {
      seen.add(path)
      const file = await stat(path).catch(() => null)
      if (!file?.isFile()) return
      let head = this.heads.get(path)
      if (head === undefined) {
        head = await read(path).catch(() => null)
        this.heads.set(path, head)
      }
      if (head) found.push({ ...head, transcriptPath: path, title: title(head.sessionId), mtime: Math.floor(file.mtimeMs) })
      // A first scan reads a thousand files: let the daemon breathe between them.
      if (seen.size % 64 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    }

    for (const project of await entries(this.opts.claudeProjectsDir)) {
      if (!project.isDirectory()) continue
      const folder = join(this.opts.claudeProjectsDir, project.name)
      // Only the project's own files: a sub-agent's are in a folder beneath it.
      for (const file of await entries(folder)) {
        if (file.isFile() && file.name.endsWith('.jsonl')) await consider(join(folder, file.name), readClaudeHead)
      }
    }

    const titles = await codexTitles(join(this.opts.codexHome, 'session_index.jsonl'))
    for (const path of [
      ...await rollouts(join(this.opts.codexHome, 'sessions')),
      ...await rollouts(join(this.opts.codexHome, 'archived_sessions')),
    ]) await consider(path, readCodexHead, (id) => titles.get(id) ?? '')

    for (const path of [...this.heads.keys()]) if (!seen.has(path)) this.heads.delete(path)
    found.sort((a, b) => b.mtime - a.mtime)
    this.found = found
    this.byId = new Map(found.map((session) => [session.sessionId, session]))
    return found
  }
}

async function entries(dir: string) {
  return readdir(dir, { withFileTypes: true }).catch(() => [])
}

/** Every rollout file under a Codex sessions folder (`YYYY/MM/DD/rollout-*.jsonl`), at any depth. */
async function rollouts(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (at: string, depth: number): Promise<void> => {
    for (const entry of await entries(at)) {
      const path = join(at, entry.name)
      if (entry.isDirectory() && depth < 4) await walk(path, depth + 1)
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) out.push(path)
    }
  }
  await walk(dir, 0)
  return out
}

async function readHead(path: string, bytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

/** A Claude Code transcript's session, folder and entrypoint, from the first line that has them. */
export async function readClaudeHead(path: string): Promise<Head | null> {
  const text = await readHead(path, CLAUDE_HEAD_BYTES)
  for (const line of text.split('\n')) {
    if (!line.includes('"entrypoint"')) continue
    let record: { sessionId?: unknown; cwd?: unknown; entrypoint?: unknown; isSidechain?: unknown }
    try { record = JSON.parse(line) } catch { continue }
    if (record.isSidechain === true) return null
    const origin = record.entrypoint === 'cli' ? 'terminal' : record.entrypoint === 'claude-desktop' ? 'claude-app' : null
    if (!origin) return null
    if (typeof record.sessionId !== 'string' || !SESSION_ID.test(record.sessionId)) return null
    if (typeof record.cwd !== 'string' || !record.cwd.startsWith('/')) return null
    return { sessionId: record.sessionId, engine: 'claude', cwd: record.cwd, origin }
  }
  return null
}

/** A Codex rollout's session, folder and source, from its first line (`session_meta`). */
export async function readCodexHead(path: string): Promise<Head | null> {
  const text = await readHead(path, CODEX_HEAD_BYTES)
  const newline = text.indexOf('\n')
  if (newline < 0) return null
  let record: { type?: unknown; payload?: { id?: unknown; cwd?: unknown; source?: unknown; originator?: unknown } }
  try { record = JSON.parse(text.slice(0, newline)) } catch { return null }
  const meta = record.payload
  if (record.type !== 'session_meta' || !meta) return null
  const origin = meta.source === 'cli' ? 'terminal'
    : meta.source === 'vscode' ? (meta.originator === 'Codex Desktop' ? 'codex-app' : 'editor')
    : null
  if (!origin) return null
  if (typeof meta.id !== 'string' || !SESSION_ID.test(meta.id)) return null
  if (typeof meta.cwd !== 'string' || !meta.cwd.startsWith('/')) return null
  return { sessionId: meta.id, engine: 'codex', cwd: meta.cwd, origin }
}

/** Codex's thread names: `session_index.jsonl`, one `{id, thread_name}` a line, the last one winning. */
async function codexTitles(path: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  const text = await readFile(path, 'utf8').catch(() => '')
  for (const line of text.split('\n')) {
    try {
      const record = JSON.parse(line) as { id?: unknown; thread_name?: unknown }
      if (typeof record.id === 'string' && typeof record.thread_name === 'string' && record.thread_name.trim()) {
        titles.set(record.id, record.thread_name.trim())
      }
    } catch { /* a line being written */ }
  }
  return titles
}

/** Where an open session is: a terminal, which Harness can take it over from, or an app, which it cannot. */
export type OpenIn = 'terminal' | 'app'

/** The process that has a session open. */
export interface SessionOwner {
  pid: number
  engine: ExternalEngine
  /** The terminal it runs in (`/dev/ttys003`), or null for an app: an app is never stopped from here. */
  tty: string | null
  /** What says whether it is mid-turn: Claude Code's `sessions/<pid>.json`, or Codex's rollout. */
  record: string
}

export interface OpenSessionsOptions {
  /** `~/.claude`: running Claude Code processes each keep `sessions/<pid>.json` there. */
  claudeHome: string
  /** How long an answer is reused. */
  maxAgeMs?: number
  /** Whether a process is running; tests replace it. */
  alive?: (pid: number) => boolean
  /** The Codex rollouts open in a running process, and the process; tests replace it. */
  openRollouts?: () => Promise<Array<{ pid: number; path: string }>>
  /** The terminal each process runs in, or null; tests replace it. */
  ttys?: (pids: number[]) => Promise<Map<number, string | null>>
  now?: () => number
}

type OpenAnswer = { at: number; owners: Map<string, SessionOwner>; open: Map<string, OpenIn> }

/**
 * Which sessions are open in a running process right now, so Cmd-P does not open one a second time
 * beside a terminal that still has it: both would write the same conversation. One open in a
 * terminal can be taken over instead (`owner`, `stopSessionOwner`).
 *
 * Claude Code says so itself — each running process keeps `~/.claude/sessions/<pid>.json` naming its
 * session. Codex keeps no such record, but holds its rollout file open while it runs, so the
 * operating system says which are (`lsof`). A process with a terminal is one a person runs there;
 * the engines' apps have none.
 */
export class OpenSessions {
  private answer: OpenAnswer | null = null
  private asking: Promise<OpenAnswer> | null = null

  constructor(private readonly opts: OpenSessionsOptions) {}

  /** The last answer, however old; empty before the first. Never waits. */
  known(): ReadonlyMap<string, OpenIn> {
    const now = (this.opts.now ?? Date.now)()
    if (!this.answer || now - this.answer.at > (this.opts.maxAgeMs ?? 5_000)) void this.fresh()
    return this.answer?.open ?? new Map()
  }

  /** An answer at most `maxAgeMs` old. */
  async fresh(): Promise<ReadonlyMap<string, OpenIn>> {
    return (await this.current()).open
  }

  /** The process that has [sessionId] open, looked at now rather than taken from a recent answer. */
  async owner(sessionId: string): Promise<SessionOwner | null> {
    if (!this.asking) this.answer = null
    return (await this.current()).owners.get(sessionId) ?? null
  }

  private current(): Promise<OpenAnswer> {
    const now = (this.opts.now ?? Date.now)()
    if (this.answer && now - this.answer.at <= (this.opts.maxAgeMs ?? 5_000)) return Promise.resolve(this.answer)
    this.asking ??= this.read().then((owners) => {
      const open = new Map([...owners].map(([id, owner]): [string, OpenIn] => [id, owner.tty ? 'terminal' : 'app']))
      this.answer = { at: (this.opts.now ?? Date.now)(), owners, open }
      return this.answer
    }).finally(() => { this.asking = null })
    return this.asking
  }

  private async read(): Promise<Map<string, SessionOwner>> {
    const owners = new Map<string, SessionOwner>()
    const alive = this.opts.alive ?? processAlive
    const dir = join(this.opts.claudeHome, 'sessions')
    for (const file of await entries(dir)) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue
      const path = join(dir, file.name)
      try {
        const record = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown; sessionId?: unknown }
        if (typeof record.pid === 'number' && typeof record.sessionId === 'string' && alive(record.pid)) {
          owners.set(record.sessionId, { pid: record.pid, engine: 'claude', tty: null, record: path })
        }
      } catch { /* one being written, or gone */ }
    }
    for (const { pid, path } of await (this.opts.openRollouts ?? openCodexRollouts)().catch(() => [])) {
      const id = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path)?.[1]
      if (id) owners.set(id, { pid, engine: 'codex', tty: null, record: path })
    }
    if (owners.size) {
      const ttys = await (this.opts.ttys ?? processTtys)([...new Set([...owners.values()].map((owner) => owner.pid))]).catch(() => new Map<number, string | null>())
      for (const owner of owners.values()) owner.tty = ttys.get(owner.pid) ?? null
    }
    return owners
  }
}

/**
 * Whether [owner] is in the middle of a turn. Claude Code's record says `idle` between turns. A Codex
 * rollout marks a turn's start (`task_started`) and its end (`task_complete`, or `turn_aborted`), so
 * the last of those near its end says. A file that cannot say counts as busy: the answer only
 * decides whether to ask before stopping it.
 */
export async function sessionBusy(owner: Pick<SessionOwner, 'engine' | 'record'>): Promise<boolean> {
  if (owner.engine === 'claude') {
    try {
      return (JSON.parse(await readFile(owner.record, 'utf8')) as { status?: unknown }).status !== 'idle'
    } catch {
      return false // gone: the process ended with it
    }
  }
  for (const bytes of [256 * 1024, 4 * 1024 * 1024]) {
    const lines = (await readTail(owner.record, bytes)).split('\n')
    for (let i = lines.length - 1; i > 0; i--) {
      const line = lines[i]
      if (!line.includes('"event_msg"') || !TURN_MARK.test(line)) continue
      try {
        const kind = (JSON.parse(line) as { payload?: { type?: unknown } }).payload?.type
        if (kind === 'task_started') return true
        if (kind === 'task_complete' || kind === 'turn_aborted') return false
      } catch { /* the line being written */ }
    }
  }
  return true
}

const TURN_MARK = /"(task_started|task_complete|turn_aborted)"/

async function readTail(path: string, bytes: number): Promise<string> {
  const handle = await open(path, 'r').catch(() => null)
  if (!handle) return ''
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, bytes)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

export interface StopOptions {
  alive?: (pid: number) => boolean
  kill?: (pid: number, signal: NodeJS.Signals) => void
  sleep?: (ms: number) => Promise<void>
  /** Writes to the owner's terminal; tests replace it. */
  writeTty?: (tty: string, text: string) => Promise<void>
}

/**
 * Stops the terminal process that has a session open, so Harness can resume it: asked to quit
 * (SIGTERM, which both engines answer by saving and restoring the terminal), then made to after five
 * seconds. Codex leaves its cursor hidden when told to quit rather than typing its way out, so the
 * terminal gets it back. Whether the process is gone.
 */
export async function stopSessionOwner(owner: Pick<SessionOwner, 'pid' | 'tty'>, opts: StopOptions = {}): Promise<boolean> {
  const alive = opts.alive ?? processAlive
  const kill = opts.kill ?? ((pid: number, signal: NodeJS.Signals) => { process.kill(pid, signal) })
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const gone = async (ms: number): Promise<boolean> => {
    for (let waited = 0; waited < ms; waited += 100) {
      if (!alive(owner.pid)) return true
      await sleep(100)
    }
    return !alive(owner.pid)
  }
  const signal = (name: NodeJS.Signals): void => {
    try { kill(owner.pid, name) } catch { /* already gone */ }
  }
  signal('SIGTERM')
  if (!await gone(5_000)) {
    signal('SIGKILL')
    if (!await gone(2_000)) return false
  }
  if (owner.tty) await (opts.writeTty ?? writeTty)(owner.tty, '\x1b[?25h').catch(() => undefined)
  return true
}

async function writeTty(tty: string, text: string): Promise<void> {
  const handle = await open(tty, 'w')
  try { await handle.write(text) } finally { await handle.close() }
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

/** The rollout files Codex processes have open, and which process: `lsof` over processes named codex. */
function openCodexRollouts(): Promise<Array<{ pid: number; path: string }>> {
  return new Promise((resolve) => {
    execFile('lsof', ['-n', '-P', '-Fpn', '-c', 'codex', '-c', 'Codex'], { timeout: 3_000, maxBuffer: 8 * 1024 * 1024 }, (_error, stdout) => {
      // lsof exits 1 when a name matches no process; what it printed is still the answer.
      const found: Array<{ pid: number; path: string }> = []
      let pid = 0
      for (const line of String(stdout ?? '').split('\n')) {
        if (line.startsWith('p')) pid = Number(line.slice(1)) || 0
        else if (pid && line.startsWith('n') && line.includes('rollout-') && line.endsWith('.jsonl')) found.push({ pid, path: line.slice(1) })
      }
      resolve(found)
    })
  })
}

/** Each process's terminal (`ps -o tty`): `ttys003` on macOS, `pts/3` on Linux, `??` or `?` for none. */
function processTtys(pids: number[]): Promise<Map<number, string | null>> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'pid=,tty=', '-p', pids.join(',')], { timeout: 3_000 }, (_error, stdout) => {
      const ttys = new Map<number, string | null>()
      for (const line of String(stdout ?? '').split('\n')) {
        const [pid, tty] = line.trim().split(/\s+/)
        if (!pid) continue
        ttys.set(Number(pid), tty && !tty.startsWith('?') ? `/dev/${tty}` : null)
      }
      resolve(ttys)
    })
  })
}
