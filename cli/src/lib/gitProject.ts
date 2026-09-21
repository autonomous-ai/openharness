import { execFile } from 'node:child_process'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { projectFolderName } from './agentNames.js'

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
    const [branch, refs] = await Promise.all([
      git(path, ['symbolic-ref', '--quiet', 'HEAD']).then(ref => ref.replace(/^refs\/heads\//, '')).catch(() => null),
      git(path, ['for-each-ref', '--format=%(refname)%09%(refname:short)%09%(symref)', 'refs/heads', 'refs/remotes']),
    ])
    const branches = refs.split('\n').filter(Boolean).flatMap(line => {
      const [ref, name, symbolic] = line.split('\t')
      return ref && name && !symbolic ? [{ ref, name, remote: ref.startsWith('refs/remotes/') }] : []
    })
    return { isGit: true, root, branch, branches }
  } catch { return { error: 'GIT_UNAVAILABLE' } }
}

/** Start uses a fresh branch for worktrees; the shared folder is only switched
 * when the user explicitly chooses a different local branch with Worktree off. */
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
  if (!options.worktree) {
    if (!options.ref?.startsWith('refs/heads/')) throw new GitProjectError('INVALID_BRANCH', 'Choose a local branch, or turn Worktree on.')
    try {
      const current = await git(source, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => null)
      if (current === options.ref) return source
      await git(source, ['switch', '--', options.ref.slice('refs/heads/'.length)], 120_000)
      return source
    } catch {
      throw new GitProjectError('BRANCH_SWITCH_FAILED', 'Could not switch branches. Commit or stash conflicting changes, or turn Worktree on.')
    }
  }
  const parent = join(options.root, 'worktrees')
  await mkdir(parent, { recursive: true })
  const name = projectFolderName(`${basename(root)}-${options.label?.trim() || 'harness'}`, (options.now ?? (() => new Date()))(), true)
  const destination = await mkdtemp(join(parent, `${name}-`))
  const branch = `harness/${basename(destination)}`
  try {
    await git(source, ['worktree', 'add', '-b', branch, '--', destination, head], 120_000)
    return prefix ? join(destination, prefix.replace(/\/$/, '')) : destination
  } catch {
    // Keep any partial checkout and branch available for recovery.
    throw new GitProjectError('WORKTREE_FAILED', `Could not create the worktree at ${destination}. Check Git and folder permissions, then retry.`)
  }
}
