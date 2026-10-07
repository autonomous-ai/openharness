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
  heartbeatGraceMs,
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
  /**
   * Replace this master with the bundle on disk before a core is started on it, carrying `state`
   * (./reexec.ts): asked in the gap before every core start, when no core is running, so the swap
   * orphans nothing. `proceed` is called when it did not replace itself, and why. Left out, never.
   */
  reexec?(state: ResumeState, proceed: (outcome: ReexecOutcome) => void): void
  /** A core is up: ready, or bound for a protocol 1 core. A re-executed master has proved itself. */
  coreUp?(): void
  /**
   * The bundle on disk now (its sha256, ./reexec.ts `fingerprint`), or null when it cannot be read: a
   * core judged on an update that exits for another has staged a newer bundle only if this changed
   * since it started. Left out, such an exit is the update failing, as it was before.
   */
  bundle?(): string | null
  /** Start the process that runs [service] on demand (./services.ts `ServiceSupervisor.want`): the core asked for it. */
  want?(service: string): void
  /**
   * The core bound speaking an older protocol than this master (./services.ts `ServiceSupervisor.unasked`): it
   * never asks for a process that became on demand after its protocol, and expects it to run, as it did.
   */
  unasked?(protocol: number): void
}

/**
 * What a master hands the one that replaces it in its own process (./reexec.ts). The crash times and
 * the backoff are left behind: they are on the old process's monotonic clock, which a new one restarts.
 */
export interface ResumeState {
  restarts: number
  lastExit: string | null
  lastExitReason: ExitReason | null
  /** `pending`: the core about to start runs an update, on probation once it is ready. */
  update: 'pending' | null
  /** The pid file is this process's already. */
  claimed: boolean
  /** How many times this process has re-executed. */
  reexecs: number
  /** Of those, how many since a core last came up: a master that keeps re-executing without one is
   *  in a loop, and stops (./reexec.ts `REEXEC_LIMIT`). */
  unproven: number
}

/**
 * Why a master did not replace itself: the bundle on disk is its own code (`same`); it could not or
 * would not, for a reason that is not the bundle's (`kept`); or the bundle's master did not answer its
 * probe (`refused`), which fails an update to it.
 */
export type ReexecOutcome = 'same' | 'kept' | 'refused'

/** Who this master is: its code's version, and what the master it replaced handed on. */
export interface SupervisorIdentity {
  version?: string
  resume?: ResumeState | null
  /**
   * The bundle this master starts on is an update no master kept or rolled back (the version it names,
   * `selfUpdate.unjudgedUpdate`): the master judging it died first (a crash, a kill, a power cut). Its
   * first core is on probation, as it would have been. Before, a fresh master ran it unwatched, and a
   * build whose core crashed at start crash-looped for good (e2e/updateHostile.e2e.ts). Ignored when
   * `resume` is given: a re-executed master carries its own.
   */
  unjudgedUpdate?: string | null
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
  /** The version of the code this master runs, when it knows it. */
  masterVersion: string | null
  /** How many times this master's process has replaced itself with a newer or restored bundle. */
  reexecs: number
}

type TimerName = 'bindTimer' | 'readyTimer' | 'heartbeatTimer' | 'killTimer' | 'restartTimer' | 'probationTimer' | 'handOverTimer'

/**
 * How long a core asked to hand over for an update (`harnessd:update`) has before the master stops it all
 * the same: its teardown gives up after 15 s (core/updateHandoff.ts) and a grace of 1 s follows, so this
 * is a core that did not hear, or did not act. Its exit then counts as the update's.
 */
export const HAND_OVER_GRACE_MS = 45_000

const describeExit = (code: number | null, signal: NodeJS.Signals | null): string =>
  signal ? `signal ${signal}` : `code ${code}`

/**
 * Whether why a core could not start names the disk rather than the build: no space left, a quota
 * spent, a file system mounted read-only. Read off the reason a core gives for its safe mode, which is
 * the error it failed on (`listen ENOSPC: no space left on device …` for its socket's claim).
 */
