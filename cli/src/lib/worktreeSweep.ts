import { execFile } from 'node:child_process'
import { constants, type Dirent } from 'node:fs'
import { access, lstat, mkdir, readdir, readFile, realpath, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, normalize, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { gitEnv, inRepositoryTurn } from './gitProject.js'
import { upgradeOlderRuntimeIgnore } from './harnessRuntimeIgnore.js'

const exec = promisify(execFile)

/** A week without a commit, a checkout or an index write. */
export const WORKTREE_IDLE_MS = 7 * 24 * 3600_000

/**
 * git as itself: none of the repository settings a parent process left in the environment, and none of the repository's own
 * that would run a program or hide work from the checks here (review of package 6, 11-12). `core.fsmonitor` names a program
 * git runs on a status, which the daemon's other git never lets it (lib/gitProject.ts); a hook runs when a branch goes; and
 * with `status.showUntrackedFiles=no` a worktree holding new files read as clean, to `git status` and to `git worktree
 * remove`, which asks git the same and so removed them too. A `-c` reaches the git that git itself starts.
 */
export async function git(cwd: string, args: string[]): Promise<string> {
  const guarded = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'status.showUntrackedFiles=normal']
  return (await exec('git', [...guarded, '-C', cwd, ...args], { timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env: gitEnv(process.env) }))
    .stdout.replace(/\r?\n$/, '')
}

async function isLinkedCheckout(path: string): Promise<boolean> {
  try {
    const [folder, marker] = await Promise.all([lstat(path), lstat(join(path, '.git'))])
    return folder.isDirectory() && marker.isFile()
  } catch { return false }
}

/** Checkouts in Harness's worktrees folder: `<repo>/<name>`, and the flat `<name>` older builds made. */
async function candidates(home: string): Promise<string[]> {
  let entries: string[]
  try { entries = await readdir(home) } catch { return [] }
  const found: string[] = []
  for (const entry of entries.filter(name => !name.startsWith('.'))) {
    const path = join(home, entry)
    if (await isLinkedCheckout(path)) { found.push(path); continue }
    let children: string[] = []
    try { if ((await lstat(path)).isDirectory()) children = await readdir(path) } catch { continue }
    for (const child of children.filter(name => !name.startsWith('.'))) {
      if (await isLinkedCheckout(join(path, child))) found.push(join(path, child))
    }
  }
  return found
}

/** What a sweep did. [removed]: the worktrees that went whole. In the worktrees that stay, [freed]: the build folders that
 *  went. [failed]: a fixed code for each worktree or folder it could not read or finish, never a path (an error's own text
 *  can carry one). [left]: the worktrees it did not come to once it stopped at its limit; the next sweep does them. */
export interface Swept { removed: string[]; freed: string[]; failed: string[]; left: number }

/** What one sweep does at most: free build output in [freed] worktrees, and begin no worktree after [ms], though always one;
 *  the rest wait for the next sweep, twelve hours on (review of package 6, 11-12: one sweep had no bound). Measured on a
 *  loaded Mac, 11-12: a folder goes at about 1,500 files a second, and reading an idle worktree takes about 40 ms. One Mac
 *  had build output in 12 worktrees on 11-11. */
const SWEEP_LIMIT = { freed: 20, ms: 10 * 60_000 }

/** The folders of [cwds] that are given. */
const folders = (cwds: Iterable<string | null | undefined>) => [...cwds].filter((cwd): cwd is string => typeof cwd === 'string' && cwd.length > 0)
/** Whether any of [cwds] is [path] or a folder in it. */
const worksIn = (cwds: string[], path: string) => cwds.some(cwd => cwd === path || cwd.startsWith(path + sep))
/** A folder as the disk names it: links followed, and its own letters on a disk that ignores case. One that is not there
 *  keeps its spelling. */
const onDisk = (path: string) => realpath(path).catch(() => normalize(path))

/** A worktree Harness made: its path as found, as the disk names it ([here]), its own git folder, and when it was last
 *  used, to go longest unused first. */
interface Candidate { path: string; here: string; gitDir: string; at: number }

