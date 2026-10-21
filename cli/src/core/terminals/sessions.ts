/** Terminal identity and exit evidence stay with the core's live registry. */
import type { CoreApi, TerminalsPort } from '../api.js'
import { primaryRuntime } from '../../lib/terminalRuntime.js'
import type { TerminalPaneRead, TerminalRuntimeRef } from '../../lib/terminalTypes.js'
import type { checkPidRuntime } from '../../lib/deleteAgentFallback.js'

interface TerminalSessionDeps {
  agents: Pick<CoreApi['agents'], 'byAgent' | 'displayName' | 'terminalAvailable'>
  /** The pane's state, as its own backend reads it (`TerminalBackend.paneState`): asked with the row's runtime,
   *  never the bare `tmuxPane`, which is a ptyhost pane's id on a ptyhost row. */
  paneState: (runtime: TerminalRuntimeRef) => Promise<TerminalPaneRead>
  processState: typeof checkPidRuntime
}

export function createTerminalSessions(deps: TerminalSessionDeps): Pick<TerminalsPort, 'describe' | 'visitStatus'> {
  // This only restores a client's parked shell view. The core still owns archiving and resume.
  // A banner or Ctrl-C is not proof: require the launcher's exit mark AND the exact process gone.
  const visitStatus = async (agentId: string): Promise<{ exited: boolean }> => {
    const row = deps.agents.byAgent(agentId)
    // Discovery clears a completed launch record when it binds the engine's conversation.
    // October 6 shell-return E2E: a resumed process exited after discovery marked its row inactive,
    // before retirement. That flag cannot suppress an exact exit probe or the parked shell is stranded.
    if (!row || row.engine === 'terminal' || row.launch?.state === 'starting' || row.launch?.state === 'failed'
      || !row.runtimes.length || !row.processIdentity?.startMarker) return { exited: false }
    const session = { ...row, processIdentity: { ...row.processIdentity } }
    const identity = (value: ReturnType<typeof deps.agents.byAgent>) => JSON.stringify([value?.engine, value?.sessionId,
      value?.registeredAt, value?.tmuxPane, value?.launch?.state, value?.processIdentity])
    const before = identity(session)
    const pane = await deps.paneState(primaryRuntime(session))
    if (pane === 'gone' || pane === 'unknown' || pane.engineExit == null) return { exited: false }
    const process = await deps.processState(session)
    return { exited: process.state === 'gone' && identity(deps.agents.byAgent(agentId)) === before }
  }
  return {
    visitStatus,
    describe: async (agentId) => {
      const row = deps.agents.byAgent(agentId)
      if (!row) return null
      return {
        id: row.agentId, sessionId: row.sessionId, engine: row.engine, name: deps.agents.displayName(row),
        status: 'active', launch: row.launch, terminal: { available: deps.agents.terminalAvailable(row.agentId) },
        project: { cwd: row.cwd, root: row.cwd, name: row.projectDir },
      }
    },
  }
}
