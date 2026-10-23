import { lstat, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CoreApi } from '../core/api.js'
import { folderTrust } from '../engines/launchPrep.js'
import { launchEnvironment } from '../engines/kit/launchExecutable.js'
import { readGitProject } from '../lib/gitProject.js'
import { identifier, object } from './wire.js'

type Json = Record<string, unknown>
interface PathProof { physical: string; identity: string; git: string }
interface ClonePaths { source: string; paths: string[]; proofs: Map<string, PathProof> }
interface DiscoverySnapshot {
  roots: Map<string, Array<{ source: string; lexical: string }>>
  clones: Map<string, ClonePaths | null>
}

const identity = (info: { dev: number; ino: number }) => `${info.dev}:${info.ino}`
async function pathProof(physical: string): Promise<PathProof> {
  const folder = await lstat(physical), git = await lstat(join(physical, '.git'))
  if (!folder.isDirectory() || (!git.isDirectory() && !git.isFile())) throw new Error('Workspace changed during trust repair')
  // A worktree's .git file is its backlink. Keep its version too; ordinary edits within a directory
  // do not change that directory's identity and must not invalidate a pending settings retry.
  return { physical, identity: identity(folder), git: git.isDirectory() ? identity(git)
    : `${identity(git)}:${git.size}:${git.mtimeMs}:${git.ctimeMs}` }
}
async function stillMatches(cwd: string, proof: PathProof): Promise<boolean> {
  try {
    if (await realpath(cwd) !== proof.physical) return false
    const current = await pathProof(proof.physical)
    return current.identity === proof.identity && current.git === proof.git
  } catch { return false }
}
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Folder names are cheap to reread; a clone can arrive after a completely successful or empty pass.
 * Keep the Git/worktree results separate so steady polling never repeats that expensive discovery. */
async function cloneFolders(core: CoreApi, tabId: string): Promise<DiscoverySnapshot['roots']> {
  const roots: DiscoverySnapshot['roots'] = new Map()
  for (const [index, lexicalRoot] of swarmCloneRoots(core.dataDir, tabId).entries()) {
    try {
      const root = index === 0 ? await physicalRoot(homedir(), 'harnesses', 'swarms', tabId)
        : await physicalRoot(core.dataDir, 'swarm-projects', tabId)
      const entries = root ? (await readdir(root, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && identifier(entry.name))
        .map(entry => ({ source: join(root, entry.name), lexical: join(lexicalRoot, entry.name) }))
        .sort((a, b) => a.source.localeCompare(b.source)) : []
      roots.set(lexicalRoot, entries)
    } catch { /* A missing reading stays incomplete so discovery retries after backoff. */ }
  }
  return roots
}

async function discoverClones(core: CoreApi, row: Json, tabId: string, snapshot: DiscoverySnapshot): Promise<{ clones: ClonePaths[]; complete: boolean }> {
  const clones: ClonePaths[] = []
  let complete = snapshot.roots.size === swarmCloneRoots(core.dataDir, tabId).length
  const ids = new Set(Array.isArray(row.harnessIds) ? row.harnessIds.filter(identifier) : [])
  const agents = core.agents.all().filter(agent => ids.has(agent.agentId))
  const agentFolders = await Promise.all(agents.map(agent => agent.cwd ? realpath(agent.cwd).catch(() => null) : null))
  let worktrees: string | null
  try { worktrees = await physicalRoot(homedir(), 'harnesses', 'worktrees') }
  catch { return { clones, complete: false } }
  for (const [lexicalRoot, entries] of snapshot.roots) {
    for (const { source, lexical } of entries) {
      if (snapshot.clones.has(source)) {
        const known = snapshot.clones.get(source)
        if (known) clones.push(known)
        continue
      }
      try {
        if (await realpath(source) !== source) throw new Error('Clone path changed')
        const git = await lstat(join(source, '.git')).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        })
        // A clone owns its .git directory; a link or a worktree is not another consented clone.
        if (!git) { complete = false; continue } // A clone may still be initializing its .git directory.
        if (!git.isDirectory()) { snapshot.clones.set(source, null); continue }
        const project = await readGitProject(source, { knownRoots: [lexicalRoot] })
        if ('error' in project) throw new Error('Clone discovery unavailable')
        if (!('root' in project) || resolve(project.root) !== source || 'mainFolder' in project) {
          snapshot.clones.set(source, null); continue
        }
        // Core checks the stored source spelling. Keep an alias only with its verified physical target.
        const targets = new Map([[source, source], [lexical, source]])
        for (const branch of project.branches) {
          if (!worktrees || !branch.worktree) continue
          const tree = await realpath(branch.worktree).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
            throw error
          })
          if (!tree || !within(worktrees, tree) || tree === worktrees) continue
          // A renamed branch is still this Swarm's workspace when its local registry row says so.
          const belongs = branch.ref.startsWith('refs/heads/super-tab/') || agentFolders.some(cwd => cwd && within(tree, cwd))
          if (!belongs) continue
          const linked = await readGitProject(tree)
          if ('error' in linked) throw new Error('Worktree discovery unavailable')
          if ('mainFolder' in linked && await realpath(linked.mainFolder) === source && resolve(linked.root) === tree) {
            targets.set(tree, tree)
            targets.set(join(homedir(), 'harnesses', 'worktrees', relative(worktrees, tree)), tree)
          }
        }
        const proofs = new Map<string, PathProof>()
        for (const [cwd, physical] of targets) proofs.set(cwd, await pathProof(physical))
        const found = { source, paths: [...targets.keys()], proofs }
        snapshot.clones.set(source, found)
        clones.push(found)
      } catch { complete = false /* Only this failed clone is rediscovered on the next tick. */ }
    }
  }
  return { clones, complete }
}

