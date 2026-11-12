/**
 * Workspaces: everything about the folder an agent works in (docs/design/2026-10-03-harnessd.md,
 * "Workspaces"). Here so far: a worktree branch Harness made up takes its session's name. Nothing here removes a worktree:
 * the timer sweep that did (#4166) removed clean, week-idle ones its person had chosen to keep, gitignored files and all.
 *
 * A service on the core boundary (step 13): it reads the core only through `CoreApi`, and the core
 * reaches it only through `ports.workspaces`.
 */
import type { CoreApi, CorePorts } from '../core/api.js'
import { sid } from '../lib/log.js'
import { sessionDisplayTitle } from '../lib/registry.js'
import { forgetScmProject, renameScmProject } from '../scm/scmProjects.js'

export function startWorkspaces(core: CoreApi, ports: CorePorts): void {
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
}
