/**
 * The master's supervision of harnessd's services, in processes of their own, kept running beside the core.
 *
 * The master restarts a service's process with backoff, kills it when it stops beating (hung) or outgrows its
 * memory budget (leaking), parks it when it keeps crashing, and the core answers its services' requests
 * SERVICE_UNAVAILABLE meanwhile. Which processes there are is ./services.ts (`SERVICE_HOSTS`).
 *
 * The same shape as ./supervisor.ts, for many children and fewer promises: a service has no port to
 * bind and no update to prove; it beats, or it is restarted. Everything that touches the operating
 * system is injected, so every decision here is tested without one.
 */
import { SERVICE_EXIT_RESTART, describeStaged, heartbeatGraceMs, isCoreMessage, isUpdaterMessage, type StagedUpdate } from './protocol.js'
import { UPDATER_PROCESS, type ServiceSpec } from './services.js'
import { describeExit, type CoreHandle } from './supervisor.js'

export interface ServiceSupervisorDeps {
  /** Start a process with these extra environment variables, running every service its spec names. */
  spawnService(spec: ServiceSpec, env: Record<string, string>): CoreHandle
  /** A monotonic clock, in ms. */
  now(): number
  /** The wall clock, in ms: what the status says things happened at. */
  wallClock(): number
  setTimer(run: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
  log(line: string): void
  /** The updater staged a CLI build, a terminal host or both on disk (`harnessd:staged`): the core is to hand over. */
  staged?(staged: StagedUpdate): void
  /** Stop a service with `harnessd:shutdown` rather than SIGTERM: Windows, where Node's `kill` is TerminateProcess
   *  and the service's own stop never runs (./supervisor.ts `SupervisorDeps.stopByMessage`). */
  stopByMessage?: boolean
}

export interface ServiceSupervisorOptions {
  /** A service that sends no heartbeat for this long — from its start, too — is hung: killed, restarted. */
  heartbeatTimeoutMs: number
  /** How long a service gets to stop after SIGTERM before SIGKILL. */
  stopGraceMs: number
  /** Restart delay: starts here, doubles per crash, caps at `maxBackoffMs`. */
  initialBackoffMs: number
  maxBackoffMs: number
  /** A service that stayed up this long earns the next crash the initial delay again. */
  backoffResetMs: number
  /** Past this share of its heap limit a service is restarted cleanly, before V8 aborts it. */
  heapRestartPercent: number
  /** This many crashes inside `parkWindowMs` park the service: reported, and not respawned in a loop. */
  parkCrashes: number
  parkWindowMs: number
  /** A parked service is tried again after this long. */
  parkRetryMs: number
}

export const DEFAULT_SERVICE_OPTIONS: ServiceSupervisorOptions = {
  heartbeatTimeoutMs: 30_000,
  stopGraceMs: 1_500,
  initialBackoffMs: 1_000,
  maxBackoffMs: 60_000,
  backoffResetMs: 60_000,
  heapRestartPercent: 75,
  parkCrashes: 5,
  parkWindowMs: 600_000,
  parkRetryMs: 1_800_000,
}

/** `off`: an experiment's process that no one has asked for yet, and so was never started. */
export type ServiceState = 'off' | 'starting' | 'running' | 'restarting' | 'parked' | 'stopping' | 'stopped'
export type ServiceExitReason = 'crashed' | 'hung' | 'memory' | 'stopped' | 'restart'

export interface ServiceStatus {
  name: string
  state: ServiceState
  pid: number | null
  restarts: number
  lastExit: string | null
  lastExitReason: ServiceExitReason | null
  /** When the state last changed, wall clock ms. */
  since: number
}

const MIB = 1024 * 1024

/** One service's process, restarted for as long as the master runs. */
class Service {
  state: ServiceState
  private since: number
  private child: CoreHandle | null = null
  private restarts = 0
  private backoff: number
  private upAt = 0
  private crashes: number[] = []
  private lastExit: string | null = null
  private lastExitReason: ServiceExitReason | null = null
  /** Why the master killed the running process, when it did. */
  private killReason: ServiceExitReason | null = null
  private ending = false
  private heartbeatTimer: unknown = null
  private killTimer: unknown = null
  private restartTimer: unknown = null
  private onStopped: Array<() => void> = []
  private refusedStaged = false

