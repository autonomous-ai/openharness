/**
 * PERSON-ONLY (daemons/LEARNING.md, "Security"). Approving a lesson puts words in front of every agent, so
 * only the person may do it — and the same for restoring an archived one and exporting skills into engine
 * folders. The goal is to keep AGENTS (the pair harness included) from approving lessons; it is not to defeat
 * malware running as the same user, which can already type into tmux.
 *
 * Every person-only action needs a daemon-issued, one-time NONCE (128 bits, two minutes, one use), handed out
 * only where the person is:
 *
 *   a key   The lesson's line and brief carry an id with a nonce in it (`lesson:<id>:<nonce>`), sent only to
 *           windows and `hn` (local `daemon_*` frames, never to a tool client). A key press echoes it back.
 *           A tool client's `daemon_act` on a lesson is refused, and so is one from a process the daemon can
 *           see inside a harness pane.
 *   the CLI `harness pair lessons approve <id>` asks for a challenge; the daemon issues its nonce only to a
 *           caller it has VERIFIED: over loopback TCP, found by its port (lsof, or /proc on Linux), whose
 *           process ancestry does not reach a harness-managed tmux pane or the daemon itself. The nonce is
 *           bound to that process; the approve that spends it is verified again. The CLI also refuses at
 *           once when its own environment says it is in a harness pane, and asks [y/N] at a terminal.
 *
 * Refused outright: any request carrying the pair token (PERSON_ONLY), any that only claims `confirmed`
 * (NONCE_REQUIRED), and any the daemon could not verify (UNVERIFIED: say yes with the key instead).
 */
import { execFile } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, readdirSync, readlinkSync } from 'node:fs'

export const PERSON_ACTIONS = ['approve', 'restore', 'export'] as const
export type PersonAction = typeof PERSON_ACTIONS[number]
export const isPersonAction = (action: string): action is PersonAction => (PERSON_ACTIONS as readonly string[]).includes(action)
export const APPROVAL_NONCE_TTL_MS = 2 * 60_000
const NONCES_MAX = 32

interface Issued { nonce: Buffer; action: string; id: string; pid: number | null; until: number }

/** One-time nonces for person-only actions, each bound to an action, a lesson and (for the CLI) a process. */
export class ApprovalNonces {
  private issued: Issued[] = []

  constructor(private readonly now: () => number, private readonly random: () => Buffer = () => randomBytes(16)) {}

  issue(action: string, id: string, pid: number | null = null): string {
    this.prune()
    this.issued = this.issued.filter((i) => !(i.action === action && i.id === id))
    const nonce = this.random()
    this.issued.push({ nonce, action, id, pid, until: this.now() + APPROVAL_NONCE_TTL_MS })
    if (this.issued.length > NONCES_MAX) this.issued.shift()
    return nonce.toString('hex')
  }

  /** True once for a live nonce issued for this action, lesson and process. Spent either way. */
  consume(action: string, id: string, nonce: unknown, pid: number | null = null): boolean {
    this.prune()
    if (typeof nonce !== 'string' || !/^[0-9a-f]{32}$/.test(nonce)) return false
    const given = Buffer.from(nonce, 'hex')
    const at = this.issued.findIndex((i) => i.nonce.length === given.length && timingSafeEqual(i.nonce, given))
    if (at < 0) return false
    const entry = this.issued.splice(at, 1)[0]!
    return entry.action === action && entry.id === id && (entry.pid === null || entry.pid === pid)
  }

  private prune(): void {
    const now = this.now()
    this.issued = this.issued.filter((i) => i.until > now)
  }
}

/** A random, unguessable key-line id: the key path's nonce. */
export function lessonLineId(lessonId: string): string {
  return `lesson:${lessonId}:${randomBytes(16).toString('hex')}`
}

// ── who is asking ─────────────────────────────────────────────────────────────────────────────────────

export type CallerVerdict = { ok: true; pid: number } | { ok: false; error: 'UNVERIFIED' | 'INSIDE_HARNESS'; detail: string }

export interface CallerDeps {
  /** The caller's end of local connection `connId`: its loopback TCP port, or null (the Unix socket, gone). */
  peerPort: (connId: string) => number | null
  /** The daemon's own loopback port. */
  localPort: () => number | null
  peerPid: (peerPort: number, localPort: number) => Promise<number | null>
  /** The process table (pid and parent), or null when it could not be read. */
  processes: () => Promise<Array<{ pid: number; parentPid: number }> | null>
  /** The root processes of the harness-managed tmux panes, or null when they could not be listed. */
  harnessPanePids: () => Promise<number[] | null>
  selfPid?: number
}

const USE_THE_KEY = 'press [y] on the daemon\'s line, or run the command in a terminal outside Harness'

/** A process and its parents, up to init. */
export function ancestry(pid: number, rows: ReadonlyArray<{ pid: number; parentPid: number }>): number[] {
  const parent = new Map(rows.map((r) => [r.pid, r.parentPid]))
  const chain: number[] = []
  for (let at: number | undefined = pid; at !== undefined && at > 1 && !chain.includes(at) && chain.length < 64; at = parent.get(at)) chain.push(at)
  return chain
}

