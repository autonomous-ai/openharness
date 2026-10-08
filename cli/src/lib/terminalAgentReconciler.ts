import { isTerminalEngine, type AgentEngine } from '../engines/types.js'
import type { RegisteredSession } from './registry.js'
import {
  probeTerminalAgents,
  targetForRuntime,
  type DiscoveredTerminalAgent,
  type TerminalAgentProbe,
} from './terminalAgentDiscovery.js'
import type { TerminalBackend } from './terminalBackend.js'
import { mergeTerminalRuntimes, processIdentityKey, sameProcessIdentity, terminalInstanceId, terminalPlacementKey, terminalRouteKey } from './terminalRuntime.js'
import type { TerminalRuntimeRef } from './terminalTypes.js'

const MISS_LIMIT = 2

/**
 * How long one reconcile pass may take before the core stops waiting on it.
 *
 * A pass asks tmux and ps (the probe), then applies what they said inside a registry transaction.
 * Nothing bounded the whole: a probe that never answered, or an apply stuck on an engine's files,
 * held the pass forever, and with it every hook waiting for a pass to bind its agent, every later
 * pass (they are serial), and every registry save (a transaction holds them back). Past this, a probe
 * that has not answered is given up — nothing is applied, every agent kept as it is, and the next pass
 * probes again — whoever waits for the pass goes on without it, and the registry stops holding saves
 * back for it. A pass that is merely slow still finishes, and passes stay one at a time.
 */
export const RECONCILE_PASS_DEADLINE_MS = 30_000

const GIVEN_UP = Symbol('given up')
/** [work]'s value, or GIVEN_UP once [ms] have passed without it. A rejection after that is dropped. */
function withinDeadline<T>(work: Promise<T>, ms: number): Promise<T | typeof GIVEN_UP> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<typeof GIVEN_UP>((resolve) => {
    timer = setTimeout(() => resolve(GIVEN_UP), ms)
    timer.unref?.()
  })
  return Promise.race([work, deadline]).then((value) => {
    if (value === GIVEN_UP) work.catch(() => {})
    return value
  }).finally(() => clearTimeout(timer))
}

export interface TerminalAgentReconcilerDeps {
  current: () => RegisteredSession[]
  backends: readonly TerminalBackend[]
  backendOrder: readonly string[]
  onDiscovered: (agent: DiscoveredTerminalAgent) => void | Promise<void>
  onObserved: (agent: DiscoveredTerminalAgent, current: RegisteredSession) => void | Promise<void>
  onDormant: (current: RegisteredSession, reason: string) => void | Promise<void>
  onRemoved: (current: RegisteredSession, reason: string) => void | Promise<void>
  onTerminalAvailability?: (current: RegisteredSession, available: boolean) => void | Promise<void>
  onProbeStatus?: (status: { ready: true; error: string | null }) => void
  transaction?: <T>(apply: () => T | Promise<T>) => Promise<T>
  probe?: (hints: ReadonlyMap<string, AgentEngine>) => Promise<TerminalAgentProbe>
  daemonPid?: number
  /** Hooks may arrive while reboot restoration is still allocating panes. Keep their hints,
   * but do not scan or retire any saved owners until start() opens discovery. */
  deferUntilStart?: boolean
  /** [RECONCILE_PASS_DEADLINE_MS], shorter in tests. */
  passDeadlineMs?: number
}

function currentProcessKey(session: RegisteredSession): string | null {
  return session.processIdentity ? processIdentityKey(session.engine, session.processIdentity) : null
}

function sharesPlacement(
  current: Pick<RegisteredSession, 'runtimes'>,
  observed: Pick<DiscoveredTerminalAgent, 'runtimes'>,
): boolean {
  const placements = new Set(current.runtimes.map(terminalPlacementKey))
  return observed.runtimes.some((runtime) => placements.has(terminalPlacementKey(runtime)))
}

