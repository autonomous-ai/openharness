/**
 * A crew member's folder on its host (task #3398). The server says when a member sleeps, moves or has its folder dropped
 * (backend superTabs/crewKeep.ts, on the agent record of its row); this keeps the folder in step:
 * - a dropped folder goes through the Swarm's own worktree removal (machines.ts removeStoppedWorktree), which refuses one
 *   with work not committed or pushed, and is remembered so a wake brings it back at the same path, where the engine's
 *   conversation is filed (claude --resume and codex resume find it by folder);
 * - finished branch copies go: a local branch whose work merged into the default branch, or whose remote branch was
 *   deleted (a merged or closed pull request). Never the current branch or one never pushed; a deleted branch's tip is
 *   kept under refs/harness/dropped/ so no commit becomes unreachable. Branches are the clone's, shared by its worktrees, so
 *   another agent's finished branch that no worktree has checked out goes too, recoverably (security review of #3229).
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim()

/** What a crew row asks of its host, from its agent record: close it to sleep (folder kept), close it and drop its folder, or
 *  close it because it moves elsewhere. Null for an awake member. */
export function crewRest(agent: { asleep?: { since?: unknown; folderDropped?: unknown } | null; movedTo?: unknown }): 'sleep' | 'drop' | 'moving' | null {
  if (agent.movedTo) return 'moving'
  if (agent.asleep) return agent.asleep.folderDropped === true ? 'drop' : 'sleep'
  return null
}

type Remembered = { tabId: string; harnessId: string; path: string; source: string }
export interface CrewFoldersDeps {
  dataDir: string
  machineId: string
  /** The Swarm's record of this member's worktree (machines.ts swarm-worktrees file): its folder and its project clone. */
  worktree(tabId: string, harnessId: string): { path: string; source: string } | null
  /** The Swarm's own removal, with its proofs and refusals (machines.ts removeStoppedWorktree). */
  removeWorktree(tabId: string, harnessId: string): Promise<void>
  log(line: string): void
}

export class CrewFolders {
  /** This host's record, read once and kept in step with its writes: only this host writes the file. */
  private cache?: Remembered[]
  constructor(private readonly deps: CrewFoldersDeps) {}
  /** Whether [harnessId]'s folder was dropped and waits to come back: read from disk, so a host restart forgets nothing. */
  remembers(tabId: string, harnessId: string): boolean {
    return this.read().some(r => r.tabId === tabId && r.harnessId === harnessId)
  }
  private get file() { return join(this.deps.dataDir, 'super-tabs', `crew-folders-${this.deps.machineId}.json`) }
  private read(): Remembered[] {
    return this.cache ??= this.readFile()
  }
  private readFile(): Remembered[] {
    try {
      const rows = (JSON.parse(readFileSync(this.file, 'utf8')) as { folders?: unknown }).folders
      return Array.isArray(rows) ? rows.filter((r): r is Remembered => !!r && typeof r === 'object' && ['tabId', 'harnessId', 'path', 'source']
        .every(k => typeof (r as Record<string, unknown>)[k] === 'string') && isAbsolute((r as Remembered).path) && isAbsolute((r as Remembered).source)) : []
    } catch { return [] }
  }
  private write(rows: Remembered[]) {
    this.cache = rows
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    writeFileSync(`${this.file}.next`, JSON.stringify({ version: 1, folders: rows }), { mode: 0o600 })
    renameSync(`${this.file}.next`, this.file)
  }
  private forget(tabId: string, harnessId: string) {
    const rows = this.read(), kept = rows.filter(r => !(r.tabId === tabId && r.harnessId === harnessId))
    if (kept.length !== rows.length) this.write(kept)
  }

  /** Drops [harnessId]'s folder ('dropped'), or keeps it when the removal refused it ('kept'), or finds no record ('none'). */
  async drop(tabId: string, harnessId: string): Promise<'dropped' | 'kept' | 'none'> {
    const worktree = this.deps.worktree(tabId, harnessId)
    if (!worktree) return 'none'
    this.write([...this.read().filter(r => !(r.tabId === tabId && r.harnessId === harnessId)), { tabId, harnessId, ...worktree }])
    await this.deps.removeWorktree(tabId, harnessId)
    if (!existsSync(worktree.path)) return 'dropped'
    this.forget(tabId, harnessId)
    this.deps.log('Kept an asleep crew folder: the Swarm\'s removal refused it')
    return 'kept'
  }

  /** Brings back a dropped folder at its own path, on the default branch, before its session reopens there. */
  async restore(tabId: string, harnessId: string): Promise<'restored' | 'none' | 'failed'> {
    const remembered = this.read().find(r => r.tabId === tabId && r.harnessId === harnessId)
    if (!remembered) return 'none'
    if (existsSync(remembered.path)) { this.forget(tabId, harnessId); return 'none' }
    try {
      await git(remembered.source, 'worktree', 'prune')
      const base = await git(remembered.source, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').catch(() => 'HEAD')
      await git(remembered.source, 'worktree', 'add', '--detach', remembered.path, base)
      this.forget(tabId, harnessId)
      return 'restored'
    } catch (error) {
      this.deps.log(`Could not bring back a crew folder: ${error instanceof Error ? error.name : typeof error}`)
      return 'failed'
    }
  }
}

/** Deletes [folder]'s finished branch copies and returns their names (see the file's comment for which). */
export async function pruneBranches(folder: string): Promise<string[]> {
  const checkedOut = new Set((await git(folder, 'worktree', 'list', '--porcelain')).split('\n')
    .filter(l => l.startsWith('branch refs/heads/')).map(l => l.slice('branch refs/heads/'.length)))
  const base = await git(folder, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').catch(() => '')
  const rows = (await git(folder, 'for-each-ref', 'refs/heads', '--format=%(refname:short)%09%(upstream)%09%(upstream:track)%09%(objectname)'))
    .split('\n').filter(Boolean).map(line => { const [name, upstream, track, sha] = line.split('\t'); return { name: name!, upstream: upstream ?? '', track: track ?? '', sha: sha ?? '' } })
  const dropped: string[] = []
  for (const branch of rows) {
    // A branch tracking the default branch itself (a start's own branch) is no pull request's copy.
    if (checkedOut.has(branch.name) || !branch.upstream || (base && branch.upstream === `refs/remotes/${base}`)) continue
    const gone = branch.track === '[gone]'
    const merged = !gone && !!base && await git(folder, 'merge-base', '--is-ancestor', branch.name, base).then(() => true, () => false)
    if (!gone && !merged) continue
    // Its tip stays reachable, so a commit that was only here (a squash-merged branch, a closed one) is never lost.
    if (gone) await git(folder, 'update-ref', `refs/harness/dropped/${branch.name}`, branch.sha)
    await git(folder, 'branch', '-D', branch.name)
    dropped.push(branch.name)
  }
  return dropped
}
