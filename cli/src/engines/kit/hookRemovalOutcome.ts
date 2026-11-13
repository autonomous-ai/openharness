/**
 * What became of one file Harness's hooks were taken out of, and how a failure is said. In a file of their own: the
 * core takes Hermes's hooks out itself where a Hermes needs none (engines/nativeHooks.ts, ./nativeHookYaml.ts), and
 * loaded all of `harness uninstall`'s removers for these two (./hookRemoval.ts; the audit of 2026-11-12).
 */
import { IdentityReadUnavailable } from './identityScan.js'
import { HookPreparationHeld } from './nativeHookFiles.js'

export interface HookFileRemoval {
  file: string
  /** How many of Harness's entries (hooks, rules, approvals, or the file itself) went. */
  removed: number
  /** Why the file was left as it was. */
  failed?: string
  /** A file at a path of ours that is somebody else's. */
  kept?: string
}

/**
 * Why a file was left, as the end of a sentence a person reads in uninstall's report: a held preparation's reason
 * without its "Hook preparation is waiting" prefix, which is the installers' wording, and a refused route's reason
 * without the identity reader's.
 */
export function failure(error: unknown): string {
  if (error instanceof HookPreparationHeld) return error.reason
  if (error instanceof IdentityReadUnavailable) return error.message.replace(/^Conversation identity is held: (.*?)\.?$/s, '$1')
  return error instanceof Error ? error.message : String(error)
}
