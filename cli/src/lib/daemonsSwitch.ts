/**
 * Whether this harnessd runs its daemons at all (daemons/README.md, "Off switches"). Every daemon deploy
 * ships dark: until the account's zoo answers, harnessd behaves exactly as it did before daemons existed.
 *
 * Idle means idle. While off, none of these runs or even starts: the zoo reporter (`zoo.turn` batching),
 * the `zoo.lesson` credit, the PairSensor and its journal, the brain, learning (signals, distilling,
 * borrowing, the curator, lesson usage and lessons in launches), the pair harness, the pair.jsonc tick and
 * the pair's model warm-up. No timer, no journal, no extra transcript read, and one backend request: the
 * probe below.
 *
 * What turns them on:
 *
 *   signed in   `GET /api/zoo` answers 200. The server answers 404 when its switch is off for this account
 *               (backend lib/daemonsSwitch.ts): that is OFF, and it is cached — asked again at most every
 *               6 hours, with jitter, or at once on `zoo_changed` (which only a server with the zoo on
 *               sends) or when a window's own read through the proxy says otherwise. A 5xx or no answer is
 *               UNKNOWN: idle, asked again later (5 minutes, doubling to 6 hours). Once on, the zoo is
 *               re-read as it always was: on `zoo_changed` and on every reconnect.
 *   signed out  a window bound to this machine says its guest zoo has the person's consent
 *               (`daemon_presence { consent: true }`). Nothing is asked of the backend.
 *   never       the local kill switch: `HARNESS_DAEMONS=0` (`false`, `off`, `no`) in harnessd's
 *               environment, or `"daemons": false` in pair.jsonc. It wins over the server and a guest, and
 *               while it is set harnessd asks nothing at all. Setting it takes effect within 30 s while on
 *               (the pair.jsonc tick); clearing it the next time something asks for the zoo (a window's
 *               read, `zoo_changed`) or at the next harnessd start.
 *
 * The probe is the account's ordinary zoo read, so a 200 is also the zoo (`onRead`): pairing reads it
 * without a second request.
 */
import { statSync, readFileSync } from 'node:fs'
import { parseJsonc } from '../pair/rules.js'

/** What a window, `harness pair` or a tool is answered while daemons are off. Never an error that breaks it. */
export const DAEMONS_OFF = 'DAEMONS_OFF'
export const DAEMONS_OFF_DETAIL = 'Daemons are off for this account or on this computer.'
/** Once the server said off, the longest harnessd goes before asking again. */
export const DAEMONS_PROBE_MS = 6 * 60 * 60_000
/** At most this much is added to a scheduled probe, so a fleet of daemons never asks in step. */
export const DAEMONS_PROBE_JITTER_MS = 30 * 60_000
/** A probe that reached nothing (5xx, no answer) is asked again after this, doubling up to DAEMONS_PROBE_MS. */
export const DAEMONS_RETRY_MS = 5 * 60_000

export type ZooRead = { status: number; body: Record<string, unknown> }

/** The server's last definitive answer: 200 on, 404 off, or none yet. */
export type DaemonsServerState = 'on' | 'off' | 'unknown'

export interface DaemonsSwitchDeps {
  /** GET /api/zoo through the daemon's signed-in backend path (proxyBackend in cli.ts). Never throws there. */
  read: () => Promise<ZooRead>
  signedIn: () => boolean
  /** The local kill switch (`localKillSwitch`): a reason while set, else null. */
  killed: () => string | null
  /** Daemons as a whole came on or went off: cli.ts starts or stops everything daemon-related. */
  onChange: (on: boolean) => void
  /**
   * Every answer the switch acted on: each probe's, and the 200s and 404s it observed. A 200 is the zoo
   * itself (pairing reads it), handed over BEFORE daemons switch on, so what starts sees the fresh zoo.
   */
  onRead?: (read: ZooRead) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  random?: () => number
  log?: (line: string) => void
}

