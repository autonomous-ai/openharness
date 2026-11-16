/**
 * The folder a create asks for (`agent_create`'s `projectSource`), as the core reads it: parsed and checked here, and a
 * new empty one made here. A clone, a worktree and the folder itself on another branch are git's work, which the
 * workspaces service does in the edge host (lib/gitProjectFolder.ts): the core runs no git (the audit of 2026-11-12).
 */
import { constants } from 'node:fs'
import { access, mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { plausibleBranchName, projectFolderName, projectFolderSlug } from './agentNames.js'
import { validProjectPath } from './projectPath.js'
import { parseGitHubRepository } from './githubRepository.js'

export type ProjectFolder = NewProjectFolder | GitProjectFolder
/** `name` on a new project is what the person called it; without one the folder is named after the
 *  harness and the time. `suggested` marks a name the app made up (from the first task — the phone has
 *  no name field), which is numbered past a folder that exists rather than refused. */
export type NewProjectFolder = { source: 'new'; name?: string; suggested?: boolean }
/** The folders git makes: a clone, a worktree, or the folder itself on another branch. */
export type GitProjectFolder = { source: 'remote'; repositoryUrl: string; name: string }
  | { source: 'worktree'; gitSource: string; branchRef?: string; branchName?: string; existingBranch?: boolean; placeholder?: boolean }
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
    if (!validProjectPath(payload.gitSource) || payload.repositoryUrl !== undefined ||
        (ref !== undefined && (typeof ref !== 'string' || ref.length > 1024 || !/^refs\/(heads|remotes)\/[^\s\x00-\x1f\x7f]+$/.test(ref))) ||
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
        ...(payload.branchMode === 'placeholder' ? { placeholder: true } : {}) }
    }
    // A new branch for the folder itself, named by `branchRef` too.
    if (payload.projectSource === 'branch' && name !== undefined) {
      if (!plausibleBranchName(name) || ref !== `refs/heads/${name}`) {
        throw new ProjectFolderError('INVALID_PROJECT_SOURCE', 'Choose a Git project and branch.')
      }
      return { source: 'branch', gitSource: payload.gitSource, branchRef: ref, branchName: name }
    }
    return { source: payload.projectSource, gitSource: payload.gitSource, ...(typeof ref === 'string' ? { branchRef: ref } : {}) }
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
 * A new project's empty folder, under [options.root] (`projectsRoot()`): the core makes it itself, as no git runs for
 * it. Every other folder a create asks for, git makes, in the workspaces service (lib/gitProjectFolder.ts).
 */
export async function prepareNewFolder(
  project: NewProjectFolder,
  options: {
    root?: string
    /** Who the harness is ("Codex", "Blender"): a new project folder is named after it and the time. */
    label?: string | null
    now?: () => Date
  } = {},
): Promise<string> {
  const root = options.root ?? projectsRoot()
  try {
    await mkdir(root, { recursive: true })
    if (project.name) {
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
  } catch (error) {
    if (error instanceof ProjectFolderError) throw error
    throw new ProjectFolderError('PROJECT_PREPARATION_FAILED', 'Could not create a project folder on this machine. Browse for a folder you can edit.')
  }
}
