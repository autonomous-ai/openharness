import type { PromptSpan, SubmissionPolicy, SubmissionReading } from '../engines/facets/submission.js'
import type { RegisteredSession } from './registry.js'

/**
 * An engine's reading of a prompt core typed, for the engines whose submissions their worker reads
 * (engines/submissionPolicies.ts). Null means no evidence: the worker unavailable, the session rebound
 * while it answered, or text past the bounds. It never means the prompt was taken, or that it was not.
 */
export interface SubmissionReader {
  /** The engine's declared timing, data read in line; undefined: the core reads this engine's submissions
   *  itself, as it did before (the engines not yet behind the facet). */
  policy(engine: string): SubmissionPolicy | undefined
  read(session: RegisteredSession, capture: string, prompt: string): Promise<SubmissionReading | null>
  echo(session: RegisteredSession, recorded: string): Promise<PromptSpan | null>
}
