import { execFile } from 'node:child_process'
import { lstat, readdir, rmdir, stat } from 'node:fs/promises'
import { basename, dirname, join, normalize, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** A week without a commit, a checkout or an index write. */
export const WORKTREE_IDLE_MS = 7 * 24 * 3600_000

async function git(cwd: string, args: string[]): Promise<string> {
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

async function sweepOne(path: string, now: number, idleMs: number): Promise<boolean> {
  const gitDir = resolve(path, await git(path, ['rev-parse', '--git-dir']))
  const common = resolve(path, await git(path, ['rev-parse', '--git-common-dir']))
  if (gitDir === common || basename(common) !== '.git') return false
  const main = dirname(common)
  const touched = await Promise.all(
    [path, join(gitDir, 'HEAD'), join(gitDir, 'index'), join(gitDir, 'logs', 'HEAD')]
      .map(file => stat(file).then(info => info.mtimeMs, () => 0)),
  )
  if (now - Math.max(...touched) < idleMs) return false
  if (await git(path, ['status', '--porcelain']) !== '') return false
  const branch = await git(path, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => null)
  if (!branch && await git(path, ['rev-list', '--count', 'HEAD', '--not', '--branches', '--remotes']) !== '0') return false
  await git(main, ['worktree', 'remove', '--', path])
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
