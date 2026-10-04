/**
 * harnessd's master: keeps the core running, and nothing else.
 *
 * The core is the process that owns sessions, terminals and turns. The master starts it, restarts it
 * when it crashes, hangs or outgrows its memory budget, and stops it when asked. It holds no
 * sessions, opens no network connection and contains no feature code, so there is almost nothing in
 * it that can fail — which is the point: the daemon comes back even when the desktop app is not
 * running to restart it.
 *
 * The core and the master talk over the spawn channel (`./protocol.ts`). Everything that touches the
 * operating system is injected (`SupervisorDeps`), so every decision here is tested without one.
 */
import {
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
  now(): number
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
  log(line: string): void
  exit(code: number): void
}

export interface SupervisorOptions {
  /** A core that has not said it is bound by then is killed and started again. */
  bindTimeoutMs: number
  /** A bound core that sends no heartbeat for this long is hung: killed and started again. */
  heartbeatTimeoutMs: number
  /** How long a core gets to stop after SIGTERM before SIGKILL. */
  stopGraceMs: number
  /** Restart delay: starts here, doubles per crash, caps at `maxBackoffMs`. */
  initialBackoffMs: number
  maxBackoffMs: number
  /** A core that stayed bound this long earns the next crash the initial delay again. */
  backoffResetMs: number
  /** Resident memory past which a core is restarted, MiB; 0 turns the check off. */
  rssLimitMiB: number
  /** How long a core started on a new bundle must stay up after binding before the update is kept. */
  updateProbationMs: number
}

export const DEFAULT_SUPERVISOR_OPTIONS: SupervisorOptions = {
  bindTimeoutMs: 60_000,
  heartbeatTimeoutMs: 30_000,
  // Inside `harness stop`'s own 3 s grace, so the master stops its core and exits before that SIGKILL.
  stopGraceMs: 2_500,
  initialBackoffMs: 500,
  maxBackoffMs: 30_000,
  backoffResetMs: 60_000,
  rssLimitMiB: 4_096,
  updateProbationMs: 30_000,
}

export type SupervisorState = 'idle' | 'starting' | 'running' | 'restarting' | 'stopping' | 'stopped'

export interface SupervisorStatus {
  state: SupervisorState
  corePid: number | null
  restarts: number
  lastExit: string | null
  protocol: number
}

type TimerName = 'bindTimer' | 'heartbeatTimer' | 'killTimer' | 'restartTimer' | 'probationTimer'

const describeExit = (code: number | null, signal: NodeJS.Signals | null): string =>
  signal ? `signal ${signal}` : `code ${code}`

export class Supervisor {
  private state: SupervisorState = 'idle'
  private core: CoreHandle | null = null
  private bound = false
  private boundAt = 0
  private claimed = false
  private restarts = 0
  private backoff: number
  private lastExit: string | null = null
  /** Why the master is ending the core it is running, if it is: decides what its exit means. */
  private ending: 'stop' | 'restart' | null = null
  /** A core exited for an update: the next one runs the new bundle, on probation until it proves it. */
  private update: 'pending' | 'probation' | null = null
  private bindTimer: unknown = null
  private probationTimer: unknown = null
  private heartbeatTimer: unknown = null
  private killTimer: unknown = null
  private restartTimer: unknown = null

  constructor(private readonly deps: SupervisorDeps, private readonly options: SupervisorOptions = DEFAULT_SUPERVISOR_OPTIONS) {
    this.backoff = options.initialBackoffMs
  }

