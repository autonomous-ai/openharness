import { stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { sep } from 'node:path'
import { agentProject, type AgentProject } from './agentProject.js'
import type { SessionWork, WorkPullRequest } from './sessionWork.js'
import type { GitHistory } from './sessionGitHistory.js'

export type SessionGitContext = {
  state: 'workspace' | 'observed' | 'multiple' | 'uncertain' | 'unavailable'
  current: AgentProject | null
  /** Git snapshots of session-associated checkouts. Paths are internal identity, not UI labels. */
  checkouts?: AgentProject[]
  /** Branch in the most recently confirmed Git location, not a claim of live execution. */
  recentWork?: { project: AgentProject; at: string }
  observedAt: string | null
  /** The location is confirmed historical work; newer tool activity could not yet be resolved. */
  activityUncertain?: boolean
  /** Paths describe observed work, never worktree ownership or deletion eligibility. */
  locations: Array<{ cwd: string; at: string }>
  pullRequests: WorkPullRequest[]
  truncated: boolean
  history?: GitHistory
  /** Changes only with the display snapshot; clients reject older list/push responses. */
  version?: { epoch: string; revision: number }
}

/** Overlapping projections all finish with the newest requested observation. Versions survive
 * cache eviction within a daemon, and do not advance during unchanged roster polling. */
export class SessionGitContextReader {
  private epoch = randomUUID()
  private revision = 0
  private entries = new Map<string, { pending: Promise<SessionGitContext>; users: number; json?: string; value?: SessionGitContext }>()
  async read(key: string, resolve: () => Promise<SessionGitContext>): Promise<SessionGitContext> {
    const pending = resolve()
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { pending, users: 0 }
      this.entries.set(key, entry)
    }
    entry.pending = pending
    entry.users++
    try {
      let selected: Promise<SessionGitContext>, value: SessionGitContext
      do { selected = entry.pending; value = await selected } while (selected !== entry.pending)
      const json = JSON.stringify(value)
      if (entry.json !== json) {
        entry.json = json
        entry.value = { ...value, version: { epoch: this.epoch, revision: ++this.revision } }
      }
      return entry.value!
    } finally {
      entry.users--
      // Never evict an entry while an older projection still references it.
      for (const [oldKey, old] of this.entries) {
        if (this.entries.size <= 512) break
        if (!old.users) this.entries.delete(oldKey)
      }
    }
  }
}
type Inspect = (cwd: string) => Promise<AgentProject | null>
async function inspect(cwd: string): Promise<AgentProject | null> {
  if (!(await stat(cwd).catch(() => null))?.isDirectory()) return null
  return agentProject(cwd)
}

/** Display-only projection. Registry cwd and the legacy project keep their launch semantics. */
export async function sessionGitContext(home: AgentProject | null, work?: SessionWork | null,
  read: Inspect = inspect, history?: GitHistory): Promise<SessionGitContext> {
  const context: SessionGitContext = {
    state: 'workspace', current: home, observedAt: null,
    locations: work?.locations ?? [], pullRequests: work?.pullRequests ?? [], truncated: work?.truncated ?? false,
    checkouts: [],
  }
  const roots = new Map<string, AgentProject>()
  const resolved = new Map<string, AgentProject | null>()
  const add = (project: AgentProject | null) => {
    if (project?.root && !roots.has(project.root)) roots.set(project.root, { ...project, cwd: project.root })
  }
  // The assigned checkout is authoritative for every engine, including engines without a
  // transcript reader. Tool receipts only add associations; they never invalidate Git facts.
  add(home)
  const paths = [...new Set([
    ...(work?.current.map(row => row.cwd) ?? []),
    ...(history?.branches.map(row => row.cwd) ?? []),
    ...(work?.locations.map(row => row.cwd) ?? []),
  ])]
  let reads = 0
  for (const cwd of paths) {
    if (roots.has(cwd)) { resolved.set(cwd, roots.get(cwd)!); continue }
    // A subdirectory can itself be a nested repository/worktree. Resolve it through Git,
    // never assume path containment proves checkout identity. Bound additional lookups.
    if (reads++ === 8) { context.truncated = true; break }
    const project = await read(cwd).catch(() => null)
    resolved.set(cwd, project)
    add(project)
  }
  // A later command outside Git does not erase the last useful coding context.
  // Same-time locations are one operation: never select one member of parallel work,
  // or a partially inspected group, as the session's unique recent branch.
  const activity = [...(work?.current ?? []), ...(work?.locations ?? [])]
  const times = [...new Set(activity.map(row => row.at))].sort((a, b) => Date.parse(b) - Date.parse(a))
  for (const at of times) {
    const locations = activity.filter(row => row.at === at)
    const projects = locations.map(row => resolved.get(row.cwd))
    const git = new Map<string, AgentProject>()
    for (const project of projects) {
      const fresh = project?.root ? roots.get(project.root) : null
      if (fresh?.branch && !fresh.branchPending && !fresh.branch.startsWith('Detached ')) {
        git.set(JSON.stringify([fresh.remote ?? fresh.root, fresh.branch]), fresh)
      }
    }
    if (!git.size) continue
    if (git.size === 1 && projects.every(project => project != null && !project.branchPending
      && (!project.root || project.branch && !project.branch.startsWith('Detached ')))) {
      context.recentWork = { project: [...git.values()][0], at }
    }
    break
  }
  // Different files in one checkout are one useful workspace in the details view. Only collapse
  // paths under roots Git actually resolved; similarly named sibling worktrees remain distinct.
  const knownRoots = [...new Set([...roots.values()].flatMap(p => p.root ? [p.root] : []))].sort((a, b) => b.length - a.length)
  const locations = new Map<string, { cwd: string; at: string }>()
  for (const row of context.locations) {
    const cwd = knownRoots.find(root => row.cwd === root || row.cwd.startsWith(root.endsWith(sep) ? root : root + sep)) ?? row.cwd
    const previous = locations.get(cwd)
    if (!previous || previous.at < row.at) locations.set(cwd, { ...row, cwd })
  }
  context.locations = [...locations.values()].sort((a, b) => b.at.localeCompare(a.at))
  context.checkouts = [...roots.values()]
  // Same repository + branch is one user-facing branch, even if it has several local copies.
  const branches = new Map<string, AgentProject>()
  for (const project of context.checkouts) if (!project.branchPending) {
    const key = JSON.stringify([project.remote ?? project.root, project.branch])
    if (!branches.has(key)) branches.set(key, project)
  }
  if (branches.size > 1) return { ...context, state: 'multiple', current: null }
  if (branches.size === 1) {
    context.current = [...branches.values()][0]
    context.state = context.current.root === home?.root ? 'workspace' : 'observed'
    return context
  }
  // A non-Git folder has no branch. Missing activity is never reported as a lost workspace.
  return { ...context, current: home, state: home ? 'workspace' : 'unavailable' }
}
