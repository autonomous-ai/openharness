import type { EngineSubmission } from '../facets/submission.js'
import { readNativeSubmission } from '../kit/nativeSubmission.js'
import { policy } from './submissionPolicy.js'

/**
 * Claude Code 2.1.283 records a bracketed paste inside an envelope whose opening and closing ids match.
 * Only its exact payload is the typed prompt: never a substring of a different prompt, or text outside
 * the envelope (lib/sessionInput.spec.ts keeps the recorded cases). Moved from sessionInput.ts unchanged.
 */
const PASTED = /^\s*<pasted_content id="([a-f0-9]+)">\r?\n([\s\S]*)\r?\n<\/pasted_content id="\1">\s*$/d

export const submission: EngineSubmission = {
  policy,
  read: readNativeSubmission,
  echo(recorded) {
    const payload = PASTED.exec(recorded)?.indices?.[2]
    return payload ? { start: payload[0], end: payload[1] } : { start: 0, end: recorded.length }
  },
}