  status(): SupervisorStatus {
    return {
      state: this.state,
      corePid: this.core?.pid ?? null,
      restarts: this.restarts,
      lastExit: this.lastExit,
      protocol: HARNESSD_PROTOCOL,
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
    this.state = 'stopping'
    this.clearTimer('restartTimer')
    if (!this.core) { this.finish(0); return }
    this.end('stop', 'SIGTERM')
  }

  private spawn(): void {
    this.state = this.restarts === 0 ? 'starting' : 'restarting'
    this.bound = false
    this.ending = null
    const env: Record<string, string> = { HARNESSD_SUPERVISED: '1', HARNESSD_RESTARTS: String(this.restarts) }
    if (this.lastExit) env.HARNESSD_LAST_EXIT = this.lastExit
    const core = this.deps.spawnCore(env)
    this.core = core
    core.onMessage((message) => { if (this.core === core && isCoreMessage(message)) this.onMessage(core, message) })
    core.onExit((code, signal) => { if (this.core === core) this.onExit(code, signal) })
    this.deps.log(`[harnessd] core started (pid ${core.pid ?? '?'})${this.restarts ? ` · restart ${this.restarts}` : ''}`)
    this.armTimer('bindTimer', () => {
      this.deps.log(`[harnessd] core did not bind within ${this.options.bindTimeoutMs} ms — killing it`)
      core.kill('SIGKILL')
    }, this.options.bindTimeoutMs)
  }

  private onMessage(core: CoreHandle, message: CoreMessage): void {
    switch (message.type) {
      case 'harnessd:bound':
        this.bound = true
        this.boundAt = this.deps.now()
        if (this.state !== 'stopping') this.state = 'running'
        this.clearTimer('bindTimer')
        if (!this.claimed) { this.deps.claimPidFile(); this.claimed = true }
        this.deps.log(`[harnessd] core bound (pid ${core.pid ?? '?'}, protocol ${message.protocol})`)
        if (this.update === 'pending') {
          this.update = 'probation'
          this.armTimer('probationTimer', () => {
            this.probationTimer = null
            this.update = null
            this.deps.confirmUpdate()
            this.deps.log('[harnessd] the update stayed up — keeping it')
          }, this.options.updateProbationMs)
        }
        this.watchHeartbeat()
        core.send({ type: 'harnessd:status', status: this.status() })
        return
      case 'harnessd:heartbeat':
        if (!this.bound) return
        this.watchHeartbeat()
        if (this.options.rssLimitMiB && message.rssBytes > this.options.rssLimitMiB * 1024 * 1024 && !this.ending) {
          this.deps.log(`[harnessd] core is using ${Math.round(message.rssBytes / 1048576)} MiB, over its ${this.options.rssLimitMiB} MiB budget — restarting it`)
          this.end('restart', 'SIGTERM')
        }
        return
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const exit = describeExit(code, signal)
    this.clearTimer('bindTimer')
    this.clearTimer('heartbeatTimer')
    this.clearTimer('killTimer')
    this.clearTimer('probationTimer')
    this.core = null
    if (this.state === 'stopping') { this.deps.log(`[harnessd] core stopped (${exit})`); this.finish(0); return }
    if (this.update) {
      // The core on the new bundle did not come up, or did not stay up: the bundle before it did.
      this.update = null
      this.deps.restoreUpdate()
      this.lastExit = exit
      this.restarts++
      this.state = 'restarting'
      this.deps.log(`[harnessd] the updated core failed (${exit}) — rolled back to the previous bundle; restarting`)
      this.armTimer('restartTimer', () => { this.restartTimer = null; this.spawn() }, 0)
      return
    }
    if (code === 0 && signal === null && this.ending !== 'restart') {
      // The core ended itself on purpose — signed out for good, removed from the machine — and a core
      // started again would only end itself again. The master goes with it.
      this.deps.log('[harnessd] core exited on its own (code 0) — stopping')
      this.finish(0)
      return
    }
    this.lastExit = exit
    this.restarts++
    const update = code === CORE_EXIT_UPDATE
    if (update) this.update = 'pending'
    if (this.bound && this.deps.now() - this.boundAt >= this.options.backoffResetMs) this.backoff = this.options.initialBackoffMs
    // A memory restart backs off like a crash: a core over budget from the start would otherwise be
    // restarted as fast as it can bind. Only an update restarts at once.
    const delay = update ? 0 : this.backoff
    if (!update) this.backoff = Math.min(this.backoff * 2, this.options.maxBackoffMs)
    this.state = 'restarting'
    this.deps.log(`[harnessd] core exited (${exit})${update ? ' for an update' : ''} — restarting${delay ? ` in ${delay} ms` : ''}`)
    this.armTimer('restartTimer', () => { this.restartTimer = null; this.spawn() }, delay)
  }

  /** End the running core: SIGTERM (or SIGKILL), and SIGKILL if it outlives the grace. */
  private end(why: 'stop' | 'restart', signal: NodeJS.Signals): void {
    const core = this.core!
    this.ending = why
    this.clearTimer('heartbeatTimer')
    core.kill(signal)
    this.armTimer('killTimer', () => {
      this.deps.log(`[harnessd] core outlived its ${this.options.stopGraceMs} ms to stop — killing it`)
      core.kill('SIGKILL')
    }, this.options.stopGraceMs)
  }

  private watchHeartbeat(): void {
    const core = this.core!
    this.armTimer('heartbeatTimer', () => {
      this.deps.log(`[harnessd] core sent no heartbeat for ${this.options.heartbeatTimeoutMs} ms — it is hung; killing it`)
      core.kill('SIGKILL')
    }, this.options.heartbeatTimeoutMs)
  }

  private finish(code: number): void {
    this.state = 'stopped'
    this.clearTimer('restartTimer')
    this.clearTimer('probationTimer')
    if (this.claimed) this.deps.releasePidFile()
    this.deps.exit(code)
  }

  private armTimer(name: TimerName, run: () => void, ms: number): void {
    this.clearTimer(name)
    this[name] = this.deps.setTimer(run, ms)
  }

  private clearTimer(name: TimerName): void {
    if (this[name] === null) return
    this.deps.clearTimer(this[name])
    this[name] = null
  }
}