/**
 * Removes the worktrees Harness made that nothing uses: under `<root>/worktrees`, no live or stopped harness working in it
 * (a stopped one can be resumed there), nothing uncommitted, untouched for [idleMs], and — on no branch — no commit only it
 * has. What git ignores there (an `.env`, build output) goes with it. The branch stays, unless Harness made it and its
 * commits are all on other branches or the remote. Anything that does not pass is left exactly as it is.
 *
 * In a worktree that stays, unused for [idleMs], what an install or a build makes again is freed (`freeBuildOutput`), the
 * longest unused first and within SWEEP_LIMIT. Nothing is removed or freed where a harness works: [busy] names the folders
 * where one runs now or stopped within [idleMs], however each is spelled, and it is asked again just before git removes a
 * worktree, before each build folder goes and while it goes. A sweep can take minutes, and a harness may start meanwhile
 * (review of package 6, 11-12).
 */
export async function sweepWorktrees(input: {
  root: string
  inUse: Iterable<string | null | undefined>
  busy: () => Iterable<string | null | undefined>
  now?: number
  idleMs?: number
  limit?: { freed: number; ms: number }
}): Promise<Swept> {
  const home = join(input.root, 'worktrees')
  const used = folders(input.inUse).map(cwd => normalize(cwd))
  const now = input.now ?? Date.now(), idleMs = input.idleMs ?? WORKTREE_IDLE_MS, limit = input.limit ?? SWEEP_LIMIT
  const started = performance.now()
  const busy = async () => Promise.all(folders(input.busy()).map(onDisk))
  const swept: Swept = { removed: [], freed: [], failed: [], left: 0 }
  const trees: Candidate[] = []
  for (const path of await candidates(home)) {
    try {
      const dirs = await linked(path)
      if (dirs) trees.push({ path, here: await onDisk(path), gitDir: dirs.gitDir, at: await lastUsed(path, dirs.gitDir) })
    } catch { swept.failed.push('WORKTREE_CHECK_FAILED') }
  }
  trees.sort((a, b) => a.at - b.at)
  let freedIn = 0
  for (const [index, tree] of trees.entries()) {
    if (index > 0 && (freedIn >= limit.freed || performance.now() - started > limit.ms)) { swept.left = trees.length - index; break }
    const free = async () => !worksIn(await busy(), tree.here)
    try {
      if (!worksIn(used, tree.path) && await sweepOne(tree.path, now, idleMs, free)) {
        swept.removed.push(tree.path)
        // The repository's folder goes with its last worktree; the worktrees folder itself stays.
        if (dirname(tree.path) !== home) await rmdir(dirname(tree.path)).catch(() => {})
      // Read again: a worktree may be used by hand while the sweep works on the ones before it.
      } else if (now - await lastUsed(tree.path, tree.gitDir) >= idleMs && await freeBuildOutput(tree, now, idleMs, swept, free)) freedIn++
    } catch (error) { swept.failed.push(error instanceof WorktreeKept ? error.code : 'WORKTREE_CHECK_FAILED') }
  }
  return swept
}

/** A linked worktree's own git folder and its repository's, or null for any other checkout. */
async function linked(path: string): Promise<{ gitDir: string; common: string } | null> {
  const gitDir = resolve(path, await git(path, ['rev-parse', '--git-dir']))
  const common = resolve(path, await git(path, ['rev-parse', '--git-common-dir']))
  return gitDir === common || basename(common) !== '.git' ? null : { gitDir, common }
}

/** When a worktree was last used: its top folder, HEAD or index written, or HEAD moved. HEAD's moves are read from the last
 *  line of its reflog, never from the time that file was written: `git gc`, which git runs by itself after fetches, writes
 *  every worktree's reflog again. One Mac, 11-10: 15 worktrees of one repository in one second, and 85 of another's 88; read
 *  as use, that restarted the idle week for all of them, worked in or not. */
async function lastUsed(path: string, gitDir: string): Promise<number> {
  const written = [path, join(gitDir, 'HEAD'), join(gitDir, 'index')].map(file => stat(file).then(info => info.mtimeMs, () => 0))
  // A reflog line: the two commits, who moved HEAD, the second it moved and the zone, then a tab and why when git says why.
  const moved = readFile(join(gitDir, 'logs', 'HEAD'), 'utf8')
    .then(log => 1000 * Number(/> (\d+) [-+]\d{4}(?:\t[^\n]*)?\n?$/.exec(log)?.[1] ?? 0), () => 0)
  return Math.max(...await Promise.all([...written, moved]))
}

