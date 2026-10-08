/**
 * harnessd's services, in processes of their own, kept running by the master beside the core.
 *
 * A service is a feature the core can run without (search, devices, models, …). In the core's process a
 * service's exception is caught (core/serviceHost.ts), but a native crash, a hung event loop or a leak
 * would still take the core with it. Out here a service can only take its own process down, and the
 * services that share it (`SERVICE_HOSTS`): the master restarts it with backoff, kills it when it stops
 * beating (hung) or outgrows its memory budget (leaking), parks it when it keeps crashing, and the core
 * answers its services' requests SERVICE_UNAVAILABLE meanwhile.
 *
 * The same shape as ./supervisor.ts, for many children and fewer promises: a service has no port to
 * bind and no update to prove; it beats, or it is restarted. Everything that touches the operating
 * system is injected, so every decision here is tested without one.
 */
import { SERVICE_EXIT_RESTART, heartbeatGraceMs, isCoreMessage, isUpdaterMessage } from './protocol.js'
import type { CoreHandle } from './supervisor.js'

export interface ServiceSpec {
  /** The process's name: what the master logs it as and the process is titled (`harnessd <name>`). */
  name: string
  /** The services it runs, as `harness __service <a>,<b>` names them, each on its own link to the core. */
  services: readonly string[]
  /** The V8 heap limit it runs with, MiB; its budget is a share of it. */
  heapLimitMiB: number
  /** Resident memory past which it is restarted, MiB; 0: off. */
  rssLimitMiB: number
  /** A process on demand (an experiment's, the devices'): not started with the others, only once the core
   *  asks for one of its services (`want`), and then kept running like any other. */
  onDemand?: boolean
  /** The core protocol (./protocol.ts) from which a core asks for this process on demand; 3, the experiments',
   *  when unset. A core that speaks an older one never asks for it, and it is started as that core binds. */
  askedSince?: number
}

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
  /** The updater staged `version` on disk (`harnessd:staged`): the core is to hand over for it. */
  staged?(version: string): void
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
const describeExit = (code: number | null, signal: NodeJS.Signals | null): string =>
  signal ? `signal ${signal}` : `code ${code}`

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
      if (this.spec.name !== UPDATER_PROCESS) { if (!this.refusedStaged) this.deps.log(`[harnessd] service ${this.spec.name} said it staged ${message.version}, which only the updater may — ignored`); this.refusedStaged = true; return }
      this.deps.log(`[harnessd] service ${this.spec.name} staged ${message.version}`)
      this.deps.staged?.(message.version)
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
    child.kill(signal)
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
   * `want` (2) asks for none; one from before the devices were on demand (3) never asks for theirs.
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

/** A process the services run in: the services it hosts, and its memory budget. */
export type ServiceHostSpec = Omit<ServiceSpec, 'name'>

/**
 * The processes this build runs its services in, with their memory budgets: every one, unless
 * `HARNESSD_SERVICES` names a subset (`search,viewers`) or `none` (see `serviceSpecs`). A service that
 * is not out here runs inside the core's process, behind the service host's guard, as before.
 *
 * A process per risk, not per feature (docs/design/2026-10-06-core-boundary-next.md, "The target
 * shape"): native code (search's `node:sqlite`), memory and child-process herds (the viewers' servers)
 * each get their own, so one feature cannot take another down. The light services are pure JavaScript
 * answering requests, and share one: a fault in one can cost the others in the edge host, never the
 * core, and the master restarts the host. Each is one process of about 60 MiB at idle; apart, they
 * would cost that four times.
 */
