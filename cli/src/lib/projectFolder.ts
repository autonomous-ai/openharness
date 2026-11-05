import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { plausibleBranchName, projectFolderName, projectFolderSlug } from './agentNames.js'
import { GitProjectError, prepareGitProject, stopTree, validGitPath } from './gitProject.js'
import { cloneAttempts, isGitHubHost, parseGitHubRepository, resolvedRepositoryIdentity } from './githubRepository.js'
import { githubAliases, resolveHost } from './sshHosts.js'
import { ownProcessGroup } from './windows/noWindow.js'
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

// The desktop app's GitHub forms (githubRepository.ts, held to the same vectors). Neither credentials nor arbitrary local
// paths/remote helpers are repository URLs.
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
  const repository = parseGitHubRepository(raw)
  if (!repository) {
    throw new ProjectFolderError('INVALID_REPOSITORY', raw.includes('://') || raw.startsWith('git@')
      ? 'Enter a GitHub HTTPS or SSH URL, or owner/repository.' : 'Enter a GitHub URL or owner/repository.')
  }
  return { source: 'remote', repositoryUrl: repository.url, name: repository.name }
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

export { repositoryIdentity } from './githubRepository.js'

type HostResolver = (alias: string) => Promise<string | null>

/**
 * Whether [folder] is itself a checkout whose `origin` is [repositoryUrl]. Bounded and local: `.git` is looked for before
 * git runs (on a Mac without the Command Line Tools, `git` is Apple's stub, which opens an install dialog), git may not
 * look above [folder] for a repository (GIT_CEILING_DIRECTORIES), and it gets four seconds, as gitProject.ts's reads do.
 * Anything else — no `.git`, another remote, an origin git cannot read — is not that repository. An SSH alias on either
 * side is read as the host it names, so a checkout cloned as `git@gh-work:org/repo` is the browser link's repository.
 */
async function holdsRepository(folder: string, repositoryUrl: string, resolveAlias: HostResolver): Promise<boolean> {
  const wanted = await resolvedRepositoryIdentity(repositoryUrl, resolveAlias)
  if (!wanted || !await exists(join(folder, '.git')).catch(() => false)) return false
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_OPTIONAL_LOCKS: '0',
    GIT_CEILING_DIRECTORIES: dirname(folder) }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_NAMESPACE', 'GIT_PREFIX']) delete env[key]
  const origin = await new Promise<string | null>((resolve) => {
    execFile('git', ['-c', 'core.fsmonitor=false', '-C', folder, 'remote', 'get-url', 'origin'],
      { env, timeout: 4000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 },
      (error, stdout) => resolve(error ? null : stdout.trim()))
  })
  return origin !== null && await resolvedRepositoryIdentity(origin, resolveAlias) === wanted
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
    /** A clone GitHub refuses tries the other transport, then this computer's SSH aliases for github.com
     *  (sshHosts.ts), stopping at the first that works: a person who reaches a private repository only over SSH, or
     *  only through a second account's key, can paste the browser's link. It is also what lets an address name an
     *  alias at all. Set only for the computer owner's own start (core/agents/launches.ts). Off, one attempt and no
     *  alias: a Swarm's or a contribution's start, whose address someone else chose, never picks the owner's accounts. */
    cloneFallback?: boolean
    /** Told which address a clone used, when it cloned; `alias` when that was an SSH alias. */
    onCloned?: (clone: { url: string; alias?: string }) => void
    resolveHost?: HostResolver
    githubAliases?: () => Promise<string[]>
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
    const repository = parseGitHubRepository(project.repositoryUrl)
    if (!repository) throw new ProjectFolderError('INVALID_REPOSITORY', 'Enter a GitHub URL or owner/repository.')
    const resolve = options.resolveHost ?? resolveHost
    // An alias picks one of this computer's GitHub accounts, so only its owner's own start may name one. A Swarm Lead or
    // a contribution sets the address of a project that starts on someone else's computer: an alias there would choose
    // that owner's second account, and "isn't a GitHub host" would tell the Lead which aliases exist. Such a start is
    // refused in the same words as any other address, before ssh is asked anything.
    if (repository.alias && !options.cloneFallback) {
      throw new ProjectFolderError('INVALID_REPOSITORY', 'Enter a GitHub HTTPS or SSH URL, or owner/repository.')
    }
    // An alias names a host in THIS computer's SSH configuration, so it is checked here, where git will use it.
    if (repository.alias && !isGitHubHost(await resolve(repository.alias))) {
      throw new ProjectFolderError('INVALID_REPOSITORY', `“${repository.alias}” isn't a GitHub host on this machine.`)
    }
    const destination = join(root, project.name)
    // A checkout of the very repository asked for is that project, already there: started in, never cloned again. It
    // was refused as PROJECT_EXISTS (4 of 7 failed starts on Oct 18, CLI 0.4.18), a failed start for asking twice.
    // Anything else there (another repository, a folder of files) is still the person's, and still refused.
    if (await exists(destination)) {
      if (await holdsRepository(destination, project.repositoryUrl, resolve)) return destination
      throw new ProjectFolderError('PROJECT_EXISTS', `“${project.name}” already exists. Select that folder from your projects.`)
    }
    // The aliases are read only once GitHub has refused: a computer that clones at once never runs ssh for them.
    // cloneAttempts with them keeps the order it had without them, so the attempts so far stay a prefix.
    let attempts = options.cloneFallback ? cloneAttempts(repository, []) : [repository.url]
    let aliasesRead = !options.cloneFallback
    let used = repository.url
    let hostKeyFailure: RepositoryHostKeyError | undefined
    for (let index = 0; ; index++) {
      used = attempts[index]!
      if (staging) await rm(staging, { force: true, recursive: true }).catch(() => {})
      staging = await mkdtemp(join(root, '.harness-clone-'))
      try {
        await (options.clone ?? cloneRepository)(used, join(staging, 'checkout'), options.gitEnv)
        if (index > 0) logAttempt(repository.owner, repository.name, used, 'cloned')
        break
      } catch (error) {
        logAttempt(repository.owner, repository.name, used, error instanceof ProjectFolderError ? error instanceof RepositoryAccessError ? 'refused' : error.code : 'failed')
        // Only a refusal or an untrusted host key is worth another way in: a network failure or a timeout would fail every
        // one of them. An alias may carry its own HostKeyAlias, and https never looks at ssh's keys.
        if (error instanceof RepositoryHostKeyError) hostKeyFailure ??= error
        else if (!(error instanceof RepositoryAccessError)) throw error
        if (!aliasesRead) { aliasesRead = true; attempts = cloneAttempts(repository, await (options.githubAliases ?? githubAliases)()) }
        // What the person can act on: a machine that may have access once it trusts the key has not been refused.
        if (index === attempts.length - 1) throw hostKeyFailure ?? error
      }
    }
    const checkout = join(staging, 'checkout')
    if (await exists(destination)) {
      // Another start cloned the same repository meanwhile: that one is kept and this staging goes (below).
      if (await holdsRepository(destination, project.repositoryUrl, resolve)) return destination
      throw new ProjectFolderError('PROJECT_EXISTS', `“${project.name}” was created while cloning. Select that folder from your projects.`)
    }
    await rename(checkout, destination)
    const alias = parseGitHubRepository(used)?.alias
    options.onCloned?.({ url: used, ...(alias ? { alias } : {}) })
    return destination
  } catch (error) {
    if (error instanceof GitProjectError) throw new ProjectFolderError(error.code, error.message)
    if (error instanceof ProjectFolderError) throw error
    throw new ProjectFolderError('PROJECT_PREPARATION_FAILED', 'Could not create a project folder on this machine. Browse for a folder you can edit.')
  } finally {
    if (staging) await rm(staging, { force: true, recursive: true }).catch(() => {})
  }
}

