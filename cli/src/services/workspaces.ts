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
import { WORKTREE_IDLE_MS } from '../lib/worktreeSweep.js'
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
  // that stays where no harness works, what an install or a build makes again
  // (lib/worktreeSweep.ts). The core decides when: a few minutes after start, once restored agents
  // are back in the registry, then twice a day.
  //
  // One sweep at a time: a sweep still going is never joined by a second over the same folders. In the
  // core's process its timers are hours apart; in this service's own process, a core that restarted
  // asks again on its own timer while a long sweep from the last core may still be running.
  let sweeping = false
  const sweepUnusedWorktrees = () => {
    if (sweeping) return
    let inUse: Array<string | null>, working: Array<string | null>
    try {
      const now = Date.now(), all = core.agents.all()
      inUse = all.map(s => s.cwd)
      // A harness works where it runs, and where it stopped within the week (review of package 6, 11-12): what it did
      // since its last commit is in the folder alone, and it may be resumed there. A stopped record is written when it
      // stops; one with no time counts as recent.
      working = [...core.agents.live(), ...all.filter(s => !(now - s.touchedAt >= WORKTREE_IDLE_MS))].map(s => s.cwd)
    } catch { return }
    sweeping = true
    // Asked again as the sweep goes: it can take minutes, and a harness may start meanwhile. In the workspaces' own process
    // the live agents are those the core sent with its last terminal-title pass, every few seconds.
    const busy = () => [...working, ...core.agents.live().map(s => s.cwd)]
    void sweepScmProjects({ root: join(homedir(), 'harnesses'), inUse, busy })
      .then(({ removed, freed, failed, left }) => {
        // Counts and fixed codes only: a path names a person's folder.
        if (removed.length) console.log(`[worktrees] removed ${removed.length} unused worktree(s)`)
        if (freed.length) console.log(`[worktrees] freed ${freed.length} build folder(s) in idle worktrees`)
        if (failed.length) console.warn(`[worktrees] left as they were: ${byCode(failed)}`)
        if (left) console.log(`[worktrees] stopped at its limit: ${left} worktree(s) wait for the next sweep`)
      })
      .catch(() => { console.warn('[worktrees] SWEEP_FAILED') })
      .finally(() => { sweeping = false })
  }
  ports.workspaces = { nameBranches: nameSessionBranches, sweepUnused: sweepUnusedWorktrees }
}

/** Each code once, with how many times it came: `BUILD_OUTPUT_STUCK:EBUSY 2, WORKTREE_NOT_REMOVED 1`. */
function byCode(codes: string[]): string {
  const counts = new Map<string, number>()
  for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1)
  return [...counts].map(([code, count]) => `${code} ${count}`).join(', ')
}
