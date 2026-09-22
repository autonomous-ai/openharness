import { execFile } from 'node:child_process'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, normalize } from 'node:path'
import { promisify } from 'node:util'
import { worktreeName } from './agentNames.js'

const exec = promisify(execFile)

export class GitProjectError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export function validGitPath(path: unknown): path is string {
  return typeof path === 'string' && isAbsolute(path) && path.length <= 4096 && !/[\x00-\x1f\x7f]/.test(path)
}

async function git(path: string, args: string[], timeout = 4000): Promise<string> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_OPTIONAL_LOCKS: '0' }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_NAMESPACE', 'GIT_PREFIX']) delete (env as NodeJS.ProcessEnv)[key]
  return (await exec('git', ['--no-optional-locks', '-C', path, ...args], {
    timeout, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    env,
  })).stdout.replace(/\r?\n$/, '')
}

/** `git worktree list --porcelain`, main checkout first. A bare repository has no files and a
 *  prunable entry lost its folder, so neither is somewhere to work. */
type Worktree = { path: string; ref: string | null; usable: boolean }
function parseWorktrees(output: string): Worktree[] {
  return output.split(/\n\s*\n/).flatMap(block => {
    const lines = block.split('\n')
    const path = lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length)
    if (!path) return []
    return [{
      path,
      ref: lines.find(line => line.startsWith('branch '))?.slice('branch '.length) ?? null,
      usable: !lines.some(line => line === 'bare' || line.startsWith('prunable')),
    }]
  })
}
const worktrees = (path: string) => git(path, ['worktree', 'list', '--porcelain']).then(parseWorktrees, () => [])
const real = (path: string) => realpath(path).catch(() => normalize(path))
const isDirectory = (path: string) => stat(path).then(info => info.isDirectory(), () => false)

/** The main checkout, when `root` is one of its linked worktrees. */
async function mainCheckout(root: string, trees: Worktree[]): Promise<string | null> {
  if (trees.length < 2 || !trees[0]!.usable) return null
  const here = await real(root)
  if (await real(trees[0]!.path) === here) return null
  for (const tree of trees.slice(1)) if (await real(tree.path) === here) return trees[0]!.path
  return null
}

