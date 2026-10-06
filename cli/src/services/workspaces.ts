/**
 * Workspaces: everything about the folder an agent works in (docs/design/2026-10-03-harnessd.md,
 * "Workspaces"). Here so far: a worktree branch Harness made up takes its session's name, and the
 * worktrees Harness made that nothing uses are swept.
 *
 * A service on the core boundary (step 13): it reads the core only through `CoreApi`, and the core
 * reaches it only through `ports.workspaces`.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CoreApi, CorePorts } from '../core/api.js'
import { forgetAgentProject } from '../lib/agentProject.js'
import { nameBranchAfterSession } from '../lib/branchNaming.js'
import { sid } from '../lib/log.js'
import { sessionDisplayTitle } from '../lib/registry.js'
import { sweepWorktrees } from '../lib/worktreeSweep.js'

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
      void nameBranchAfterSession(cwd, title).then((renamed) => {
        if (!renamed) return
        console.log(`[worktrees] agent ${sid(session.agentId)} branch named ${renamed}`)
        forgetAgentProject(cwd)
        const current = core.agents.byAgent(session.agentId)
        if (current) core.agents.sync(current)
      }).catch(() => {})
    }
  }
  // Worktrees Harness made that no live or stopped harness uses and nothing would miss
  // (lib/worktreeSweep.ts). The core decides when: a few minutes after start, once restored agents
  // are back in the registry, then twice a day.
  //
  // One sweep at a time: a sweep still going is never joined by a second over the same folders. In the
  // core's process its timers are hours apart; in this service's own process, a core that restarted
  // asks again on its own timer while a long sweep from the last core may still be running.
  let sweeping = false
  const sweepUnusedWorktrees = () => {
    if (sweeping) return
    let inUse: Array<string | null>
    try { inUse = core.agents.all().map(s => s.cwd) } catch { return }
    sweeping = true
    void sweepWorktrees({ root: join(homedir(), 'harnesses'), inUse })
      .then(removed => { if (removed.length) console.log(`[worktrees] removed ${removed.length} unused worktree(s)`) })
      .catch(() => {})
      .finally(() => { sweeping = false })
  }
  ports.workspaces = { nameBranches: nameSessionBranches, sweepUnused: sweepUnusedWorktrees }
}