  constructor(
    readonly spec: ServiceSpec,
    private readonly deps: ServiceSupervisorDeps,
    private readonly options: ServiceSupervisorOptions,
    private readonly env: Record<string, string>,
  ) {
    this.backoff = options.initialBackoffMs
    this.since = deps.wallClock()
    this.state = spec.onDemand ? 'off' : 'starting'
  }

  status(): ServiceStatus {
    return {
      name: this.spec.name,
      state: this.state,
      pid: this.child?.pid ?? null,
      restarts: this.restarts,
      lastExit: this.lastExit,
      lastExitReason: this.lastExitReason,
      since: this.since,
    }
  }

  start(): void {
    const child = this.deps.spawnService(this.spec, {
      ...this.env,
      HARNESSD_SERVICE: this.spec.name,
      HARNESSD_RESTARTS: String(this.restarts),
      HARNESSD_WATCHDOG_MS: String(this.options.heartbeatTimeoutMs),
    })
    this.child = child
    this.killReason = null
    this.ending = false
    this.upAt = this.deps.now()
    child.onMessage((message) => { if (this.child === child) this.onMessage(child, message) })
    child.onExit((code, signal) => { if (this.child === child) this.onExit(code, signal) })
    this.deps.log(`[harnessd] service ${this.spec.name} started (pid ${child.pid ?? '?'})${this.restarts ? ` · restart ${this.restarts}` : ''}`)
    this.setState(this.restarts === 0 ? 'starting' : 'restarting')
    this.watchHeartbeat(child)
  }

  /** Start a process on demand the core asked for: once, while it is off. One already started is the
   *  master's to keep running, parked included. */
  want(): void {
    if (this.state === 'off') this.start()
  }

  /** A process on demand stopped with the others and started again with them: off, for whoever needs it next to
   *  ask. Left stopped, no `want` started it again for the rest of the master's life. */
  rest(): void {
    if (this.state === 'stopped') this.setState('off')
  }

  /** SIGTERM, then SIGKILL after the grace; `done` once it is gone. A parked or waiting one is simply stopped. */
  stop(done: () => void): void {
    if (this.state === 'stopped') { done(); return }
    this.onStopped.push(done)
    if (this.state === 'stopping') return
    this.clearTimer('restartTimer')
    if (!this.child) { this.setState('stopped'); this.stopped(); return }
    this.setState('stopping')
    this.end('SIGTERM')
  }

  private stopped(): void {
    const waiting = this.onStopped
    this.onStopped = []
    for (const done of waiting) done()
  }

  private onMessage(child: CoreHandle, message: unknown): void {
    if (isUpdaterMessage(message)) {
      // It restarts the core: from any other service than the updater, a bug or worse, said once and ignored.
      const staged: StagedUpdate = {
        ...(message.version ? { version: message.version } : {}), ...(message.ptyVersion ? { ptyVersion: message.ptyVersion } : {}),
      }
      if (this.spec.name !== UPDATER_PROCESS) { if (!this.refusedStaged) this.deps.log(`[harnessd] service ${this.spec.name} said it staged ${describeStaged(staged)}, which only the updater may — ignored`); this.refusedStaged = true; return }
      this.deps.log(`[harnessd] service ${this.spec.name} staged ${describeStaged(staged)}`)
      this.deps.staged?.(staged)
      return
    }
    if (!isCoreMessage(message) || message.type !== 'harnessd:heartbeat') return
    this.watchHeartbeat(child)
    if (this.state === 'starting' || this.state === 'restarting') this.setState('running')
    if (this.ending) return
    const heapBudget = this.spec.heapLimitMiB * MIB * this.options.heapRestartPercent / 100
    if (heapBudget && message.heapUsedBytes > heapBudget) {
      this.restartForMemory(`its heap is at ${Math.round(message.heapUsedBytes / MIB)} MiB, past ${this.options.heapRestartPercent}% of its ${this.spec.heapLimitMiB} MiB limit`)
    } else if (this.spec.rssLimitMiB && message.rssBytes > this.spec.rssLimitMiB * MIB) {
      this.restartForMemory(`it is using ${Math.round(message.rssBytes / MIB)} MiB, over its ${this.spec.rssLimitMiB} MiB budget`)
    }
  }