/** One line per clone attempt that failed, or that worked after another had: which way in (https, ssh, or the alias) and
 *  how it ended. Never git's own words, which may quote a credential helper. */
function logAttempt(owner: string, name: string, url: string, outcome: string): void {
  const via = url.startsWith('https://') ? 'https' : url.startsWith('git@github.com:') ? 'ssh' : `ssh alias ${parseGitHubRepository(url)?.alias}`
  console.info(`[project] clone ${owner}/${name} over ${via}: ${outcome}`)
}

/** Every branch a fetch sees, as a full clone's `origin` has: a single-branch clone writes only its own. */
const ALL_BRANCHES = '+refs/heads/*:refs/remotes/origin/*'

/** How long a clone may go without git reporting any progress before it is given up. Git reports at least once a second
 *  while objects arrive (`--progress`); the longest silence measured cloning lampOS was 4.4 s. A clone that keeps
 *  progressing is never cut off, however long it takes on a slow connection. */
export const CLONE_STALL_MS = 120_000

/** No shell interpolation or interactive password prompt. Diagnostics stay
 * bounded and private; only actionable, credential-free messages reach the UI.
 *
 * Blob-less and single-branch: the default branch with its whole history, file contents fetched as they are needed (the
 * checkout's own, then whatever `blame` or another branch's checkout reads). lampOS (576 MB pack, about 4,400 branches)
 * took 48 s in full on MACs-Mac-Studio and longer than the 5 minutes once allowed on a slower Mac; blob-less, 6 s. The
 * fetch rule is then widened to every branch, so `git fetch origin X && git checkout X` works as in a full clone.
 * [options] are for tests: `git` the command, `stallMs` the no-progress window. */
