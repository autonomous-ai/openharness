import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { plausibleBranchName, projectFolderName, projectFolderSlug } from './agentNames.js'
import { GitProjectError, prepareGitProject, validGitPath } from './gitProject.js'
import { scmByKind } from '../scm/scmProjects.js'
import type { ScmLaunchRecord } from '../scm/types.js'

/** `name` on a new project is what the person called it; without one the folder is named after the
 *  harness and the time. `suggested` marks a name the app made up (from the first task — the phone has
 *  no name field), which is numbered past a folder that exists rather than refused. */
export type ProjectFolder = { source: 'new'; name?: string; suggested?: boolean } | { source: 'remote'; repositoryUrl: string; name: string }
  | { source: 'worktree'; gitSource: string; branchRef?: string; branchName?: string; existingBranch?: boolean; placeholder?: boolean; fromDefaultBranch?: boolean
    /** Fetch nothing (gitProject.ts `offline`): set by the daemon for a Swarm start doing another person's work, never by a client. */
    offline?: boolean }
  | { source: 'branch'; gitSource: string; branchRef?: string; branchName?: string }

/** Where this daemon and the desktop app put the workspaces they make. A folder directly inside it is
 *  one of those; anywhere else is a folder the person chose and answers for themselves. */
export function projectsRoot(home = homedir()): string {
  return join(home, process.env.HARNESS_OS === '1' ? 'projects' : 'harnesses')
}

export class ProjectFolderError extends Error {
  /** [folder]: on PROJECT_EXISTS for a name the person typed, the folder already there when it is one this daemon can
   *  open, so an app can offer to start in it once the person chooses that. Never set for anything else. */
  constructor(readonly code: string, message: string, readonly folder?: string) { super(message) }
}

// Same accepted forms as the existing desktop GitHub clone flow. Neither
// credentials nor arbitrary local paths/remote helpers are repository URLs.
export function parseProjectFolder(payload: Record<string, unknown>): ProjectFolder | null {
  if (payload.projectSource === undefined) return null
  if (payload.projectSource === 'worktree' || payload.projectSource === 'branch') {
    const ref = payload.branchRef
    // `branchBase: 'default'` starts a new worktree from the remote's default branch rather than from `HEAD`; it
    // is for a start that names no branch, and for a worktree.
    const base = payload.branchBase
    if (!validGitPath(payload.gitSource) || payload.repositoryUrl !== undefined ||
        (ref !== undefined && (typeof ref !== 'string' || ref.length > 1024 || !/^refs\/(heads|remotes)\/[^\s\x00-\x1f\x7f]+$/.test(ref))) ||
        (base !== undefined && (base !== 'default' || ref !== undefined || payload.projectSource !== 'worktree')) ||
        (payload.projectSource === 'branch' && (typeof ref !== 'string' || !ref.startsWith('refs/heads/')))) {
      throw new ProjectFolderError('INVALID_PROJECT_SOURCE', 'Choose a Git project and branch.')
    }
    const name = payload.branchName
    if (payload.projectSource === 'worktree' && name !== undefined) {
      if (!plausibleBranchName(name) || (payload.branchMode !== undefined && payload.branchMode !== 'existing' && payload.branchMode !== 'placeholder')) {
        throw new ProjectFolderError('INVALID_PROJECT_SOURCE', 'Choose a Git project and branch.')
      }
      return { source: 'worktree', gitSource: payload.gitSource, ...(typeof ref === 'string' ? { branchRef: ref } : {}),
        branchName: name, ...(payload.branchMode === 'existing' ? { existingBranch: true } : {}),
        ...(payload.branchMode === 'placeholder' ? { placeholder: true } : {}),
        ...(base === 'default' ? { fromDefaultBranch: true } : {}) }
    }
    // A new branch for the folder itself, named by `branchRef` too.
    if (payload.projectSource === 'branch' && name !== undefined) {
      if (!plausibleBranchName(name) || ref !== `refs/heads/${name}`) {
        throw new ProjectFolderError('INVALID_PROJECT_SOURCE', 'Choose a Git project and branch.')
      }
      return { source: 'branch', gitSource: payload.gitSource, branchRef: ref, branchName: name }
    }
    return { source: payload.projectSource, gitSource: payload.gitSource, ...(typeof ref === 'string' ? { branchRef: ref } : {}),
      ...(base === 'default' ? { fromDefaultBranch: true } : {}) }
  }
  if (payload.projectSource === 'new' && payload.repositoryUrl === undefined) {
    // Slugged again here: the name becomes a path segment, so it is never taken on trust.
    const name = typeof payload.projectName === 'string' ? projectFolderSlug(payload.projectName) : null
    if (!name) return { source: 'new' }
    return payload.projectNameMode === 'suggested' ? { source: 'new', name, suggested: true } : { source: 'new', name }
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

/** A folder somebody can work in: a directory (a link to one counts) this daemon may list and enter. A file, or a folder
 *  it cannot read, is no project to offer. */
async function openableFolder(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isDirectory()) return false
    await access(path, constants.R_OK | constants.X_OK)
    return true
  } catch { return false }
}

