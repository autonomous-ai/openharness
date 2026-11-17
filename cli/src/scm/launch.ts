/** Launch contracts have no repository readers: every session needs them before its service starts. */
import { PROJECT_INSTRUCTION_FILES } from '../dsh/adapters.js'
import type { ScmLaunchRecord, ScmProject } from './types.js'

export type ScmLaunchContract = Pick<ScmProject, 'kind' | 'launchEnv' | 'prepareWrite'>
export const gitLaunchContract: ScmLaunchContract = { kind: 'git', launchEnv: () => ({}) }
const scmLaunchContracts: readonly ScmLaunchContract[] = [gitLaunchContract]

/** The pane environment a workspace's record asks for, or undefined when there is none to ask —
 *  shaped for `mergedLaunchEnv` (core/agents/launchEnv.ts), which treats "no env" and "empty env" the same way. */
export function scmLaunchEnv(record: ScmLaunchRecord | null | undefined, scms: readonly ScmLaunchContract[] = scmLaunchContracts): Record<string, string> | undefined {
  if (!record) return undefined
  const env = scms.find(scm => scm.kind === record.kind)?.launchEnv(record) ?? {}
  return Object.keys(env).length ? env : undefined
}

/** Before Harness writes into project files an SCM may hold read-only. Nothing runs for an SCM with
 *  no `prepareWrite` (git), so a git workspace sees no new subprocess and no file access from this. */
export async function prepareScmWrite(cwd: string, paths: readonly string[], scms: readonly ScmLaunchContract[] = scmLaunchContracts): Promise<void> {
  for (const scm of scms) await scm.prepareWrite?.(cwd, paths)
}

/** Before Harness writes into a project's instruction files (a harness's session bootstrap, the
 *  saved-API notes): an SCM that holds tracked files read-only opens `PROJECT_INSTRUCTION_FILES` first.
 *  Awaited by create, fork and every relaunch (`core/agents/create.ts`, `fork.ts`, `launch.ts`). Git
 *  has no `prepareWrite`, so for a git workspace this runs nothing and touches no file. A failure here
 *  is only logged; the write that follows reports its own. */
export async function prepareInstructionWrites(cwd: string | null | undefined, scms: readonly ScmLaunchContract[] = scmLaunchContracts): Promise<void> {
  if (!cwd) return
  try { await prepareScmWrite(cwd, PROJECT_INSTRUCTION_FILES, scms) }
  catch (error) { console.warn(`[scm] could not prepare instruction files for writing · ${error instanceof Error ? error.message : error}`) }
}