/**
 * A process-backed agent exists before an engine session does. During that interval the terminal route
 * is its stable identity: launchers are allowed to exec/fork into the real native binary while painting
 * a first-run prompt (Claude folder trust is the common case). Once a session binds, process identity is
 * authoritative again so a different process in the same pane cannot inherit an existing transcript.
 */
/**
 * Whether a row may own an observed engine process at its own route. The same engine, or a
 * terminal — a shell somebody typed `claude` into: the process is what the terminal is running now,
 * and the row adopts the engine (cli.ts `onObserved` → `registry.adoptEngine`) rather than a second
 * agent being minted for the same pane.
 */
function routeEngineMatches(current: Pick<RegisteredSession, 'engine'>, observed: Pick<DiscoveredTerminalAgent, 'engine'>): boolean {
  return current.engine === observed.engine || isTerminalEngine(current.engine)
}

/**
 * The observation for a row that cannot be matched by process identity, because it does not have one
 * yet. Its terminal route is the only identity it has.
 *
 * ⚠️ `!sessionId` is NOT the test, and that was a real bug. A RESUMED row keeps the archived session
 * id while `resumePendingAgent` clears its `processIdentity` — so it has an id and no process, and
 * the old test made exactly the row that is waiting to be confirmed invisible to every scan. Nothing
 * else looks at it either: `bindObservedAgent` keys on `byProcess`, and the dormancy branch below
 * skips it because a failed launch already cleared `active`. A resume whose engine never sent a
 * startup hook therefore sat at "Starting" — measured at 19 hours over a pane its owner could type
 * in (openharness#189) — with the heal in cli.ts's `onObserved` (`if (wasLaunching) setLaunch(ready)`)
 * never reached.
 *
 * A row with BOTH an id and a process keeps the stricter rule: process identity is authoritative
 * again, so a different process in the same pane cannot inherit its transcript.
 */
function unboundRouteObservation(
  current: RegisteredSession,
  observed: readonly DiscoveredTerminalAgent[],
): DiscoveredTerminalAgent | undefined {
  if (current.sessionId && current.processIdentity) return undefined
  const matches = observed.filter((candidate) => (
    routeEngineMatches(current, candidate) && sharesPlacement(current, candidate)
  ))
  return matches.length === 1 ? matches[0] : undefined
}

/** Serialized, failure-isolated reconciliation across every enabled backend instance. */
export class TerminalAgentReconciler {
  private readonly misses = new Map<string, number>()
  /** Consecutive scans that found no engine for an agent, counted against the process identity they
   *  missed: an engine identified since is a different engine, and its count starts again. */
  private readonly engineMisses = new Map<string, { processKey: string | null; count: number }>()
  private readonly suppressed = new Set<string>()
  private readonly hints = new Map<string, AgentEngine>()
  /** Terminal routes currently mid an in-place process swap (restart). Held by ROUTE, not by process
   *  identity like `suppressed` — the replacement process's identity is not known until the swap
   *  finishes, so there is nothing to key a process-identity suppression on yet. */
  private readonly heldRoutes = new Set<string>()
  private readonly heldRouteTimers = new Map<string, NodeJS.Timeout>()
  /** When each route was last held or released, as a sequence number, so a probe can tell a route
   *  that changed hands while it ran (see `reconcileOnce`). */
  private routeSeq = 0
  private readonly routeTouched = new Map<string, number>()
  private pending = false
  private inFlight: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null
  private waitingForStart: boolean

  constructor(private readonly deps: TerminalAgentReconcilerDeps) {
    this.waitingForStart = deps.deferUntilStart === true
  }

