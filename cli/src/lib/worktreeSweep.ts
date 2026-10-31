import { execFile } from 'node:child_process'
import { constants, type Dirent } from 'node:fs'
import { access, lstat, mkdir, readdir, readFile, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, normalize, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
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

/**
 * Removes the worktrees Harness made that nothing uses and nothing would miss: under
 * `<root>/worktrees`, no live or stopped harness working in it (a stopped one can be resumed there),
 * nothing uncommitted, untouched for [idleMs], and — on no branch — no commit only it has. The
 * branch stays, unless Harness made it and its commits are all on other branches or the remote. Anything that does not pass is left exactly as it is.
 */
export async function sweepWorktrees(input: {
  root: string
  inUse: Iterable<string | null | undefined>
  now?: number
  idleMs?: number
}): Promise<string[]> {
  const home = join(input.root, 'worktrees')
  const used = [...input.inUse].filter((cwd): cwd is string => typeof cwd === 'string' && cwd.length > 0).map(cwd => normalize(cwd))
  const removed: string[] = []
  for (const path of await candidates(home)) {
    if (used.some(cwd => cwd === path || cwd.startsWith(path + sep))) continue
    try {
      if (!await sweepOne(path, input.now ?? Date.now(), input.idleMs ?? WORKTREE_IDLE_MS)) continue
      removed.push(path)
      // The repository's folder goes with its last worktree; the worktrees folder itself stays.
      if (dirname(path) !== home) await rmdir(dirname(path)).catch(() => {})
    } catch { /* left as it is */ }
  }
  return removed
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
  const gitDir = resolve(path, await git(path, ['rev-parse', '--git-dir']))
  const common = resolve(path, await git(path, ['rev-parse', '--git-common-dir']))
  if (gitDir === common || basename(common) !== '.git') return false
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
  return true
}
