import { execFile } from 'node:child_process'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { CoreApi } from '../core/api.js'
import { fetchStartBase } from '../lib/gitProject.js'
import { otherGitHubTransport, parseProjectFolder, prepareProjectFolder, ProjectFolderError, RepositoryAccessError } from '../lib/projectFolder.js'
import { revokeGitHubToken, swarmGitPrepareEnv } from '../lib/swarmGitHub.js'
import { identifier, object, SuperTabHostError } from './wire.js'
import { decided } from './github.js'
import { repairSwarmCloneTrust, swarmCloneRoot } from './cloneTrust.js'

type Json = Record<string, unknown>
type Backend = (core: CoreApi, method: string, path: string, body?: unknown) => Promise<unknown>

/** A read-only Harness GitHub App token for a queued start's project repository, and whom that work is for. */
export interface StartGitHub { token: string; repository: string; requester: string }

const NO_APP_ON_TEAM = 'This Harness server has no GitHub App, and a Harness Team account has no git login of its own, so it cannot fetch '
  + 'the project. Ask the server\'s administrator to set up the Harness GitHub App (docs/swarm-github-app.md).'

/** A start this machine could not prepare yet, as the Harness server gave no answer (a timeout, a 5xx, no connection), which
 *  decides nothing: its host tries again on its next pass, and fails the start only once it has kept failing for as long as
 *  a refused start (superTabs/machines.ts). Diego's Mac, 2026-10-30: one backend timeout on the token call failed a start. */
export class PrepareRetryError extends Error {}

/**
 * Whether a queued start on this machine is prepared with the Harness GitHub App's token instead of this machine's own git
 * login, and that token (docs/swarm-github-app.md). Asked of the backend, which knows whose project it is: another person's
 * project gets a token that only reads its repository; the machine owner's own project answers none, and the owner's login
 * prepares it as before. A Harness Team account ([team]) has no login, so it always asks for one. A server without the app
 * gives none: an owner's machine prepares as before, as its agents then also use its own login; a team account cannot.
 * Anything the backend refuses is thrown, to fail the start; a call it gave no answer to, as a PrepareRetryError: never this
 * machine's own login instead.
 */
export async function startGitHub(core: CoreApi, row: Json, start: Json,
  deps: { backend: Backend; team: boolean; revoke?: (token: string) => Promise<void> }): Promise<StartGitHub | null> {
  const machineId = core.daemon.machineId()
  if (row.githubApp !== true) {
    if (deps.team) throw new Error(NO_APP_ON_TEAM)
    return null
  }
  if (!identifier(row.tabId) || !identifier(start.id) || !identifier(machineId)) throw new Error('This start cannot be prepared on this machine.')
  let answer: Json
  try {
    answer = object(await deps.backend(core, 'POST', `/api/super-tabs/hosts/${machineId}/starts/${row.tabId}/${start.id}/github-token`, deps.team ? { always: true } : {}))
  } catch (error) {
    const said = `This machine could not get a Harness GitHub App token for this project, so it was not prepared with its owner's own GitHub login either: ${error instanceof Error ? error.message : String(error)}`
    // Only an answer the backend decided is a refusal, by the rule a session's own token follows (github.ts `decided`).
    if (error instanceof SuperTabHostError && decided(error)) throw new Error(said)
    throw new PrepareRetryError(error instanceof SuperTabHostError ? `${said} (${error.code})` : said)
  }
  const requester = object(answer.requestedBy).email
  if (answer.github === true && typeof answer.token === 'string' && typeof answer.repository === 'string' && typeof requester === 'string' && requester) {
    return { token: answer.token, repository: answer.repository, requester }
  }
  // A token in an answer that is not used is revoked, never logged: one that came without its repository or requester failed
  // the start and stayed good for its hour (security review of #2390).
  if (typeof answer.token === 'string') await revokeQuietly(answer.token, deps.revoke)
  if (answer.github === false && !deps.team) return null
  throw new Error('The Harness server answered without a GitHub token for this project.')
}

/** Revokes a read-only clone token; one GitHub will not revoke now still expires within the hour, and fails nothing. */
async function revokeQuietly(token: string, revoke = revokeGitHubToken): Promise<void> {
  await revoke(token).catch(error => console.warn(`[super-tabs] could not revoke the clone token: ${(error as Error).message}`))
}

/**
 * Everything a queued start on this machine needs before its agent is created: the Harness GitHub App's token when the work
 * is another person's (`startGitHub`), the Swarm folder's checkout (`prepareSwarmProject`) and, for a worktree, the branch it
 * starts from (the default one unless it names another) brought up to date with that token, its files included, so the agent's worktree starts from it (the core then fetches nothing itself:
 * core/agents/launches.ts). Returns whom the work is for, for the start; null when this machine's own login is right for it.
 */
