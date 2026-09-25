import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { sessionBranchNames } from './agentNames.js'
import { HARNESS_BRANCH_KEY } from './gitProject.js'

const exec = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete (env as NodeJS.ProcessEnv)[key]
  return (await exec('git', ['-C', cwd, ...args], { timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, env }))
    .stdout.replace(/\r?\n$/, '')
}

/** Names that read as a repository's own branches or remotes. A session is never named one of them. */
const RESERVED_BRANCHES = ['main', 'master', 'head', 'origin', 'upstream', 'develop', 'development', 'trunk',
  'staging', 'production', 'prod', 'gh-pages']

/**
 * Names a worktree's branch after its session, once: `brave-otter`, made up at Start, becomes
 * `harness-list` for `Fix the harness list order`, or `login` for `Fix the login page`, when the
 * session first has a name. A taken name falls back to the fuller ones `sessionBranchNames` offers —
 * `login-page`, then a third word of the title — and only then to the shortest with `-2`, `-3`…
 * Names are compared without case: on macOS `Login` and `login` are one file. Only a branch Harness
 * marked as a placeholder, with no upstream, is renamed; the mark goes with it, so a later session name,
 * a push, or a rename by the person or the agent is never overridden. Returns the new name, if any.
 */
export async function nameBranchAfterSession(cwd: string, title: string | null): Promise<string | null> {
  const names = sessionBranchNames(title)
  if (!names.length) return null
  const branch = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null)
  if (!branch) return null
  const mark = await git(cwd, ['config', '--get', `branch.${branch}.${HARNESS_BRANCH_KEY}`]).catch(() => null)
  if (mark !== 'placeholder') return null
  if (await git(cwd, ['config', '--get', `branch.${branch}.remote`]).then(() => true, () => false)) return null
  const base = names[0]!
  // Taken here, or on a remote: a name somebody else pushed is not one to push over.
  const known = new Set([...RESERVED_BRANCHES, ...(await git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']).catch(() => ''))
    .split('\n').flatMap(ref => ref.startsWith('refs/heads/') ? [ref.slice(11)]
      : ref.startsWith('refs/remotes/') ? [ref.split('/').slice(3).join('/')] : [])
    .map(name => name.toLowerCase())])
  const candidates = [...names, ...Array.from({ length: 49 }, (_, i) => `${base}-${i + 2}`)]
  for (const name of candidates) {
    if (name === branch) return null
    if (known.has(name.toLowerCase())) continue
    try { await git(cwd, ['check-ref-format', '--branch', name]) } catch { return null }
    await git(cwd, ['branch', '-m', branch, name])
    await git(cwd, ['config', `branch.${name}.${HARNESS_BRANCH_KEY}`, 'created']).catch(() => '')
    return name
  }
  return null
}
