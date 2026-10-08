/** Real native submission readers injected into unit hosts; production supervision never imports this. */
import { submissionFor } from '../engines/submissions.js'
import { submissionPolicy } from '../engines/submissionPolicies.js'
import type { SubmissionReader } from '../lib/submissionReader.js'
export const inlineSubmission: SubmissionReader = {
  policy: submissionPolicy,
  read: async (session, capture, prompt) => submissionFor(session.engine)?.read(capture, prompt) ?? null,
  echo: async (session, recorded) => submissionFor(session.engine)?.echo(recorded) ?? null,
}