export function cloneRepository(url: string, destination: string, gitEnv?: NodeJS.ProcessEnv,
  options: { git?: string; stallMs?: number } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const base = gitEnv ?? process.env
    const git = options.git ?? 'git'
    const env = { ...base, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never',
      GIT_SSH_COMMAND: base.GIT_SSH_COMMAND ?? 'ssh -oBatchMode=yes -oConnectTimeout=20' }
    // Its own process group, so a stalled clone's remote helper and index-pack stop with it.
    const child = spawn(git, ['clone', '--progress', '--filter=blob:none', '--single-branch', '--', url, destination], {
      stdio: ['ignore', 'ignore', 'pipe'], env, ...ownProcessGroup(),
    })
    let diagnostic = '', stalled = false
    const stall = setTimeout(() => {
      stalled = true
      void stopTree(child.pid).then(problem => { if (problem) console.error(`[project] could not stop a stalled clone: ${problem}`) })
    }, options.stallMs ?? CLONE_STALL_MS)
    stall.unref()
    child.stderr?.on('data', (chunk: Buffer) => {
      if (!stalled) stall.refresh()
      diagnostic = (diagnostic + chunk.toString()).slice(-8192)
    })
    child.on('error', () => {
      clearTimeout(stall)
      reject(new ProjectFolderError('GIT_UNAVAILABLE', 'Git could not start. Install Git on the selected machine, then retry.'))
    })
    child.on('close', (code) => {
      clearTimeout(stall)
      if (stalled) {
        const last = lastLine(diagnostic)
        reject(new ProjectFolderError('CLONE_TIMEOUT', `Cloning stopped making progress${last ? ` (git's last words: ${last})` : ''}. Check the connection and retry.`))
      }
      else if (code !== 0) reject(cloneFailure(diagnostic))
      else {
        execFile(git, ['-C', destination, 'config', 'remote.origin.fetch', ALL_BRANCHES], { env, timeout: 10_000, killSignal: 'SIGKILL' },
          error => error ? reject(new ProjectFolderError('CLONE_FAILED', 'Could not clone the repository. Check the URL and connection, then retry.')) : resolve())
      }
    })
  })
}

/** CLONE_FAILED because the host refused this machine's credentials, not because of the network or the URL. The code
 *  stays CLONE_FAILED for the apps; a caller that knows another way in can tell the two apart. */
export class RepositoryAccessError extends ProjectFolderError {}

/** CLONE_FAILED because ssh stopped before GitHub was asked: this machine does not trust the host key it was shown. Not a
 *  refusal, so the apps never call it "No access", and it may mean the key changed. Another way in checks its own key. */
export class RepositoryHostKeyError extends ProjectFolderError {}

/** Credentials and tokens cut from a line of git's, which may quote the address it used or a helper's answer. */
function plain(line: string): string {
  return line.replace(/\/\/[^/@\s]*@/g, '//').replace(/\b(gh[pousr]_|github_pat_)\w+/g, '').replace(/x-access-token\S*/gi, '').trim().slice(0, 200)
}
/** The last thing git said, a progress line or not (carriage returns are its progress redraws). */
function lastLine(diagnostic: string): string {
  return plain(diagnostic.split(/[\r\n]+/).map(line => line.trim()).filter(Boolean).at(-1) ?? '')
}
/** Why git says it failed: its last `fatal:` or `error:` line, else nothing. Six first starts on 11-05 failed with "Could not
 *  clone the repository" and no way to tell GitHub's 5xx from a DNS failure. */
function gitsReason(diagnostic: string): string {
  const lines = diagnostic.split(/[\r\n]+/).map(line => /^(?:fatal|error):\s*(.+)$/i.exec(line.trim())?.[1]).filter((line): line is string => !!line)
  return plain(lines.at(-1) ?? '')
}

/** What git's diagnostic of a failed clone becomes. A private GitHub repository answers "not found" without access. */
export function cloneFailure(diagnostic: string): ProjectFolderError {
  // First: ssh's warning about a changed key also says "Password authentication is disabled".
  if (/host key verification failed/i.test(diagnostic)) {
    return new RepositoryHostKeyError('CLONE_FAILED', "The selected machine doesn't trust GitHub's SSH host key. Check it by connecting once with ssh -T git@github.com, then retry.")
  }
  return /authentication|permission denied|could not read username|repository not found/i.test(diagnostic)
    ? new RepositoryAccessError('CLONE_FAILED', 'Could not access this repository. Check the URL and GitHub access on the selected machine.')
    : new ProjectFolderError('CLONE_FAILED', `Could not clone the repository${gitsReason(diagnostic) ? ` (git said: ${gitsReason(diagnostic)})` : ''}. Check the URL and connection, then retry.`)
}

/** The same GitHub repository over the other transport, for parseProjectFolder's two forms; null for anything else. */
export function otherGitHubTransport(url: string): string | null {
  const ssh = /^git@github\.com:([^/\s]+\/[^/\s]+)$/.exec(url)
  if (ssh) return `https://github.com/${ssh[1]}`
  const https = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)$/.exec(url)
  return https ? `git@github.com:${https[1]}` : null
}
