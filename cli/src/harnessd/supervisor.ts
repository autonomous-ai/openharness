/**
 * harnessd's master: keeps the core running, and nothing else.
 *
 * The core is the process that owns sessions, terminals and turns. The master starts it, restarts it
 * when it crashes, hangs, never finishes starting or outgrows its memory budget, puts it in safe mode
 * when it keeps crashing, and stops it when asked. It holds no sessions, opens no network connection
 * and contains no feature code, so there is almost nothing in it that can fail — which is the point:
 * the daemon comes back even when the desktop app is not running to restart it.
 *
 * The core and the master talk over the spawn channel (`./protocol.ts`). Everything that touches the
 * operating system is injected (`SupervisorDeps`), so every decision here is tested without one.
 */
import {
  CORE_EXIT_STOP,
  CORE_EXIT_UPDATE,
  HARNESSD_PROTOCOL,
  isCoreMessage,
  type CoreMessage,
  type MasterMessage,
} from './protocol.js'

export interface CoreHandle {
  readonly pid: number | undefined
  send(message: MasterMessage): void
  kill(signal: NodeJS.Signals): void
  onMessage(listener: (message: unknown) => void): void
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
}

export interface SupervisorDeps {
  /** Start a core with these extra environment variables. */
  spawnCore(env: Record<string, string>): CoreHandle
  /** A monotonic clock, in ms: durations only, untouched by sleep and clock changes. */
  now(): number
  /** The wall clock, in ms: what the status says things happened at. */
  wallClock(): number
  setTimer(run: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
  /** Claim the pid file for the master — the signal `harness start` waits on. */
  claimPidFile(): void
  /** Remove the pid file if it is still the master's. */
  releasePidFile(): void
  /** Put the previous bundle back (`selfUpdate.restore`): the update it replaced failed. */
  restoreUpdate(): void
  /** Drop the previous bundle (`selfUpdate.confirm`): the update came up and stayed up. */
  confirmUpdate(): void
  /** Record the status where `harness status` reads it when no core can answer. */
  writeStatus(status: SupervisorStatus): void
  log(line: string): void
  exit(code: number): void
}

export interface SupervisorOptions {
  /** A core that has not said it is bound by then is killed and started again. */
  bindTimeoutMs: number
  /** A bound core that has not said it is ready by then is killed and started again (protocol 2 on). */
  readyTimeoutMs: number
  /** A bound core that sends no heartbeat for this long is hung: killed and started again. */
  heartbeatTimeoutMs: number
  /** How long a core gets to stop after SIGTERM before SIGKILL. */
  stopGraceMs: number
  /** Restart delay: starts here, doubles per crash, caps at `maxBackoffMs`. */
  initialBackoffMs: number
  maxBackoffMs: number
  /** A core that stayed up this long earns the next crash the initial delay again. */
  backoffResetMs: number
  /** The V8 heap limit the core runs with, MiB (`--max-old-space-size`); 0 leaves V8's own. */
  heapLimitMiB: number
  /** Past this share of `heapLimitMiB` the core is restarted cleanly, before V8 aborts it. */
  heapRestartPercent: number
  /** Resident memory past which a core is restarted, MiB — buffers V8 does not count included; 0: off. */
  rssLimitMiB: number
  /** How long a core started on a new bundle must stay up, from ready, before the update is kept. */
  updateProbationMs: number
  /** This many crashes inside `crashLoopWindowMs` start the next core in safe mode. */
  crashLoopCrashes: number
  crashLoopWindowMs: number
}

export const DEFAULT_SUPERVISOR_OPTIONS: SupervisorOptions = {
  bindTimeoutMs: 60_000,
  readyTimeoutMs: 120_000,
  heartbeatTimeoutMs: 30_000,
  // Inside `harness stop`'s own 3 s grace, so the master stops its core and exits before that SIGKILL.
  stopGraceMs: 2_500,
  initialBackoffMs: 500,
  maxBackoffMs: 30_000,
  backoffResetMs: 60_000,
  heapLimitMiB: 4_096,
  heapRestartPercent: 75,
  rssLimitMiB: 6_144,
  updateProbationMs: 30_000,
  crashLoopCrashes: 3,
  crashLoopWindowMs: 300_000,
}

/** `listening`: bound, still starting. `running`: ready (a protocol 1 core is running once bound). */
export type SupervisorState = 'idle' | 'starting' | 'listening' | 'running' | 'restarting' | 'stopping' | 'stopped'

/** Why the last core ended. */
export type ExitReason = 'crashed' | 'hung' | 'did-not-bind' | 'not-ready' | 'memory' | 'update' | 'stopped'

export interface SupervisorStatus {
  state: SupervisorState
  corePid: number | null
  restarts: number
  lastExit: string | null
  lastExitReason: ExitReason | null
  /** Why the core runs in safe mode, or null. */
  safeMode: string | null
  protocol: number
  /** When the state last changed, wall clock ms. */
  since: number
}

type TimerName = 'bindTimer' | 'readyTimer' | 'heartbeatTimer' | 'killTimer' | 'restartTimer' | 'probationTimer'

const describeExit = (code: number | null, signal: NodeJS.Signals | null): string =>
  signal ? `signal ${signal}` : `code ${code}`
const MIB = 1024 * 1024

export class Supervisor {
  private state: SupervisorState = 'idle'
  private since: number
  private core: CoreHandle | null = null
  private bound = false
  /** The protocol the running core stated in `bound`; the master's own until it does. */
  private coreProtocol = HARNESSD_PROTOCOL
  private upAt = 0
  private claimed = false
  private restarts = 0
  private backoff: number
  private lastExit: string | null = null
  private lastExitReason: ExitReason | null = null
  /** Why the master is ending the core it is running, if it is: decides what its exit means. */
  private ending: 'stop' | 'restart' | null = null
  /** Why the master killed the running core, when it did. */
  private killReason: ExitReason | null = null
  /** A core exited for an update: the next one runs the new bundle, on probation until it proves it. */
  private update: 'pending' | 'probation' | null = null
  /** Crashes inside the crash-loop window, on the monotonic clock. */
  private crashes: number[] = []
  /** Set while the core is started in safe mode, with the reason. */
  private safeMode: string | null = null
  /** The safe mode the running core says it is in, whoever chose it. */
  private coreSafeMode: string | null = null
  private bindTimer: unknown = null
  private readyTimer: unknown = null
  private probationTimer: unknown = null
  private heartbeatTimer: unknown = null
  private killTimer: unknown = null
  private restartTimer: unknown = null

