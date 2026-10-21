/**
 * Move one agent to another pty host (spec §4): its engine stops in the old pane and resumes its conversation in a
 * new pane seeded with the old one's scrollback, under the same agent id and row. When the new engine cannot be
 * proven in time, the engine comes back in the old pane, as a restart brings it back (`restartAgent.ts`).
 *
 * Dependency-injected like `restartAgent.ts`: the order of the steps, and what each failure undoes, is what this
 * file owns. The daemon's wiring (core/main.ts) supplies the backends, the registry and the reconciler.
 *
 * Two engines never hold one conversation at once: the new pane waits with no engine until the old engine is
 * confirmed stopped, and the old one is relaunched only once the new pane is confirmed closed.
 */

import type { AgentEngine } from '../../engines/types.js'
import type { TerminateOutcome } from '../deleteAgentFallback.js'
import type { RegisteredSession } from '../registry.js'
import { KILL_CONFIRMED } from '../restartAgent.js'
import type { RestoreAgentsDeps, RestoreLaunch } from '../restoreAgents.js'
import type { TerminalBackend } from '../terminalBackend.js'
import { sameProcessIdentity, terminalRouteKey } from '../terminalRuntime.js'
import type { ProcessIdentity, TerminalCreateRequest, TerminalRuntimeRef } from '../terminalTypes.js'
import type { MoveGate } from './gate.js'
import { seedFromCapture } from './seed.js'

/** Names a move's new pane after the agent it is for: in its environment, and as its label, which the host lists
 *  back (`removeOrphanMovePanes`). */
export const MOVE_MARKER_ENV = 'HARNESS_MOVE_OF'

/** The new engine must be proven running within this, or the move falls back to the old pane. */
export const MOVE_TIMEOUT_MS = 30_000
/** How often the new pane is probed for its engine. An engine counts once two probes in a row see the same process:
 *  a resume the engine refuses runs for an instant, as `paneSwapDeps`' `waitForProcess` settles for. */
export const MOVE_PROBE_INTERVAL_MS = 500

/**
 * Bounds on each step taken while the agent's input is held. The whole hold must end well under 120 s on every
 * path (a mailbox message held longer is sent again, gate.ts), so no held step may wait unbounded. The longest
 * path, a fallback whose every step takes its whole bound, holds for about 90 s:
 * stop 15 + respawn 10 + probe 30 + close the new pane 5 + relaunch 30.
 */
export const MOVE_STOP_TIMEOUT_MS = 15_000
export const MOVE_STEP_TIMEOUT_MS = 10_000
export const MOVE_KILL_TIMEOUT_MS = 5_000
/** The old pane's relaunch: a restart's resume attempt and its fresh retry, each with its own wait for the engine. */
export const MOVE_RELAUNCH_TIMEOUT_MS = 30_000

export type MoveOutcome = { moved: true; resumed: boolean } | { moved: false; reason: string; fellBack: boolean }

