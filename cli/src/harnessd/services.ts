/**
 * harnessd's services, each in its own process, kept running by the master beside the core.
 *
 * A service is a feature the core can run without (search, devices, models, …). In the core's process a
 * service's exception is caught (core/serviceHost.ts), but a native crash, a hung event loop or a leak
 * would still take the core with it. Out here a service can only take itself down: the master restarts
 * it with backoff, kills it when it stops beating (hung) or outgrows its memory budget (leaking), parks it
 * when it keeps crashing, and the core answers its requests SERVICE_UNAVAILABLE meanwhile.
 *
 * The same shape as ./supervisor.ts, for many children and fewer promises: a service has no port to
 * bind and no update to prove; it beats, or it is restarted. Everything that touches the operating
 * system is injected, so every decision here is tested without one.
 */
import { isCoreMessage } from './protocol.js'
import type { CoreHandle } from './supervisor.js'

export interface ServiceSpec {
  /** The service's name, as `harness __service <name>` runs it. */
  name: string
  /** The V8 heap limit it runs with, MiB; its budget is a share of it. */
  heapLimitMiB: number
  /** Resident memory past which it is restarted, MiB; 0: off. */
  rssLimitMiB: number
}

export interface ServiceSupervisorDeps {
  /** Start a service's process with these extra environment variables. */
  spawnService(spec: ServiceSpec, env: Record<string, string>): CoreHandle
  /** A monotonic clock, in ms. */
  now(): number
  /** The wall clock, in ms: what the status says things happened at. */
  wallClock(): number
  setTimer(run: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
  log(line: string): void
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

export type ServiceState = 'starting' | 'running' | 'restarting' | 'parked' | 'stopping' | 'stopped'
export type ServiceExitReason = 'crashed' | 'hung' | 'memory' | 'stopped'

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
const describeExit = (code: number | null, signal: NodeJS.Signals | null): string =>
  signal ? `signal ${signal}` : `code ${code}`

/** One service's process, restarted for as long as the master runs. */
class Service {
  state: ServiceState = 'starting'
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

  constructor(
    readonly spec: ServiceSpec,
    private readonly deps: ServiceSupervisorDeps,
    private readonly options: ServiceSupervisorOptions,
    private readonly env: Record<string, string>,
  ) {
    this.backoff = options.initialBackoffMs
    this.since = deps.wallClock()
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
    child.kill(signal)
    this.armTimer('killTimer', () => {
      this.deps.log(`[harnessd] service ${this.spec.name} outlived its ${this.options.stopGraceMs} ms to stop — killing it`)
      child.kill('SIGKILL')
    }, this.options.stopGraceMs)
  }

  private watchHeartbeat(child: CoreHandle): void {
    this.armTimer('heartbeatTimer', () => {
      this.deps.log(`[harnessd] service ${this.spec.name} sent no heartbeat for ${this.options.heartbeatTimeoutMs} ms — it is hung; killing it`)
      this.killReason = 'hung'
      child.kill('SIGKILL')
    }, this.options.heartbeatTimeoutMs)
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

  /** Start every service; none waits on another, or on the core. */
  start(): void {
    for (const service of this.services) service.start()
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

/**
 * The services this build can run in their own processes, with their memory budgets. Which of them do
 * is `HARNESSD_SERVICES` (`search`): off until named, while each one beds in, and the core runs a
 * service that is not out here in its own process, as before.
 */
export const KNOWN_SERVICES: Readonly<Record<string, Omit<ServiceSpec, 'name'>>> = {
  search: { heapLimitMiB: 1_024, rssLimitMiB: 2_048 },
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

/** The services to run, from `HARNESSD_SERVICES` (`search,devices`): only names this build knows.
 *  `HARNESSD_SERVICE_HEAP_LIMIT_MIB` gives every one the same heap limit instead (tests, support). */
export function serviceSpecs(env: NodeJS.ProcessEnv, known: Readonly<Record<string, Omit<ServiceSpec, 'name'>>>): ServiceSpec[] {
  const names = (env.HARNESSD_SERVICES ?? '').split(',').map((name) => name.trim()).filter(Boolean)
  const heap = Number(env.HARNESSD_SERVICE_HEAP_LIMIT_MIB)
  return [...new Set(names)].filter((name) => Object.hasOwn(known, name)).map((name) => ({
    name, ...known[name], ...(Number.isInteger(heap) && heap > 0 ? { heapLimitMiB: heap } : {}),
  }))
}
