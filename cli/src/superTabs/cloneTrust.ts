import { lstat, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CoreApi } from '../core/api.js'
import { folderTrust } from '../engines/launchPrep.js'
import { launchEnvironment } from '../engines/kit/launchExecutable.js'
import { readGitProject } from '../lib/gitProject.js'
import { identifier, object } from './wire.js'

type Json = Record<string, unknown>
const within = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** New contributions are visible beside worktrees; existing Git common directories must never move. */
export const swarmCloneRoots = (dataDir: string, tabId: string): string[] => [
  join(homedir(), 'harnesses', 'swarms', tabId), join(dataDir, 'swarm-projects', tabId),
]

export function swarmCloneRoot(dataDir: string, tabId: string, cwd: unknown): string | undefined {
  return typeof cwd === 'string' && isAbsolute(cwd)
    ? swarmCloneRoots(dataDir, tabId).find(root => resolve(root) === resolve(cwd)) : undefined
}

/** Add machine consents to these clones, not arbitrary paths in backend metadata. Resolve from an
 * existing trusted base so a symlink at the tab, project or worktree cannot extend that consent. */
async function physicalRoot(base: string, ...parts: string[]): Promise<string | null> {
  try {
    const expected = join(await realpath(base), ...parts)
    return await realpath(join(base, ...parts)) === expected ? expected : null
  } catch { return null }
}

/** Also runs without pending starts: updating Harness repairs an earlier contribution by itself.
 * No completion marker is persisted, so a missing/locked engine config can be retried next tick. */
export async function repairSwarmCloneTrust(core: CoreApi, row: Json, profile?: string): Promise<void> {
  const pool = object(row.machine)
  if (pool.scope !== 'swarm' || !identifier(row.tabId) || !swarmCloneRoot(core.dataDir, row.tabId, pool.cwd)) return
  const roots = await Promise.all([
    physicalRoot(homedir(), 'harnesses', 'swarms', row.tabId), physicalRoot(core.dataDir, 'swarm-projects', row.tabId),
  ])
  const clones: Array<{ source: string; paths: string[] }> = []
  const ids = new Set(Array.isArray(row.harnessIds) ? row.harnessIds.filter(identifier) : [])
  const agents = core.agents.all().filter(agent => ids.has(agent.agentId))
  const agentFolders = await Promise.all(agents.map(agent => agent.cwd ? realpath(agent.cwd).catch(() => null) : null))
  const worktrees = await physicalRoot(homedir(), 'harnesses', 'worktrees')
  for (const [index, root] of roots.entries()) {
    if (!root) continue
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !identifier(entry.name)) continue
      const source = join(root, entry.name)
      // A clone has its own .git directory. Linked folders and a .git symlink are not clones.
      if (!(await lstat(join(source, '.git')).catch(() => null))?.isDirectory()) continue
      const project = await readGitProject(source, { knownRoots: [root] })
      if (!('root' in project) || resolve(project.root) !== source || 'mainFolder' in project) continue
      // Core tests the stored gitSource spelling before preparing a new worktree. An aliased
      // dataDir needs that answer too, but only after proving both names identify this clone.
      const paths = [...new Set([source, join(swarmCloneRoots(core.dataDir, row.tabId)[index]!, entry.name)])]
      for (const branch of project.branches) {
        if (!worktrees || !branch.worktree) continue
        const tree = await realpath(branch.worktree).catch(() => null)
        if (!tree || !within(worktrees, tree) || tree === worktrees) continue
        // Session titles can rename the initial super-tab branch. The contributed agent's registry
        // row still proves which workspace belongs to this Swarm after that rename.
        const belongs = branch.ref.startsWith('refs/heads/super-tab/') || agentFolders.some(cwd => cwd && within(tree, cwd))
        if (!belongs) continue
        // Git's registered branch AND the worktree's own backlink must identify this clone.
        const linked = await readGitProject(tree)
        if ('mainFolder' in linked && await realpath(linked.mainFolder).catch(() => null) === source && resolve(linked.root) === tree) {
          paths.push(...new Set([tree, join(homedir(), 'harnesses', 'worktrees', relative(worktrees, tree))]))
        }
      }
      clones.push({ source, paths })
    }
  }
  if (!clones.length) return
  // The service has a separate shell cache from core. Use the same captured locations as native launch.
  const environment = await launchEnvironment()
  if (!environment) return
  // Native launch treats an unset CODEX_HOME as HOME/.codex, not the daemon's cached default.
  const codexHome = environment.CODEX_HOME || join(environment.HOME || homedir(), '.codex')
  const record = (engine: 'claude' | 'codex', paths: string[], profile?: string) => {
    const home = engine === 'codex' ? profile || codexHome : undefined
    if (home && !isAbsolute(home)) return
    const trust = folderTrust(engine, home, environment)
    for (const cwd of paths) {
      try { trust?.record(cwd) }
      catch { /* A locked config is retried next tick; it cannot starve another engine or the pool. */ }
    }
  }
  for (const { source, paths } of clones) {
    for (const engine of ['claude', 'codex'] as const) record(engine, paths)
    // A selected Codex profile reads its own config; it needs the source answer before core prepares
    // a new worktree. Existing agents' profiles also repair automatically, without a Configure action.
    const profiles = new Set(profile && isAbsolute(profile) ? [profile] : [])
    for (const agent of agents) {
      if (!agent.codexHome || !agent.cwd) continue
      const cwd = await realpath(agent.cwd).catch(() => null)
      if (cwd && paths.some(path => within(path, cwd))) profiles.add(agent.codexHome)
    }
    for (const codexHome of profiles) {
      record('codex', [source, ...paths.slice(1)], codexHome)
    }
  }
}
