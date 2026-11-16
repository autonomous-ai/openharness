/**
 * The SCMs this daemon knows, and the one-call-per-stage functions the rest of the daemon uses
 * instead of naming an implementation. Callers (`agentFrame`, the workspaces service's rename,
 * `projectFolder`, `launchOverrides`, the instruction-file writers) ask "whichever SCM this is" and
 * get an answer; a second SCM is one more entry in `scmProjects`, not one more branch at each call site.
 *
 * Order matters: the first implementation that claims a folder wins. Git is first and, today, alone.
 * A folder none claims is `kind: 'none'` — a real answer a frame carries, not an error — with the
 * same `root: null` fields `agentProject` reports.
 *
 * The optional `scms` parameters are test seams; the daemon always uses `scmProjects`.
 */
import { basename } from 'node:path'
import { validProjectPath } from '../lib/projectPath.js'
import { GitScmProject } from './gitScmProject.js'
import type { ScmDescription, ScmDetectOptions, ScmDetectResult, ScmKind, ScmProject } from './types.js'

export const scmProjects: readonly ScmProject[] = [new GitScmProject()]

export function scmByKind(kind: ScmKind, scms: readonly ScmProject[] = scmProjects): ScmProject | null {
  return scms.find(scm => scm.kind === kind) ?? null
}

/** The `scm_project_info` answer: the first SCM that claims `path`, else `none` with the first
 *  failure code any of them raised (a probe that could not run is not the same as a plain folder).
 *  Asked together and read in order, so one SCM's slow probe never holds another's answer back, and a
 *  probe that throws is that SCM's failure, never the others'. */
export async function detectScmProject(path: string, options: ScmDetectOptions = {},
  scms: readonly ScmProject[] = scmProjects): Promise<ScmDetectResult> {
  const answers = await Promise.all(scms.map(scm =>
    scm.detect(path, options).catch((): ScmDetectResult => ({ kind: 'none', error: 'UNAVAILABLE' }))))
  let error: string | undefined
  for (const found of answers) {
    if (found.kind !== 'none') return found
    error ??= found.error
  }
  return { kind: 'none', ...(error ? { error } : {}) }
}

/** What `AgentFrame.project` carries for `cwd`; null for no or an implausible `cwd`, exactly as
 *  `agentProject` answers, so a frame never gains a project it did not have. */
export async function describeScmProject(cwd: string | null | undefined, scms: readonly ScmProject[] = scmProjects): Promise<ScmDescription | null> {
  if (!validProjectPath(cwd)) return null
  for (const scm of scms) {
    const described = await scm.describe(cwd)
    if (described) return described
  }
  return { kind: 'none', name: basename(cwd) || cwd, cwd, root: null, remote: null, branch: null }
}

/** The session's title reaches the workspace's line of work, once (`branchNaming.ts` for git). */
export async function renameScmProject(cwd: string, title: string | null, scms: readonly ScmProject[] = scmProjects): Promise<string | null> {
  for (const scm of scms) {
    const renamed = await scm.rename(cwd, title)
    if (renamed) return renamed
  }
  return null
}

export function forgetScmProject(cwd: string, scms: readonly ScmProject[] = scmProjects): void {
  for (const scm of scms) scm.forget?.(cwd)
}