  /**
   * Arm the interval FIRST, then run the opening pass.
   *
   * The other way round — await, then schedule — meant a first pass that threw left discovery
   * unscheduled for the life of the daemon: no new agents, no liveness, `discoveryReady` never true,
   * and the caller's own start-up rejected on top of it. Neither is worth one bad probe. The opening
   * pass is reported and dropped; the interval retries it a few seconds later.
   */
  async start(intervalMs: number): Promise<void> {
    this.waitingForStart = false
    this.timer = setInterval(() => { void this.trigger() }, intervalMs)
    this.timer.unref?.()
    await this.trigger().catch((error) => {
      console.warn(`[discovery] first pass failed, retrying on the interval · ${error instanceof Error ? error.message : error}`)
    })
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Asks for a pass that knows `engine` is starting in `runtime`'s pane. As [trigger]. */
  triggerHint(runtime: TerminalRuntimeRef, engine: AgentEngine): Promise<boolean> {
    this.hints.set(terminalRouteKey(runtime), engine)
    return this.trigger()
  }

  /** Hide an explicitly deleted process until an authoritative scan proves that process exited. */
  suppress(session: Pick<RegisteredSession, 'engine' | 'processIdentity'>): void {
    if (session.processIdentity) this.suppressed.add(processIdentityKey(session.engine, session.processIdentity))
  }

  /**
   * Hide one terminal route from BOTH halves of reconciliation — the existing-agent liveness/dormant
   * loop and new-process discovery — for the duration of an in-place process swap (restart). Without
   * this, the old process going away can flicker the agent dormant mid-kill, and the replacement
   * process appearing in the same pane before the restart handler rebinds it would otherwise be opened
   * as a brand-new agent (`onDiscovered` mints a fresh `agentId`).
   *
   * `autoReleaseMs` is a belt-and-suspenders bound: the caller is expected to `releaseRoute` in a
   * `finally`, but a future refactor that drops that `finally` must not leave a route permanently
   * invisible to reconciliation.
   */
  holdRoute(routeKey: string, autoReleaseMs = 30_000): void {
    this.heldRoutes.add(routeKey)
    this.routeTouched.set(routeKey, ++this.routeSeq)
    const existing = this.heldRouteTimers.get(routeKey)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => this.releaseRoute(routeKey), autoReleaseMs)
    timer.unref?.()
    this.heldRouteTimers.set(routeKey, timer)
  }

  /** Resume normal reconciliation for a route held by `holdRoute`. Idempotent. */
  releaseRoute(routeKey: string): void {
    if (this.heldRoutes.delete(routeKey)) this.routeTouched.set(routeKey, ++this.routeSeq)
    const timer = this.heldRouteTimers.get(routeKey)
    if (timer) {
      clearTimeout(timer)
      this.heldRouteTimers.delete(routeKey)
    }
  }

  /** Held now, or held or released since the probe numbered `probeSeq` began: that probe cannot speak
   *  for the route. A stop holds its agent's route while it retires the pane, and a probe taken before
   *  the stop, landing after it, otherwise opened a second agent for the engine it saw starting there
   *  (e2e/races.e2e.ts). */
  private routeHeld(runtimes: readonly TerminalRuntimeRef[], probeSeq = this.routeSeq): boolean {
    return runtimes.some((runtime) => {
      const key = terminalRouteKey(runtime)
      return this.heldRoutes.has(key) || (this.routeTouched.get(key) ?? 0) > probeSeq
    })
  }

  /** Asks for a pass, and resolves once it is done: true, or false when the pass outran its deadline
   *  ([RECONCILE_PASS_DEADLINE_MS]) and the caller goes on without what it would have found. */
  trigger(): Promise<boolean> {
    this.pending = true
    // Return promptly to startup hooks: waiting for start() here can hold up the very engines
    // restore is trying to launch. The opening pass consumes every retained hint after restore.
    if (this.waitingForStart) return Promise.resolve(true)
    if (!this.inFlight) this.inFlight = this.drain().finally(() => { this.inFlight = null })
    return this.waitFor(this.inFlight)
  }

