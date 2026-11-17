/** Workspace file preparation runs with the component that writes the instructions. */
import { PROJECT_INSTRUCTION_FILES } from '../dsh/adapters.js'
import { scmLaunchContracts, type ScmLaunchContract } from './launch.js'

/** Before Harness writes into project files an SCM may hold read-only. Nothing runs for an SCM with
 *  no `prepareWrite` (git), so a git workspace sees no new subprocess and no file access from this. */
export async function prepareScmWrite(cwd: string, paths: readonly string[], scms: readonly ScmLaunchContract[] = scmLaunchContracts): Promise<void> {
  for (const scm of scms) await scm.prepareWrite?.(cwd, paths)
}

/** Before Harness writes into a project's instruction files (a harness's session bootstrap, the
 *  saved-API notes): an SCM that holds tracked files read-only opens `PROJECT_INSTRUCTION_FILES` first.
 *  Used by the Store and workspaces component before their own writes. Git
 *  has no `prepareWrite`, so for a git workspace this runs nothing and touches no file. A failure here
 *  is only logged; the write that follows reports its own. */
export async function prepareInstructionWrites(cwd: string | null | undefined, scms: readonly ScmLaunchContract[] = scmLaunchContracts): Promise<void> {
  if (!cwd) return
  try { await prepareScmWrite(cwd, PROJECT_INSTRUCTION_FILES, scms) }
  catch { console.warn('[scm] INSTRUCTION_PREPARATION_FAILED') }
}