/** What an install or a build makes again, by the folder's name: 4.7 of the 21.6 GB that 29 worktrees Harness made held on
 *  one Mac (11-11). Only these names, never all that git ignores: there an agent kept 2 GB of evidence under `.harness`, and
 *  a new worktree is given the project's ignored `.env`. Not `build` (review of package 6, 11-12): people name their own
 *  folders so, and this repository's firmware keeps a pet's hand-drawn frames in one its ignore file names. */
const BUILD_OUTPUT = new Set(['node_modules', '.dart_tool', '.next'])

/** `git status --porcelain -z` as [status, path] pairs. A rename or a copy is followed by the path it came from, which is
 *  no entry of its own. */
function statusEntries(listing: string): Array<[string, string]> {
  const fields = listing.split('\0'), entries: Array<[string, string]> = []
  for (let at = 0; at < fields.length; at++) {
    const field = fields[at]!
    if (field.length < 4) continue
    entries.push([field.slice(0, 2), field.slice(3)])
    if (/[RC]/.test(field.slice(0, 2))) at++
  }
  return entries
}

/** The build output in [worktree] by git's listing (`statusEntries`): each folder an ignore rule matches itself, which git
 *  lists as ignored with a slash, by its last name. Git writes `/` on every platform, so the listing is never split on the
 *  platform's separator; [joinPath] is the platform's, and a test passes Windows's. */
export function buildOutputIn(worktree: string, listing: string, joinPath: typeof join = join): string[] {
  return statusEntries(listing).flatMap(([status, path]) => {
    const names = path.split('/')
    return status === '!!' && names.pop() === '' && BUILD_OUTPUT.has(names.at(-1) ?? '') ? [joinPath(worktree, ...names)] : []
  })
}

/**
 * Frees what an install or a build makes again in a worktree that stays and nobody has used for [idleMs]: the folders an
 * ignore rule matches itself, by the names in BUILD_OUTPUT. "Used" is git's record (`lastUsed`) and every path git lists
 * here, by when it was written: a change, each file it does not track, an ignored file or folder such as a test run's log
 * or an install (review of package 6, 11-12). A stopped harness resumed there, or a person back at uncommitted work, finds
 * the checkout and every other file as they were, and installs again. A folder that fails part way is said by its code and
 * left for the next sweep. True when a folder went.
 */
async function freeBuildOutput(tree: Candidate, now: number, idleMs: number, swept: Swept, free: () => Promise<boolean>): Promise<boolean> {
  // `--ignored=matching` lists a folder whole only when a rule matches it. `ls-files --ignored --directory` also listed one no
  // rule matches whose files were each ignored by a rule of their own, and `deploy/build/.env` and `prod.pem` went with it.
  // Each file git does not track is listed by itself: a folder of them listed as one read only that folder's own time.
  const listing = await git(tree.path, ['status', '--porcelain', '-z', '--ignored=matching', '--untracked-files=all'])
  for (const [, entry] of statusEntries(listing)) {
    // A path that cannot be read, such as a tracked file that was deleted, counts as written now: nobody can say when it went.
    if (now - await lstat(join(tree.path, entry)).then(info => info.mtimeMs, () => now) < idleMs) return false
  }
  let freed = false
  for (const folder of buildOutputIn(tree.path, listing)) {
    if (!await free()) break
    const named = relative(tree.path, folder)
    if (!await removable(folder, join(tree.here, named))) continue
    // With core.ignorecase=false on a disk that ignores case, git lists `lib/node_modules/` as ignored whole though its index
    // holds `lib/Node_Modules/fixture.js` (review of package 6, round 3). Asked whatever the letters: a tracked file keeps it.
    if (await git(tree.path, ['ls-files', '-z', '--', `:(icase,literal)${named.split(sep).join('/')}/`]) !== '') continue
    try {
      await removeTree(folder, free)
      swept.freed.push(folder)
      freed = true
    } catch (error) {
      // After a stop the next folder's check stops the rest: the harness is there now.
      const code = (error as NodeJS.ErrnoException).code
      swept.failed.push(error === HARNESS_STARTED ? 'BUILD_OUTPUT_STOPPED' : code ? `BUILD_OUTPUT_STUCK:${code}` : 'BUILD_OUTPUT_STUCK')
    }
  }
  return freed
}

