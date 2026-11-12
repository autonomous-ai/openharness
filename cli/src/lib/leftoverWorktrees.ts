/**
 * Leftover worktrees: the checkouts in Harness's worktrees folder (`<root>/worktrees`) that no live or stopped harness
 * works in, listed for the person to choose from, and the chosen ones moved to the Trash (lib/trash.ts). Nothing here runs
 * unless the person asks, and nothing is deleted: a worktree kept when its harness was deleted stays until it is chosen
 * here (#711). The branch stays too; `git worktree prune` only drops the repository's record of a folder that is gone.
 */
import { lstat, readdir, rmdir, stat } from 'node:fs/promises'
import { basename, dirname, join, normalize, resolve, sep } from 'node:path'
import { inRepositoryTurn } from './gitProject.js'
import { TrashError, type Trash } from './trash.js'
import { git } from './worktreeSweep.js'

export interface LeftoverWorktree {
  path: string
  /** The repository it was checked out from (its main checkout's folder); null when git cannot say. */
  repository: string | null
  /** Its branch; null on a detached HEAD, or when git cannot say. */
  branch: string | null
  /** Its size on disk, as far as the walk went ([sizeComplete]). */
  sizeBytes: number
  /** False when the walk stopped at its bound: the folder is at least [sizeBytes]. */
  sizeComplete: boolean
  /** The newest change the walk saw: a file, a folder, a commit, a checkout or an index write (epoch ms). */
  lastChangeMs: number
  /** Whether anything in it is uncommitted or untracked (Harness's own `.harness/` aside); null when git cannot say. */
  uncommitted: boolean | null
}

export type CleanResult =
  | { path: string; state: 'trashed'; pruned: boolean }
  | { path: string; state: 'in_use' | 'not_found' }
  | { path: string; state: 'failed'; reason: TrashError['code'] }

/** The most worktrees one list reads; past it the list says there are more. */
export const LIST_MAX = 200
/** The most entries one worktree's walk reads. node_modules alone can hold more. */
export const WALK_ENTRIES_MAX = 200_000
/** How long all the walks of one list may take together: the rest report what they read by then. */
export const WALK_MS = 60_000
/** How many worktrees are read at once. */
const AT_ONCE = 4

async function isLinkedCheckout(path: string): Promise<boolean> {
  try {
    const [folder, marker] = await Promise.all([lstat(path), lstat(join(path, '.git'))])
    return folder.isDirectory() && marker.isFile()
  } catch { return false }
}

/** The checkouts in Harness's worktrees folder: `<repo>/<name>`, and the flat `<name>` older builds made. A link is none. */
async function candidates(home: string): Promise<string[]> {
  let entries: string[]
  try { entries = await readdir(home) } catch { return [] }
  const found: string[] = []
  for (const entry of entries.filter((name) => !name.startsWith('.'))) {
    const path = join(home, entry)
    if (await isLinkedCheckout(path)) { found.push(path); continue }
    let children: string[] = []
    try { if ((await lstat(path)).isDirectory()) children = await readdir(path) } catch { continue }
    for (const child of children.filter((name) => !name.startsWith('.'))) {
      if (await isLinkedCheckout(join(path, child))) found.push(join(path, child))
    }
  }
  return found
}

const isUsed = (path: string, used: string[]): boolean => used.some((cwd) => cwd === path || cwd.startsWith(path + sep))
const inUseFolders = (inUse: Iterable<string | null | undefined>): string[] =>
  [...inUse].filter((cwd): cwd is string => typeof cwd === 'string' && cwd.length > 0).map((cwd) => normalize(cwd))

/** The worktrees under `<root>/worktrees` that nothing in [inUse] works in, oldest change first. */
export async function listLeftoverWorktrees(input: {
  root: string
  inUse: Iterable<string | null | undefined>
  now?: () => number
  listMax?: number
  entriesMax?: number
}): Promise<{ worktrees: LeftoverWorktree[]; more: boolean }> {
  const used = inUseFolders(input.inUse)
  const unused = (await candidates(join(input.root, 'worktrees'))).filter((path) => !isUsed(path, used)).sort()
  const now = input.now ?? Date.now
  const deadline = now() + WALK_MS
  const entriesMax = input.entriesMax ?? WALK_ENTRIES_MAX
  const chosen = unused.slice(0, input.listMax ?? LIST_MAX)
  const worktrees: LeftoverWorktree[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < chosen.length) worktrees.push(await describe(chosen[next++], entriesMax, () => now() < deadline))
  }
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, chosen.length) }, worker))
  worktrees.sort((a, b) => a.lastChangeMs - b.lastChangeMs || a.path.localeCompare(b.path))
  return { worktrees, more: unused.length > chosen.length }
}