/** No durable marker: a service restart or a new contribution generation retries migration. */
interface RepairSnapshot {
  discovery?: DiscoverySnapshot
  environment?: NodeJS.ProcessEnv
  recorded: Set<string>
  complete?: boolean
  slowRetry?: boolean
}

/** The host owns this cache. A steady pool does no shell/Git/config work after successful repair. */
export function createSwarmCloneTrustRepair(core: CoreApi, now: () => number = Date.now): (row: Json) => Promise<void> {
  const repairs = new Map<string, { generation: unknown; homes: string; folders: string; snapshot: RepairSnapshot; failures: number; next: number }>()
  return async row => {
    if (!identifier(row.tabId)) return
    const pool = object(row.machine)
    if (pool.scope !== 'swarm' || !swarmCloneRoot(core.dataDir, row.tabId, pool.cwd)) return
    const generation = pool.generation
    const roots = await cloneFolders(core, row.tabId)
    const folders = JSON.stringify([...roots])
    const homes = JSON.stringify([...new Set(core.agents.all().filter(agent => agent.engine === 'codex' && agent.codexHome)
      .map(agent => resolve(agent.codexHome!)))].sort())
    let repair = repairs.get(row.tabId)
    if (!repair || repair.generation !== generation) {
      repair = { generation, homes, folders, snapshot: { recorded: new Set() }, failures: 0, next: 0 }
      repairs.set(row.tabId, repair)
    } else if (repair.homes !== homes) {
      // A newly registered profile may already have a worktree. Discover it even without a new grant.
      repair.homes = homes
      repair.snapshot.discovery = undefined
      repair.snapshot.complete = false
      repair.failures = 0
      repair.next = 0
    }
    if (repair.folders !== folders) {
      repair.folders = folders
      repair.snapshot.complete = false
      repair.failures = 0
      repair.next = 0
    }
    const discovery = repair.snapshot.discovery ??= { roots, clones: new Map() }
    discovery.roots = roots
    if (repair.snapshot.complete || now() < repair.next) return
    try { await repairSwarmCloneTrust(core, row, undefined, repair.snapshot) }
    finally {
      if (!repair.snapshot.complete) {
        // Five-second start pickup must not run a broken login shell or unavailable config each pass.
        // Engines that have never run have no config yet; look again slowly without creating one.
        const delay = repair.snapshot.slowRetry ? 300_000 : Math.min(15_000 * 2 ** repair.failures, 300_000)
        repair.failures = Math.min(repair.failures + 1, 5)
        repair.next = now() + delay
      }
    }
  }
}

