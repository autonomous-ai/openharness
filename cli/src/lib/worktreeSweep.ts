import { execFile } from 'node:child_process'
import { constants, type Dirent } from 'node:fs'
import { access, lstat, mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, normalize, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { inRepositoryTurn } from './gitProject.js'
import { upgradeOlderRuntimeIgnore } from './harnessRuntimeIgnore.js'

const exec = promisify(execFile)

/** A week without a commit, a checkout or an index write. */
export const WORKTREE_IDLE_MS = 7 * 24 * 3600_000

/** git as itself: none of the repository settings a parent process left in the environment. */
export async function git(cwd: string, args: string[]): Promise<string> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete (env as NodeJS.ProcessEnv)[key]
  return (await exec('git', ['-C', cwd, ...args], { timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env }))
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
 *  went, and [stuck]: those it began to remove and could not finish, so part of one may be left. */
export interface Swept { removed: string[]; freed: string[]; stuck: string[] }

/**
 * Removes the worktrees Harness made that nothing uses and nothing would miss: under
 * `<root>/worktrees`, no live or stopped harness working in it (a stopped one can be resumed there),
 * nothing uncommitted, untouched for [idleMs], and — on no branch — no commit only it has. The
 * branch stays, unless Harness made it and its commits are all on other branches or the remote. Anything that does not pass is left exactly as it is.
 *
 * In a worktree that stays, with no live harness in it and unused for [idleMs], what an install or a build makes again is
 * freed (`freeBuildOutput`). [live] is the folders of [inUse] whose harness is running now.
 */
export async function sweepWorktrees(input: {
  root: string
  inUse: Iterable<string | null | undefined>
  live: Iterable<string | null | undefined>
  now?: number
  idleMs?: number
}): Promise<Swept> {
  const home = join(input.root, 'worktrees')
  const folders = (cwds: Iterable<string | null | undefined>) =>
    [...cwds].filter((cwd): cwd is string => typeof cwd === 'string' && cwd.length > 0).map(cwd => normalize(cwd))
  const used = folders(input.inUse), live = folders(input.live)
  const worksIn = (cwds: string[], path: string) => cwds.some(cwd => cwd === path || cwd.startsWith(path + sep))
  const now = input.now ?? Date.now(), idleMs = input.idleMs ?? WORKTREE_IDLE_MS
  const swept: Swept = { removed: [], freed: [], stuck: [] }
  for (const path of await candidates(home)) {
    // A worktree the checks could not finish on is left as it is.
    if (!worksIn(used, path) && await sweepOne(path, now, idleMs).catch(() => false)) {
      swept.removed.push(path)
      // The repository's folder goes with its last worktree; the worktrees folder itself stays.
      if (dirname(path) !== home) await rmdir(dirname(path)).catch(() => {})
    // Never under a live harness: a server or a test run it started may be running from that build output.
    } else if (!worksIn(live, path)) await freeBuildOutput(path, now, idleMs, swept).catch(() => { /* left as it is */ })
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
 *  a new worktree is given the project's ignored `.env`. */
const BUILD_OUTPUT = new Set(['node_modules', '.dart_tool', 'build', '.next'])

/**
 * The build output in what git lists as ignored in [worktree] (`ls-files --others --ignored --directory -z`): the folders
 * it lists whole, by their last name. Git lists a folder whole only when nothing in it is tracked or waits to be committed,
 * and a link as a file. It writes `/` on every platform, so the listing is never split on the platform's separator.
 * [joinPath] is the platform's; a test passes Windows's.
 */
export function buildOutputIn(worktree: string, listing: string, joinPath: typeof join = join): string[] {
  return listing.split('\0').flatMap((entry) => {
    const names = entry.split('/')
    return names.pop() === '' && BUILD_OUTPUT.has(names.at(-1) ?? '') ? [joinPath(worktree, ...names)] : []
  })
}

/** Whether something in [dir] is a repository or a worktree of its own: a checkout someone made inside build output is their
 *  work, and git, which ignores the folder around it, says nothing of it. */
async function holdsCheckout(dir: string): Promise<boolean> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || (entry.isDirectory() && await holdsCheckout(join(dir, entry.name)))) return true
  }
  return false
}

/**
 * Frees what an install or a build makes again in a worktree that stays, once nobody has used the worktree for [idleMs]:
 * the folders git ignores whole that are named for build output. A stopped harness resumed there, or a person back at
 * uncommitted work, finds the checkout and every other file as they were, and installs again. A folder stays when it was
 * written within [idleMs], when something in it could not be emptied (nothing of it is touched then), and when it holds a
 * checkout of its own. Nothing is forced: a removal that fails part way is named in [swept] and left for the next sweep.
 */
async function freeBuildOutput(path: string, now: number, idleMs: number, swept: Swept): Promise<void> {
  const dirs = await linked(path)
  if (!dirs || now - await lastUsed(path, dirs.gitDir) < idleMs) return
  const ignored = await git(path, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])
  for (const folder of buildOutputIn(path, ignored)) {
    // Not there reads as written now: git also lists what is in a folder it ignores for its contents alone, and that
    // folder went just before.
    const written = await lstat(folder).then(info => info.mtimeMs, () => Infinity)
    if (now - written < idleMs || await unwritableFolder(folder) || await holdsCheckout(folder)) continue
    await rm(folder, { recursive: true }).then(() => swept.freed.push(folder), () => swept.stuck.push(folder))
  }
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
export async function sweepOne(path: string, now: number, idleMs: number, unused: () => boolean = () => true): Promise<boolean> {
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
  if (!unused()) return false
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