  private restartForMemory(why: string): void {
    this.deps.log(`[harnessd] service ${this.spec.name}: ${why} — restarting it`)
    this.killReason = 'memory'
    this.end('SIGTERM')
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const exit = describeExit(code, signal)
    this.clearTimer('heartbeatTimer')
    this.clearTimer('killTimer')
    this.child = null
    this.lastExit = exit
    if (this.state === 'stopping') {
      this.lastExitReason = 'stopped'
      this.deps.log(`[harnessd] service ${this.spec.name} stopped (${exit})`)
      this.setState('stopped')
      this.stopped()
      return
    }
    if (code === SERVICE_EXIT_RESTART && this.spec.name === UPDATER_PROCESS && !this.killReason) {
      // Asked for: the updater, once it has staged a build, so that it next runs as that build (a lean bundle
      // that no longer matches cli.js is not used, ./leanServices.ts). Not a crash, and not delayed; from any
      // other service, 75 is a crash, or a loop of them would never be parked.
      this.lastExitReason = 'restart'
      this.restarts++
      this.deps.log(`[harnessd] service ${this.spec.name} asked to start again (${exit}) — restarting`)
      this.setState('restarting')
      this.armTimer('restartTimer', () => { this.restartTimer = null; this.start() }, 0)
      return
    }
    const reason = this.killReason ?? 'crashed'
    this.lastExitReason = reason
    this.restarts++
    const now = this.deps.now()
    if (this.upAt && now - this.upAt >= this.options.backoffResetMs) this.backoff = this.options.initialBackoffMs
    // A memory restart counts like a crash: a service over budget from the start must not spin.
    this.crashes = [...this.crashes.filter((at) => now - at < this.options.parkWindowMs), now]
    if (this.crashes.length >= this.options.parkCrashes) {
      this.crashes = []
      this.backoff = this.options.initialBackoffMs
      this.deps.log(`[harnessd] service ${this.spec.name} ended ${this.options.parkCrashes} times in ${Math.round(this.options.parkWindowMs / 60_000)} min (${exit}, ${reason}) — parked; trying again in ${Math.round(this.options.parkRetryMs / 60_000)} min`)
      this.setState('parked')
      this.armTimer('restartTimer', () => { this.restartTimer = null; this.start() }, this.options.parkRetryMs)
      return
    }
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, this.options.maxBackoffMs)
    this.deps.log(`[harnessd] service ${this.spec.name} exited (${exit}, ${reason}) — restarting in ${delay} ms`)
    this.setState('restarting')
    this.armTimer('restartTimer', () => { this.restartTimer = null; this.start() }, delay)
  }

  private end(signal: NodeJS.Signals): void {
    const child = this.child!
    this.ending = true
    this.clearTimer('heartbeatTimer')
    // Called with SIGTERM only: a stop, or a restart for memory.
    if (this.deps.stopByMessage) child.send({ type: 'harnessd:shutdown' })
    else child.kill(signal)
    this.armTimer('killTimer', () => {
      this.deps.log(`[harnessd] service ${this.spec.name} outlived its ${this.options.stopGraceMs} ms to stop — killing it`)
      child.kill('SIGKILL')
    }, this.options.stopGraceMs)
  }

  /** A silence that runs out gets one beat's time more, in case the master was paused too: see
   *  `Supervisor.watchHeartbeat`, where a 40 s pause cost the core and an app's message. */
  private watchHeartbeat(child: CoreHandle): void {
    const timeout = this.options.heartbeatTimeoutMs
    const grace = heartbeatGraceMs(timeout)
    this.armTimer('heartbeatTimer', () => {
      this.armTimer('heartbeatTimer', () => {
        this.deps.log(`[harnessd] service ${this.spec.name} sent no heartbeat for ${timeout + grace} ms — it is hung; killing it`)
        this.killReason = 'hung'
        child.kill('SIGKILL')
      }, grace)
    }, timeout)
  }

