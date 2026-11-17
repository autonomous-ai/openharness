/** Launch contracts have no repository readers: every session needs them before its service starts. */
import type { ScmLaunchRecord, ScmProject } from './types.js'

export type ScmLaunchContract = Pick<ScmProject, 'kind' | 'launchEnv' | 'prepareWrite'>
export const gitLaunchContract: ScmLaunchContract = { kind: 'git', launchEnv: () => ({}) }
export const scmLaunchContracts: readonly ScmLaunchContract[] = [gitLaunchContract]

/** The pane environment a workspace's record asks for, or undefined when there is none to ask —
 *  shaped for `mergedLaunchEnv` (core/agents/launchEnv.ts), which treats "no env" and "empty env" the same way. */
export function scmLaunchEnv(record: ScmLaunchRecord | null | undefined, scms: readonly ScmLaunchContract[] = scmLaunchContracts): Record<string, string> | undefined {
  if (!record) return undefined
  const env = scms.find(scm => scm.kind === record.kind)?.launchEnv(record) ?? {}
  return Object.keys(env).length ? env : undefined
}

