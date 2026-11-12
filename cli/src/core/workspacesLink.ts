/**
 * Workspaces in their own process, as the core sees them (`HARNESSD_SERVICES=workspaces`; the process's
 * side is services/workspacesProcess.ts).
 *
 * The core asks workspaces nothing it must have answered: its one call is a command. So unlike the
 * viewers (core/viewersLink.ts) there is nothing to keep for while the process is down. An agent's
 * frame reads its branch from git in the core (lib/agentProject.ts), so a frame built meanwhile still
 * names the branch; only renaming a made-up branch waits for the process to come back.
 *
 * Nothing is held for the process either: each terminal-title pass (every few seconds) tells it to name
 * branches, with the live agents. One it misses is followed by the next.
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
) {
  const port: WorkspacesPort = {
    nameBranches: () => {
      notify({ type: 'service_event', payload: { kind: 'nameBranches', agents: core.agents.live() } })
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
      if (query === 'branchNamed') return branchNamed(payload)
      return { error: 'UNKNOWN_QUERY' }
    },
  }
}

export type WorkspacesLink = ReturnType<typeof createWorkspacesLink>