export interface MoveAgentDeps {
  /** The old pane's scrollback (`capture` with `SEED_HISTORY_LINES`, ANSI kept); null when it could not be read. */
  capture(session: RegisteredSession): Promise<string | null>
  /** Open the new pane on the create backend, waiting with no engine: `moveCreateRequest` with the waiting shell
   *  restore uses (`waitingLaunch` in core/main.ts). An empty [seed] means nothing to carry: no seed is sent. */
  createSeeded(session: RegisteredSession, seed: string): Promise<{ ok: true; runtime: TerminalRuntimeRef } | { ok: false; reason: string }>
  /** The backend's `respawn` of [runtime] with the launch's argv, cwd and env, as `restoreTerminals.ts` does: the
   *  pane, and the scrollback it was seeded with, stay. */
  respawn(runtime: TerminalRuntimeRef, launch: RestoreLaunch): Promise<{ ok: boolean; reason?: string }>
  /** Restore's launch (`createRestoreLaunch`, core/agents/restoreLaunch.ts), shared and not copied. */
  buildLaunch: RestoreAgentsDeps['buildLaunch']
  /** Stop the old engine and keep its pane, as `paneSwapDeps`' `terminate` does after its `holdOpen` (core/agents/
   *  swap.ts): a pane that is not held is closed with its process, and the fallback needs it. */
  stopEngine(session: RegisteredSession): Promise<TerminateOutcome>
  /** The engine process in [runtime], or null when none is found yet (`resolvePaneEngineProcess`). */
  probeProcess(runtime: TerminalRuntimeRef, engine: AgentEngine): Promise<ProcessIdentity | null>
  /** Point the row at [runtime], in one `registry.transaction`: `updateRuntimes(agentId, [runtime],
   *  terminalRouteKey(runtime))` and `updateProcessIdentity`, then announce the session as a restart does. Throws
   *  only when the row was not switched. */
  swap(agentId: string, runtime: TerminalRuntimeRef, identity: ProcessIdentity): void
  /** Move the agent's open streams to [runtime] (`TerminalStreamManager.retarget`). */
  retarget(agentId: string, runtime: TerminalRuntimeRef): Promise<void>
  /** Hand the new pane back to the backend's default disposal once it is the agent's, as a restart does
   *  (`releaseHold`): it was created held. Left out, the pane stays held. */
  releaseHold?(runtime: TerminalRuntimeRef): Promise<void>
  /** Close [runtime]. True once the backend confirms it is gone. */
  killPane(runtime: TerminalRuntimeRef): Promise<boolean>
  /** Relaunch the engine in the old pane, with resume (`restartAgent`). True once it runs there. */
  relaunchOld(session: RegisteredSession): Promise<boolean>
  gate: MoveGate
  /** The reconciler's route hold, for the old and the new pane, released by `releaseRoute` when the move ends: with
   *  no auto-release shorter than the move, or a pane seen mid-move would be read as an agent appearing or ending. */
  holdRoute(routeKey: string): void
  releaseRoute(routeKey: string): void
  /** False once the move is cancelled (Stop, delete, a replacement): `restartJobs.run`'s `current`. */
  current(): boolean
  log(message: string): void
}

/** The new pane's create request: the waiting shell [command] in the row's folder, marked as [agentId]'s move. The pty
 *  host holds every pane it creates (`hold: true`), which keeps the pane when the waiting shell is replaced. An empty
 *  seed is left out: a pane seeded with nothing would start with a blank history line. */
export function moveCreateRequest(agentId: string, options: { seed: string; command: string[]; cwd?: string | null }): TerminalCreateRequest {
  return {
    command: options.command,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: { [MOVE_MARKER_ENV]: agentId },
    label: moveLabel(agentId),
    ...(options.seed ? { seed: options.seed } : {}),
  }
}

function moveLabel(agentId: string): string {
  return `${MOVE_MARKER_ENV}=${agentId}`
}

/** The agent a pane labelled [label] was opened to move, or null for any other pane. */
export function moveMarkerOf(label: string | undefined): string | null {
  const prefix = `${MOVE_MARKER_ENV}=`
  return label?.startsWith(prefix) && label.length > prefix.length ? label.slice(prefix.length) : null
}

/**
 * Close every move pane no row names: a move a dead daemon left before its swap. The row still names the old pane,
 * which restore relaunches; this pane, possibly running an engine on the same conversation, would otherwise be minted
 * a second agent by discovery. Run once at core start, before restore and discovery. A pane a finished move made
 * keeps its label, and its row names it: it stays. Returns how many were closed.
 */
export async function removeOrphanMovePanes(
  backends: ReadonlyArray<Pick<TerminalBackend, 'inventory' | 'kill'>>,
  rows: ReadonlyArray<Pick<RegisteredSession, 'runtimes'>>,
): Promise<number> {
  const named = new Set(rows.flatMap((row) => row.runtimes.map(terminalRouteKey)))
  let removed = 0
  for (const backend of backends) {
    let inventory: Awaited<ReturnType<TerminalBackend['inventory']>>
    try { inventory = await backend.inventory() } catch { continue }
    // A host that cannot be listed keeps its panes: absence of an answer is not absence of a row.
    if (inventory.state !== 'available') continue
    for (const root of inventory.roots) {
      if (moveMarkerOf(root.label) === null || named.has(terminalRouteKey(root.runtime))) continue
      try {
        if ((await backend.kill(root.runtime)).state === 'succeeded') removed++
      } catch { /* left for the next start */ }
    }
  }
  return removed
}

type Bounded<T> = { done: true; value: T } | { done: false; reason: string }

/** [work], or why it did not finish within [ms]: thrown, or still running. A step that overruns is abandoned, not
 *  stopped; what it may still do later is undone by the steps after it (the new pane is closed). */