  constructor(private readonly deps: SupervisorDeps, private readonly options: SupervisorOptions = DEFAULT_SUPERVISOR_OPTIONS) {
    this.backoff = options.initialBackoffMs
    this.since = deps.wallClock()
  }

  status(): SupervisorStatus {
    return {
      state: this.state,
      corePid: this.core?.pid ?? null,
      restarts: this.restarts,
      lastExit: this.lastExit,
      lastExitReason: this.lastExitReason,
      safeMode: this.coreSafeMode ?? this.safeMode,
      protocol: HARNESSD_PROTOCOL,
      since: this.since,
    }
  }

  start(): void {
    if (this.state !== 'idle') return
    this.spawn()
  }

  /** Stop the core and the master. A second call while stopping kills the core outright. */
  stop(reason: string): void {
    if (this.state === 'stopped') return
    if (this.state === 'stopping') {
      this.core?.kill('SIGKILL')
      return
    }
    this.deps.log(`[harnessd] ${reason} — stopping`)
    this.setState('stopping')
    this.clearTimer('restartTimer')
    if (!this.core) { this.finish(0); return }
    this.end('stop', 'SIGTERM')
  }

  private setState(state: SupervisorState): void {
    this.state = state
    this.since = this.deps.wallClock()
    this.publish()
  }

  /** The status to the status file, and to a bound core for its `/api/status`. */
  private publish(): void {
    const status = this.status()
    this.deps.writeStatus(status)
    if (this.bound) this.core?.send({ type: 'harnessd:status', status })
  }

