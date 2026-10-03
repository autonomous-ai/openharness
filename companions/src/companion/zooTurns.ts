/**
 * Turns this computer finished, reported to the account's zoo so the server can grant the eggs earned
 * from work and grow the paired daemon (daemons/README.md, "Earning eggs and growing"; the server side
 * is backend/src/lib/zoo.ts, op `zoo.turn`).
 *
 * Two pieces, both free of the daemon's wiring so they test with a fake clock and a fake backend:
 *
 *  - `ZooTurnCounter` decides whether a finished turn counts. It counts when `turn_ended` arrives for a
 *    turn whose `turn_started` this process saw LIVE — the engine normalizers' own prompt record, which
 *    already leaves out tool results, injected context, compaction summaries and interrupts — and the
 *    session is one a person drives: not a replay, not a sub-agent, not a terminal, not the pair
 *    harness, not a turn killed by an interrupt. A turn picked back up at attach, or re-read from a
 *    transcript, never counts. There is no per-prompt "a person typed this" signal that covers prompts
 *    typed straight into a pane (only delivered messages carry a deliveryId), so a prompt a script or a
 *    `/loop` types counts too; the server's daily cap is what bounds that.
 *
 *    A counted turn carries two more facts: its `minutes` (whole agent-minutes from its live start to
 *    its end; every 10 count as one more turn on the server) and whether it finished while the person
 *    was `away` from this computer (the night egg).
 *
 *  - `LocalPresence` knows whether the person is at this computer: the local clients (a window, `hn`)
 *    attached and what their `daemon_presence` says. Away is no active client for `ZOO_AWAY_MS`.
 *
 *  - `ZooTurnReporter` batches counted turns for a minute and sends them as `zoo.turn` ops, one per
 *    local (day, hour), through the daemon's authenticated backend path — signed in only; a guest's
 *    turns are counted by the desktop client in its local zoo, never here. Each op carries a batch id;
 *    a send that failed is retried with the SAME ids, so a send that landed but whose answer was lost
 *    is dropped by the server rather than counted twice. Only while daemons are on (lib/daemonsSwitch.ts):
 *    off, nothing is counted, no timer is armed and nothing is sent.
 */
import { randomBytes } from 'node:crypto'
import { PAIR_ROSTER } from './roster.g.js'

/** How long counted turns gather before one report. */
export const ZOO_TURN_FLUSH_MS = 60_000
/** The most turns one op may carry (the server's bound); a minute never gets near it. */
const MAX_TURNS_PER_OP = 50
/** Ops waiting for a successful send, oldest dropped first past this (an hour of minutes, offline). */
const MAX_PENDING_OPS = 64
/** The server drops a day older than this many days before today (UTC-12 plus a day's lateness). */
const STALE_AFTER_DAYS = 2
/** The Store harness the pair brain runs in (daemons/BRAIN.md, P4). Its turns are the daemon's own. */
export const PAIR_HARNESS_DSH = 'autonomous/pair'
/** No active local client for this long, and a turn that finishes is an away turn (roster
 *  `earn.night.awayMinutes`, 30). */
export const ZOO_AWAY_MS = PAIR_ROSTER.awayMinutes * 60_000
/** The most minutes one turn counts: a turn whose end was never seen, stretched over days, counts one. */
export const ZOO_TURN_MAX_MINUTES = 24 * 60

/** A turn that counts: how long it ran, and whether it finished while the person was away. */
export interface ZooCountedTurn { minutes: number; away: boolean }
/** `minutes` and `away` are sent only when above 0, so a server from before them still takes the rest. */
export interface ZooTurnOp { op: 'zoo.turn'; batchId: string; n: number; minutes?: number; away?: number; day: string; hour: number; machineId: string }
export type ZooPost = (body: { ops: ZooTurnOp[] }) => Promise<{ status: number; body: Record<string, unknown> }>

const pad = (n: number): string => String(n).padStart(2, '0')

