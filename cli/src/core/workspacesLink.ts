/**
 * Workspaces in their own process, as the core sees them (`HARNESSD_SERVICES=workspaces`; the process's
 * side is services/workspacesProcess.ts).
 *
 * The core asks workspaces nothing it must have answered: both calls are commands. So unlike the
 * viewers (core/viewersLink.ts) there is nothing to keep for while the process is down. An agent's
 * frame reads its branch from git in the core (lib/agentProject.ts), so a frame built meanwhile still
 * names the branch; only renaming a made-up branch waits for the process to come back.
 *
 * Nothing is held for the process either:
 * - Each terminal-title pass (every few seconds) tells it to name branches, with the live agents.
 *   One it misses is followed by the next.
 * - A sweep is never held or replayed. The core's timers decide when one runs, as in its own process.
 *   A sweep decided while the process is not connected is skipped, and the next timer decides again:
 *   a held one would run at a time nobody chose, possibly beside the next.
 * - When the process starts the sweep, it asks for every agent, live and stopped (`agents`), and sweeps
 *   only with that answer. So the folders in use are read when the sweep begins, as in the core's
 *   process, never from a list that waited in a buffer while the process was stopped. A core that
 *   cannot list them (an unreadable stopped agent) answers QUERY_FAILED, and nothing is swept.
 *
 * After it renames a branch, the process asks the core to send the agent's frame again
 * (`branchNamed`): the core forgets what it read of the folder, and the frame shows the new name now
 * rather than when that read expires.
 */
import type { CoreApi, WorkspacesPort } from './api.js'
import type { ServiceFrame } from './serviceLinks.js'

/** Tell the workspaces' process something (core/serviceLinks.ts `notify`, for `workspaces`). */
export type NotifyWorkspaces = (frame: ServiceFrame) => boolean

export function createWorkspacesLink(
  core: Pick<CoreApi, 'agents'>,
  notify: NotifyWorkspaces,
  /** Forget what the core read of a folder's project (lib/agentProject.ts `forgetAgentProject`). */
  forgetProject: (cwd: string) => void,
  log: (line: string) => void = (line) => console.log(line),
) {
  const port: WorkspacesPort = {
    nameBranches: () => {
      notify({ type: 'service_event', payload: { kind: 'nameBranches', agents: core.agents.live() } })
    },
    sweepUnused: () => {
      if (!notify({ type: 'service_event', payload: { kind: 'sweep' } })) {
        log('[worktrees] sweep skipped: the workspaces process is not running; the next one is on its timer')
      }
    },
  }

  /** The process renamed an agent's branch: its frame goes out again, read fresh. */
  const branchNamed = (payload: Record<string, unknown>): Record<string, unknown> => {
    const session = typeof payload.agentId === 'string' ? core.agents.byAgent(payload.agentId) : undefined
    if (!session) return { synced: false }
    if (session.cwd) forgetProject(session.cwd)
    core.agents.sync(session)
    return { synced: true }
  }

  return {
    port,
    /** The core's answers to the workspaces' questions (core/serviceLinks.ts `answer`, for `workspaces`). */
    answer(query: string, payload: Record<string, unknown>): Record<string, unknown> {
      // Every agent, live then stopped: the folders a sweep starting now must keep.
      if (query === 'agents') return { agents: core.agents.all() }
      if (query === 'branchNamed') return branchNamed(payload)
      return { error: 'UNKNOWN_QUERY' }
    },
  }
}

export type WorkspacesLink = ReturnType<typeof createWorkspacesLink>