async function bounded<T>(work: () => Promise<T>, ms: number, what: string): Promise<Bounded<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race<Bounded<T>>([
      Promise.resolve().then(work).then((value) => ({ done: true as const, value })),
      new Promise<Bounded<T>>((resolve) => {
        timer = setTimeout(() => resolve({ done: false, reason: `${what} did not finish within ${ms / 1000} s` }), ms)
      }),
    ])
  } catch (error) {
    return { done: false, reason: `${what} failed: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The engine in [runtime], once two probes in a row see the same process, polled until `MOVE_TIMEOUT_MS`; null when
 *  it is not proven by then, or the move was cancelled. */
async function proveEngine(deps: MoveAgentDeps, runtime: TerminalRuntimeRef, engine: AgentEngine): Promise<ProcessIdentity | null> {
  const deadline = Date.now() + MOVE_TIMEOUT_MS
  let previous: ProcessIdentity | null = null
  for (;;) {
    const left = deadline - Date.now()
    if (left <= 0) return null
    const probed = await bounded(() => deps.probeProcess(runtime, engine), left, 'the probe')
    const found = probed.done ? probed.value : null
    if (found && sameProcessIdentity(found, previous)) return found
    previous = found
    if (!deps.current()) return null
    const wait = Math.min(MOVE_PROBE_INTERVAL_MS, deadline - Date.now())
    if (wait <= 0) return null
    await sleep(wait)
  }
}

const CANCELLED = 'the move was cancelled'

export async function moveAgent(session: RegisteredSession, deps: MoveAgentDeps): Promise<MoveOutcome> {
  const { agentId, engine } = session
  // A move restarts the engine: one with no conversation to resume would come back empty.
  if (!session.sessionId) return { moved: false, reason: 'no conversation to resume', fellBack: false }

  // A log line that throws must not turn a finished step into a failed one.
  const log = (message: string) => { try { deps.log(message) } catch { /* nothing to tell */ } }
  const heldRoutes = new Set<string>()
  const holdRoute = (key: string) => {
    if (heldRoutes.has(key)) return
    heldRoutes.add(key)
    deps.holdRoute(key)
  }
  /** The pane step 3 made; until the swap, the only pane a failure may close. */
  let created: TerminalRuntimeRef | null = null
  let holding = false
  /** Step 5 ran: the old engine may be stopped, and only `relaunchOld` brings it back. */
  let stopped = false
  /** Step 6 ran: the new pane may run an engine, so it must be confirmed closed before the old one is relaunched. */
  let respawned = false
  /** Step 8 ran: the row names the new pane, whose engine runs. Nothing after it may relaunch the old one. */
  let swapped = false

  /** Undo everything a failed or cancelled move did before its swap. The gate is released by the caller after it. */
  const recover = async (reason: string): Promise<MoveOutcome> => {
    if (swapped) {
      log(`[move] ${agentId}: after the switch, ${reason}`)
      return { moved: true, resumed: true }
    }
    let newPaneClosed = true
    if (created) {
      const newPane = created
      const closed = await bounded(() => deps.killPane(newPane), MOVE_KILL_TIMEOUT_MS, 'closing the new pane')
      newPaneClosed = closed.done && closed.value
      if (!newPaneClosed) log(`[move] ${agentId}: the new pane was not confirmed closed (${closed.done ? 'refused' : closed.reason})`)
    }
    if (!stopped) return { moved: false, reason, fellBack: false }
    // Cancelled by a Stop, a delete or a replacement: the engine stays stopped, for whoever cancelled the move.
    if (!deps.current()) return { moved: false, reason, fellBack: false }
    if (respawned && !newPaneClosed) {
      // Relaunched now, the old engine could share its conversation with one still running in the new pane. That pane
      // keeps its marker, and the next core start closes it (`removeOrphanMovePanes`).
      log(`[move] ${agentId}: not relaunched in the old pane while the new one may still run its engine`)
      return { moved: false, reason, fellBack: false }
    }
    // The old pane's engine runs again before the gate opens, so held input reaches a live engine. When it does not
    // come back, the input still goes to the old pane, as it does after a failed restart.
    const relaunched = await bounded(() => deps.relaunchOld(session), MOVE_RELAUNCH_TIMEOUT_MS, 'the relaunch in the old pane')
    if (!relaunched.done) log(`[move] ${agentId}: ${relaunched.reason}`)
    return { moved: false, reason, fellBack: relaunched.done && relaunched.value }
  }

  try {
    for (const runtime of session.runtimes) holdRoute(terminalRouteKey(runtime))
    if (!deps.current()) return await recover(CANCELLED)

    // 1. The old pane's scrollback.
    let captured: string | null
    try { captured = await deps.capture(session) } catch { captured = null }
    if (captured === null) return await recover('could not capture the old pane')
    if (!deps.current()) return await recover(CANCELLED)
    const seed = seedFromCapture(captured)

    // 2. The launch, as restore builds it, resuming the row's conversation.
    const launch = await deps.buildLaunch(session, { resumeSessionId: session.sessionId, current: () => deps.current() })
    if (!deps.current() || 'cancelled' in launch) return await recover(CANCELLED)
    if ('error' in launch) return await recover(`no launch: ${launch.detail}`)
    if ('held' in launch) return await recover(`the launch waits for ${launch.held}`)

    // 3. The new pane, waiting with no engine.
    const made = await deps.createSeeded(session, seed)
    if (!made.ok) return await recover(`could not open a pane on the new host: ${made.reason}`)
    created = made.runtime
    holdRoute(terminalRouteKey(created))
    if (!deps.current()) return await recover(CANCELLED)

    // 4. From here until release, what is typed or sent to the agent waits (gate.ts).
    deps.gate.hold(agentId)
    holding = true
    if (!deps.current()) return await recover(CANCELLED)
    // Someone reached for the agent: nothing has changed yet, so give it back untouched.
    if (deps.gate.touched(agentId)) return await recover('the agent was used as the move began')

    // 5. The old engine stops; its pane stays, for the fallback.
    stopped = true
    const stop = await bounded(() => deps.stopEngine(session), MOVE_STOP_TIMEOUT_MS, `stopping ${engine}`)
    if (!stop.done) return await recover(stop.reason)
    if (!KILL_CONFIRMED.has(stop.value)) return await recover(`could not confirm the old ${engine} process stopped (${stop.value})`)
    if (!deps.current()) return await recover(CANCELLED)

    // 6. The engine resumes in the new pane, over its scrollback.
    respawned = true
    const newPane = created
    const spawn = await bounded(() => deps.respawn(newPane, launch), MOVE_STEP_TIMEOUT_MS, `starting ${engine} in the new pane`)
    if (!spawn.done) return await recover(spawn.reason)
    if (!spawn.value.ok) return await recover(`could not start ${engine} in the new pane: ${spawn.value.reason ?? 'unknown reason'}`)
    if (!deps.current()) return await recover(CANCELLED)

    // 7. Proven running there.
    const identity = await proveEngine(deps, newPane, engine)
    if (!deps.current()) return await recover(CANCELLED)
    if (!identity) return await recover(`${engine} was not proven running in the new pane within ${MOVE_TIMEOUT_MS / 1000} s`)

    // 8. The row names the new pane first, synchronously, and only then are the streams moved: a stream opened during
    // the hold opened on the pane the row named, and retarget moves it with the rest. Retargeted before the switch, a
    // stream opened in between would land on the old pane and stay there.
    try { deps.swap(agentId, newPane, identity) } catch (error) {
      return await recover(`could not switch the row: ${error instanceof Error ? error.message : String(error)}`)
    }
    swapped = true
    created = null
    const streams = await bounded(() => deps.retarget(agentId, newPane), MOVE_STEP_TIMEOUT_MS, 'moving open streams')
    if (!streams.done) log(`[move] ${agentId}: ${streams.reason}`)
    if (deps.releaseHold) {
      const release = deps.releaseHold
      const released = await bounded(() => release(newPane), MOVE_KILL_TIMEOUT_MS, 'releasing the new pane')
      if (!released.done) log(`[move] ${agentId}: ${released.reason}`)
    }

    // 9. The old pane, which nothing names now.
    for (const old of session.runtimes) {
      const closed = await bounded(() => deps.killPane(old), MOVE_KILL_TIMEOUT_MS, 'closing the old pane')
      if (!closed.done || !closed.value) log(`[move] ${agentId}: the old pane was not confirmed closed (${closed.done ? 'refused' : closed.reason})`)
    }
    return { moved: true, resumed: true }
  } catch (error) {
    return await recover(`the move failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    // 10. Held input goes to the pane the row names now: the new one, or the old one after a fallback.
    if (holding) await deps.gate.release(agentId).catch(() => { /* each delivery reports its own failure */ })
    for (const key of heldRoutes) deps.releaseRoute(key)
  }
}
