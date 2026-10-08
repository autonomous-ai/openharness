/** Core's submission port: the screen's transport with the submission reader's version, bounds and replies. */
import type { PromptSpan, SubmissionReading } from '../../engines/facets/submission.js'
import { EngineReadError } from '../../engines/worker/protocol.js'
import { promptSpan, submissionCapture, submissionReading, submissionText, SUBMISSION_CAPABILITIES, SUBMISSION_ECHO, SUBMISSION_IN_FLIGHT,
  SUBMISSION_QUEUED, SUBMISSION_READ, SUBMISSION_REPLY_BYTES, SUBMISSION_VERSION, SUBMISSION_WAIT_MS } from '../../engines/worker/submissionProtocol.js'
import { createSnapshotTransport, type SnapshotTransportDeps } from './snapshotTransport.js'

export function createSubmissionTransport(deps: SnapshotTransportDeps) {
  const transport = createSnapshotTransport(deps, { version: SUBMISSION_VERSION, capabilities: SUBMISSION_CAPABILITIES, capability: 'submission',
    inFlight: SUBMISSION_IN_FLIGHT, queued: SUBMISSION_QUEUED, waitMs: SUBMISSION_WAIT_MS, replyBytes: SUBMISSION_REPLY_BYTES })
  const invalid = (): never => { throw new EngineReadError('ENGINE_INVALID_REQUEST') }
  return {
    connected: transport.connected,
    disconnected: transport.disconnected,
    async read(engine: string, capture: string, prompt: string): Promise<SubmissionReading> {
      if (!submissionCapture(capture) || !submissionText(prompt)) invalid()
      return await transport.read(engine, SUBMISSION_READ, { capture, prompt }, submissionReading) as SubmissionReading
    },
    async echo(engine: string, recorded: string): Promise<PromptSpan> {
      if (!submissionText(recorded)) invalid()
      return await transport.read(engine, SUBMISSION_ECHO, { recorded }, answer => promptSpan(answer, recorded)) as PromptSpan
    },
  }
}

export type SubmissionTransport = ReturnType<typeof createSubmissionTransport>
