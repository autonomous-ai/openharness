/**
 * Workspaces: everything about the folder an agent works in (docs/design/2026-10-03-harnessd.md, "Workspaces"), and the
 * git it takes, which the core runs none of (the audit of 2026-11-12): the folder a create asks git for (a clone, a
 * worktree, the folder itself on another branch: lib/gitProjectFolder.ts), a harness's worktree read and removed at a
 * purge (lib/worktreeDeletion.ts), and a worktree branch Harness made up named after its session. Nothing here removes
 * a worktree on its own: the timer sweep that did (#4166) removed clean, week-idle ones its person had chosen to keep,
 * gitignored files and all. Starts, renames and removals in one repository take turns (lib/gitProject.ts
 * `inRepositoryTurn`), all of them in this process.
 *
 * A service on the core boundary (step 13): it reads the core only through `CoreApi`, and the core
 * reaches it only through `ports.workspaces`.
 */
import type { CoreApi, CorePorts } from '../core/api.js'
import { gitFolderAnswer } from '../lib/gitProjectFolder.js'
import { sid } from '../lib/log.js'
import { sessionDisplayTitle } from '../lib/registry.js'
import { worktreeAnswers } from '../lib/worktreeDeletion.js'
import { forgetScmProject, renameScmProject } from '../scm/scmProjects.js'
import { startWorkspaceFrames } from './workspaceFrames.js'
import { createWorkspaceInstructions } from './workspaceInstructions.js'

export function startWorkspaces(core: CoreApi, ports: CorePorts): void {
  const frames = startWorkspaceFrames(core)
  let stopped = false
  // A worktree branch Harness made up at Start takes its session's name once it has one
  // (lib/branchNaming.ts). Each agent is looked at once per daemon; the git reads are the cost.
  const branchNamed = new Set<string>()
  const nameSessionBranches = (): void => {
    if (stopped) return
    for (const session of core.agents.live()) {
      const title = sessionDisplayTitle(session)
      if (!title || !session.cwd || branchNamed.has(session.agentId)) continue
      branchNamed.add(session.agentId)
      const cwd = session.cwd
      void renameScmProject(cwd, title).then((renamed) => {
        if (!renamed || stopped) return
        // Not the branch's name: it is made of the session's title, the person's words.
        console.log(`[worktrees] agent ${sid(session.agentId)} branch named after its title`)
        forgetScmProject(cwd)
        const current = core.agents.byAgent(session.agentId)
        if (current && current.cwd === cwd && current.sessionId === session.sessionId) { frames.refresh(current); core.agents.sync(current) }
      }).catch(() => {})
    }
  }
  ports.workspaces = {
    stop: () => { stopped = true; frames.stop(); branchNamed.clear() },
    nameBranches: nameSessionBranches,
    ready: () => true,
    prepareFolder: gitFolderAnswer,
    prepareInstructions: createWorkspaceInstructions(core.dataDir, () => stopped),
    ...worktreeAnswers(),
  }
}
