/** Resolve a host-authorized workspace locally; remotes never establish memory ownership. */
import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import { MemoryError } from './types.js'

const exec = promisify(execFile)
export interface ProjectLocator { kind: 'git_common_directory' | 'directory'; path: string }
export interface ProjectContext {
  locator: ProjectLocator
  workspacePath: string
  branchRef: string | null
  revision: string | null
}

/** The caller supplies an authorized workspace root, not a path proposed by an LLM. */
export async function locateProject(workspace: string): Promise<ProjectContext> {
  if (!isAbsolute(workspace) || /[\x00-\x1f\x7f]/.test(workspace) || workspace.length > 4096) throw new MemoryError('invalid_workspace')
  const path = await realpath(workspace).catch(() => null)
  if (!path || !(await stat(path)).isDirectory()) throw new MemoryError('workspace_unavailable')
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GCM_INTERACTIVE: 'Never' })
  const git = async (args: string[]): Promise<string> => (await exec('git',
    ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', path, ...args],
    { env, timeout: 2_000, killSignal: 'SIGKILL', maxBuffer: 32_000 })).stdout.trimEnd()
  let common: string
  try { common = await git(['rev-parse', '--git-common-dir']) }
  catch (error) {
    const failure = error as { code?: number | string; killed?: boolean; stderr?: string }
    if (failure.code === 128 && !failure.killed && /not a git repository/i.test(failure.stderr ?? '')) {
      return { locator: { kind: 'directory', path }, workspacePath: path, branchRef: null, revision: null }
    }
    throw new MemoryError('project_identity_unavailable')
  }
  const locatorPath = await realpath(resolve(path, common)).catch(() => null)
  if (!locatorPath) throw new MemoryError('project_identity_unavailable')
  const [root, branchRef, revision] = await Promise.all([
    git(['rev-parse', '--show-toplevel']),
    git(['symbolic-ref', '--quiet', 'HEAD']).catch(() => null),
    git(['rev-parse', '--verify', 'HEAD']).catch(() => null),
  ])
  return { locator: { kind: 'git_common_directory', path: locatorPath }, workspacePath: await realpath(root), branchRef, revision }
}
