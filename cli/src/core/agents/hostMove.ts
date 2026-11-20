/**
 * One move to the target pty host, wired to the core (hostMove/moveAgent.ts says what each step must do; this says
 * which core call does it). Every pane call reaches the pane's own backend; the new pane is made on the create
 * backend, the target's.
 *
 * The launch is built once, at step 2, without its preparation (`prepare: false`). What it was built with (the grid's
 * or the Store's overrides, the permission) is kept on it (`deferred`), and both the preparation and a fallback's
 * relaunch in the old pane use that: nothing is asked of the grid or the Store again while the agent's input is held.
 */
import { baseNode } from '../../harnessd/baseNode.js'
import { matchesLaunchReceipt, type RegisteredSession, type registry } from '../../lib/registry.js'
import { IdentityReadUnavailable } from '../../engines/kit/identityScan.js'
import type { TerminalRuntimeRef } from '../../lib/terminalTypes.js'
import type { MoveGate } from '../../lib/hostMove/gate.js'
import { moveAgent, moveCreateRequest, type MoveAgentDeps, type MoveOutcome } from '../../lib/hostMove/moveAgent.js'
import { SEED_HISTORY_LINES } from '../../lib/hostMove/seed.js'
import { restartAgent } from '../../lib/restartAgent.js'
import type { RestoreAgentsDeps, RestoreLaunch } from '../../lib/restoreAgents.js'
import type { RestoreTerminals } from '../../lib/restoreTerminals.js'
import { restartTargetOf, type TerminalBackend } from '../../lib/terminalBackend.js'
import type { TerminalBackendCoordinator } from '../../lib/terminalBackendCoordinator.js'
import { sameProcessIdentity, terminalRouteKey } from '../../lib/terminalRuntime.js'
import { commitRelaunchedEngine } from './restart.js'
import type { PaneSwap } from './swap.js'

export interface HostMoveWiring {
  registry: Pick<typeof registry, 'byAgent' | 'confirmLaunch'>
  terminals: Pick<TerminalBackendCoordinator, 'backendFor' | 'capture'>
  /** The backend new panes are made on: the target host's. */
  createBackend(): TerminalBackend | null
  /** Restore's own pane calls (lib/restoreTerminals.ts): its respawn spreads the launch's Windows pane launch. */
  restore: Pick<RestoreTerminals, 'respawn' | 'probeProcess'>
  /** Restore's launch (`createRestoreLaunch`), shared. */
  buildLaunch: RestoreAgentsDeps['buildLaunch']
  /** The pane-process swap's calls (core/agents/swap.ts): the stop of the recorded process, and a restart's relaunch. */
  paneSwapDeps: PaneSwap['paneSwapDeps']
  retarget(agentId: string, runtime: TerminalRuntimeRef): Promise<void>
  gate: MoveGate
  /** Whether [agentId] is still idle, quiet and not looked at, as the mover picked it: asked before the stop. */
  eligible(agentId: string): boolean
  /** `agentReconciler.holdRoute`, asked with no auto-release. */
  holdRoute(routeKey: string, autoReleaseMs: null): () => void
  announce(session: RegisteredSession): void
  /** A control lease taken on the old pane is not the new one's (core/terminals/control.ts). */
  invalidateControl(agentId: string): void
  refreshGridAssignment?(session: RegisteredSession): void
  /** The command the new pane waits in, with no engine, until the engine is started in it. */
  waitingArgv(): string[]
  log(message: string): void
}

/**
 * What the new pane runs until the engine is started in it: a process that waits and prints nothing, so the pane shows
 * the scrollback it was seeded with and no line of its own (restore's waiting pane, `heldPaneArgv`, says why it waits).
 * It ignores the interrupt keys, as that one does, so nothing typed ends it before the respawn replaces it. It ends on
 * the hangup that respawn sends, as that one does: on Windows Node hears the console's close as SIGHUP, and a listener
 * for it would hold the close until the host kills the pane, the host's whole 2 s grace (lib/windows/engineStart.ts
 * `windowsHeldPaneArgv`).
 */
export function moveWaitingArgv(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') {
    return [baseNode(process.execPath), '-e', 'for(const s of ["SIGINT","SIGBREAK"])process.on(s,()=>{});setInterval(()=>{},3600000)', 'harness-move']
  }
  return ['/bin/sh', '-c', 'trap "" INT QUIT TSTP; while :; do sleep 3600; done', 'harness-move']
}

/** The row as the move found it: what it stops is the process recorded then, never one recorded since. */
function snapshot(session: RegisteredSession): RegisteredSession {
  return structuredClone(session)
}

