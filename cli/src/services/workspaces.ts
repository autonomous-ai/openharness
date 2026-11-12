/**
 * Workspaces: everything about the folder an agent works in (docs/design/2026-10-03-harnessd.md,
 * "Workspaces"). Here so far: a worktree branch Harness made up takes its session's name, and the person's apps list the
 * leftover worktrees and move the ones they choose to the Trash (`worktrees_list`, `worktrees_clean`;
 * lib/leftoverWorktrees.ts). Nothing here removes a worktree on its own: the timer sweep that did (#4166) removed clean,
 * week-idle ones its person had chosen to keep, gitignored files and all.
 *
 * A service on the core boundary (step 13): it reads the core only through `CoreApi`, and the core
 * reaches it only through `ports.workspaces`.
 */
import type { CoreApi, CorePorts, ServiceRequest, ServiceRequests } from '../core/api.js'
import { cleanWorktrees, listLeftoverWorktrees } from '../lib/leftoverWorktrees.js'
import { sid } from '../lib/log.js'
import { projectsRoot } from '../lib/projectFolder.js'
import { sessionDisplayTitle } from '../lib/registry.js'
import { systemTrash } from '../lib/trash.js'
import { forgetScmProject, renameScmProject } from '../scm/scmProjects.js'

/** The leftover worktrees' requests, declared in core/api.ts for the core to route. */
export { WORKSPACES_REQUESTS } from '../core/api.js'

/** The most worktrees one clean takes (core/api.ts LONG_ANSWERS waits for them). */
export const CLEAN_MAX = 50

export function startWorkspaces(core: CoreApi, ports: CorePorts): ServiceRequests {
  // A worktree branch Harness made up at Start takes its session's name once it has one
  // (lib/branchNaming.ts). Each agent is looked at once per daemon; the git reads are the cost.
  const branchNamed = new Set<string>()
  const nameSessionBranches = (): void => {
    for (const session of core.agents.live()) {
      const title = sessionDisplayTitle(session)
      if (!title || !session.cwd || branchNamed.has(session.agentId)) continue
      branchNamed.add(session.agentId)
      const cwd = session.cwd
      void renameScmProject(cwd, title).then((renamed) => {
        if (!renamed) return
        console.log(`[worktrees] agent ${sid(session.agentId)} branch named ${renamed}`)
        forgetScmProject(cwd)
        const current = core.agents.byAgent(session.agentId)
        if (current) core.agents.sync(current)
      }).catch(() => {})
    }
  }
  ports.workspaces = { nameBranches: nameSessionBranches }

  // The person's own choice, never a timer's: the owner lists what is left and picks what goes to the Trash. Each request
  // reads every agent, live and stopped, before anything else, while it is answered: in the edge host the core is asked
  // for them as the request arrives, and they are known only then (services/workspacesProcess.ts).
  // Where a start makes its worktrees: ~/harnesses, or ~/projects on a Harness OS device.
  const root = projectsRoot()
  const owned = (answer: (payload: Record<string, unknown>, inUse: Array<string | null>) => Promise<Record<string, unknown>>): ServiceRequest =>
    (payload, asker) => {
      if (!asker.owner) return { error: 'OWNER_REQUIRED' }
      let inUse: Array<string | null>
      try { inUse = core.agents.all().map((session) => session.cwd) } catch { return { error: 'WORKTREES_UNAVAILABLE' } }
      return answer(payload, inUse)
    }
  return {
    worktrees_list: owned(async (_payload, inUse) => ({ ...await listLeftoverWorktrees({ root, inUse }) })),
    worktrees_clean: owned(async (payload, inUse) => {
      const paths = payload.paths
      if (!Array.isArray(paths) || paths.length === 0 || paths.length > CLEAN_MAX || !paths.every((path) => typeof path === 'string')) {
        return { error: 'INVALID_PATHS' }
      }
      const results = await cleanWorktrees({ root, inUse, paths, trash: systemTrash() })
      // Counts and fixed codes only: a path names the person's work.
      const kept = results.filter((result) => result.state !== 'trashed').map((result) => 'reason' in result ? result.reason : result.state)
      console.log(`[worktrees] ${results.length - kept.length} of ${results.length} moved to the Trash${kept.length ? ` · kept: ${kept.join(', ')}` : ''}`)
      return { results }
    }),
  }
}