/**
 * One repository however git spells its address: `github.com/owner/repo` for `https://github.com/Owner/Repo.git/`,
 * `git@github.com:owner/repo`, `ssh://git@github.com:22/owner/repo.git` and `git://github.com/owner/repo`, credentials and
 * ports left out. Lowercased: host names are case-insensitive, and so are GitHub's owner and repository names, the only
 * host a clone is asked for (parseProjectFolder). Null for a local path or anything else that names no host.
 */
export function repositoryIdentity(address: string): string | null {
  const raw = address.trim()
  let host: string, path: string
  // scp-like `[user@]host:path`, which has no scheme and no slash before its colon.
  const scp = raw.includes('://') ? null : /^(?:[^@/\s]+@)?([^:/\s]+):([^\s]+)$/.exec(raw)
  if (scp) { host = scp[1]!; path = scp[2]! }
  else {
    let url: URL
    try { url = new URL(raw) } catch { return null }
    if (!['https:', 'http:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:'].includes(url.protocol)) return null
    host = url.hostname
    path = url.pathname
  }
  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
  return host && path ? `${host}/${path}`.toLowerCase() : null
}

/**
 * Whether [folder] is itself a checkout whose `origin` is [repositoryUrl]. Bounded and local: `.git` is looked for before
 * git runs (on a Mac without the Command Line Tools, `git` is Apple's stub, which opens an install dialog), git may not
 * look above [folder] for a repository (GIT_CEILING_DIRECTORIES), and it gets four seconds, as gitProject.ts's reads do.
 * Anything else — no `.git`, another remote, an origin git cannot read — is not that repository.
 */
async function holdsRepository(folder: string, repositoryUrl: string): Promise<boolean> {
  const wanted = repositoryIdentity(repositoryUrl)
  if (!wanted || !await exists(join(folder, '.git')).catch(() => false)) return false
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_OPTIONAL_LOCKS: '0',
    GIT_CEILING_DIRECTORIES: dirname(folder) }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_NAMESPACE', 'GIT_PREFIX']) delete env[key]
  const origin = await new Promise<string | null>((resolve) => {
    execFile('git', ['-c', 'core.fsmonitor=false', '-C', folder, 'remote', 'get-url', 'origin'],
      { env, timeout: 4000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 },
      (error, stdout) => resolve(error ? null : stdout.trim()))
  })
  return origin !== null && repositoryIdentity(origin) === wanted
}