/** Whether a build folder git listed may go: still a folder and not a link, and found at [real], the worktree's own real
 *  path joined with where git listed it, so that no link lies on the way to it; and nothing in it that keeps it whole. Git
 *  for Windows walks a junction as a folder (`web -> packages/web` lists `web/node_modules/`), and a folder may become a
 *  link after git listed it: either way the removal would happen where the link points, outside the worktree or inside it,
 *  tracked files and uncommitted changes with it (review of package 6, rounds 2 and 3). */
async function removable(folder: string, real: string): Promise<boolean> {
  if (!(await lstat(folder).catch(() => null))?.isDirectory()) return false
  if (await realpath(folder).catch(() => '') !== real) return false
  return !await keptWhole(folder)
}

/** Whether a build folder stays whole: a folder in it this process could not empty, so its removal would stop part way; or a
 *  checkout or a repository of its own in it (`.git`, or HEAD, objects and refs side by side in a bare one), someone's work,
 *  which git says nothing of inside a folder it ignores. One walk, never through a link. */
async function keptWhole(dir: string): Promise<boolean> {
  try { await access(dir, constants.W_OK | constants.X_OK) } catch { return true }
  let entries: Dirent[]
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return true }
  const names = new Set(entries.map(entry => entry.name))
  if (names.has('.git') || (names.has('HEAD') && names.has('objects') && names.has('refs'))) return true
  for (const entry of entries) if (entry.isDirectory() && await keptWhole(join(dir, entry.name))) return true
  return false
}

/** Thrown when a harness starts in a worktree while one of its build folders is being removed. */
const HARNESS_STARTED = new Error('a harness started where build output was being removed')

/** Removes [dir] one entry at a time, a link as a link and never what it points to, and stops at the first entry it cannot
 *  remove. Node's own recursive removal holds what it has not reached yet and removes many entries at once: on 300,000 files
 *  it took the process's heap from 14 to 269 MiB and its resident memory from 130 to 746 MiB, where the master restarts the
 *  edge process at 288 and 768 (harnessd/services.ts); a 2-byte read beside it waited up to 2.3 s; and after a failure it
 *  went on deleting (review of package 6, 11-12). One entry at a time, the same 300,000 files: heap at most 43 MiB, resident
 *  158, and the read beside it at most 5.4 ms (11-12). Every few hundred entries it asks [free] again, and stops once a
 *  harness has started there: a big folder takes minutes, and that harness's own install would race the removal (review of
 *  package 6, round 3). */
async function removeTree(dir: string, free: () => Promise<boolean>, seen = { entries: 0 }): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (++seen.entries % 256 === 0 && !await free()) throw HARNESS_STARTED
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await removeTree(path, free, seen)
    else await unlink(path)
  }
  await rmdir(dir)
}

/** Why a worktree that passed every check above was kept anyway, by a fixed code: an error's own text can carry its path.
 *  UNWRITABLE: a folder in it git could not empty, so nothing was touched. NOT_REMOVED: git began and failed; whatever is
 *  left keeps its record, so git still works there. */
export class WorktreeKept extends Error {
  constructor(readonly code: 'WORKTREE_UNWRITABLE' | 'WORKTREE_NOT_REMOVED') { super(code) }
}

/** Whether a folder in the worktree cannot be emptied: git would delete part of it and stop (below). One Mac, 10-28: a
 *  skill folder an agent had copied in read-only stopped the removal of a stopped worker's worktree after a third of it. */
async function unwritableFolder(dir: string): Promise<boolean> {
  try { await access(dir, constants.W_OK | constants.X_OK) } catch { return true }
  let entries: Dirent[]
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return true }
  for (const entry of entries) if (entry.isDirectory() && await unwritableFolder(join(dir, entry.name))) return true
  return false
}