export const SERVICE_HOSTS: Readonly<Record<string, ServiceHostSpec>> = {
  // Engine workers have no older-core startup obligation: old cores run these facets inline and never ask.
  // Each holds at most four reads, a 128-entry pager and replies capped at 4 MiB. The heap limit
  // contains transient parsing; RSS additionally bounds file buffers outside V8's heap.
  'engine-claude': { services: ['engine-claude'], heapLimitMiB: 512, rssLimitMiB: 1_024, onDemand: true, askedSince: 0 },
  'engine-codex': { services: ['engine-codex'], heapLimitMiB: 512, rssLimitMiB: 1_024, onDemand: true, askedSince: 0 },
  search: { services: ['search'], heapLimitMiB: 1_024, rssLimitMiB: 2_048 },
  // Its file watches on every harness's workspace; the viewer servers it starts are processes of their
  // own, outside this budget. The Store beside them: its installs run git and the harnesses' toolchains
  // in their own processes too, and take minutes, which is what it must not spend in the core.
  viewers: { services: ['viewers', 'store'], heapLimitMiB: 512, rssLimitMiB: 1_024 },
  // The git work (workspaces, the project readers) runs in git's own processes, and the monitor's
  // samples in ps's and ioreg's; what it holds is the agents the core sent it and one parsed sample.
  // The monitor parses up to 8 MB of ioreg output per Monitor poll on a Mac with a GPU, hence more
  // than workspaces alone had. The recaps hold each session's last three recaps, answers (8 KiB each at
  // most) and asks, as the core did while they ran in it, and a few timers per open turn. The window
  // names hold at most 400 short names; their model runs in its own process (lib/oneshot.ts).
  edge: { services: ['workspaces', 'usage', 'monitor', 'projects', 'handoff', 'recaps', 'windowNames', 'shell'], heapLimitMiB: 384, rssLimitMiB: 768 },
  // The orchestrator (services/orchestratorProcess.ts), an experiment: started only once it is on, for a
  // saved project or a request (core/api.ts `EXPERIMENTS`). Its projects' files and the frames of their
  // Directors; the agents it runs are the core's.
  orchestrator: { services: ['orchestrator'], heapLimitMiB: 256, rssLimitMiB: 512, onDemand: true },
  // The command bar (services/commandBarProcess.ts), an experiment: started at its first request. What it holds
  // is at most eight decisions in flight and one bounded JEV answer each (lib/commandBar.ts).
  commandBar: { services: ['commandBar'], heapLimitMiB: 128, rssLimitMiB: 384, onDemand: true },
  // Tab collaboration and teams, an experiment: the prompt scopes, a few drafts and fingerprints per agent, and
  // beside them the teams, their mailbox and the tab channels (services/collaborationProcess.ts), each on its
  // own link to the core. Started only once it is on (core/api.ts `EXPERIMENTS`).
  teams: { services: ['teams', 'collaboration'], heapLimitMiB: 256, rssLimitMiB: 512, onDemand: true },
  // Share, an experiment (services/sharingProcess.ts): its invitations, its observers' sessions and their
  // ciphers; the headless Chrome it captures a shared viewer in is a process of its own, outside this budget.
  sharing: { services: ['sharing'], heapLimitMiB: 256, rssLimitMiB: 512, onDemand: true },
  // The relay and its E2EE (gateway/gatewayProcess.ts): the backend link, every remote client's session,
  // the terminals' WebRTC channels and their queues. Network, crypto and pure-JS WebRTC, the attack surface,
  // where a fault costs the remote clients and nothing else (docs/design/2026-10-06-core-boundary-next.md).
  // Started as the core starts when it is signed in or anything is paired here, and otherwise by the first
  // thing that needs it (core/gatewayWake.ts): about 75 MiB at idle a computer signed out with nothing
  // paired never pays.
  gateway: { services: ['gateway'], heapLimitMiB: 512, rssLimitMiB: 1_024, onDemand: true, askedSince: 4 },
  // Grid's pictures, the Model Manager's catalog and the models found on this machine. Its downloads, model
  // servers and `grid` commands run in processes of their own, outside this budget. Started only once grid is
  // in use here or a request needs it (core/modelsWake.ts): about 70 MiB at idle, which a computer that uses
  // no grid never pays.
  models: { services: ['models'], heapLimitMiB: 512, rssLimitMiB: 1_024, onDemand: true, askedSince: 4 },
  // The devices (services/devicesProcess.ts): the dials on USB (pure-JS serial, a frame decoder whose buffer
  // is bounded per dial), the window bridges, the fleet's router and its lane, the voice router's engine
  // worker (a process of its own, outside this budget). Hardware that speaks whatever its firmware says:
  // what it costs, it costs here, never a session. The Wi-Fi device beside them (services/wifiProcess.ts),
  // on a link of its own: its receipts, its streams and its Store preparations. Started only once there is
  // a device, or a request for one (core/devicesWake.ts): about 72 MiB at idle, which a computer with none
  // never pays.
  devices: { services: ['devices', 'wifi'], heapLimitMiB: 256, rssLimitMiB: 512, onDemand: true, askedSince: 4 },
}