/** The machine's local calendar day (`YYYY-MM-DD`) and hour (0-23) at `at`. */
export function localDayHour(at: Date): { day: string; hour: number } {
  return { day: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`, hour: at.getHours() }
}

// ── Which turns count ────────────────────────────────────────────────────────────────────────────
export interface ZooTurnCounterDeps {
  /** Whether a session is one a person drives: not a sub-agent, not a terminal, not the pair harness.
   *  Asked when the turn ends, since that is when a Director's `busy` is known. */
  eligible: (sessionId: string) => boolean
  /** Whether the person is away from this computer now (LocalPresence.away). Asked when a counted turn
   *  ends. Absent: never away. */
  away?: () => boolean
  now?: () => number
}

export class ZooTurnCounter {
  /** Sessions whose open turn started live on the engine's prompt record, and when. */
  private readonly open = new Map<string, number>()
  private readonly now: () => number

  constructor(private readonly deps: ZooTurnCounterDeps) {
    this.now = deps.now ?? Date.now
  }

  /** A `turn_started`. `replay` covers both a transcript re-read and a turn picked up at attach. A second
   *  live start before the end (a prompt queued into a running turn) keeps the first start. */
  started(sessionId: string, opts: { replay: boolean }): void {
    if (opts.replay) this.open.delete(sessionId)
    else if (!this.open.has(sessionId)) this.open.set(sessionId, this.now())
  }

  /** A `turn_ended`: the turn as it counts toward the zoo, or null when it does not. */
  ended(sessionId: string, opts: { replay: boolean; aborted: boolean }): ZooCountedTurn | null {
    const startedAt = this.open.get(sessionId)
    this.open.delete(sessionId)
    if (startedAt === undefined || opts.replay || opts.aborted || !this.deps.eligible(sessionId)) return null
    const minutes = Math.min(Math.floor(Math.max(0, this.now() - startedAt) / 60_000), ZOO_TURN_MAX_MINUTES)
    return { minutes, away: this.deps.away?.() ?? false }
  }

  forget(sessionId: string): void {
    this.open.delete(sessionId)
  }

  /** Daemons went off (lib/daemonsSwitch.ts): no open turn carries over to when they come back. */
  clear(): void {
    this.open.clear()
  }
}

// ── Whether the person is here ───────────────────────────────────────────────────────────────────
/**
 * Whether the person is at this computer, from the local clients this harnessd serves (a window, `hn`;
 * never a tool client): here while any attached client is active — one that has not said otherwise is —
 * and away from the moment the last one went inactive (`daemon_presence { active: false }`) or detached.
 * A client going inactive may say how long its keyboard was already idle (`awayMs`), which moves that
 * moment back. Until a client has come and gone, the absence counts from when this process started, so
 * a restart never makes a turn an away turn.
 */
export class LocalPresence {
  /** Attached clients, and whether each says the person is active. */
  private readonly clients = new Map<string, boolean>()
  /** When the person was last here. */
  private leftAt: number

  constructor(private readonly now: () => number = Date.now) {
    this.leftAt = now()
  }

  attached(connId: string): void {
    this.clients.set(connId, true)
  }

  detached(connId: string): void {
    const was = this.here()
    this.clients.delete(connId)
    if (was && !this.here()) this.leftAt = this.now()
  }

  /** A client's `daemon_presence`. Only `active` (and, going inactive, `awayMs`) matters here. */
  presence(connId: string, payload: Record<string, unknown>): void {
    if (typeof payload.active !== 'boolean') return
    const was = this.here()
    this.clients.set(connId, payload.active)
    if (!was || this.here()) return
    const idle = typeof payload.awayMs === 'number' && Number.isFinite(payload.awayMs) ? Math.max(0, payload.awayMs) : 0
    this.leftAt = this.now() - idle
  }

  here(): boolean {
    for (const active of this.clients.values()) if (active) return true
    return false
  }

  /** How long the person has been away: 0 while here. */
  awayMs(): number {
    return this.here() ? 0 : Math.max(0, this.now() - this.leftAt)
  }

  away(): boolean {
    return this.awayMs() >= ZOO_AWAY_MS
  }
}

// ── Reporting them ───────────────────────────────────────────────────────────────────────────────
export interface ZooTurnReporterDeps {
  /** POST /api/zoo/ops through the daemon's authenticated backend path (proxyBackend in cli.ts). */
  post: ZooPost
  /** Only a signed-in daemon reports. */
  signedIn: () => boolean
  /** Daemons are on (lib/daemonsSwitch.ts). Off, nothing is counted, armed or sent. Absent: on. */
  enabled?: () => boolean
  /** This computer's machine id, as the backend knows it. */
  machineId: () => string
  now?: () => Date
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  newBatchId?: () => string
  log?: (line: string) => void
}

export class ZooTurnReporter {
  /** Turns counted since the last flush, by local day and hour, with their minutes and away turns. */
  private readonly buckets = new Map<string, { day: string; hour: number; n: number; minutes: number; away: number }>()
  /** Ops made but not yet accepted, oldest first. A retry sends them again with the same batch ids. */
  private pending: ZooTurnOp[] = []
  private timer: unknown = null
  private inFlight: Promise<void> | null = null
  private stopped = false
  private readonly now: () => Date
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly newBatchId: () => string
  private readonly log: (line: string) => void

  constructor(private readonly deps: ZooTurnReporterDeps) {
    this.now = deps.now ?? (() => new Date())
    this.setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t })
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
    this.newBatchId = deps.newBatchId ?? (() => randomBytes(12).toString('base64url'))
    this.log = deps.log ?? ((line) => console.log(line))
  }

  /** One counted turn, finished now. */
  count(turn: ZooCountedTurn = { minutes: 0, away: false }): void {
    if (this.stopped || !this.on() || !this.deps.signedIn()) return
    const { day, hour } = localDayHour(this.now())
    const key = `${day}T${hour}`
    const bucket = this.buckets.get(key) ?? { day, hour, n: 0, minutes: 0, away: 0 }
    bucket.n += 1
    bucket.minutes += Math.min(Math.max(0, Math.floor(turn.minutes)), ZOO_TURN_MAX_MINUTES)
    if (turn.away) bucket.away += 1
    this.buckets.set(key, bucket)
    this.arm()
  }

  /** What is waiting to be reported, for tests and the log. */
  get waiting(): { counted: number; pending: number } {
    let counted = 0
    for (const b of this.buckets.values()) counted += b.n
    return { counted, pending: this.pending.length }
  }

  /** Report now. Serialized: a flush while one is in flight runs after it. */
  flush(): Promise<void> {
    const run = (this.inFlight ?? Promise.resolve()).then(() => this.send())
    const tracked: Promise<void> = run.finally(() => { if (this.inFlight === tracked) this.inFlight = null })
    this.inFlight = tracked
    return tracked
  }

  /** Settles once no report is in flight (the one a timer started included). */
  idle(): Promise<void> {
    return this.inFlight ?? Promise.resolve()
  }

  /** Stop the timer; nothing more is counted. `flush()` still sends what is waiting. */
  stop(): void {
    this.stopped = true
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null }
  }

  /** Daemons went off: nothing waits, nothing is armed. Counting resumes when they are on again. */
  clear(): void {
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null }
    this.buckets.clear()
    this.pending = []
  }

  private on(): boolean { return this.deps.enabled?.() ?? true }

  private arm(): void {
    if (this.timer !== null || this.stopped) return
    this.timer = this.setTimer(() => { this.timer = null; void this.flush() }, ZOO_TURN_FLUSH_MS)
  }

  private async send(): Promise<void> {
    if (!this.on()) { this.buckets.clear(); this.pending = []; return }
    if (!this.deps.signedIn()) {
      // Signed out since: these were the account's turns, but there is no account to send them to now,
      // and a guest's zoo is the desktop's to count. Nothing is kept for a later sign-in.
      this.buckets.clear()
      this.pending = []
      return
    }
    const machineId = this.deps.machineId()
    for (const b of this.buckets.values()) {
      // Past 50 turns a bucket is split; its minutes and away turns go with the first ops that can hold
      // them (a day per turn, and at most one away per turn).
      let minutes = b.minutes
      let away = b.away
      for (let left = b.n; left > 0; left -= MAX_TURNS_PER_OP) {
        const n = Math.min(left, MAX_TURNS_PER_OP)
        const m = Math.min(minutes, n * ZOO_TURN_MAX_MINUTES)
        const a = Math.min(away, n)
        minutes -= m
        away -= a
        this.pending.push({
          op: 'zoo.turn', batchId: this.newBatchId(), n, ...(m > 0 ? { minutes: m } : {}), ...(a > 0 ? { away: a } : {}),
          day: b.day, hour: b.hour, machineId,
        })
      }
    }
    this.buckets.clear()
    const today = localDayHour(this.now()).day
    this.pending = this.pending.filter((op) => daysBetween(op.day, today) <= STALE_AFTER_DAYS).slice(-MAX_PENDING_OPS)
    if (!this.pending.length) return
    const ops = [...this.pending]
    const turns = ops.reduce((sum, op) => sum + op.n, 0)
    let status: number
    let code: unknown
    try {
      const res = await this.deps.post({ ops })
      status = res.status
      code = (res.body.error as { code?: unknown } | undefined)?.code
    } catch (err) {
      status = 0
      code = err instanceof Error ? err.message : String(err)
    }
    const sent = new Set(ops.map((op) => op.batchId))
    if (status >= 200 && status < 300) {
      this.pending = this.pending.filter((op) => !sent.has(op.batchId))
      this.log(`[zoo] reported ${turns} turn${turns === 1 ? '' : 's'} (${ops.length} batch${ops.length === 1 ? '' : 'es'})`)
      return
    }
    if (status === 401 || status === 400 || status === 403 || status === 404) {
      // Signed out (the backend's own answer), or a report this server will never take — a 404 is a
      // server with daemons off for this account: dropping it is the only way it stops being sent.
      this.pending = this.pending.filter((op) => !sent.has(op.batchId))
      this.log(`[zoo] dropped ${turns} turn${turns === 1 ? '' : 's'}: ${status} ${String(code ?? '')}`.trimEnd())
      return
    }
    const why = code ? `${status || 'no answer'} ${String(code)}` : String(status || 'no answer')
    this.log(`[zoo] could not report ${turns} turn${turns === 1 ? '' : 's'} (${why}); retrying`)
    this.arm()
  }
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. */
function daysBetween(from: string, to: string): number {
  const at = (day: string): number => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d) }
  return Math.round((at(to) - at(from)) / 86_400_000)
}
