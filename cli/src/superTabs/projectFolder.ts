import { execFile } from 'node:child_process'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { CoreApi } from '../core/api.js'
import { otherGitHubTransport, parseProjectFolder, prepareProjectFolder, ProjectFolderError, RepositoryAccessError } from '../lib/projectFolder.js'
import { identifier, object } from './wire.js'
import { repairSwarmCloneTrust, swarmCloneRoot } from './cloneTrust.js'

type Json = Record<string, unknown>

/**
 * Everything a queued start on this machine needs before its agent is created: the Swarm folder's checkout of the project
 * (`prepareSwarmProject`), cloned with this machine's own GitHub login. The owner's own checkout and the folders of agents
 * that start in no project are left as they are.
 */
export async function prepareSwarmStart(core: CoreApi, row: Json, start: Json,
  deps: { prepare?: typeof prepareProjectFolder; empty?: typeof prepareEmptyProjectFolder } = {}): Promise<void> {
  const request = object(start.request)
  // A Regular agent (backend agent.new, task #4116) starts in no project, in a folder of its own (start.ts). A
  // Member's start is a Regular agent's in its person's chat, but it sets its project up there (task #4698), so it is prepared.
  if (request.regular === true && !memberProject(request)) return
  if (object(row.machine).scope === 'swarm') await prepareSwarmProject(core, row, start, deps.prepare, deps.empty)
}

/** Whether a requested folder names this one. The backend joins a swarm folder with '/'
 * (backend machines.ts), which on Windows arrives as C:\…\TAB/PROJECT; this machine's
 * own separators are applied here, where the folder is used. Only an absolute folder can match. */
function sameFolder(requested: unknown, folder: unknown): boolean {
  return typeof requested === 'string' && typeof folder === 'string' && isAbsolute(requested) && resolve(requested) === resolve(folder)
}

/** The project a Member's start sets up (task #4698): its person's chat is in no project's list, so the start names it. */
const memberProject = (request: Json): string | undefined => {
  const id = object(request.member).projectId
  return typeof id === 'string' && id ? id : undefined
}

/** The project a queued start is for, of those this machine was told of. A Member's start names its project: its chat is in no
 *  project's list (backend hostRows.ts). */
function startProject(row: Json, request: Json): Json | undefined {
  const named = memberProject(request)
  return (Array.isArray(row.projects) ? row.projects.map(object) : [])
    .find(p => named ? p.id === named : Array.isArray(p.conversationIds) && p.conversationIds.includes(request.conversationId))
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
  // Its owner's alone, as the work in it is (security review 1 of #3137).
  await mkdir(folder, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
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
export async function prepareSwarmProject(core: CoreApi, row: Json, start: Json, prepare = prepareProjectFolder,
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
  if (cwd !== expected) throw new Error('The prepared checkout does not match the authorized project.')
  await repairSwarmCloneTrust(core, row, typeof request.codexHome === 'string' ? request.codexHome : undefined)
}

/** A folder in the place of a project's clone that is no clone of its repository: most likely the empty folder its work
 *  used here before its repository was shared (task #3211). Its files are the project's, so it is never removed here. */
function folderLeftBehind(folder: string): ProjectFolderError {
  return new ProjectFolderError('PROJECT_EXISTS', `This machine already has a folder for this project that is not a clone of its repository (${folder}), `
    + 'probably one its agents used before its repository was shared. Move it aside so the repository can be cloned there, then start again.')
}