/** Every service this build can run outside the core's process: what `HARNESSD_SERVICES` names. */
export const KNOWN_SERVICES: readonly string[] = Object.values(SERVICE_HOSTS).flatMap((host) => host.services)

/**
 * The updater's process (services/updaterProcess.ts): checks for a newer build of the CLI and of hn, and
 * downloads, verifies, canaries and stages it, then tells the master, which has the core hand over. Its own
 * process and never the core's: the core never downloads a build, and a core that cannot start (safe mode)
 * or a host whose services keep crashing must not stop the fix from arriving. Not one of `SERVICE_HOSTS`:
 * the core neither routes to it nor runs it, and `HARNESSD_SERVICES` does not turn it off; the master runs
 * it when it runs the installed copy with updates on (masterProcess.ts). It holds one download at a time.
 */
export const UPDATER_HOST: ServiceHostSpec = { services: ['updater'], heapLimitMiB: 256, rssLimitMiB: 512 }
export const UPDATER_PROCESS = 'updater' // the name the master runs it under: the one whose staged build counts

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

/** How a master tells the core it starts which services it runs in their own processes. */
export const SERVICE_PROCESSES_ENV = 'HARNESSD_SERVICE_PROCESSES'
/** Version of the live engine methods hosted by this master, independent of reader-only hosts. */
export const ENGINE_LIVE_ENV = 'HARNESSD_ENGINE_LIVE'
/** Runtime profile methods, negotiated independently from live transcript parsing. */
export const ENGINE_RUNTIME_ENV = 'HARNESSD_ENGINE_RUNTIME'
export const ENGINE_SCREEN_ENV = 'HARNESSD_ENGINE_SCREEN'
export const ENGINE_MODEL_CONTROL_ENV = 'HARNESSD_ENGINE_MODEL_CONTROL'
export const ENGINE_QUESTION_CONTROL_ENV = 'HARNESSD_ENGINE_QUESTION_CONTROL'
export const ENGINE_SUBMISSION_ENV = 'HARNESSD_ENGINE_SUBMISSION'
export const ENGINE_NATIVE_CONTROL_ENV = 'HARNESSD_ENGINE_NATIVE_CONTROL'

/**
 * What a master puts in its core's environment about the services it runs in their own processes: the
 * list, and `HARNESSD_SERVICES` set to the same (`none` for none), so that a core from before the list,
 * one this master finds back on disk after a rollback, reads the same answer for the services it knows
 * and runs none of them a second time.
 */
export function serviceProcessesEnv(specs: readonly ServiceSpec[], masterPid: number): Record<string, string> {
  // The services, not the processes: a core knows what it routes by service, and one from before the
  // edge host still finds the services it knows here (workspaces) and runs the rest itself.
  const names = specs.flatMap((spec) => spec.services).join(',')
  return { [SERVICE_PROCESSES_ENV]: names, HARNESSD_SERVICES: names || 'none', [ENGINE_LIVE_ENV]: `${masterPid}:1`, [ENGINE_RUNTIME_ENV]: `${masterPid}:1`, [ENGINE_SCREEN_ENV]: `${masterPid}:1`, [ENGINE_MODEL_CONTROL_ENV]: `${masterPid}:1`, [ENGINE_QUESTION_CONTROL_ENV]: `${masterPid}:1`, [ENGINE_SUBMISSION_ENV]: `${masterPid}:1`, [ENGINE_NATIVE_CONTROL_ENV]: `${masterPid}:1` }
}

/** An older master may inherit a newer master's environment after rollback. Trust only this parent. */
export function masterRunsLiveEngines(env: NodeJS.ProcessEnv, parentPid: number): boolean {
  return env.HARNESSD_SUPERVISED === '1' && !!env.HARNESSD_SERVICE_TOKEN
    && env[ENGINE_LIVE_ENV] === `${parentPid}:1`
}

export function masterRunsEngineRuntime(env: NodeJS.ProcessEnv, parentPid: number): boolean {
  return env.HARNESSD_SUPERVISED === '1' && !!env.HARNESSD_SERVICE_TOKEN
    && env[ENGINE_RUNTIME_ENV] === `${parentPid}:1`
}

