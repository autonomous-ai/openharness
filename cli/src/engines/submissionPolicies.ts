import type { SubmissionPolicy } from './facets/submission.js'
import { policy as claude } from './claude/submissionPolicy.js'
import { policy as codex } from './codex/submissionPolicy.js'

/**
 * The submission timing of the engines whose submissions their worker reads: data only, like the launch
 * contract (launches.ts), so the core's input path reads it in line and loads no reader. An engine not
 * here keeps the core's own reading (lib/sessionInput.ts) until its batch.
 */
const policies: Readonly<Record<string, SubmissionPolicy>> = { claude, codex }

export function submissionPolicy(engine: string | null | undefined): SubmissionPolicy | undefined {
  return engine && Object.hasOwn(policies, engine) ? policies[engine] : undefined
}