  private spawn(): void {
    this.bound = false
    this.coreProtocol = HARNESSD_PROTOCOL
    this.coreSafeMode = null
    this.ending = null
    this.killReason = null
    // The core is told how long a silence the master allows, and beats well inside it (systemd passes
    // WATCHDOG_USEC the same way): a timeout shorter than the core's own beat would kill a healthy core.
    const env: Record<string, string> = {
      HARNESSD_SUPERVISED: '1', HARNESSD_RESTARTS: String(this.restarts), HARNESSD_WATCHDOG_MS: String(this.options.heartbeatTimeoutMs),
    }
    if (this.lastExit) env.HARNESSD_LAST_EXIT = this.lastExit
    if (this.safeMode) env.HARNESSD_SAFE_MODE = this.safeMode
    const core = this.deps.spawnCore(env)
    this.core = core
    core.onMessage((message) => { if (this.core === core && isCoreMessage(message)) this.onMessage(core, message) })
    core.onExit((code, signal) => { if (this.core === core) this.onExit(code, signal) })
    this.deps.log(`[harnessd] core started (pid ${core.pid ?? '?'})${this.restarts ? ` · restart ${this.restarts}` : ''}${this.safeMode ? ` · safe mode: ${this.safeMode}` : ''}`)
    this.setState(this.restarts === 0 ? 'starting' : 'restarting')
    this.armTimer('bindTimer', () => this.kill(core, 'did-not-bind', `did not bind within ${this.options.bindTimeoutMs} ms`), this.options.bindTimeoutMs)
  }

  private onMessage(core: CoreHandle, message: CoreMessage): void {
    switch (message.type) {
      case 'harnessd:bound': {
        if (this.bound) return
        this.bound = true
        this.coreProtocol = message.protocol
        this.upAt = this.deps.now()
        this.clearTimer('bindTimer')
        if (!this.claimed) { this.deps.claimPidFile(); this.claimed = true }
        this.deps.log(`[harnessd] core bound (pid ${core.pid ?? '?'}, protocol ${message.protocol})`)
        this.watchHeartbeat()
        // A core from before `ready` is running once bound, and its update is judged from there.
        const readiness = message.protocol >= 2
        if (readiness) {
          this.armTimer('readyTimer', () => this.kill(core, 'not-ready', `bound but not ready within ${this.options.readyTimeoutMs} ms`), this.options.readyTimeoutMs)
        }
        if (this.state !== 'stopping') this.setState(readiness ? 'listening' : 'running')
        if (!readiness) this.beginProbation()
        return
      }
      case 'harnessd:ready':
        if (!this.bound || this.state !== 'listening') return
        this.clearTimer('readyTimer')
        if (message.safeMode !== undefined && this.update) {
          // The new bundle could not start: that is the update failing, however long it stays up.
          this.kill(core, 'crashed', `started in safe mode on the new bundle (${message.safeMode})`)
          return
        }
        this.upAt = this.deps.now()
        this.coreSafeMode = message.safeMode ?? null
        this.deps.log(`[harnessd] core ready (pid ${core.pid ?? '?'})${message.safeMode === undefined ? '' : ` · in safe mode: ${message.safeMode}`}`)
        this.setState('running')
        this.beginProbation()
        return
      case 'harnessd:heartbeat': {
        if (!this.bound) return
        this.watchHeartbeat()
        if (this.ending) return
        const heapBudget = this.options.heapLimitMiB * MIB * this.options.heapRestartPercent / 100
        if (heapBudget && message.heapUsedBytes > heapBudget) {
          this.restartForMemory(`its heap is at ${Math.round(message.heapUsedBytes / MIB)} MiB, past ${this.options.heapRestartPercent}% of its ${this.options.heapLimitMiB} MiB limit`)
        } else if (this.options.rssLimitMiB && message.rssBytes > this.options.rssLimitMiB * MIB) {
          this.restartForMemory(`it is using ${Math.round(message.rssBytes / MIB)} MiB, over its ${this.options.rssLimitMiB} MiB budget`)
        }
        return
      }
    }
  }

  private restartForMemory(why: string): void {
    this.deps.log(`[harnessd] core ${why} — restarting it`)
    this.killReason = 'memory'
    this.end('restart', 'SIGTERM')
  }