export class DaemonsSwitch {
  private server: DaemonsServerState = 'unknown'
  private guest = false
  private current = false
  private started = false
  private stopped = false
  private timer: unknown = null
  private inFlight: Promise<void> | null = null
  /** A reason to ask again arrived while a probe was out (a `zoo_changed`): one more read after it. */
  private again = false
  /** Probes in a row that reached nothing: the retry's back-off. */
  private failures = 0
  private probes = 0
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly random: () => number
  private readonly log: (line: string) => void

  constructor(private readonly deps: DaemonsSwitchDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t })
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
    this.random = deps.random ?? Math.random
    this.log = deps.log ?? ((line) => console.log(line))
  }

  /** Daemons run right now. */
  on(): boolean { return this.current }

  /** For the log, the status endpoint and tests. */
  state(): { on: boolean; server: DaemonsServerState; guest: boolean; killed: string | null; probes: number; waiting: boolean } {
    return { on: this.current, server: this.server, guest: this.guest, killed: this.deps.killed(), probes: this.probes, waiting: this.timer !== null }
  }

  /** harnessd is up (a sign-in restarts it, so this is sign-in too): the one probe. */
  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    this.probe()
  }

  /**
   * The backend link came up. While on, the zoo is re-read as it always was (a `zoo_changed` sent while
   * the link was down is lost). A daemon that never asked (it was signed out when it started) asks now;
   * one whose last probe reached nothing asks now rather than wait out its back-off. Off waits for its timer.
   */
  connected(): void {
    if (!this.started || this.stopped) return
    if (this.server === 'on' || this.probes === 0 || this.failures > 0) this.probe()
  }

  /** `zoo_changed`: only a server with the zoo on sends it. Ask now, whatever was cached. */
  zooChanged(): void {
    if (!this.started || this.stopped) return
    this.probe()
  }

  /**
   * A /api/zoo answer somebody else asked for (a window's read or op through the proxy, a zoo.turn report):
   * the same news as a probe, and no request of our own. 200 is on, 404 is off; anything else says nothing.
   */
  observe(read: ZooRead): void {
    if (!this.started || this.stopped || this.deps.killed()) return
    if (read.status === 200 || read.status === 404) this.answered(read)
  }

  /** A window bound to this machine says whether its guest zoo has the person's consent (signed out only). */
  guestConsent(consented: boolean): void {
    if (this.guest === consented) return
    this.guest = consented
    this.apply()
  }

  /** Look at the kill switch again (the pair.jsonc tick, while on). */
  recheck(): void { this.apply() }

  stop(): void {
    this.stopped = true
    this.cancel()
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────────

  private probe(): void {
    if (this.stopped) return
    if (this.inFlight) { this.again = true; return }
    this.cancel()
    // Killed: nothing is asked, ever. Signed out: there is no account to ask; a guest window decides.
    if (this.deps.killed() || !this.deps.signedIn()) { this.apply(); return }
    this.probes++
    const run = this.deps.read()
      .catch((): ZooRead => ({ status: 0, body: {} }))
      .then((read) => this.answered(read))
    this.inFlight = run.finally(() => {
      this.inFlight = null
      if (this.again && !this.stopped) { this.again = false; this.probe() }
    })
  }

  private answered(read: ZooRead): void {
    if (this.stopped) return
    if (read.status === 200) {
      this.server = 'on'
      this.failures = 0
      this.cancel()
      this.hand(read)   // first: what switches on reads this zoo, not the one before it
      this.apply()
      return
    }
    if (read.status === 404) {
      if (this.server !== 'off') this.log('[daemons] off for this account (the server answers 404 for /api/zoo); asking again in about 6 hours')
      this.server = 'off'
      this.failures = 0
      this.apply()
      this.hand(read)
      this.schedule(DAEMONS_PROBE_MS)
      return
    }
    this.hand(read)
    // Anything else is no answer about daemons. A daemon that was on stays on through a blip (the zoo is
    // re-read on the next reconnect, as it always was); one that was off or never knew stays idle.
    if (this.server === 'on') return
    if (read.status === 0 || read.status >= 500) {
      this.failures++
      if (this.server === 'off') { this.schedule(DAEMONS_PROBE_MS); return }
      this.schedule(Math.min(DAEMONS_RETRY_MS * 2 ** (this.failures - 1), DAEMONS_PROBE_MS))
      return
    }
    // 401, 403 and the rest: this account cannot be asked right now. A sign-in restarts harnessd.
    this.failures = 0
    this.schedule(DAEMONS_PROBE_MS)
  }

  private hand(read: ZooRead): void {
    try { this.deps.onRead?.(read) } catch (err) { this.log(`[daemons] reading the zoo failed: ${err instanceof Error ? err.message : String(err)}`) }
  }

  private apply(): void {
    // Nothing switches before start(): what it would start is not wired yet.
    if (!this.started) return
    const killed = this.deps.killed()
    const next = !this.stopped && !killed && (this.deps.signedIn() ? this.server === 'on' : this.guest)
    if (killed) this.cancel()
    if (next === this.current) return
    this.current = next
    this.log(next
      ? `[daemons] on${this.deps.signedIn() ? '' : ' · a guest window asked'}`
      : `[daemons] off${killed ? ` · ${killed}` : ''}`)
    try { this.deps.onChange(next) } catch (err) { this.log(`[daemons] switching ${next ? 'on' : 'off'} failed: ${err instanceof Error ? err.message : String(err)}`) }
  }

  private schedule(base: number): void {
    this.cancel()
    if (this.stopped) return
    const ms = base + Math.floor(this.random() * Math.min(DAEMONS_PROBE_JITTER_MS, base / 5))
    this.timer = this.setTimer(() => { this.timer = null; this.probe() }, ms)
  }

  private cancel(): void {
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null }
  }
}

