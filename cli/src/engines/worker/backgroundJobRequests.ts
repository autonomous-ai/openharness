import type { ServiceRequests } from '../../core/api.js'
import type { StopBackgroundJob } from '../facets/backgroundJob.js'
import { backgroundJobStop, backgroundJobStopped, BACKGROUND_JOB_CAPABILITIES, BACKGROUND_JOB_IN_FLIGHT, BACKGROUND_JOB_REPLY_BYTES,
  BACKGROUND_JOB_STOP, BACKGROUND_JOB_VERSION, BACKGROUND_JOB_WAIT_MS } from './backgroundJobProtocol.js'
import { snapshotRequests } from './snapshotRequests.js'

export interface BackgroundJobRequestDeps { load?: () => Promise<StopBackgroundJob>; recycle?: () => void }

/** Claude Code's worker stops a `claude --bg` job holding a session core is about to resume; when to ask is core's. */
export function engineBackgroundJobRequests(deps: BackgroundJobRequestDeps = {}): ServiceRequests {
  return snapshotRequests<StopBackgroundJob>({
    engine: 'claude', version: BACKGROUND_JOB_VERSION, capabilities: BACKGROUND_JOB_CAPABILITIES, capability: 'backgroundJob',
    inFlight: BACKGROUND_JOB_IN_FLIGHT, waitMs: BACKGROUND_JOB_WAIT_MS, replyBytes: BACKGROUND_JOB_REPLY_BYTES,
    load: deps.load ?? (async () => (await import('../backgroundJobs.js')).backgroundJobFor('claude')!),
    recycle: () => (deps.recycle ?? (() => process.exit(1)))(),
    methods: {
      [BACKGROUND_JOB_STOP]: {
        fields: ['bin', 'sessionId', 'env'],
        accepts: payload => backgroundJobStop({ bin: payload.bin, sessionId: payload.sessionId, env: payload.env }),
        answer: (stop, payload) => stop({ bin: payload.bin as string, sessionId: payload.sessionId as string, env: payload.env as Record<string, string> }),
        valid: answer => backgroundJobStopped(answer),
      },
    },
  })
}