/** Explicit setup/project preparation gets a fresh scan; periodic migration keeps its successful paths
 * in the host's snapshot. Missing or locked settings retry without another Git scan or login shell. */
export async function repairSwarmCloneTrust(core: CoreApi, row: Json, profile?: string,
  snapshot: RepairSnapshot = { recorded: new Set() }): Promise<void> {
  const pool = object(row.machine)
  if (pool.scope !== 'swarm' || !identifier(row.tabId) || !swarmCloneRoot(core.dataDir, row.tabId, pool.cwd) || snapshot.complete) return
  snapshot.slowRetry = false
  const discovery = snapshot.discovery ??= { roots: await cloneFolders(core, row.tabId), clones: new Map() }
  const { clones, complete: discovered } = await discoverClones(core, row, row.tabId, discovery)
  if (!clones.length) { snapshot.complete = discovered; return }
  const local = core.agents.all()
  const ids = new Set(Array.isArray(row.harnessIds) ? row.harnessIds.filter(identifier) : [])
  const agents = local.filter(agent => ids.has(agent.agentId))
  // A backend-selected path is not authority to edit a local config file. Only a Codex profile a
  // locally registered Codex agent already uses can select another config.toml for this consent.
  const known = profile && isAbsolute(profile) ? local.find(agent => agent.engine === 'codex'
    && agent.codexHome && resolve(agent.codexHome) === resolve(profile)) : undefined
  let complete = discovered
  // The service has a separate shell cache from core. Use the same captured locations as native launch.
  const environment = snapshot.environment ?? await launchEnvironment()
  if (!environment) return
  snapshot.environment = environment
  // Native launch treats an unset CODEX_HOME as HOME/.codex, not the daemon's cached default.
  const codexHome = environment.CODEX_HOME || join(environment.HOME || homedir(), '.codex')
  const record = async (engine: 'claude' | 'codex', clone: ClonePaths, profile?: string) => {
    const home = engine === 'codex' ? profile || codexHome : undefined
    if (home && !isAbsolute(home)) { complete = false; return }
    const trust = folderTrust(engine, home, environment)
    for (const cwd of clone.paths) {
      const key = JSON.stringify([engine, home, cwd])
      if (snapshot.recorded.has(key)) continue
      // Failed settings retry against the original physical identity, never an alias that now escapes.
      if (!await stillMatches(clone.source, clone.proofs.get(clone.source)!) || !await stillMatches(cwd, clone.proofs.get(cwd)!)) {
        snapshot.discovery?.clones.delete(clone.source)
        complete = false; continue
      }
      try {
        const result = trust?.record(cwd)
        if (result === 'skipped') snapshot.slowRetry = true
        // Codex also returns already for an explicit refusal. Keep that answer and stop retrying it.
        if (result === 'trusted' || result === 'already') snapshot.recorded.add(key)
        else complete = false
      } catch { complete = false /* Retry only this setting; another engine and the pool still proceed. */ }
    }
  }
  for (const clone of clones) {
    const { paths } = clone
    for (const engine of ['claude', 'codex'] as const) await record(engine, clone)
    // A selected Codex profile reads its own config; it needs the source answer before core prepares
    // a new worktree. Existing agents' profiles also repair automatically, without a Configure action.
    const profiles = new Set(known?.codexHome ? [known.codexHome] : [])
    for (const agent of agents) {
      if (agent.engine !== 'codex' || !agent.codexHome || !agent.cwd) continue
      const cwd = await realpath(agent.cwd).catch(() => null)
      if (cwd && paths.some(path => within(path, cwd))) profiles.add(agent.codexHome)
    }
    for (const codexHome of profiles) {
      await record('codex', clone, codexHome)
    }
  }
  snapshot.complete = complete
}
