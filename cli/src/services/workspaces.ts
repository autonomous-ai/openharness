/**
 * Workspaces: everything about the folder an agent works in (docs/design/2026-10-03-harnessd.md,
 * "Workspaces"). Here so far: a worktree branch Harness made up takes its session's name, the
 * worktrees Harness made that nothing uses are swept, and build output is freed in the idle ones that stay.
 *
 * A service on the core boundary (step 13): it reads the core only through `CoreApi`, and the core
 * reaches it only through `ports.workspaces`.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CoreApi, CorePorts } from '../core/api.js'
import { sid } from '../lib/log.js'
import { sessionDisplayTitle } from '../lib/registry.js'
import { forgetScmProject, renameScmProject, sweepScmProjects } from '../scm/scmProjects.js'

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
  // Worktrees Harness made that no live or stopped harness uses and nothing would miss; and, in an idle one
  // that stays with no live harness in it, what an install or a build makes again
  // (lib/worktreeSweep.ts). The core decides when: a few minutes after start, once restored agents
  // are back in the registry, then twice a day.
  //
  // One sweep at a time: a sweep still going is never joined by a second over the same folders. In the
  // core's process its timers are hours apart; in this service's own process, a core that restarted
  // asks again on its own timer while a long sweep from the last core may still be running.
  let sweeping = false
  const sweepUnusedWorktrees = () => {
    if (sweeping) return
    let inUse: Array<string | null>, live: Array<string | null>
    try {
      inUse = core.agents.all().map(s => s.cwd)
      live = core.agents.live().map(s => s.cwd)
    } catch { return }
    sweeping = true
    void sweepScmProjects({ root: join(homedir(), 'harnesses'), inUse, live })
      .then(({ removed, freed, stuck }) => {
        // Counts only: a path names a person's folder.
        if (removed.length) console.log(`[worktrees] removed ${removed.length} unused worktree(s)`)
        if (freed.length) console.log(`[worktrees] freed ${freed.length} build folder(s) in idle worktrees`)
        if (stuck.length) console.warn(`[worktrees] BUILD_OUTPUT_STUCK: ${stuck.length} build folder(s) could not be removed whole`)
      })
      .catch(() => {})
      .finally(() => { sweeping = false })
  }
  ports.workspaces = { nameBranches: nameSessionBranches, sweepUnused: sweepUnusedWorktrees }
}