export async function prepareProjectFolder(
  project: ProjectFolder,
  options: {
    root?: string
    clone?: (url: string, destination: string, env?: NodeJS.ProcessEnv) => Promise<void>
    /** The environment a clone's git runs in instead of the daemon's own: a Swarm host's, with the Harness GitHub App's
     *  token for the project (lib/swarmGitHub.ts `swarmGitPrepareEnv`). */
    gitEnv?: NodeJS.ProcessEnv
    /** Who the harness is ("Codex", "Blender"): a new project folder is named after it and the time. */
    label?: string | null
    now?: () => Date
    /** Told, before the folder is returned, what the SCM that made an isolated workspace needs on its
     *  every relaunch (`scmLaunch` on the registry row). A new folder, a clone or the folder itself on a
     *  branch reports nothing. A callback rather than a wider return so the folder stays the answer
     *  here, for every caller. */
    onPrepared?: (prepared: { cwd: string; scmLaunchRecord: ScmLaunchRecord }) => void
  } = {},
): Promise<string> {
  const root = options.root ?? projectsRoot()
  let staging: string | undefined
  try {
    if (project.source === 'worktree') {
      // The isolated-workspace path, through the SCM seam. The git implementation makes exactly the
      // prepareGitProject call this used to make.
      const { cwd, launchRecord } = await scmByKind('git')!.prepareIsolated(project.gitSource, {
        root, base: project.branchRef, ...(project.fromDefaultBranch ? { fromDefaultBranch: true } : {}), ...(project.offline ? { offline: true } : {}),
        ...(project.branchName ? { name: project.branchName, existing: project.existingBranch === true, placeholder: project.placeholder === true } : {}),
      })
      options.onPrepared?.({ cwd, scmLaunchRecord: launchRecord })
      return cwd
    }
    if (project.source === 'branch') {
      // The folder itself, on a branch: git's own in-place mode, not an isolated workspace.
      return await prepareGitProject(project.gitSource, {
        root, worktree: false, ref: project.branchRef,
        ...(project.branchName ? { branchName: project.branchName } : {}),
      })
    }
    await mkdir(root, { recursive: true })
    if (project.source === 'new' && project.name) {
      // A name somebody chose is never quietly changed: an existing folder is theirs to pick as an
      // existing project, as a clone's is. A suggested one is only a guess, so a second "robot" task
      // gets `robot-2` beside the first rather than an error (openharness#94).
      for (let attempt = 1; ; attempt++) {
        const name = attempt === 1 ? project.name : `${project.name.slice(0, 60)}-${attempt}`
        const folder = join(root, name)
        try { await mkdir(folder); return folder }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          if (!project.suggested) {
            // Refused, and the folder told, so an app can offer "Use the existing folder" (used only once the person
            // picks it). PROJECT_EXISTS was 4 of 7 failed starts on Oct 18 (CLI 0.4.18), all from the apps, which
            // had nothing to offer but retyping the name as a path.
            throw new ProjectFolderError('PROJECT_EXISTS', `“${project.name}” already exists. Select that folder from your projects.`,
              await openableFolder(folder) ? folder : undefined)
          }
        }
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
    // A checkout of the very repository asked for is that project, already there: started in, never cloned again. It
    // was refused as PROJECT_EXISTS (4 of 7 failed starts on Oct 18, CLI 0.4.18), a failed start for asking twice.
    // Anything else there (another repository, a folder of files) is still the person's, and still refused.
    if (await exists(destination)) {
      if (await holdsRepository(destination, project.repositoryUrl)) return destination
      throw new ProjectFolderError('PROJECT_EXISTS', `“${project.name}” already exists. Select that folder from your projects.`)
    }
    staging = await mkdtemp(join(root, '.harness-clone-'))
    const checkout = join(staging, 'checkout')
    await (options.clone ?? cloneRepository)(project.repositoryUrl, checkout, options.gitEnv)
    if (await exists(destination)) {
      // Another start cloned the same repository meanwhile: that one is kept and this staging goes (below).
      if (await holdsRepository(destination, project.repositoryUrl)) return destination
      throw new ProjectFolderError('PROJECT_EXISTS', `“${project.name}” was created while cloning. Select that folder from your projects.`)
    }
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
function cloneRepository(url: string, destination: string, gitEnv?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const base = gitEnv ?? process.env
    const child = spawn('git', ['clone', '--', url, destination], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...base, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never',
        GIT_SSH_COMMAND: base.GIT_SSH_COMMAND ?? 'ssh -oBatchMode=yes -oConnectTimeout=20' },
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
      else reject(cloneFailure(diagnostic))
    })
  })
}

/** CLONE_FAILED because the host refused this machine's credentials, not because of the network or the URL. The code
 *  stays CLONE_FAILED for the apps; a caller that knows another way in can tell the two apart. */
export class RepositoryAccessError extends ProjectFolderError {}

/** What git's diagnostic of a failed clone becomes. A private GitHub repository answers "not found" without access. */
export function cloneFailure(diagnostic: string): ProjectFolderError {
  return /authentication|permission denied|could not read username|repository not found/i.test(diagnostic)
    ? new RepositoryAccessError('CLONE_FAILED', 'Could not access this repository. Check the URL and GitHub access on the selected machine.')
    : new ProjectFolderError('CLONE_FAILED', 'Could not clone the repository. Check the URL and connection, then retry.')
}

/** The same GitHub repository over the other transport, for parseProjectFolder's two forms; null for anything else. */
export function otherGitHubTransport(url: string): string | null {
  const ssh = /^git@github\.com:([^/\s]+\/[^/\s]+)$/.exec(url)
  if (ssh) return `https://github.com/${ssh[1]}`
  const https = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)$/.exec(url)
  return https ? `git@github.com:${https[1]}` : null
}