  private setState(state: ServiceState): void {
    this.state = state
    this.since = this.deps.wallClock()
  }

  private armTimer(name: 'heartbeatTimer' | 'killTimer' | 'restartTimer', run: () => void, ms: number): void {
    this.clearTimer(name)
    this[name] = this.deps.setTimer(run, ms)
  }

  private clearTimer(name: 'heartbeatTimer' | 'killTimer' | 'restartTimer'): void {
    if (this[name] !== null) this.deps.clearTimer(this[name])
    this[name] = null
  }
}

/** Every enabled service's process, started together and stopped together. */
export class ServiceSupervisor {
  private readonly services: Service[]

  constructor(
    specs: readonly ServiceSpec[],
    deps: ServiceSupervisorDeps,
    options: ServiceSupervisorOptions = DEFAULT_SERVICE_OPTIONS,
    /** What every service is started with: the token that lets the core know it, for one. */
    env: Record<string, string> = {},
  ) {
    this.services = specs.map((spec) => new Service(spec, deps, options, env))
  }

  /** Start every service but those on demand, which wait to be asked for again; none waits on another, or on the
   *  core. Found end to end (e2e/reexec.e2e.ts): a master whose re-execution was refused stops its services and
   *  starts them again, and a process on demand stayed stopped, so a core too old to ask never got models. */
  start(): void {
    for (const service of this.services) {
      if (!service.spec.onDemand) service.start()
      else service.rest()
    }
  }

  /** Start the process on demand that hosts [service], if it is not running yet: the core asked for it (`harnessd:want`). */
  want(service: string): void {
    for (const each of this.services) if (each.spec.services.includes(service)) each.want()
  }

  /**
   * A core bound that speaks [protocol], older than this master's: every process that became on demand after it
   * starts now, since that core never asks for one and ran it as it ran every other service. A core from before
   * `want` (2) asks for none; one from before the devices were on demand (3) never asks for theirs, and one from
   * before the viewers were (4) never for theirs.
   */
  unasked(protocol: number): void {
    for (const each of this.services) if (each.spec.onDemand && (each.spec.askedSince ?? 3) > protocol) each.want()
  }

  /** Stop every service; `done` once all are gone. */
  stop(done: () => void): void {
    let left = this.services.length
    if (!left) { done(); return }
    for (const service of this.services) service.stop(() => { if (--left === 0) done() })
  }

  status(): ServiceStatus[] {
    return this.services.map((service) => service.status())
  }
}

/** Service timings from the environment (for tests and support); anything unset or invalid keeps its default. */
export function serviceOptions(env: NodeJS.ProcessEnv): ServiceSupervisorOptions {
  const read = (name: string, fallback: number, min: number): number => {
    const value = Number(env[name])
    return env[name] !== undefined && Number.isFinite(value) && value >= min ? value : fallback
  }
  const d = DEFAULT_SERVICE_OPTIONS
  return {
    // A second at least: below that a GC pause reads as a hang.
    heartbeatTimeoutMs: read('HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS', d.heartbeatTimeoutMs, 1_000),
    stopGraceMs: read('HARNESSD_SERVICE_STOP_GRACE_MS', d.stopGraceMs, 1),
    initialBackoffMs: read('HARNESSD_SERVICE_INITIAL_BACKOFF_MS', d.initialBackoffMs, 0),
    maxBackoffMs: read('HARNESSD_SERVICE_MAX_BACKOFF_MS', d.maxBackoffMs, 0),
    backoffResetMs: read('HARNESSD_SERVICE_BACKOFF_RESET_MS', d.backoffResetMs, 0),
    heapRestartPercent: Math.min(100, read('HARNESSD_SERVICE_HEAP_RESTART_PERCENT', d.heapRestartPercent, 1)),
    parkCrashes: read('HARNESSD_SERVICE_PARK_CRASHES', d.parkCrashes, 1),
    parkWindowMs: read('HARNESSD_SERVICE_PARK_WINDOW_MS', d.parkWindowMs, 0),
    parkRetryMs: read('HARNESSD_SERVICE_PARK_RETRY_MS', d.parkRetryMs, 0),
  }
}
