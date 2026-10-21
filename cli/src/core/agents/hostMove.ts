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
import type { RegisteredSession } from '../../lib/registry.js'
import type { ProcessIdentity, TerminalRuntimeRef } from '../../lib/terminalTypes.js'
import type { MoveGate } from '../../lib/hostMove/gate.js'
import { moveAgent, moveCreateRequest, type MoveAgentDeps, type MoveOutcome } from '../../lib/hostMove/moveAgent.js'
import { SEED_HISTORY_LINES } from '../../lib/hostMove/seed.js'
import { restartAgent } from '../../lib/restartAgent.js'
import type { RestoreAgentsDeps, RestoreLaunch } from '../../lib/restoreAgents.js'
import type { RestoreTerminals } from '../../lib/restoreTerminals.js'
import { restartTargetOf, type TerminalBackend } from '../../lib/terminalBackend.js'
import type { TerminalBackendCoordinator } from '../../lib/terminalBackendCoordinator.js'
import { terminalRouteKey } from '../../lib/terminalRuntime.js'
import { commitRelaunchedEngine } from './restart.js'
import type { PaneSwap } from './swap.js'

export interface HostMoveWiring {
  registry: {
    byAgent(agentId: string): RegisteredSession | undefined
    transaction<T>(apply: () => T | Promise<T>): Promise<T>
    updateRuntimes(agentId: string, runtimes: readonly TerminalRuntimeRef[], primaryRuntimeKey?: string): boolean
    updateProcessIdentity(agentId: string, identity: ProcessIdentity, gateway?: 'ori' | null): boolean
    setActive(agentId: string, active: boolean): boolean
  }
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
 * It ignores the interrupt keys, as that one does, so nothing typed ends it before the respawn replaces it.
 */
export function moveWaitingArgv(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') {
    return [baseNode(process.execPath), '-e', 'for(const s of ["SIGINT","SIGBREAK","SIGHUP"])process.on(s,()=>{});setInterval(()=>{},3600000)', 'harness-move']
  }
  return ['/bin/sh', '-c', 'trap "" INT QUIT TSTP; while :; do sleep 3600; done', 'harness-move']
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** The row as the move found it: what it stops is the process recorded then, never one recorded since. */
function snapshot(session: RegisteredSession): RegisteredSession {
  return { ...session, runtimes: [...session.runtimes], processIdentity: session.processIdentity && { ...session.processIdentity } }
}

/** [session]'s move, its cancellation read from [current] (`restartJobs.run`'s). */
export function hostMoveDeps(session: RegisteredSession, current: () => boolean, w: HostMoveWiring): MoveAgentDeps {
  const { agentId } = session
  const recorded = snapshot(session)
  /** The launch step 2 built, and whether its preparation has run. */
  let launch: RestoreLaunch | null = null
  let prepared = false
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
      const made = await backend.create({ ...moveCreateRequest(agentId, { seed, command: w.waitingArgv(), cwd: row.cwd }), current })
      return made.state === 'succeeded' ? { ok: true, runtime: made.runtime } : { ok: false, reason: made.reason }
    },
    respawn: (runtime, built) => w.restore.respawn(runtime, built, { current: () => current() && built.current?.() !== false }),
    prepareResume: async () => {
      const deferred = launch?.deferred
      if (!deferred) throw new Error('the launch was not built for a move')
      deferred.prepare()
      prepared = true
    },
    stopEngine: async () => {
      const place = placeOf(recorded)
      if (!place) return 'failed'
      // The pane is kept (`holdOpen`) before its engine is signalled: closed with it, nothing would be left to fall back
      // to. `terminate` signals the process the row recorded, checked against its start marker.
      const swap = w.paneSwapDeps(recorded, place, {}, recorded.permissionMode ?? null, current)
      const kept = await swap.holdOpen()
      if (!kept.ok) {
        w.log(`[terminal] move ${agentId}: could not keep the old pane open (${kept.reason ?? 'unknown reason'})`)
        return 'failed'
      }
      return swap.terminate()
    },
    probeProcess: (runtime, engine) => w.restore.probeProcess(runtime, engine),
    swap: (id, runtime, identity) => {
      // Synchronous: the transaction applies before it first awaits, so the row names the new pane on return.
      let switched = false
      void w.registry.transaction(() => {
        if (!w.registry.updateRuntimes(id, [runtime], terminalRouteKey(runtime))) return
        switched = true
        w.registry.updateProcessIdentity(id, identity)
      }).catch((error) => { w.log(`[terminal] move ${id}: saving the switch failed: ${message(error)}`) })
      if (!switched) throw new Error('the row is gone')
      // The row is switched: nothing after this may fail the move, which would relaunch the old engine beside the new.
      try {
        w.invalidateControl(id)
        const row = w.registry.byAgent(id)
        if (row) {
          w.announce(row)
          w.refreshGridAssignment?.(row)
        }
      } catch (error) {
        w.log(`[terminal] move ${id}: announcing the switch failed: ${message(error)}`)
      }
    },
    retarget: (id, runtime) => w.retarget(id, runtime),
    releaseHold: async (runtime) => {
      const backend = w.terminals.backendFor(runtime)
      if (!backend) throw new Error('no backend for the new pane')
      await backend.releaseHold(runtime)
    },
    killPane: async (runtime) => {
      const backend = w.terminals.backendFor(runtime)
      return !!backend && (await backend.kill(runtime)).state === 'succeeded'
    },
    relaunchOld: async (row) => {
      const deferred = launch?.deferred
      const place = placeOf(recorded)
      if (!deferred || !place || !recorded.sessionId) return false
      // A restart in the old pane, as `agent_restart` runs it, with the overrides and permission the move's launch was
      // built with. The conversation was prepared before the respawn when that step ran; otherwise here.
      const swap = w.paneSwapDeps(recorded, place, deferred.overrides, deferred.permission.permissionMode ?? null, current)
      const outcome = await restartAgent(
        { engine: recorded.engine, sessionId: recorded.sessionId, ...(recorded.resumeOnly ? { resumeOnly: true as const } : {}) },
        deferred.permission.bypassPermission === true,
        { ...swap, isCurrent: current, prepareResume: prepared ? undefined : () => deferred.prepare() },
      )
      if (!outcome.ok) {
        w.log(`[terminal] move ${agentId}: the relaunch in the old pane failed: ${outcome.detail}`)
        return false
      }
      // The row learns it as a restart's does (`commitRelaunchedEngine`, core/agents/restart.ts): shared, not copied.
      const committed = await commitRelaunchedEngine(
        { registry: w.registry, announceSession: w.announce, refreshGridAssignment: (refreshed) => w.refreshGridAssignment?.(refreshed) },
        row.agentId, outcome.processIdentity, place, current)
      // Cancelled once the row had the engine: it runs in the old pane all the same, which is what a fallback is.
      return typeof committed !== 'string' || committed === 'changed after commit'
    },
    gate: w.gate,
    holdRoute: (routeKey) => w.holdRoute(routeKey, null),
    current,
    eligible: () => w.eligible(agentId),
    log: (line) => w.log(line),
  }
}

/** Move [session] to the target host, as [current]'s lifecycle operation. */
export function createHostMove(w: HostMoveWiring): (session: RegisteredSession, current: () => boolean) => Promise<MoveOutcome> {
  return (session, current) => moveAgent(snapshot(session), hostMoveDeps(session, current, w))
}
