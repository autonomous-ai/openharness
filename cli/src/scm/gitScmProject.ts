/**
 * The git implementation of `ScmProject`: a thin wrapper over the modules that already do the work.
 * It delegates rather than moves them — `gitProject.ts`, `agentProject.ts`, `branchNaming.ts` and
 * `worktreeSweep.ts` keep their exports, their specs and their call shapes — so the seam's arrival is
 * invisible to a git project. The only thing this file adds to a frame is `kind: 'git'`.
 *
 * What is deliberately NOT here: any git knowledge of its own. The `refs/…` regex, the `.git` file
 * marker, the `branch.<name>.harness` mark and `git status --porcelain` all stay behind the wrapped
 * functions, which is the point — a caller of the seam cannot pick one of them up by accident.
 */
import { agentProject, forgetAgentProject } from '../lib/agentProject.js'
import { nameBranchAfterSession } from '../lib/branchNaming.js'
import { prepareGitProject, readGitProject } from '../lib/gitProject.js'
import { sweepWorktrees } from '../lib/worktreeSweep.js'
import type { PrepareOptions, ScmDescription, ScmDetectOptions, ScmDetectResult, ScmLaunchRecord, ScmProject } from './types.js'

export class GitScmProject implements ScmProject {
  readonly kind = 'git' as const

  async detect(path: string, options: ScmDetectOptions = {}): Promise<ScmDetectResult> {
    const found = await readGitProject(path, options)
    if ('error' in found) return { kind: 'none', error: found.error }
    return 'root' in found ? { kind: 'git', git: found } : { kind: 'none' }
  }

  /** Exactly the call `projectFolder.ts` makes for `source: 'worktree'`: the branch trio travels
   *  together or not at all, because `prepareGitProject` reads `existingBranch` and `placeholder` only
   *  alongside a `branchName`. */
  async prepareIsolated(source: string, options: PrepareOptions): Promise<{ cwd: string; launchRecord: ScmLaunchRecord }> {
    const cwd = await prepareGitProject(source, {
      root: options.root, worktree: true, ref: options.base,
      ...(options.name !== undefined ? {
        branchName: options.name, existingBranch: options.existing === true, placeholder: options.placeholder === true,
      } : {}),
      ...(options.pick ? { pick: options.pick } : {}),
    })
    return { cwd, launchRecord: { kind: 'git' } }
  }

  /** `agentProject`'s answer, named. A folder outside any repository (`root: null`) is not git's to
   *  describe, so it is null here and the seam reports it as `kind: 'none'` with the same fields. */
  async describe(cwd: string): Promise<ScmDescription | null> {
    const project = await agentProject(cwd)
    return project && project.root !== null ? { kind: 'git', ...project } : null
  }

  rename(cwd: string, title: string | null): Promise<string | null> {
    return nameBranchAfterSession(cwd, title)
  }

  sweep(input: { root: string; inUse: Iterable<string | null | undefined>; now?: number; idleMs?: number }): Promise<string[]> {
    return sweepWorktrees(input)
  }

  /** A worktree is a folder, and the folder is the row's `cwd`: nothing to re-apply. */
  launchEnv(_record: ScmLaunchRecord): Record<string, string> {
    return {}
  }

  forget(cwd: string): void {
    forgetAgentProject(cwd)
  }
}