  private beginProbation(): void {
    if (this.update !== 'pending') return
    this.update = 'probation'
    this.armTimer('probationTimer', () => {
      this.probationTimer = null
      this.update = null
      this.deps.confirmUpdate()
      this.deps.log('[harnessd] the update stayed up — keeping it')
    }, this.options.updateProbationMs)
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const exit = describeExit(code, signal)
    const reason = this.killReason ?? (code === CORE_EXIT_UPDATE ? 'update' : 'crashed')
    const wasSafe = this.safeMode ?? this.coreSafeMode
    for (const timer of ['bindTimer', 'readyTimer', 'heartbeatTimer', 'killTimer', 'probationTimer'] as const) this.clearTimer(timer)
    this.core = null
    this.bound = false
    this.coreSafeMode = null
    if (this.state === 'stopping') {
      this.deps.log(`[harnessd] core stopped (${exit})`)
      this.lastExit = exit
      this.lastExitReason = 'stopped'
      this.finish(0)
      return
    }
    this.lastExit = exit
    this.lastExitReason = reason
    this.restarts++
    if (this.update) {
      // The core on the new bundle did not come up, or did not stay up: the bundle before it did.
      this.update = null
      this.deps.restoreUpdate()
      this.deps.log(`[harnessd] the updated core failed (${exit}) — rolled back to the previous bundle; restarting`)
      this.scheduleSpawn(0)
      return
    }
    // A deliberate end: signed out for good, removed from the account, connected from elsewhere. A core
    // started again would only end itself again; the master goes with it. Protocol 1 cores said so with 0.
    const forGood = signal === null && this.ending !== 'restart' && (code === CORE_EXIT_STOP || (code === 0 && this.coreProtocol < 2))
    if (forGood) {
      this.deps.log(`[harnessd] core stopped for good (${exit}) — stopping`)
      this.lastExitReason = 'stopped'
      this.finish(0)
      return
    }
    if (reason === 'update') {
      // A new bundle, and a clean slate: whatever was crashing may be what it fixes.
      this.update = 'pending'
      this.crashes = []
      this.safeMode = null
      this.deps.log(`[harnessd] core exited (${exit}) for an update — restarting`)
      this.scheduleSpawn(0)
      return
    }
    if (wasSafe) {
      // Safe mode ran its course without a fix arriving: a normal core gets another try.
      this.crashes = []
      this.safeMode = null
    } else {
      const now = this.deps.now()
      this.crashes = [...this.crashes.filter((at) => now - at < this.options.crashLoopWindowMs), now]
      if (this.crashes.length >= this.options.crashLoopCrashes) {
        this.safeMode = 'crash-loop'
        this.deps.log(`[harnessd] core crashed ${this.crashes.length} times in ${Math.round(this.options.crashLoopWindowMs / 60_000)} min — starting it in safe mode`)
      }
    }
    if (this.upAt && this.deps.now() - this.upAt >= this.options.backoffResetMs) this.backoff = this.options.initialBackoffMs
    // A memory restart backs off like a crash: a core over budget from the start would otherwise be
    // restarted as fast as it can bind. Only an update restarts at once.
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, this.options.maxBackoffMs)
    this.upAt = 0
    this.deps.log(`[harnessd] core exited (${exit}, ${reason}) — restarting in ${delay} ms`)
    this.scheduleSpawn(delay)
  }

  private scheduleSpawn(delay: number): void {
    this.setState('restarting')
    this.armTimer('restartTimer', () => { this.restartTimer = null; this.spawn() }, delay)
  }

  /** Kill a core that broke a promise — to bind, to be ready, to beat — and remember which. */
  private kill(core: CoreHandle, reason: ExitReason, what: string): void {
    this.deps.log(`[harnessd] core ${what} — killing it`)
    this.killReason = reason
    core.kill('SIGKILL')
  }

  /** End the running core: SIGTERM (or SIGKILL), and SIGKILL if it outlives the grace. */
  private end(why: 'stop' | 'restart', signal: NodeJS.Signals): void {
    const core = this.core!
    this.ending = why
    this.clearTimer('heartbeatTimer')
    this.clearTimer('readyTimer')
    core.kill(signal)
    this.armTimer('killTimer', () => {
      this.deps.log(`[harnessd] core outlived its ${this.options.stopGraceMs} ms to stop — killing it`)
      core.kill('SIGKILL')
    }, this.options.stopGraceMs)
  }

  private watchHeartbeat(): void {
    const core = this.core!
    this.armTimer('heartbeatTimer', () => this.kill(core, 'hung', `sent no heartbeat for ${this.options.heartbeatTimeoutMs} ms — it is hung;`), this.options.heartbeatTimeoutMs)
  }

  private finish(code: number): void {
    this.clearTimer('restartTimer')
    this.clearTimer('probationTimer')
    this.setState('stopped')
    if (this.claimed) this.deps.releasePidFile()
    this.deps.exit(code)
  }

  private armTimer(name: TimerName, run: () => void, ms: number): void {
    this.clearTimer(name)
    this[name] = this.deps.setTimer(run, ms)
  }

  private clearTimer(name: TimerName): void {
    if (this[name] !== null) this.deps.clearTimer(this[name])
    this[name] = null
  }
}
