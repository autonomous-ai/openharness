import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { projectFolderName, projectFolderSlug } from './agentNames.js'
import { GitProjectError, prepareGitProject, validGitPath } from './gitProject.js'

/** `name` on a new project is what the person called it; without one the folder is named after the
 *  harness and the time. */
export type ProjectFolder = { source: 'new'; name?: string } | { source: 'remote'; repositoryUrl: string; name: string }
  | { source: 'worktree'; gitSource: string; branchRef?: string }
  | { source: 'branch'; gitSource: string; branchRef?: string }

export class ProjectFolderError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

// Same accepted forms as the existing desktop GitHub clone flow. Neither
// credentials nor arbitrary local paths/remote helpers are repository URLs.
export function parseProjectFolder(payload: Record<string, unknown>): ProjectFolder | null {
  if (payload.projectSource === undefined) return null
  if (payload.projectSource === 'worktree' || payload.projectSource === 'branch') {
    const ref = payload.branchRef
    if (!validGitPath(payload.gitSource) || payload.repositoryUrl !== undefined ||
        (ref !== undefined && (typeof ref !== 'string' || ref.length > 1024 || !/^refs\/(heads|remotes)\/[^\s\x00-\x1f\x7f]+$/.test(ref))) ||
        (payload.projectSource === 'branch' && (typeof ref !== 'string' || !ref.startsWith('refs/heads/')))) {
      throw new ProjectFolderError('INVALID_PROJECT_SOURCE', 'Choose a Git project and branch.')
    }
    return { source: payload.projectSource, gitSource: payload.gitSource, ...(typeof ref === 'string' ? { branchRef: ref } : {}) }
  }
  if (payload.projectSource === 'new' && payload.repositoryUrl === undefined) {
    // Slugged again here: the name becomes a path segment, so it is never taken on trust.
    const name = typeof payload.projectName === 'string' ? projectFolderSlug(payload.projectName) : null
    return name ? { source: 'new', name } : { source: 'new' }
  }
  if (payload.projectSource !== 'remote' || typeof payload.repositoryUrl !== 'string') {
    throw new ProjectFolderError('INVALID_PROJECT_SOURCE', 'Choose a project.')
  }
  const raw = payload.repositoryUrl.trim()
  let path: string
  const ssh = raw.startsWith('git@github.com:')
  if (ssh) path = raw.slice('git@github.com:'.length)
  else {
    let url: URL
    try { url = new URL(raw.includes('://') ? raw : `https://github.com/${raw}`) }
    catch { throw new ProjectFolderError('INVALID_REPOSITORY', 'Enter a GitHub URL or owner/repository.') }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash) {
      throw new ProjectFolderError('INVALID_REPOSITORY', 'Enter a GitHub HTTPS or SSH URL, or owner/repository.')
    }
    path = url.pathname.replace(/^\//, '')
  }
  path = path.replace(/\/$/, '').replace(/\.git$/, '')
  const parts = path.split('/')
  if (parts.length !== 2 || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(parts[0]!) ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(parts[1]!) || parts[1] === '.' || parts[1] === '..') {
    throw new ProjectFolderError('INVALID_REPOSITORY', 'Enter a GitHub URL or owner/repository.')
  }
  return { source: 'remote', repositoryUrl: ssh ? `git@github.com:${path}.git` : `https://github.com/${path}.git`, name: parts[1]! }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

export async function prepareProjectFolder(
  project: ProjectFolder,
  options: {
    root?: string
    clone?: (url: string, destination: string) => Promise<void>
    /** Who the harness is ("Codex", "Blender"): a new project folder is named after it and the time. */
    label?: string | null
    now?: () => Date
  } = {},
): Promise<string> {
  const root = options.root ?? join(homedir(), 'harnesses')
  let staging: string | undefined
  try {
    if (project.source === 'worktree' || project.source === 'branch') {
      return await prepareGitProject(project.gitSource, {
        root, worktree: project.source === 'worktree', ref: project.branchRef, label: options.label, now: options.now,
      })
    }
    await mkdir(root, { recursive: true })
    if (project.source === 'new' && project.name) {
      // A name somebody chose is never quietly changed: an existing folder is theirs to pick as an
      // existing project, as a clone's is.
      const folder = join(root, project.name)
      try { await mkdir(folder); return folder }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        throw new ProjectFolderError('PROJECT_EXISTS', `“${project.name}” already exists. Select that folder from your projects.`)
      }
    }
    if (project.source === 'new') {
      // `codex-2026-09-17-15-26` (agentNames.ts): nothing to count. Two in the same minute take the
      // seconds; the same second, a suffix. mkdir reserves the name atomically, so simultaneous
      // desktop and remote creates never share a folder; files and symlinks count as taken.
      const at = (options.now ?? (() => new Date()))()
      const label = options.label?.trim() || 'harness'
      const precise = projectFolderName(label, at, true)
      for (let attempt = 0; ; attempt++) {
        const name = attempt === 0 ? projectFolderName(label, at) : attempt === 1 ? precise : `${precise}-${attempt}`
        const folder = join(root, name)
        try { await mkdir(folder); return folder }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
    }
    const destination = join(root, project.name)
    if (await exists(destination)) throw new ProjectFolderError('PROJECT_EXISTS', `“${project.name}” already exists. Select that folder from your projects.`)
    staging = await mkdtemp(join(root, '.harness-clone-'))
    const checkout = join(staging, 'checkout')
    await (options.clone ?? cloneRepository)(project.repositoryUrl, checkout)
    if (await exists(destination)) throw new ProjectFolderError('PROJECT_EXISTS', `“${project.name}” was created while cloning. Select that folder from your projects.`)
    await rename(checkout, destination)
    return destination
  } catch (error) {
    if (error instanceof GitProjectError) throw new ProjectFolderError(error.code, error.message)
    if (error instanceof ProjectFolderError) throw error
    throw new ProjectFolderError('PROJECT_PREPARATION_FAILED', 'Could not create a project folder on this machine. Browse for a folder you can edit.')
  } finally {
    if (staging) await rm(staging, { force: true, recursive: true }).catch(() => {})
  }
}

/** No shell interpolation or interactive password prompt. Diagnostics stay
 * bounded and private; only actionable, credential-free messages reach the UI. */
function cloneRepository(url: string, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', '--', url, destination], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never',
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -oBatchMode=yes -oConnectTimeout=20' },
    })
    let diagnostic = '', timedOut = false
    let forceKill: ReturnType<typeof setTimeout> | undefined
    const deadline = setTimeout(() => {
      timedOut = true
      child.kill()
      forceKill = setTimeout(() => child.kill('SIGKILL'), 2000)
      forceKill.unref()
    }, 300_000)
    deadline.unref()
    child.stderr?.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(0, 8192) })
    child.on('error', () => {
      clearTimeout(deadline)
      reject(new ProjectFolderError('GIT_UNAVAILABLE', 'Git could not start. Install Git on the selected machine, then retry.'))
    })
    child.on('close', (code) => {
      clearTimeout(deadline)
      clearTimeout(forceKill)
      if (timedOut) reject(new ProjectFolderError('CLONE_TIMEOUT', 'Cloning took too long. Check the connection and retry.'))
      else if (code === 0) resolve()
      else reject(new ProjectFolderError('CLONE_FAILED', /authentication|permission denied|could not read username|repository not found/i.test(diagnostic)
        ? 'Could not access this repository. Check the URL and GitHub access on the selected machine.'
        : 'Could not clone the repository. Check the URL and connection, then retry.'))
    })
  })
}