/** Whether the process at the other end of `connId` is the person's: verified, and not inside a harness pane. */
export async function verifyPerson(connId: string, deps: CallerDeps): Promise<CallerVerdict> {
  const port = deps.peerPort(connId)
  const local = deps.localPort()
  if (port === null || local === null) return { ok: false, error: 'UNVERIFIED', detail: `the daemon cannot see who is asking over this connection; ${USE_THE_KEY}` }
  const pid = await deps.peerPid(port, local).catch(() => null)
  if (pid === null) return { ok: false, error: 'UNVERIFIED', detail: `the daemon could not find the process asking; ${USE_THE_KEY}` }
  const [rows, panes] = await Promise.all([deps.processes().catch(() => null), deps.harnessPanePids().catch(() => null)])
  if (!rows || !panes) return { ok: false, error: 'UNVERIFIED', detail: `the daemon could not read the process table; ${USE_THE_KEY}` }
  const chain = ancestry(pid, rows)
  const self = deps.selfPid ?? process.pid
  if (chain.includes(self) || chain.some((p) => panes.includes(p))) {
    return { ok: false, error: 'INSIDE_HARNESS', detail: `a process inside a harness never approves a lesson; ${USE_THE_KEY}` }
  }
  return { ok: true, pid }
}

/**
 * A key on a lesson's line (`daemon_act` on a `lesson:` id). Its id is the nonce, sent only to windows and
 * `hn`; on top of that a tool client never answers one, nor a process the daemon can see inside a harness
 * pane. A window it cannot see (the Unix socket) is let through: it holds the nonce, which no agent was sent.
 */
export async function lessonKeyVerdict(connId: string, deps: { isTool: (connId: string) => boolean; verify: (connId: string) => Promise<CallerVerdict> }):
  Promise<{ ok: true } | { ok: false; error: string; detail: string }> {
  if (deps.isTool(connId)) return { ok: false, error: 'PERSON_ONLY', detail: 'a tool never answers a lesson' }
  const verdict = await deps.verify(connId).catch((): CallerVerdict => ({ ok: false, error: 'UNVERIFIED', detail: '' }))
  if (!verdict.ok && verdict.error === 'INSIDE_HARNESS') return verdict
  return { ok: true }
}

type Run = (file: string, args: string[]) => Promise<string | null>

const runText: Run = (file, args) => new Promise((resolve) => {
  execFile(file, args, { timeout: 3_000, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? null : String(stdout)))
})

/** `lsof -Fpn` output: the pid whose socket is `127.0.0.1:<peerPort> -> …:<localPort>`. */
export function parseLsofPeer(output: string, peerPort: number, localPort: number, selfPid: number): number | null {
  let pid: number | null = null
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)); continue }
    if (!line.startsWith('n') || pid === null || pid === selfPid) continue
    const m = /:(\d+)->.*:(\d+)$/.exec(line)
    if (m && Number(m[1]) === peerPort && Number(m[2]) === localPort) return pid
  }
  return null
}

/** Linux: the socket inode of an ESTABLISHED loopback connection from `peerPort` to `localPort` (/proc/net/tcp). */
export function procSocketInode(tables: string[], peerPort: number, localPort: number): string | null {
  for (const table of tables) {
    for (const line of table.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/)
      if (f.length < 10) continue
      const local = parseInt(f[1]!.split(':')[1] ?? '', 16)
      const remote = parseInt(f[2]!.split(':')[1] ?? '', 16)
      if (local === peerPort && remote === localPort && f[3] === '01') return f[9]!
    }
  }
  return null
}

/** The pid at the other end of a loopback TCP connection to this process. lsof, then /proc on Linux. */
export async function loopbackPeerPid(peerPort: number, localPort: number,
  opts: { run?: Run; platform?: NodeJS.Platform; selfPid?: number; proc?: string } = {}): Promise<number | null> {
  const run = opts.run ?? runText
  const self = opts.selfPid ?? process.pid
  const out = await run('lsof', ['-nP', `-iTCP:${peerPort}`, '-sTCP:ESTABLISHED', '-Fpn'])
  const viaLsof = out === null ? null : parseLsofPeer(out, peerPort, localPort, self)
  if (viaLsof !== null || (opts.platform ?? process.platform) !== 'linux') return viaLsof
  const proc = opts.proc ?? '/proc'
  const tables = ['net/tcp', 'net/tcp6'].map((t) => { try { return readFileSync(`${proc}/${t}`, 'utf8') } catch { return '' } })
  const inode = procSocketInode(tables, peerPort, localPort)
  if (!inode) return null
  let pids: string[]
  try { pids = readdirSync(proc).filter((p) => /^\d+$/.test(p)) } catch { return null }
  for (const pid of pids) {
    if (Number(pid) === self) continue
    let fds: string[]
    try { fds = readdirSync(`${proc}/${pid}/fd`) } catch { continue }
    for (const fd of fds) {
      try { if (readlinkSync(`${proc}/${pid}/fd/${fd}`) === `socket:[${inode}]`) return Number(pid) } catch { /* closed */ }
    }
  }
  return null
}

// ── the CLI's own check ───────────────────────────────────────────────────────────────────────────────

/** Variables Harness sets in the panes it runs agents in. */
const PANE_ENV = ['HARNESSD_PAIR_TOKEN', 'HARNESSD_PAIR_TOKEN_FILE', 'HARNESS_CONTEXT_FILE', 'HARNESS_DSH', 'HARNESS_SKILLS_DIR', 'HARNESS_WORKSPACE'] as const

/** The first sign in `env` that this process runs in a harness pane, or null. Advisory: the daemon decides. */
export function harnessPaneEnv(env: NodeJS.ProcessEnv): string | null {
  return PANE_ENV.find((name) => typeof env[name] === 'string' && env[name]!.length > 0) ?? null
}
