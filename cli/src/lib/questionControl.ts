import type { QuestionStep } from '../engines/facets/questionControl.js'
import type { RegisteredSession } from './registry.js'

/**
 * Why the last step failed: `refused`, nothing was typed (no capacity, no worker, a refused grant); `uncertain`,
 * at least one key or text had gone to the terminal before it failed (a worker killed mid-step), so only the
 * pane can tell whether the answer went in.
 */
export type QuestionStepFailure = 'refused' | 'uncertain'
/** Bound once for the complete answer, before any screen read or terminal write. */
export interface QuestionControlSession {
  apply(step: QuestionStep): Promise<boolean>
  /** After `apply` resolved false; undefined when it is not known. */
  failure?(): QuestionStepFailure | undefined
}
export type QuestionControlFor = (session: RegisteredSession) => QuestionControlSession | undefined
