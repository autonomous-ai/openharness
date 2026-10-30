/**
 * What restore (restoreAgents.ts) asks of the terminals, each runtime of its own backend: the backend a row's pane
 * is on rebuilds it, relaunches it in place and is asked about it. Only a backend that respawns in place restores
 * (`canRestart`: tmux, the pty host); a row with no runtime on one is skipped.
 *
 * tmux's survey reads its own pane listing (`listTmuxPanes`) as it always did; another backend's is its
 * inventory, which lists this daemon's panes only, a dead held one included (ptyHostBackend.ts), as tmux's
 * listing keeps a remain-on-exit pane.
 *
 * On the pty host a native launch's held shell has no tmux to replace itself with (`nativePaneHold`'s tmux
 * binary is null there): it stays inert, and restore's `respawn` with `expectedHeldToken` is what replaces it,
 * checked by the host in the same op, as tmux's `if-shell` does.
 */
import type { AgentEngine } from '../engines/types.js'
import { lookupPaneEngineProcess, resolvePaneEngineProcess } from './paneEngineProcess.js'
import { restoreRuntimeOf, terminalSurvey, type RestoreAgentsDeps, type SurveyListing } from './restoreAgents.js'
import { canRestart, type RestartableBackend, type TerminalBackend } from './terminalBackend.js'
import { terminalRuntimeLabel } from './terminalRuntime.js'
import type { TerminalRuntimeRef } from './terminalTypes.js'

export interface RestoreTerminalsOptions {
  /** Each runtime's own backend (`TerminalBackendCoordinator.backendFor`). */
  backendFor(runtime: TerminalRuntimeRef): TerminalBackend | undefined
  /** tmux's harness panes (`listTmuxPanes`). */
  listTmuxPanes(): Promise<{ ok: true; panes: ReadonlyArray<{ tmuxPane: string }> } | { ok: false }>
  /** Where a rebuilt pane opens (the home folder: the launch `cd`s into the row's own). */
  cwd: string
  /** What a rebuilt pane is called (`buildHarnessSessionLabel`). */
  label(engine: AgentEngine): string
}

export type RestoreTerminals = Required<Pick<RestoreAgentsDeps,
  'restorable' | 'survey' | 'waitingPane' | 'liveProcess' | 'createPane' | 'respawn' | 'probeProcess' | 'paneState'
  | 'clearRemainOnExit' | 'killPane'>>

export function restoreTerminals(options: RestoreTerminalsOptions): RestoreTerminals {
  const restoring = (runtime: TerminalRuntimeRef): RestartableBackend | undefined => {
    const backend = options.backendFor(runtime)
    return canRestart(backend) ? backend : undefined
  }
  /** Every caller asks of a runtime restore chose (`restorable`): one with no backend left is an error, not a guess. */
  const backendOf = (runtime: TerminalRuntimeRef): RestartableBackend => {
    const backend = restoring(runtime)
    if (!backend) throw new Error(`no terminal backend restores ${terminalRuntimeLabel(runtime)}`)
    return backend
  }
  const listPanes = async (runtime: TerminalRuntimeRef): Promise<SurveyListing> => {
    if (runtime.backend === 'tmux') {
      const read = await options.listTmuxPanes()
      return read.ok ? { ok: true, panes: read.panes.map((pane) => ({ backend: 'tmux' as const, paneId: pane.tmuxPane })) } : { ok: false }
    }
    const inventory = await backendOf(runtime).inventory()
    return inventory.state === 'available' ? { ok: true, panes: inventory.roots.map((root) => root.runtime) } : { ok: false }
  }
  const lookup = async (runtime: TerminalRuntimeRef, engine: AgentEngine) => lookupPaneEngineProcess(backendOf(runtime), runtime, engine)
  const survey = () => terminalSurvey(listPanes, lookup)
  const restorable = (runtime: TerminalRuntimeRef): boolean => !!restoring(runtime)
  /** The backend of the row's own runtime restore rebuilds (`restoreRuntimeOf`): a new pane opens there. */
  const placed = (entry: { runtimes: readonly TerminalRuntimeRef[] }): RestartableBackend => {
    const runtime = restoreRuntimeOf(entry, restorable)
    if (!runtime) throw new Error('no terminal backend restores this harness')
    return backendOf(runtime)
  }
  return {
    restorable,
    survey,
    // Async throughout: a backend gone is a rejected promise, which every restore step already handles.
    waitingPane: async (runtime, token) => backendOf(runtime).isHeld?.(runtime, token) ?? 'unknown',
    liveProcess: (entry, runtime) => survey().liveProcess(entry, runtime),
    createPane: async (entry, launch, control) => {
      const created = await placed(entry).create({
        cwd: options.cwd,
        label: options.label(entry.engine),
        command: launch.argv,
        ...control,
        ...(launch.env ? { env: launch.env } : {}),
        ...launch.paneLaunch,
      })
      return created.state === 'succeeded' ? { ok: true, runtime: created.runtime } : { ok: false, reason: created.reason }
    },
    respawn: async (runtime, launch, control) => {
      const result = await backendOf(runtime).respawn(runtime, {
        command: launch.argv,
        ...control,
        cwd: options.cwd,
        ...(launch.env ? { env: launch.env } : {}),
        ...launch.paneLaunch,
      })
      return result.state === 'succeeded' ? { ok: true } : { ok: false, reason: result.reason }
    },
    probeProcess: async (runtime, engine) => resolvePaneEngineProcess(backendOf(runtime), runtime, engine),
    paneState: async (runtime) => backendOf(runtime).paneState(runtime),
    clearRemainOnExit: async (runtime) => backendOf(runtime).releaseHold(runtime),
    killPane: async (runtime) => { await backendOf(runtime).kill(runtime) },
  }
}
