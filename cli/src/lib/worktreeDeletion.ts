/** Explicit cleanup of a linked Git worktree. Main checkouts and branches are never removed. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { env } from '../config/env.js'
import { insideGitCheckout } from './gitProject.js'
import type { RegisteredSession } from './registry.js'

const exec = promisify(execFile)
const within = (parent: string, path: string) => parent === path || path.startsWith(parent + sep)
async function git(cwd: string, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_NAMESPACE', 'GIT_PREFIX']) delete env[key]
  return (await exec('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args],
    { env, timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 })).stdout.replace(/\r?\n$/, '')
}
export type WorktreeReview = {
  path: string; main: string; branch: string | null; head: string; bytes: number | null
  dirty: boolean; changes: string[]; signature: string; dev: number; ino: number
}

export type WorkspaceInspection = {
  kind: 'main' | 'worktree' | 'folder' | 'unavailable'
  path: string | null; worktreePath?: string; mainPath?: string
  canDelete: boolean; reason: string
}

/** Read-only location and cleanup eligibility. No review token or deletion is created by Inspect. */
export async function inspectWorkspace(s: RegisteredSession, sessions: readonly RegisteredSession[]): Promise<WorkspaceInspection> {
  let path: string | null = s.cwd ?? null
  try {
    if (!path) throw new Error('No working folder')
    path = await realpath(path)
    // A plain folder, said without git (insideGitCheckout): Harness Monitor's Delete preview asks this
    // of every harness, and Apple's git stub answered with an install dialog and no "not a git
    // repository", so the folder read as unverifiable.
    if (!(await insideGitCheckout(path))) {
      return { kind: 'folder', path, canDelete: false, reason: 'This folder is not a Git worktree. Its files are kept.' }
    }
    let root: string
    try { root = await realpath(await git(path, ['rev-parse', '--show-toplevel'])) }
    catch (error) {
      if (/not a git repository/i.test(String((error as { stderr?: string }).stderr))) {
        return { kind: 'folder', path, canDelete: false, reason: 'This folder is not a Git worktree. Its files are kept.' }
      }
      throw error
    }
    const gitDir = await realpath(resolve(root, await git(root, ['rev-parse', '--git-dir'])))
    const common = await realpath(resolve(root, await git(root, ['rev-parse', '--git-common-dir'])))
    if (gitDir === common) {
      return { kind: 'main', path, mainPath: root, canDelete: false, reason: 'This is the main project checkout. It cannot be deleted here.' }
    }
    const location = { kind: 'worktree' as const, path, worktreePath: root,
      ...(basename(common) === '.git' ? { mainPath: dirname(common) } : {}) }
    try {
      const review = await inspectWorktree(s, sessions)
      return { ...location, worktreePath: review.path, mainPath: review.main, canDelete: true,
        reason: 'Selecting Worktree data in Delete removes this entire worktree folder after confirmation. The main project and branch are kept. Leave Session data unchecked to keep the conversation.' }
    } catch (error) {
      return { ...location, canDelete: false, reason: error instanceof Error ? error.message : 'Worktree cleanup is unavailable.' }
    }
  } catch {
    return { kind: 'unavailable', path, canDelete: false, reason: 'The working folder could not be verified. Reopen Inspect to try again.' }
  }
}