export async function prepareSwarmStart(core: CoreApi, row: Json, start: Json,
  deps: { backend: Backend; team: boolean; prepare?: typeof prepareProjectFolder; fetch?: typeof fetchStartBase; revoke?: (token: string) => Promise<void>
    empty?: typeof prepareEmptyProjectFolder }):
  Promise<{ requester: string } | null> {
  const request = object(start.request)
  // A person's one Buddy has no project: its launch makes its folder from the checkouts already here and fetches nothing
  // (buddyHome.ts). Asking for a token anyway was refused with a 404, which failed every such start (2026-11-02).
  if (request.buddyScope === 'swarm') return null
  // Nor does a project with no repository address (task #3211): there is nothing to clone, and the server refuses a token
  // for it. Its work starts in a folder of its own, made without any login (prepareSwarmProject).
  const project = startProject(row, request)
  if (project && typeof object(project.repository).repositoryUrl !== 'string') {
    if (object(row.machine).scope === 'swarm') await prepareSwarmProject(core, row, start, deps.prepare, undefined, deps.empty)
    return null
  }
  const github = await startGitHub(core, row, start, deps)
  const gitEnv = github ? swarmGitPrepareEnv(github.token) : undefined
  try {
    if (object(row.machine).scope === 'swarm') await prepareSwarmProject(core, row, start, deps.prepare, gitEnv, deps.empty)
    if (gitEnv && request.worktree === true && typeof request.cwd === 'string' && isAbsolute(request.cwd)) {
      // The branch the start names, when it names one: a project clone has only the default branch (lib/projectFolder.ts).
      await (deps.fetch ?? fetchStartBase)(resolve(request.cwd), gitEnv, ...(typeof request.branchRef === 'string' ? [request.branchRef] : []))
    }
  } finally {
    // The read-only token is done with: the agent gets a token of its own for its task (superTabs/github.ts).
    if (github) await revokeQuietly(github.token, deps.revoke)
  }
  return github ? { requester: github.requester } : null
}

/** Whether a requested folder names this one. The Lead and the backend join a swarm folder with '/'
 * (routeCommand.ts, backend machines.ts), which on Windows arrives as C:\…\TAB/PROJECT; this machine's
 * own separators are applied here, where the folder is used. Only an absolute folder can match. */
function sameFolder(requested: unknown, folder: unknown): boolean {
  return typeof requested === 'string' && typeof folder === 'string' && isAbsolute(requested) && resolve(requested) === resolve(folder)
}

/** The project a queued start is for, of those this machine was told of. A project session of a person's one Buddy chat
 *  names its project: that chat is in no project's list (backend hostRows.ts). */
function startProject(row: Json, request: Json): Json | undefined {
  const session = object(request.buddySession).projectId
  return (Array.isArray(row.projects) ? row.projects.map(object) : [])
    .find(p => session ? p.id === session : Array.isArray(p.conversationIds) && p.conversationIds.includes(request.conversationId))
}

const NOT_OWN_FOLDER = 'This machine has something that is not this project\'s own folder where its folder goes. Its owner can move it aside, then start again.'

/**
 * [projectId]'s own folder in [root], a Swarm's folder of project checkouts, for a project with no repository (task #3211):
 * made empty the first time, found again after. It is `git init`ed, with no remote and no commit, so the trust step that
 * lets agents work in a Swarm's checkouts (cloneTrust.ts) takes it as it takes a clone, and its work can be committed
 * there. Anything at that place that is not a plain folder there (a link, a file) is refused, never followed or replaced.
 */
export async function prepareEmptyProjectFolder(root: string, projectId: string,
  init: (folder: string) => Promise<unknown> = folder => promisify(execFile)('git', ['init', '--quiet'], { cwd: folder, timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })): Promise<string> {
  await mkdir(root, { recursive: true })
  const folder = join(root, projectId)
  await mkdir(folder).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
  const found = await lstat(folder)
  if (!found.isDirectory() || await realpath(folder) !== join(await realpath(root), projectId)) throw new Error(NOT_OWN_FOLDER)
  const git = await lstat(join(folder, '.git')).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (!git) await init(folder)
  else if (!git.isDirectory()) throw new Error(NOT_OWN_FOLDER)
  return folder
}

/** The owner granted a swarm workspace, not caller-selected filesystem paths.
 * Prepare the queued project's repository there before reserving or launching: a clone, or for a project with no
 * repository its own empty folder ([empty]). */