  /** A pass, waited for until the pass deadline and no longer: see [RECONCILE_PASS_DEADLINE_MS]. */
  private async waitFor(pass: Promise<void>): Promise<boolean> {
    // Done in time, but on a probe it gave up: it found nothing either.
    if (await withinDeadline(pass, this.passDeadlineMs) !== GIVEN_UP) return !this.probeGivenUp
    if (this.overdue !== pass) {
      this.overdue = pass
      console.warn(`[discovery] a pass has run for ${this.passDeadlineMs} ms; whoever waits for it goes on without it`)
    }
    return false
  }
  private overdue: Promise<void> | null = null
  /** Whether the last pass gave up on its probe. */
  private probeGivenUp = false
  private get passDeadlineMs(): number { return this.deps.passDeadlineMs ?? RECONCILE_PASS_DEADLINE_MS }

  private async drain(): Promise<void> {
    while (this.pending) {
      this.pending = false
      await this.reconcileOnce()
    }
  }

  private async reconcileOnce(): Promise<void> {
    const hints = new Map(this.hints)
    // What every agent was when the probe began. A probe is evidence only about what it could have
    // seen: an agent created, a pane given to it, or an engine identified while the probe ran (the
    // new-pane watcher binds one between two scans) is judged by the next probe, not this one. Four
    // agents created at once proved it: a probe that began before one engine started counted that
    // engine's second "miss", and the agent was retired 22ms after its engine was found
    // (e2e/soak.e2e.ts, 2026-10-04).
    const probedAs = new Map(this.deps.current().map((agent) => [agent.agentId, {
      processKey: currentProcessKey(agent),
      placements: new Set(agent.runtimes.map(terminalPlacementKey)),
    }]))
    // Routes that change hands from here on are this probe's blind spot. Reconciliation is serial, so
    // anything older matters to no probe still to come.
    const probeSeq = this.routeSeq
    for (const [key, seq] of this.routeTouched) if (seq <= probeSeq) this.routeTouched.delete(key)
    const probe = await withinDeadline(this.deps.probe
      ? this.deps.probe(hints)
      : probeTerminalAgents(
        this.deps.backends,
        this.deps.backendOrder,
        this.deps.daemonPid ?? process.pid,
        hints,
      ), this.passDeadlineMs)
    this.probeGivenUp = probe === GIVEN_UP
    if (probe === GIVEN_UP) {
      console.warn(`[discovery] the terminal probe has not answered in ${this.passDeadlineMs} ms; this pass is given up, every agent kept as it is`)
      return
    }
    const availableTargets = probe.targets.filter((target) => target.result.state === 'available')
    const livePlacements = new Set(availableTargets.flatMap((target) =>
      target.result.state === 'available'
        ? target.result.roots.map((root) => terminalPlacementKey(root.runtime))
        : []))
    const probeError = !probe.processTableAvailable
      ? 'process table unavailable'
      : probe.targets.length > 0 && availableTargets.length === 0
        ? probe.targets.map((target) => `${target.instanceId}: ${target.result.state === 'available' ? 'available' : target.result.reason}`).join('; ')
        : null
    // Terminal placement liveness does not depend on finding an engine process. This is what keeps a
    // retained trust/setup/shell pane visible after restart, including when `ps` itself is unavailable.
    const markVerifiedPlacements = async (): Promise<void> => {
      for (const current of this.deps.current()) {
        if (current.runtimes.some((runtime) => livePlacements.has(terminalPlacementKey(runtime)))) {
          await this.deps.onTerminalAvailability?.(current, true)
        }
      }
    }
    if (this.deps.transaction) await this.deps.transaction(markVerifiedPlacements)
    else await markVerifiedPlacements()
    if (!probe.processTableAvailable) {
      console.warn('[discovery] process table unavailable; keeping existing terminal agents')
      this.deps.onProbeStatus?.({ ready: true, error: probeError })
      return
    }
    this.hints.clear()

    const observedKeys = new Set(probe.agents.map((agent) => processIdentityKey(agent.engine, agent.processIdentity)))
    for (const key of [...this.suppressed]) if (!observedKeys.has(key)) this.suppressed.delete(key)
    probe.agents = probe.agents.filter((agent) => !this.suppressed.has(processIdentityKey(agent.engine, agent.processIdentity)))

    const apply = async (): Promise<void> => {
      const before = this.deps.current()
      const observedByProcess = new Map(probe.agents.map((agent) => [
        processIdentityKey(agent.engine, agent.processIdentity),
        agent,
      ]))
      const matchedProcesses = new Set<string>()

      // Refresh existing process identities first. New route owners are opened afterwards so split/merge
      // conflict handling never depends on backend probe completion order.
      for (const current of before) {
        // A restart in progress on this route: leave it untouched. The old process going dormant here
        // and the new one being adopted by the discovery loop below are both races restart's `holdRoute`
        // exists to prevent — see the class-level comment on `heldRoutes`.
        if (this.routeHeld(current.runtimes, probeSeq)) continue
        const processKey = currentProcessKey(current)
        const observed = (processKey ? observedByProcess.get(processKey) : undefined)
          // A row saved before start ticks is keyed by its marker, the same process observed with them
          // by its ticks: match it here, or the pass takes it for a new process (ProcessIdentity.startTicks).
          ?? probe.agents.find((agent) => agent.engine === current.engine
            && sameProcessIdentity(agent.processIdentity, current.processIdentity))
          ?? unboundRouteObservation(current, probe.agents)
        if (observed) matchedProcesses.add(processIdentityKey(observed.engine, observed.processIdentity))

        let nextRuntimes = current.runtimes
        let terminalVerified = current.runtimes.some((runtime) => livePlacements.has(terminalPlacementKey(runtime)))
        for (const runtime of current.runtimes) {
          const target = targetForRuntime(probe, runtime)
          if (!target || target.result.state !== 'available') continue
          const placement = terminalPlacementKey(runtime)
          const replacement = observed?.runtimes.find((candidate) => terminalPlacementKey(candidate) === placement)
          const missKey = `${current.agentId}\u0000${placement}`
          // Inventory is the authority for terminal existence. A live pane without a recognized engine
          // is a dormant but still viewable agent, not a missing runtime.
          if (livePlacements.has(placement)) {
            this.misses.delete(missKey)
            terminalVerified = true
            if (replacement) nextRuntimes = mergeTerminalRuntimes(nextRuntimes, [replacement])
            continue
          }
          if (probe.ambiguousPlacements.has(placement)) continue
          if (replacement) {
            this.misses.delete(missKey)
            nextRuntimes = mergeTerminalRuntimes(nextRuntimes, [replacement])
            terminalVerified = true
            continue
          }
          // The aggregate inventory/process snapshot is deliberately cheap, but it is not stronger
          // than a backend-specific check of this exact runtime and saved process identity. New-agent
          // creation already proved the pane this way; without the same fallback here, one snapshot
          // miss hid that freshly adopted agent on the very next reconciliation cycle even while its
          // Claude trust prompt remained alive in tmux.
          const backend = this.deps.backends.find((candidate) => candidate.instanceId === target.instanceId)
          if (backend && current.processIdentity) {
            const validation = await backend.validate(runtime, {
              engine: current.engine,
              // This check answers only whether the terminal placement still exists. Engine/process
              // identity is reconciled independently from the aggregate process snapshot below.
              processIdentity: undefined,
            }).catch((error: unknown) => ({
              state: 'unknown' as const,
              reason: error instanceof Error ? error.message : 'terminal validation failed',
            }))
            if (validation.state === 'alive') {
              this.misses.delete(missKey)
              terminalVerified = true
              continue
            }
            // A timeout/unreadable backend is not evidence that the process exited. Preserve both the
            // route and its active UI entry, just as a failed whole-process-table read does above.
            if (validation.state === 'unknown') continue
          }
          if (!probedAs.get(current.agentId)?.placements.has(placement)) continue
          const misses = (this.misses.get(missKey) ?? 0) + 1
          if (misses < MISS_LIMIT) {
            this.misses.set(missKey, misses)
            continue
          }
          this.misses.delete(missKey)
          nextRuntimes = nextRuntimes.filter((candidate) => terminalPlacementKey(candidate) !== placement)
        }

        if (terminalVerified) await this.deps.onTerminalAvailability?.(current, true)
        const probed = probedAs.get(current.agentId)
        if (observed) {
          this.engineMisses.delete(current.agentId)
        } else if (probed && probed.processKey === processKey
          && current.active && terminalVerified && !isTerminalEngine(current.engine) && !current.runtimes.some((runtime) =>
          probe.ambiguousPlacements.has(terminalPlacementKey(runtime)))) {
          // A live pane with no engine process in it. For an agent that is a dormant engine; for a
          // terminal (`engine === 'terminal'`) it is simply a shell at its prompt, which is why the
          // branch is skipped for one. A terminal that ADOPTED an engine (`terminalHost`, engine no
          // longer `terminal`) does come through here when that engine exits — the handler turns it
          // back into a terminal rather than marking it dormant (cli.ts `onDormant`).
          const prior = this.engineMisses.get(current.agentId)
          const misses = (prior?.processKey === processKey ? prior.count : 0) + 1
          if (misses >= MISS_LIMIT) {
            this.engineMisses.delete(current.agentId)
            await this.deps.onDormant(current, `engine process absent after ${MISS_LIMIT} confirmed scans`)
          } else {
            this.engineMisses.set(current.agentId, { processKey, count: misses })
          }
        }

        if (observed) {
          const availableInstances = new Set(probe.targets
            .filter((target) => target.result.state === 'available')
            .map((target) => target.instanceId))
          const unknownRuntimes = current.runtimes.filter((runtime) => !availableInstances.has(
            terminalInstanceId(runtime),
          ))
          const merged: DiscoveredTerminalAgent = {
            ...observed,
            runtimes: mergeTerminalRuntimes(unknownRuntimes, [...nextRuntimes, ...observed.runtimes]),
          }
          await this.deps.onObserved(merged, current)
        } else if (nextRuntimes.length < current.runtimes.length) {
          if (nextRuntimes.length === 0) {
            await this.deps.onTerminalAvailability?.(current, false)
            await this.deps.onRemoved(current, `terminal runtime absent after ${MISS_LIMIT} confirmed scans`)
          } else {
            await this.deps.onObserved({
              engine: current.engine,
              cwd: current.cwd ?? '',
              processIdentity: current.processIdentity!,
              args: current.processIdentity?.executable ?? '',
              resumeSessionId: null,
              runtimes: nextRuntimes,
              primaryRuntimeKey: nextRuntimes.some((runtime) => terminalRouteKey(runtime) === current.primaryRuntimeKey)
                ? current.primaryRuntimeKey
                : terminalRouteKey(nextRuntimes[0]),
            }, current)
          }
        }
      }

      for (const observed of probe.agents) {
        const key = processIdentityKey(observed.engine, observed.processIdentity)
        if (matchedProcesses.has(key)) continue
        // The replacement process for a restart in progress: the restart handler will bind it via
        // `updateProcessIdentity` itself once confirmed, not through ordinary discovery.
        if (this.routeHeld(observed.runtimes, probeSeq)) continue
        await this.deps.onDiscovered(observed)
      }
    }

    if (this.deps.transaction) await this.deps.transaction(apply)
    else await apply()
    // Readiness is published last: clients must never observe ready=true between the inventory read and
    // the authoritative availability/registry update.
    this.deps.onProbeStatus?.({ ready: true, error: probeError })
  }
}