/**
 * `git worktree remove`, without losing the worktree when it fails: git deletes the worktree's record in the repository even
 * when it could not delete its folder ("there's no going back from here", builtin/worktree.c), so the folder's .git then
 * points to nothing and every git and gh command there fails. A stopped worker's folder on one Mac (10-28) was left like that,
 * and a Buddy's on another with the same symptom (10-30). git empties the folder in directory order, so its .git file is often
 * gone too before git reaches what it cannot delete (security review 1 of #2417: 8 of 30 trials). Both are read first and,
 * if the folder is still there, each is written back where it is missing: the record only where git keeps records, the
 * .git file never over one that is there.
 */
async function removeKeepingRecord(main: string, common: string, gitDir: string, path: string): Promise<void> {
  // The whole record: its HEAD, index and reflog, and the refs only this worktree holds (refs/bisect, refs/worktree; security
  // review 2 of #2417).
  const saved = new Map<string, Buffer>()
  const save = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name)
      if (entry.isDirectory()) await save(file)
      else if (entry.isFile()) saved.set(relative(gitDir, file), await readFile(file))
    }
  }
  await save(gitDir)
  const link = await readFile(join(path, '.git'))
  try {
    await git(main, ['worktree', 'remove', '--', path])
  } catch (error) {
    if (!await lstat(path).then(info => info.isDirectory(), () => false)) throw error
    await writeFile(join(path, '.git'), link, { flag: 'wx' }).catch((failed: NodeJS.ErrnoException) => { if (failed.code !== 'EEXIST') throw failed })
    if (dirname(gitDir) === join(common, 'worktrees') && !await lstat(gitDir).then(() => true, () => false)) {
      for (const [name, data] of saved) {
        await mkdir(dirname(join(gitDir, name)), { recursive: true })
        await writeFile(join(gitDir, name), data)
      }
    }
    throw new WorktreeKept('WORKTREE_NOT_REMOVED')
  }
}

/** Removes one worktree under the rule above: true when it went. The Swarm's host calls it with no idle wait for a worker
 *  it just stopped (superTabs/machines.ts `removeStoppedWorktree`), and asks [unused] again just before git removes it: the
 *  reads and the folder walk take a while, and a session may open there meanwhile (security review 1 of #2417). */
export async function sweepOne(path: string, now: number, idleMs: number, unused: () => boolean | Promise<boolean> = () => true): Promise<boolean> {
  const dirs = await linked(path)
  if (!dirs) return false
  const { gitDir, common } = dirs
  const main = dirname(common)
  const touched = await Promise.all(
    [path, join(gitDir, 'HEAD'), join(gitDir, 'index'), join(gitDir, 'logs', 'HEAD')]
      .map(file => stat(file).then(info => info.mtimeMs, () => 0)),
  )
  if (now - Math.max(...touched) < idleMs) return false
  // An older Harness's own ignore file, untracked, kept every worktree (#2266): upgraded first, only when git does not track it.
  if (await git(path, ['ls-files', '--', '.harness/.gitignore']).catch(() => null) === '') upgradeOlderRuntimeIgnore(path)
  if (await git(path, ['status', '--porcelain']) !== '') return false
  const branch = await git(path, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => null)
  if (!branch && await git(path, ['rev-list', '--count', 'HEAD', '--not', '--branches', '--remotes']) !== '0') return false
  if (await unwritableFolder(path)) throw new WorktreeKept('WORKTREE_UNWRITABLE')
  if (!await unused()) return false
  // In the repository's turn: a start's `git worktree add` read the worktrees folder this removes from (gitProject.ts).
  await inRepositoryTurn(main, async () => {
    await removeKeepingRecord(main, common, gitDir, path)
    const name = branch?.slice('refs/heads/'.length)
    // Only a branch Harness made: marked in the repository's config, or named `harness/…` by older builds.
    const made = name !== undefined && (name.startsWith('harness/')
      || await git(main, ['config', '--get', `branch.${name}.harness`]).then(Boolean, () => false))
    if (branch && name && made) {
      // `--exclude` before `--branches` matches names without `refs/heads/`.
      const unique = await git(main, ['rev-list', '--count', branch, '--not', `--exclude=${name}`, '--branches', '--remotes']).catch(() => null)
      if (unique === '0') await git(main, ['branch', '-D', name]).catch(() => {})
    }
  })
  return true
}
