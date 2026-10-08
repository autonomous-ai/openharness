import type { ServiceRequests } from '../../core/api.js'
import type { EngineSubmission } from '../facets/submission.js'
import type { ReaderEngine } from './protocol.js'
import { snapshotRequests } from './snapshotRequests.js'
import { promptSpan, submissionCapture, submissionReading, submissionText, SUBMISSION_CAPABILITIES, SUBMISSION_ECHO,
  SUBMISSION_IN_FLIGHT, SUBMISSION_READ, SUBMISSION_REPLY_BYTES, SUBMISSION_VERSION, SUBMISSION_WAIT_MS } from './submissionProtocol.js'

const loadSubmission = {
  claude: async () => (await import('../claude/submission.js')).submission,
  codex: async () => (await import('../codex/submission.js')).submission,
}
export interface SubmissionRequestDeps { load?: () => Promise<EngineSubmission>; recycle?: () => void }

/** The engine's reading of its own composer and recorded prompt; the verdict and every Enter are core's. */
export function engineSubmissionRequests(engine: ReaderEngine, deps: SubmissionRequestDeps = {}): ServiceRequests {
  return snapshotRequests<EngineSubmission>({
    engine, version: SUBMISSION_VERSION, capabilities: SUBMISSION_CAPABILITIES, capability: 'submission',
    inFlight: SUBMISSION_IN_FLIGHT, waitMs: SUBMISSION_WAIT_MS, replyBytes: SUBMISSION_REPLY_BYTES,
    load: deps.load ?? loadSubmission[engine], recycle: () => (deps.recycle ?? (() => process.exit(1)))(),
    methods: {
      [SUBMISSION_READ]: {
        fields: ['capture', 'prompt'], accepts: payload => submissionCapture(payload.capture) && submissionText(payload.prompt),
        answer: (adapter, payload) => adapter.read(payload.capture as string, payload.prompt as string),
        valid: answer => submissionReading(answer),
      },
      [SUBMISSION_ECHO]: {
        fields: ['recorded'], accepts: payload => submissionText(payload.recorded),
        answer: (adapter, payload) => adapter.echo(payload.recorded as string),
        valid: (answer, payload) => promptSpan(answer, payload.recorded as string),
      },
    },
  })
}