async function describe(path: string, entriesMax: number, inTime: () => boolean): Promise<LeftoverWorktree> {
  const [size, facts] = await Promise.all([walk(path, entriesMax, inTime), gitFacts(path)])
  return { path, ...facts.worktree, ...size, lastChangeMs: Math.round(Math.max(size.lastChangeMs, facts.lastChangeMs)) }
}

/** The folder's size on disk and newest change, never following a link, within its bounds. */
async function walk(root: string, entriesMax: number, inTime: () => boolean): Promise<{ sizeBytes: number; sizeComplete: boolean; lastChangeMs: number }> {
  let sizeBytes = 0, lastChangeMs = 0, entries = 0
  const pending = [root]
  while (pending.length > 0) {
    if (entries >= entriesMax || !inTime()) return { sizeBytes, sizeComplete: false, lastChangeMs }
    const path = pending.pop()!
    entries++
    let info
    try { info = await lstat(path) } catch { continue }
    // Blocks are what the disk holds (a sparse file, a small one); Windows reports none, and its size stands for them.
    sizeBytes += info.blocks > 0 ? info.blocks * 512 : info.size
    lastChangeMs = Math.max(lastChangeMs, info.mtimeMs)
    if (!info.isDirectory()) continue
    try { for (const name of await readdir(path)) pending.push(join(path, name)) } catch { /* unreadable: its size is what was read */ }
  }
  return { sizeBytes, sizeComplete: true, lastChangeMs }
}

/** What git says of the worktree: its repository, branch and uncommitted work, and when it last committed or checked out. */
async function gitFacts(path: string): Promise<{ worktree: Pick<LeftoverWorktree, 'repository' | 'branch' | 'uncommitted'>; lastChangeMs: number }> {
  const read = (args: string[]) => git(path, args).catch(() => null)
  const [common, gitDir, branch, status] = await Promise.all([
    read(['rev-parse', '--git-common-dir']), read(['rev-parse', '--git-dir']),
    read(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    // Harness's own runtime folder is never the person's work (lib/harnessRuntimeIgnore.ts).
    read(['status', '--porcelain', '--', '.', ':(exclude).harness']),
  ])
  const touched = gitDir === null ? [] : await Promise.all(['HEAD', 'index', join('logs', 'HEAD')]
    .map((file) => stat(join(resolve(path, gitDir), file)).then((info) => info.mtimeMs, () => 0)))
  return {
    worktree: { repository: common === null ? null : repositoryOf(resolve(path, common)), branch: branch || null, uncommitted: status === null ? null : status !== '' },
    lastChangeMs: Math.max(0, ...touched),
  }
}

/** A worktree's repository: the main checkout holding `.git`, or a bare repository itself. */
const repositoryOf = (common: string): string => basename(common) === '.git' ? dirname(common) : common

/**
 * Moves each chosen worktree to the Trash, one at a time, after checking again that it is still one of the worktrees under
 * `<root>/worktrees` (the list may be minutes old) and that nothing in [inUse] works in it. Then `git worktree prune` in its
 * repository, in the repository's turn (a start's `git worktree add` reads the same records), and its repository's folder
 * here goes once it is empty. Says per path what happened.
 */
export async function cleanWorktrees(input: {
  root: string
  inUse: Iterable<string | null | undefined>
  paths: readonly string[]
  trash: Trash
}): Promise<CleanResult[]> {
  const home = join(input.root, 'worktrees')
  const used = inUseFolders(input.inUse)
  const present = new Set(await candidates(home))
  const results: CleanResult[] = []
  for (const path of new Set(input.paths)) {
    if (!present.has(path)) { results.push({ path, state: 'not_found' }); continue }
    if (isUsed(path, used)) { results.push({ path, state: 'in_use' }); continue }
    const common = await git(path, ['rev-parse', '--git-common-dir']).then((dir) => resolve(path, dir), () => null)
    try { await input.trash(path) } catch (error) {
      results.push({ path, state: 'failed', reason: error instanceof TrashError ? error.code : 'TRASH_FAILED' })
      continue
    }
    const repository = common === null ? null : repositoryOf(common)
    const pruned = repository !== null
      && await inRepositoryTurn(repository, () => git(repository, ['worktree', 'prune'])).then(() => true, () => false)
    if (dirname(path) !== home) await rmdir(dirname(path)).catch(() => {})
    results.push({ path, state: 'trashed', pruned })
  }
  return results
}