export async function prepareSwarmProject(core: CoreApi, row: Json, start: Json, prepare = prepareProjectFolder, gitEnv?: NodeJS.ProcessEnv,
  empty = prepareEmptyProjectFolder): Promise<void> {
  const pool = object(row.machine)
  if (pool.scope !== 'swarm' || start.dispatched) return
  const request = object(start.request)
  const project = startProject(row, request)
  if (!project || !identifier(project.id) || !identifier(row.tabId)) throw new Error('This start has no authorized project.')
  const repository = object(project.repository)
  const expectedRoot = swarmCloneRoot(core.dataDir, row.tabId, pool.cwd)
  if (!expectedRoot) throw new Error('Add this machine again to authorize its swarm workspace.')
  if (repository.machineId === core.daemon.machineId() && sameFolder(request.cwd, repository.cwd)) return
  const expected = join(expectedRoot, project.id)
  if (!sameFolder(request.cwd, expected)) throw new Error('The requested folder is outside this project.')
  // Nothing to clone (task #3211): its own empty folder here, with no worktree, which has nothing to branch from. The
  // backend starts it that way (machines.ts noRepositoryStart); an older one asks for a worktree, refused in words.
  if (typeof repository.repositoryUrl !== 'string') {
    if (request.worktree === true) throw new Error('This project has no repository, so its agents on other machines start in an empty folder without a worktree. Start again with worktree off, or share a GitHub repository for the project first.')
    if (await empty(expectedRoot, project.id) !== expected) throw new Error('The prepared folder does not match the authorized project.')
    await repairSwarmCloneTrust(core, row, typeof request.codexHome === 'string' ? request.codexHome : undefined)
    return
  }
  const source = parseProjectFolder({ projectSource: 'remote', repositoryUrl: repository.repositoryUrl })
  if (source?.source !== 'remote') throw new Error('This project repository is unavailable.')
  let cwd: string
  if (gitEnv) {
    // With the app's token: over https alone, whatever address was shared, and no other way in if it is refused.
    const ssh = 'git@github.com:'
    const https = source.repositoryUrl.startsWith(ssh) ? `https://github.com/${source.repositoryUrl.slice(ssh.length)}` : source.repositoryUrl
    try { cwd = await prepare({ ...source, repositoryUrl: https, name: project.id }, { root: expectedRoot, gitEnv }) }
    catch (error) {
      if (error instanceof ProjectFolderError && error.code === 'PROJECT_EXISTS') throw folderLeftBehind(expected)
      if (!(error instanceof ProjectFolderError) || !['CLONE_FAILED', 'CLONE_TIMEOUT'].includes(error.code)) throw error
      throw new ProjectFolderError(error.code, `This machine could not clone the project repository with the Harness GitHub App's token: ${error.message}`)
    }
  } else {
    try { cwd = await prepare({ ...source, name: project.id }, { root: expectedRoot }) }
    catch (error) {
      if (error instanceof ProjectFolderError && error.code === 'PROJECT_EXISTS') throw folderLeftBehind(expected)
      // The shared address names the repository, not how this machine signs in to GitHub: a credential helper for HTTPS,
      // a key for SSH. Desktop shares HTTPS because the daemon's remote no longer says which one the lead used.
      const other = error instanceof RepositoryAccessError ? otherGitHubTransport(source.repositoryUrl) : null
      if (!other) throw error
      try { cwd = await prepare({ ...source, repositoryUrl: other, name: project.id }, { root: expectedRoot }) }
      catch (second) {
        if (!(second instanceof ProjectFolderError) || !['CLONE_FAILED', 'CLONE_TIMEOUT'].includes(second.code)) throw second
        throw new ProjectFolderError('CLONE_FAILED', 'This machine could not access the project repository over HTTPS or SSH. Its owner needs GitHub access to it here: run gh auth login and gh auth setup-git, or add an SSH key to their GitHub account.')
      }
    }
  }
  if (cwd !== expected) throw new Error('The prepared checkout does not match the authorized project.')
  await repairSwarmCloneTrust(core, row, typeof request.codexHome === 'string' ? request.codexHome : undefined)
}

/** A folder in the place of a project's clone that is no clone of its repository: most likely the empty folder its work
 *  used here before its repository was shared (task #3211). Its files are the project's, so it is never removed here. */
function folderLeftBehind(folder: string): ProjectFolderError {
  return new ProjectFolderError('PROJECT_EXISTS', `This machine already has a folder for this project that is not a clone of its repository (${folder}), `
    + 'probably one its agents used before its repository was shared. Move it aside so the repository can be cloned there, then start again.')
}