export function namesTheDisk(reason: string): boolean {
  return /\b(ENOSPC|EDQUOT|EROFS)\b|no space left on device|disk quota exceeded|read-only file system/i.test(reason)
}
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
  /** The core on an update could not start for want of room on the disk: its end is no verdict. */
  private noRoom = false
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
  private handOverTimer: unknown = null
  private readonly masterVersion: string | null
  private reexecs = 0
  private unproven = 0
  /** The bundle on disk when the running core was started (`deps.bundle`). */
  private spawnedOn: string | null = null

  constructor(
    private readonly deps: SupervisorDeps,
    private readonly options: SupervisorOptions = DEFAULT_SUPERVISOR_OPTIONS,
    identity: SupervisorIdentity = {},
  ) {
    this.backoff = options.initialBackoffMs
    this.since = deps.wallClock()
    this.masterVersion = identity.version ?? null
    const resume = identity.resume
    if (resume) {
      // The master this process was a moment ago, carried on: its core exited for an update (or was
      // rolled back), and the one about to start is judged as it would have judged it.
      this.restarts = resume.restarts
      this.lastExit = resume.lastExit
      this.lastExitReason = resume.lastExitReason
      this.update = resume.update
      this.claimed = resume.claimed
      this.reexecs = resume.reexecs
      this.unproven = resume.unproven
    } else if (identity.unjudgedUpdate) {
      this.update = 'pending'
    }
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
      masterVersion: this.masterVersion,
      reexecs: this.reexecs,
    }
  }

  start(): void {
    if (this.state !== 'idle') return
    this.next()
  }

  /** What this master hands on if it replaces itself now. */
  private resumeState(): ResumeState {
    return {
      restarts: this.restarts, lastExit: this.lastExit, lastExitReason: this.lastExitReason,
      update: this.update === 'pending' ? 'pending' : null, claimed: this.claimed, reexecs: this.reexecs, unproven: this.unproven,
    }
  }

  /**
   * Start the next core, in the one moment no core is running: first, if the bundle on disk is not
   * this master's code (an update the core staged, a rollback that put the previous one back, a bundle
   * replaced by hand), the master replaces itself with it and the new master starts the core. A master
   * left running old code supervised every core after it with that code until something restarted it.
   */
  private next(): void {
    if (!this.deps.reexec) { this.spawn(); return }
    this.deps.reexec(this.resumeState(), (outcome) => {
      // Stopped while it was deciding: the stop has finished this master already.
      if (this.state === 'stopping' || this.state === 'stopped') return
      if (outcome === 'refused' && this.update === 'pending') {
        // A bundle whose master cannot start is an update that failed, as one whose core cannot is.
        this.update = null
        this.deps.restoreUpdate()
        this.deps.log('[harnessd] the new bundle\'s master would not start — rolled back to the previous bundle; restarting')
        this.next()
        return
      }
      this.spawn()
    })
  }

  /**
   * The updater (services/updaterProcess.ts) staged `version` on disk. The core used to stage it itself
   * and exit 75; now the master asks it to (`harnessd:update`), and its exit is the update's, judged as
   * before. A core that does not leave within `HAND_OVER_GRACE_MS` is stopped, and that exit counts as the
   * update's too. With no core running (a restart's backoff, safe mode's), the next one starts on the new
   * bundle at once, on probation, with a clean slate: whatever was crashing may be what it fixes.
   */
  updateStaged(version: string): void {
    if (this.state === 'stopping' || this.state === 'stopped') return
    const core = this.core
    if (!core) {
      this.update = 'pending'
      this.crashes = []
      this.safeMode = null
      this.deps.log(`[harnessd] the updater staged ${version} — the next core starts on it`)
      // Waiting out a backoff: no longer. Otherwise the next core is already being started (a
      // re-execution deciding), and starts on the bundle on disk.
      if (this.restartTimer !== null) this.scheduleSpawn(0)
      return
    }
    if (this.handOverTimer !== null) return
    this.deps.log(`[harnessd] the updater staged ${version} — asking the core to hand over`)
    core.send({ type: 'harnessd:update', version })
    this.armTimer('handOverTimer', () => {
      this.handOverTimer = null
      this.deps.log(`[harnessd] core did not hand over for ${version} within ${HAND_OVER_GRACE_MS} ms — stopping it`)
      this.killReason = 'update'
      this.end('restart', 'SIGTERM')
    }, HAND_OVER_GRACE_MS)
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
    // HARNESSD_JUDGES_SUPERSEDED: this master judges a build its core on probation stages on its own
    // (#807). A master from before rolls back on any exit during probation, the update's own included,
    // and its core must not stage then: see `stageWhileJudged` in lib/selfUpdate.ts.
    // HARNESSD_UPDATES: updates are this master's to run (services/updaterProcess.ts), not the core's. A core
    // under a master from before it starts the updater beside itself (core/updaterBeside.ts).
    const env: Record<string, string> = {
      HARNESSD_SUPERVISED: '1', HARNESSD_RESTARTS: String(this.restarts), HARNESSD_WATCHDOG_MS: String(this.options.heartbeatTimeoutMs),
      HARNESSD_JUDGES_SUPERSEDED: '1', HARNESSD_UPDATES: 'master',
    }
    if (this.lastExit) env.HARNESSD_LAST_EXIT = this.lastExit
    if (this.safeMode) env.HARNESSD_SAFE_MODE = this.safeMode
    this.spawnedOn = this.deps.bundle?.() ?? null
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
        if (message.protocol < HARNESSD_PROTOCOL) this.deps.unasked?.(message.protocol)
        this.watchHeartbeat()
        // A core from before `ready` is running once bound, and its update is judged from there.
        const readiness = message.protocol >= 2
        if (readiness) {
          this.armTimer('readyTimer', () => this.kill(core, 'not-ready', `bound but not ready within ${this.options.readyTimeoutMs} ms`), this.options.readyTimeoutMs)
        }
        if (this.state !== 'stopping') this.setState(readiness ? 'listening' : 'running')
        if (!readiness) this.up()
        return
      }
      case 'harnessd:ready':
        if (!this.bound || this.state !== 'listening') return
        this.clearTimer('readyTimer')
        if (message.safeMode !== undefined && this.update && namesTheDisk(message.safeMode)) {
          // A disk too full to start on says nothing of the build: the one before would fail the same
          // way, and a rollback that frees the room only for the updater to stage the build again is a
          // loop. Before, the good build was rolled back and remembered as bad (e2e/updateHostile.e2e.ts).
          // Started again, on the same bundle and still on trial, once there may be room.
          this.noRoom = true
          this.kill(core, 'not-ready', `could not start on the new bundle for want of room on the disk (${message.safeMode}) — not a verdict on the build`)
          return
        }
        if (message.safeMode !== undefined && this.update) {
          // The new bundle could not start: that is the update failing, however long it stays up.
          this.kill(core, 'crashed', `started in safe mode on the new bundle (${message.safeMode})`)
          return
        }
        this.upAt = this.deps.now()
        this.coreSafeMode = message.safeMode ?? null
        this.deps.log(`[harnessd] core ready (pid ${core.pid ?? '?'})${message.safeMode === undefined ? '' : ` · in safe mode: ${message.safeMode}`}`)
        this.setState('running')
        this.up()
        return
      case 'harnessd:want':
        if (this.bound) this.deps.want?.(message.service)
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

  /** A core is up: its update goes on probation, and a re-executed master has proved itself. */
  private up(): void {
    this.beginProbation()
    this.unproven = 0
    this.deps.coreUp?.()
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
      // The core on probation has staged a newer build and is on its way out for it (a teardown can
      // take seconds). Kept now, the newer build's pending note and the backup to roll it back to were
      // deleted with this one's, and it ran on probation with nothing to restore. Left on probation, its
      // exit for the update is the superseded one, and the newer build is judged on its own.
      if (this.stagedSinceSpawn()) {
        this.deps.log('[harnessd] the update stayed up, but has staged a newer build — leaving that one to be judged')
        return
      }
      this.update = null
      this.deps.confirmUpdate()
      this.deps.log('[harnessd] the update stayed up — keeping it')
    }, this.options.updateProbationMs)
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const exit = describeExit(code, signal)
    const reason = this.killReason ?? (code === CORE_EXIT_UPDATE ? 'update' : 'crashed')
    const wasSafe = this.safeMode ?? this.coreSafeMode
    for (const timer of ['bindTimer', 'readyTimer', 'heartbeatTimer', 'killTimer', 'probationTimer', 'handOverTimer'] as const) this.clearTimer(timer)
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
    // A core still being judged on an update that exits for another has staged a newer bundle: the
    // build it ran came up far enough to find the next and stage it, and the next is judged on its own.
    // Read as the update failing, the newer build was rolled back and remembered as bad on every machine
    // that found it while the one before was on probation (e2e/updateHostile.e2e.ts: a fix published
    // moments after the release it fixes).
    const superseded = this.update !== null && reason === 'update' && this.stagedSinceSpawn()
    const noRoom = this.noRoom
    this.noRoom = false
    if (this.update && noRoom) {
      // Still on trial: the next core on this bundle is judged on it, from ready. Backed off like a
      // crash, without counting as one: safe mode would not make room either.
      const delay = this.backoff
      this.backoff = Math.min(this.backoff * 2, this.options.maxBackoffMs)
      this.deps.log(`[harnessd] the updated core had no room to start (${exit}) — keeping the update on trial; trying again in ${delay} ms`)
      this.scheduleSpawn(delay)
      return
    }
    if (this.update && !superseded) {
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
      this.deps.log(superseded
        ? `[harnessd] the updated core staged a newer build before it was kept (${exit}) — restarting onto that one`
        : `[harnessd] core exited (${exit}) for an update — restarting`)
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

  /** Whether the bundle on disk changed since the running core was started (`deps.bundle`). */
  private stagedSinceSpawn(): boolean {
    const now = this.deps.bundle?.() ?? null
    return now !== null && now !== this.spawnedOn
  }

  private scheduleSpawn(delay: number): void {
    this.setState('restarting')
    this.armTimer('restartTimer', () => { this.restartTimer = null; this.next() }, delay)
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

  /**
   * ⚠️ A silence the master slept through is not a hang. Ctrl-Z on a daemon run in a terminal, a
   * paused virtual machine or a swap storm stops the master with its core, and on resume every timer
   * that fell due fires at once, before the master reads the beat the resumed core sends a moment
   * later. Measured end to end (`e2e/paused.e2e.ts`): paused for 40 s, the core was killed as hung the
   * instant it resumed, and the message an app had sent into its socket was lost with it. So a silence
   * that runs out gets one beat's time more, counted from now, while this master is running.
   */
  private watchHeartbeat(): void {
    const core = this.core!
    const timeout = this.options.heartbeatTimeoutMs
    const grace = heartbeatGraceMs(timeout)
    this.armTimer('heartbeatTimer', () => {
      this.deps.log(`[harnessd] core sent no heartbeat for ${timeout} ms — giving it ${grace} ms more, in case this master was paused too`)
      this.armTimer('heartbeatTimer', () => this.kill(core, 'hung', `sent no heartbeat for ${timeout + grace} ms — it is hung;`), grace)
    }, timeout)
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