/**
 * The services the core's master runs in their own processes, which the core routes to and does not
 * run itself: what the master says it runs (`serviceProcessesEnv`), never what this build would choose.
 * A master too old to say runs exactly the services `HARNESSD_SERVICES` names, as every master did; a
 * core that worked it out from its own default instead took every service for out of process under a
 * released master that ran none, and answered search, the viewers, workspaces and the teams
 * SERVICE_UNAVAILABLE until the master restarted (e2e/releaseRehearsal.e2e.ts). None without a master.
 */
export function servicesTheMasterRuns(env: NodeJS.ProcessEnv, known: readonly string[]): Set<string> {
  if (env.HARNESSD_SUPERVISED !== '1' || !env.HARNESSD_SERVICE_TOKEN) return new Set()
  const said = env[SERVICE_PROCESSES_ENV] ?? env.HARNESSD_SERVICES ?? ''
  return new Set(said.split(',').map((name) => name.trim()).filter((name) => known.includes(name)))
}

/**
 * The processes to run the services in: every service this build knows, unless `HARNESSD_SERVICES`
 * names a subset, by service (`search,workspaces`) or by process (`edge`, every service it hosts); `none`
 * (or empty) runs them all inside the core's process, for debugging or a quick way back. Isolation is
 * the point of the split (one service failing costs only its process), so it is the default, not an
 * opt-in. Each process hosts the services named of its own, and is not started for none. A process
 * named as one of its services is named whole: `viewers` runs the viewers' process, the Store beside
 * them, as it ran the viewers' before the Store joined it. `HARNESSD_SERVICE_HEAP_LIMIT_MIB` gives every
 * one the same heap limit instead (tests, support). A process on demand (`onDemand`: an experiment's, the
 * devices') waits for the core to ask for it; named in `HARNESSD_SERVICES`, it starts with the others.
 */
export function serviceSpecs(env: NodeJS.ProcessEnv, hosts: Readonly<Record<string, ServiceHostSpec>>): ServiceSpec[] {
  const named = env.HARNESSD_SERVICES === undefined ? null
    : new Set(env.HARNESSD_SERVICES.split(',').map((name) => name.trim()).filter((name) => name && name !== 'none'))
  const heap = Number(env.HARNESSD_SERVICE_HEAP_LIMIT_MIB)
  return Object.entries(hosts).flatMap(([name, host]) => {
    const services = host.services.filter((service) => !named || named.has(service) || named.has(name))
    // A process on demand named outright runs from the start, as every service named does (a test, support).
    const onDemand = host.onDemand && !named ? { onDemand: true } : {}
    const { onDemand: _given, ...rest } = host
    return services.length ? [{ name, ...rest, services, ...onDemand, ...(Number.isInteger(heap) && heap > 0 ? { heapLimitMiB: heap } : {}) }] : []
  })
}

export function masterRunsEngineScreen(env: NodeJS.ProcessEnv, parentPid: number): boolean {
  return masterRunsLiveEngines(env, parentPid) && env[ENGINE_SCREEN_ENV] === `${parentPid}:1`
}

/** A new core must not route controls through an older worker host. */
export function masterRunsEngineModelControl(env: NodeJS.ProcessEnv, parentPid: number): boolean {
  return masterRunsLiveEngines(env, parentPid) && env[ENGINE_MODEL_CONTROL_ENV] === `${parentPid}:1`
}

export function masterRunsEngineQuestionControl(env: NodeJS.ProcessEnv, parentPid: number): boolean {
  return masterRunsLiveEngines(env, parentPid) && env[ENGINE_QUESTION_CONTROL_ENV] === `${parentPid}:1`
}

/** A new core must not ask an older worker host for submission readings it does not serve. */
export function masterRunsEngineSubmission(env: NodeJS.ProcessEnv, parentPid: number): boolean {
  return masterRunsLiveEngines(env, parentPid) && env[ENGINE_SUBMISSION_ENV] === `${parentPid}:1`
}

/** A new core must not send an older worker host a stop its Codex worker cannot speak. */
export function masterRunsEngineNativeControl(env: NodeJS.ProcessEnv, parentPid: number): boolean {
  return masterRunsLiveEngines(env, parentPid) && env[ENGINE_NATIVE_CONTROL_ENV] === `${parentPid}:1`
}