export async function inspectWorktree(s: RegisteredSession, sessions: readonly RegisteredSession[]): Promise<WorktreeReview> {
  if (!s.cwd) throw new Error('This harness has no working folder.')
  if (!(await insideGitCheckout(s.cwd))) throw new Error('No separate worktree. This folder is not a Git worktree.')
  const root = await realpath(await git(s.cwd, ['rev-parse', '--show-toplevel']))
  const [folder, marker] = await Promise.all([lstat(root), lstat(join(root, '.git'))])
  const gitDir = await realpath(resolve(root, await git(root, ['rev-parse', '--git-dir'])))
  const common = await realpath(resolve(root, await git(root, ['rev-parse', '--git-common-dir'])))
  if (!folder.isDirectory() || !marker.isFile() || gitDir === common || basename(common) !== '.git') {
    throw new Error('No separate worktree. This is the main project folder; it cannot be deleted here.')
  }
  const main = dirname(common)
  if (within(root, main)) throw new Error('The main project is inside this folder. It cannot be deleted here.')
  const worktrees = (await git(main, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0')
  const listed = worktrees.find(block => block.split('\0').includes('worktree ' + root))
  if (!listed || listed.split('\0').some(line => line === 'locked' || line.startsWith('locked ') || line.startsWith('prunable'))) {
    throw new Error('This worktree is locked or no longer registered. It cannot be deleted here.')
  }
  for (const block of worktrees) {
    const path = block.split('\0').find(line => line.startsWith('worktree '))?.slice(9)
    if (path && path !== root && within(root, await realpath(path).catch(() => resolve(path)))) {
      throw new Error('Another Git worktree is inside this folder. It cannot be removed here.')
    }
  }
  for (const other of sessions) {
    if (other.agentId === s.agentId || !other.cwd) continue
    const path = await realpath(other.cwd).catch(() => resolve(other.cwd!))
    if (within(root, path) || within(path, root)) throw new Error('Another harness uses this worktree or an overlapping folder. Its files must be kept.')
  }
  for (const protectedPath of [env.ADAPTER_DATA_DIR, env.CLAUDE_PROJECTS_DIR, env.CODEX_HOME,
    env.OPENCODE_DATA_DIR, env.KILO_DATA_DIR, env.HERMES_HOME, env.DEVIN_HOME, env.CURSOR_HOME,
    env.PI_HOME, env.COMMANDCODE_HOME, env.MUSE_HOME, env.GROK_HOME, env.AGY_HOME,
    env.COPILOT_HOME, env.AMP_SESSIONS_DIR, s.transcriptPath, s.codexHome, s.hermesHome]) {
    if (protectedPath && within(root, await realpath(protectedPath).catch(() => resolve(protectedPath)))) {
      throw new Error('Session history or shared application data is inside this worktree. It cannot be removed here.')
    }
  }
  const branch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null)
  if (!branch && await git(root, ['rev-list', '--count', 'HEAD', '--not', '--branches', '--remotes']) !== '0') {
    throw new Error('This detached worktree has commits with no saved branch. Create a branch before deleting it.')
  }
  const head = await git(root, ['rev-parse', 'HEAD'])
  const status = await git(root, ['status', '--porcelain', '--untracked-files=normal'])
  const size = await exec('du', ['-sk', '-P', root], { timeout: 2500, maxBuffer: 4096 }).catch(() => null)
  const kb = size && /^(\d+)\s/.exec(size.stdout)?.[1]
  return { path: root, main, branch, head, bytes: kb ? Number(kb) * 1024 : null,
    dirty: status.length > 0, changes: status.split('\n').filter(Boolean).slice(0, 12),
    signature: createHash('sha256').update(JSON.stringify([root, main, branch, head, status])).digest('hex'),
    dev: folder.dev, ino: folder.ino }
}

export async function removeReviewedWorktree(review: WorktreeReview, s: RegisteredSession, sessions: readonly RegisteredSession[], discardChanges: boolean): Promise<void> {
  const current = await inspectWorktree(s, sessions)
  if (current.path !== review.path || current.dev !== review.dev || current.ino !== review.ino || current.signature !== review.signature) {
    throw new Error('The worktree or its changes changed. Review it again before deleting.')
  }
  if (current.dirty && !discardChanges) throw new Error('Confirm discarding the listed uncommitted files before deleting this worktree.')
  await git(current.main, ['worktree', 'remove', ...(current.dirty && discardChanges ? ['--force'] : []), '--', current.path])
}