/** Read only: listing a branch never checks it out or fetches from a remote. */
export async function readGitProject(path: string) {
  if (!validGitPath(path)) return { error: 'INVALID_PATH' }
  let root: string
  try { root = await git(path, ['rev-parse', '--show-toplevel']) }
  catch (error) {
    const failure = error as { code?: number | string; killed?: boolean }
    return !failure.killed && failure.code === 128 ? { isGit: false, branches: [] } : { error: 'GIT_UNAVAILABLE' }
  }
  try {
    const [branch, refs, trees] = await Promise.all([
      git(path, ['symbolic-ref', '--quiet', 'HEAD']).then(ref => ref.replace(/^refs\/heads\//, '')).catch(() => null),
      git(path, ['for-each-ref', '--format=%(refname)%09%(refname:short)%09%(symref)', 'refs/heads', 'refs/remotes']),
      worktrees(path),
    ])
    const checkedOut = new Map(trees.flatMap(tree => tree.usable && tree.ref ? [[tree.ref, tree.path] as const] : []))
    const branches = refs.split('\n').filter(Boolean).flatMap(line => {
      const [ref, name, symbolic] = line.split('\t')
      if (!ref || !name || symbolic) return []
      const worktree = checkedOut.get(ref)
      return [{ ref, name, remote: ref.startsWith('refs/remotes/'), ...(worktree ? { worktree } : {}) }]
    })
    // A worktree is a temporary folder. The launcher shows its repository.
    const main = await mainCheckout(root, trees)
    if (!main) return { isGit: true, root, branch, branches }
    const prefix = (await git(path, ['rev-parse', '--show-prefix']).catch(() => '')).replace(/\/$/, '')
    const mainFolder = prefix && await isDirectory(join(main, prefix)) ? join(main, prefix) : main
    const mainBranch = trees[0]!.ref?.replace(/^refs\/heads\//, '')
    return { isGit: true, root, branch, branches, mainFolder, ...(mainBranch ? { mainBranch } : {}) }
  } catch { return { error: 'GIT_UNAVAILABLE' } }
}

/** Start uses a fresh `harness/<name>` branch for worktrees, in a folder under
 * `<root>/worktrees/<repository>`. With Worktree off, a branch that already has a worktree opens
 * there; otherwise the shared folder is only switched when the user explicitly chooses a different
 * local branch. */
export async function prepareGitProject(
  source: string,
  options: { root: string; worktree: boolean; ref?: string; label?: string | null; now?: () => Date },
): Promise<string> {
  if (!validGitPath(source)) throw new GitProjectError('INVALID_PROJECT_SOURCE', 'Choose a Git project folder.')
  let root: string, head: string, prefix: string
  try {
    root = await git(source, ['rev-parse', '--show-toplevel'])
    if (options.ref) {
      if (!/^refs\/(heads|remotes)\/[^\s\x00-\x1f\x7f]+$/.test(options.ref)) throw new Error('Invalid branch')
      await git(source, ['show-ref', '--verify', '--hash', '--', options.ref])
    }
    head = await git(source, ['rev-parse', '--verify', '--end-of-options', `${options.ref ?? 'HEAD'}^{commit}`])
    prefix = await git(source, ['rev-parse', '--show-prefix'])
    if (prefix && await git(source, ['cat-file', '-t', `${head}:${prefix.replace(/\/$/, '')}`]) !== 'tree') throw new Error('Missing folder')
  } catch {
    throw new GitProjectError('GIT_PROJECT_UNAVAILABLE', 'Choose a Git project and branch with at least one commit. For a new folder, turn Worktree off.')
  }
  const inside = (folder: string) => prefix ? join(folder, prefix.replace(/\/$/, '')) : folder
  const trees = await worktrees(source)
  if (!options.worktree) {
    if (!options.ref?.startsWith('refs/heads/')) throw new GitProjectError('INVALID_BRANCH', 'Choose a local branch, or turn Worktree on.')
    try {
      const current = await git(source, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => null)
      if (current === options.ref) return source
      // A branch that already has a worktree is worked on there: Git would refuse to check it out
      // twice, and the folder is not the person's concern.
      for (const tree of trees) {
        if (tree.usable && tree.ref === options.ref && await isDirectory(tree.path)) return inside(tree.path)
      }
      await git(source, ['switch', '--', options.ref.slice('refs/heads/'.length)], 120_000)
      return source
    } catch {
      throw new GitProjectError('BRANCH_SWITCH_FAILED', 'Could not switch branches. Commit or stash conflicting changes, or turn Worktree on.')
    }
  }
  // Grouped by repository, so the leaf only needs the harness and the time.
  const repository = trees[0]?.usable ? basename(trees[0].path) : basename(root)
  const taken = new Set((await git(source, ['for-each-ref', '--format=%(refname)', 'refs/heads/harness/']).catch(() => '')).split('\n'))
  const base = worktreeName(options.label?.trim() || 'harness', (options.now ?? (() => new Date()))())
  let destination: string | undefined, branch = ''
  try {
    const parent = join(options.root, 'worktrees', repository)
    await mkdir(parent, { recursive: true })
    // mkdir reserves the name atomically, so simultaneous starts never share a worktree.
    for (let attempt = 1; attempt <= 100 && !destination; attempt++) {
      const name = attempt === 1 ? base : `${base}-${attempt}`
      if (taken.has(`refs/heads/harness/${name}`)) continue
      try { await mkdir(join(parent, name)); destination = join(parent, name); branch = `harness/${name}` }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
  } catch { destination = undefined }
  if (!destination) throw new GitProjectError('WORKTREE_FAILED', 'Could not create a worktree folder. Check folder permissions, then retry.')
  try {
    await git(source, ['worktree', 'add', '-b', branch, '--', destination, head], 120_000)
    return inside(destination)
  } catch {
    // Keep any partial checkout and branch available for recovery.
    throw new GitProjectError('WORKTREE_FAILED', `Could not create the worktree at ${destination}. Check Git and folder permissions, then retry.`)
  }
}
