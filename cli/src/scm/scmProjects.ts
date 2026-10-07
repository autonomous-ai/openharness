/**
 * The SCMs this daemon knows, and the one-call-per-stage functions the rest of the daemon uses
 * instead of naming an implementation. Callers (`agentFrame`, the workspaces service's rename and sweep,
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
import { PROJECT_INSTRUCTION_FILES } from '../dsh/adapters.js'
import { validProjectCwd } from '../lib/agentProject.js'
import { GitScmProject } from './gitScmProject.js'
import type { ScmDescription, ScmDetectOptions, ScmDetectResult, ScmKind, ScmLaunchRecord, ScmProject } from './types.js'

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
  if (!validProjectCwd(cwd)) return null
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

/** Every SCM sweeps its own idle workspaces under `root`; the paths removed, in SCM order. `inUse`
 *  is read once here, because an iterable handed to two implementations would be empty for the second. */
export async function sweepScmProjects(input: {
  root: string
  inUse: Iterable<string | null | undefined>
  now?: number
  idleMs?: number
}, scms: readonly ScmProject[] = scmProjects): Promise<string[]> {
  const inUse = [...input.inUse]
  const removed: string[] = []
  for (const scm of scms) removed.push(...await scm.sweep({ ...input, inUse }))
  return removed
}

/** The pane environment a workspace's record asks for, or undefined when there is none to ask —
 *  shaped for `mergedLaunchEnv` (core/agents/launchEnv.ts), which treats "no env" and "empty env" the same way. */
export function scmLaunchEnv(record: ScmLaunchRecord | null | undefined, scms: readonly ScmProject[] = scmProjects): Record<string, string> | undefined {
  if (!record) return undefined
  const env = scmByKind(record.kind, scms)?.launchEnv(record) ?? {}
  return Object.keys(env).length ? env : undefined
}

/** Before Harness writes into project files an SCM may hold read-only. Nothing runs for an SCM with
 *  no `prepareWrite` (git), so a git workspace sees no new subprocess and no file access from this. */
export async function prepareScmWrite(cwd: string, paths: readonly string[], scms: readonly ScmProject[] = scmProjects): Promise<void> {
  for (const scm of scms) await scm.prepareWrite?.(cwd, paths)
}

/** Before Harness writes into a project's instruction files (a harness's session bootstrap, the
 *  saved-API notes): an SCM that holds tracked files read-only opens `PROJECT_INSTRUCTION_FILES` first.
 *  Awaited by create, fork and every relaunch (`core/agents/create.ts`, `fork.ts`, `launch.ts`). Git
 *  has no `prepareWrite`, so for a git workspace this runs nothing and touches no file. A failure here
 *  is only logged; the write that follows reports its own. */
export async function prepareInstructionWrites(cwd: string | null | undefined, scms: readonly ScmProject[] = scmProjects): Promise<void> {
  if (!cwd) return
  try { await prepareScmWrite(cwd, PROJECT_INSTRUCTION_FILES, scms) }
  catch (error) { console.warn(`[scm] could not prepare instruction files for writing · ${error instanceof Error ? error.message : error}`) }
}

export function forgetScmProject(cwd: string, scms: readonly ScmProject[] = scmProjects): void {
  for (const scm of scms) scm.forget?.(cwd)
}
