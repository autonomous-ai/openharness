import type { EngineSubmission } from '../facets/submission.js'
import { readNativeSubmission } from '../kit/nativeSubmission.js'
import { policy } from './submissionPolicy.js'

/** Codex records the typed prompt as it was typed: the whole of it is the prompt, matched exactly. */
export const submission: EngineSubmission = {
  policy,
  read: readNativeSubmission,
  echo: recorded => ({ start: 0, end: recorded.length }),
}
