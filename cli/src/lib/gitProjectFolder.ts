/**
 * The project folders git makes for a create: a clone, a worktree, or the folder itself on another branch. They run in
 * the workspaces service (services/workspaces.ts), in the edge host: a clone took minutes and ran `git`, `ssh` and its
 * helpers as children of the core, the most trusted process (the audit of 2026-11-12, security item 5). The core parses
 * the request and makes a new empty folder itself (lib/projectFolder.ts), and asks for these.
 */
import { execFile, spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PreparedFolder } from '../core/api.js'
import { GitProjectError, prepareGitProject, stopTree } from './gitProject.js'
import { cloneAttempts, isGitHubHost, parseGitHubRepository, resolvedRepositoryIdentity } from './githubRepository.js'
import { ProjectFolderError, projectsRoot, type GitProjectFolder } from './projectFolder.js'
import { githubAliases, resolveHost } from './sshHosts.js'
import { ownProcessGroup } from './windows/noWindow.js'
import { scmByKind } from '../scm/scmProjects.js'
import type { ScmLaunchRecord } from '../scm/types.js'

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

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

export async function prepareGitFolder(
  project: GitProjectFolder,
  options: {
    root?: string
    clone?: (url: string, destination: string) => Promise<void>
    /** Told, before the folder is returned, what the SCM that made an isolated workspace needs on its
     *  every relaunch (`scmLaunch` on the registry row). A clone or the folder itself on a branch reports
     *  nothing. A callback rather than a wider return so the folder stays the answer here, for every caller. */
    onPrepared?: (prepared: { cwd: string; scmLaunchRecord: ScmLaunchRecord }) => void
    /** A clone GitHub refuses tries the other transport, then this computer's SSH aliases for github.com
     *  (sshHosts.ts), stopping at the first that works: a person who reaches a private repository only over SSH, or
     *  only through a second account's key, can paste the browser's link. It is also what lets an address name an
     *  alias at all. Set only for the computer owner's own start, which the core says (core/agents/launches.ts). Off,
     *  one attempt and no alias: a start whose address someone else chose never picks the owner's accounts. */
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
        root, base: project.branchRef,
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
    const repository = parseGitHubRepository(project.repositoryUrl)
    if (!repository) throw new ProjectFolderError('INVALID_REPOSITORY', 'Enter a GitHub URL or owner/repository.')
    const resolve = options.resolveHost ?? resolveHost
    // An alias picks one of this computer's GitHub accounts, so only its owner's own start may name one. Someone else
    // setting the address of a project that starts here would choose the owner's second account, and "isn't a GitHub
    // host" would tell them which aliases exist. Such a start is refused in the same words as any other address, before
    // ssh is asked anything.
    if (repository.alias && !options.cloneFallback) {
      throw new ProjectFolderError('INVALID_REPOSITORY', 'Enter a GitHub HTTPS or SSH URL, or owner/repository.')
    }
    // An alias names a host in THIS computer's SSH configuration, so it is checked here, where git will use it.
    if (repository.alias && !isGitHubHost(await resolve(repository.alias))) {
      throw new ProjectFolderError('INVALID_REPOSITORY', `“${repository.alias}” isn't a GitHub host on this machine.`)
    }
    // The folder is named from the address itself, as the core's parse named it (lib/projectFolder.ts): never a name
    // that could climb out of the projects folder.
    const destination = join(root, repository.name)
    // A checkout of the very repository asked for is that project, already there: started in, never cloned again. It
    // was refused as PROJECT_EXISTS (4 of 7 failed starts on Oct 18, CLI 0.4.18), a failed start for asking twice.
    // Anything else there (another repository, a folder of files) is still the person's, and still refused.
    if (await exists(destination)) {
      if (await holdsRepository(destination, project.repositoryUrl, resolve)) return destination
      throw new ProjectFolderError('PROJECT_EXISTS', `“${repository.name}” already exists. Select that folder from your projects.`)
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
        await (options.clone ?? cloneRepository)(used, join(staging, 'checkout'))
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
      throw new ProjectFolderError('PROJECT_EXISTS', `“${repository.name}” was created while cloning. Select that folder from your projects.`)
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

/** [prepareGitFolder] as the workspaces service answers the core (core/api.ts `WorkspacesPort.prepareFolder`): the folder,
 *  with what its relaunch needs and the alias a clone got in through, or the refusal in the create's own code and words.
 *  Never a throw, which would count against the service. */
export async function gitFolderAnswer(project: GitProjectFolder, options: { cloneFallback: boolean }): Promise<PreparedFolder> {
  let scmLaunchRecord: ScmLaunchRecord | undefined, alias: string | undefined
  try {
    const cwd = await prepareGitFolder(project, { cloneFallback: options.cloneFallback,
      onPrepared: prepared => { scmLaunchRecord = prepared.scmLaunchRecord }, onCloned: clone => { alias = clone.alias } })
    return { ok: true, cwd, ...(scmLaunchRecord ? { scmLaunchRecord } : {}), ...(alias ? { clonedVia: { alias } } : {}) }
  } catch (error) {
    // prepareGitFolder words every failure as a ProjectFolderError.
    const refusal = error as ProjectFolderError
    return { ok: false, error: refusal.code, detail: refusal.message, ...(error instanceof RepositoryAccessError ? { access: 'denied' as const } : {}) }
  }
}

const strings = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  keys.every(key => value[key] === undefined || typeof value[key] === 'string')

/** The folder a core asked for, as the workspaces' process reads it off the link: one of git's three sources, its fields
 *  of the types they have, or null. What each names is checked where it is used (prepareGitProject, the address's parse). */
export function gitProjectFolderOf(value: unknown): GitProjectFolder | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.source === 'remote') return typeof v.repositoryUrl === 'string' && typeof v.name === 'string' ? { source: 'remote', repositoryUrl: v.repositoryUrl, name: v.name } : null
  if ((v.source !== 'worktree' && v.source !== 'branch') || typeof v.gitSource !== 'string' || !strings(v, ['branchRef', 'branchName'])) return null
  const branch = { gitSource: v.gitSource, ...(typeof v.branchRef === 'string' ? { branchRef: v.branchRef } : {}), ...(typeof v.branchName === 'string' ? { branchName: v.branchName } : {}) }
  if (v.source === 'branch') return { source: 'branch', ...branch }
  return { source: 'worktree', ...branch, ...(v.existingBranch === true ? { existingBranch: true } : {}), ...(v.placeholder === true ? { placeholder: true } : {}) }
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

/** How often a clone's pack files are looked at, for progress git does not say. After its history, a blob-less clone's
 *  checkout fetches the files in a fetch of its own that shows progress only to a terminal: creating a project of lampOS on
 *  Mac 2, git said nothing after "Resolving deltas: 100% (70463/70463), done." for longer than [CLONE_STALL_MS] while that
 *  pack was still arriving, and the clone was cut off (anh Dee, 2026-11-10). A pack that grows is progress too. */
export const CLONE_LOOK_MS = 5_000

/** The bytes of [destination]'s pack files, a fetch's objects as they arrive; 0 before git has made any. */
async function packBytes(destination: string): Promise<number> {
  const folder = join(destination, '.git', 'objects', 'pack')
  const names = await readdir(folder).catch(() => [] as string[])
  let total = 0
  for (const name of names) total += await stat(join(folder, name)).then(file => file.size, () => 0)
  return total
}

/** No shell interpolation or interactive password prompt. Diagnostics stay
 * bounded and private; only actionable, credential-free messages reach the UI.
 *
 * Blob-less and single-branch: the default branch with its whole history, file contents fetched as they are needed (the
 * checkout's own, then whatever `blame` or another branch's checkout reads). lampOS (576 MB pack, about 4,400 branches)
 * took 48 s in full on MACs-Mac-Studio and longer than the 5 minutes once allowed on a slower Mac; blob-less, 6 s. The
 * fetch rule is then widened to every branch, so `git fetch origin X && git checkout X` works as in a full clone.
 * [options] are for tests: `git` the command, `stallMs` the no-progress window, `lookMs` how often its pack is looked at. */
export function cloneRepository(url: string, destination: string, gitEnv?: NodeJS.ProcessEnv,
  options: { git?: string; stallMs?: number; lookMs?: number } = {}): Promise<void> {
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
    let packed = 0
    const look = setInterval(() => {
      void packBytes(destination).then(bytes => {
        if (bytes > packed && !stalled) stall.refresh()
        packed = Math.max(packed, bytes)
      })
    }, options.lookMs ?? CLONE_LOOK_MS)
    look.unref()
    child.stderr?.on('data', (chunk: Buffer) => {
      if (!stalled) stall.refresh()
      diagnostic = (diagnostic + chunk.toString()).slice(-8192)
    })
    child.on('error', () => {
      clearTimeout(stall)
      clearInterval(look)
      reject(new ProjectFolderError('GIT_UNAVAILABLE', 'Git could not start. Install Git on the selected machine, then retry.'))
    })
    child.on('close', (code) => {
      clearTimeout(stall)
      clearInterval(look)
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