// ── the local kill switch ──────────────────────────────────────────────────────────────────────────────

const OFF_WORDS = new Set(['0', 'false', 'off', 'no'])

/**
 * The local kill switch: `HARNESS_DAEMONS=0` (or `false`, `off`, `no`) in harnessd's environment, or
 * `"daemons": false` at the top of pair.jsonc (JSON with comments). Answers the reason while it is set,
 * else null. The file is re-read only when it changes on disk; one that cannot be read or parsed is not a
 * kill switch (it holds no `false`).
 */
export function localKillSwitch(opts: { env?: NodeJS.ProcessEnv; file: string }): () => string | null {
  const envValue = (opts.env ?? process.env).HARNESS_DAEMONS
  const envOff = typeof envValue === 'string' && OFF_WORDS.has(envValue.trim().toLowerCase())
  let stamp = ''
  let fileOff = false
  return () => {
    if (envOff) return 'HARNESS_DAEMONS=0'
    let now = 'missing'
    try { const stat = statSync(opts.file); now = `${stat.mtimeMs}:${stat.size}` } catch { /* no file */ }
    if (now !== stamp) {
      stamp = now
      fileOff = false
      if (now !== 'missing') {
        try {
          const parsed = parseJsonc(readFileSync(opts.file, 'utf8')) as { daemons?: unknown } | null
          fileOff = !!parsed && typeof parsed === 'object' && parsed.daemons === false
        } catch { fileOff = false }
      }
    }
    return fileOff ? 'pair.jsonc "daemons": false' : null
  }
}

// ── the loopback proxy of /api/zoo ─────────────────────────────────────────────────────────────────────

/**
 * What the hook server's `/api/zoo` passthrough answers a window (hookServer.ts `onZooRead`/`onZooOps`).
 * Killed on this computer: a 404 carrying DAEMONS_OFF, without asking the backend — the window hides
 * daemons exactly as it does for the server's own 404. Otherwise the backend's answer verbatim, which the
 * switch also learns from (`observe`).
 */
export function zooPassthrough(deps: {
  proxy: (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<ZooRead>
  killed: () => string | null
  observe: (read: ZooRead) => void
}): { read: () => Promise<ZooRead>; ops: (body: unknown) => Promise<ZooRead> } {
  const off = (): ZooRead => ({ status: 404, body: { success: false, error: { code: DAEMONS_OFF, message: DAEMONS_OFF_DETAIL } } })
  const through = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<ZooRead> => {
    if (deps.killed()) return off()
    const read = await deps.proxy(method, path, body)
    deps.observe(read)
    return read
  }
  return { read: () => through('GET', '/api/zoo'), ops: (body) => through('POST', '/api/zoo/ops', body) }
}