/** [session]'s move, its cancellation read from [current] (`restartJobs.run`'s). */
export function hostMoveDeps(session: RegisteredSession, current: () => boolean, w: HostMoveWiring): MoveAgentDeps {
  const { agentId } = session
  const recorded = snapshot(session)
  /** The launch step 2 built, and whether its preparation has run. */
  let launch: RestoreLaunch | null = null
  let prepared = false
  let confirmed: RegisteredSession | null = null
  const owns = () => current() && !w.gate.refused(agentId)
    && matchesLaunchReceipt(w.registry.byAgent(agentId), confirmed ?? recorded)
  const placeOf = (row: RegisteredSession) => restartTargetOf(row, (runtime) => w.terminals.backendFor(runtime))

  return {
    capture: async (row) => {
      const read = await w.terminals.capture(row, { historyLines: SEED_HISTORY_LINES, ansi: true })
      return read.state === 'succeeded' ? read.value : null
    },
    buildLaunch: async (row, opts) => {
      const built = await w.buildLaunch(row, opts)
      if ('argv' in built) launch = built
      return built
    },
    createSeeded: async (row, seed) => {
      const backend = w.createBackend()
      if (!backend) return { ok: false, reason: 'no target host' }
      const made = await backend.create({ ...moveCreateRequest(agentId, { seed, command: w.waitingArgv(), cwd: row.cwd }), current: owns })
      return made.state === 'succeeded' ? { ok: true, runtime: made.runtime } : { ok: false, reason: made.reason }
    },
    respawn: (runtime, built) => w.restore.respawn(runtime, built, { current: () => owns() && built.current?.() !== false }),
    prepareResume: async (_row, waiting) => {
      const deferred = launch?.deferred
      if (!deferred) throw new Error('the launch was not built for a move')
      await deferred.prepare(waiting)
      prepared = true
    },
    stopEngine: async () => {
      const place = placeOf(recorded)
      if (!place || !owns()) return 'failed'
      // The pane is kept (`holdOpen`) before its engine is signalled: closed with it, nothing would be left to fall back
      // to. `terminate` signals the process the row recorded, checked against its start marker.
      const swap = w.paneSwapDeps(recorded, place, {}, recorded.permissionMode ?? null, owns)
      const kept = await swap.holdOpen()
      if (!owns()) return 'failed'
      if (!kept.ok) {
        w.log(`[terminal] move ${agentId}: could not keep the old pane open (${kept.reason ?? 'unknown reason'})`)
        return 'failed'
      }
      return swap.terminate()
    },
    probeProcess: (runtime, engine) => w.restore.probeProcess(runtime, engine),
    swap: async (id, runtime, identity) => {
      const backend = w.terminals.backendFor(runtime)
      const publication = await w.registry.confirmLaunch(id, { processIdentity: identity, runtimes: [runtime], grid: launch?.grid }, {
        current: () => owns() && !!backend && w.terminals.backendFor(runtime) === backend,
        refresh: async () => {
          const observed = await w.restore.probeProcess(runtime, recorded.engine)
          if (!sameProcessIdentity(identity, observed) || observed?.executable !== identity.executable) {
            throw new IdentityReadUnavailable('the move destination changed before publication')
          }
        },
      })
      if (publication.state === 'confirmed') {
        confirmed = publication.entry
        w.invalidateControl(id)
      }
      return publication
    },
    complete: () => {
      if (!confirmed || !owns()) return
      w.announce(confirmed)
      w.refreshGridAssignment?.(confirmed)
    },
    retarget: (id, runtime) => w.retarget(id, runtime),
    releaseHold: async (runtime) => {
      const backend = w.terminals.backendFor(runtime)
      if (!backend) throw new Error('no backend for the new pane')
      await backend.releaseHold(runtime, owns)
    },
    killPane: async (runtime) => {
      const backend = w.terminals.backendFor(runtime)
      return !!backend && (await backend.kill(runtime, () => owns() && w.terminals.backendFor(runtime) === backend)).state === 'succeeded'
    },
    relaunchOld: async (row) => {
      const deferred = launch?.deferred
      const grid = launch?.grid
      const place = placeOf(recorded)
      if (!deferred || !place || !recorded.sessionId) return false
      // A restart in the old pane, as `agent_restart` runs it, with the overrides and permission the move's launch was
      // built with. The conversation was prepared before the respawn when that step ran; otherwise here.
      if (!owns()) return false
      const swap = w.paneSwapDeps(recorded, place, deferred.overrides, deferred.permission.permissionMode ?? null, owns)
      const outcome = await restartAgent(
        { engine: recorded.engine, sessionId: recorded.sessionId, ...(recorded.resumeOnly ? { resumeOnly: true as const } : {}) },
        deferred.permission.bypassPermission === true,
        { ...swap, isCurrent: owns, prepareResume: prepared ? undefined : () => deferred.prepare() },
      )
      if (!outcome.ok) {
        w.log(`[terminal] move ${agentId}: the relaunch in the old pane failed: ${outcome.detail}`)
        return false
      }
      // The row learns it as a restart's does (`commitRelaunchedEngine`, core/agents/restart.ts): shared, not copied.
      const committed = await commitRelaunchedEngine(
        { registry: w.registry, announceSession: w.announce, refreshGridAssignment: (refreshed) => w.refreshGridAssignment?.(refreshed) },
        row.agentId, outcome.processIdentity, grid, place, owns, {}, current)
      // Cancelled once the row had the engine: it runs in the old pane all the same, which is what a fallback is.
      return typeof committed !== 'string' || committed === 'changed after commit'
    },
    gate: w.gate,
    holdRoute: (routeKey) => w.holdRoute(routeKey, null),
    current: owns,
    eligible: () => w.eligible(agentId),
    log: (line) => w.log(line),
  }
}

/** Move [session] to the target host, as [current]'s lifecycle operation. */
export function createHostMove(w: HostMoveWiring): (session: RegisteredSession, current: () => boolean) => Promise<MoveOutcome> {
  return (session, current) => moveAgent(snapshot(session), hostMoveDeps(session, current, w))
}
