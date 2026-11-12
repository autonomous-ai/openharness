/**
 * Core's side of stopping an engine's own background job before a resume (#4146): Claude Code refuses `--resume`
 * while a `claude --bg` job holds the session. Core decides when to ask and says what was answered; the stop runs in
 * Claude Code's supervised worker. A job that cannot be asked about, read or stopped never holds the resume: Claude
 * Code then says its own refusal, as it did when this ran in the core.
 */
import type { BackgroundJobAsk, BackgroundJobStop, BackgroundJobStopped, StopBackgroundJob } from '../../engines/facets/backgroundJob.js'
import { backgroundJobStop, backgroundJobStopped, BACKGROUND_JOB_CAPABILITIES, BACKGROUND_JOB_IN_FLIGHT, BACKGROUND_JOB_QUEUED,
  BACKGROUND_JOB_REPLY_BYTES, BACKGROUND_JOB_STOP, BACKGROUND_JOB_VERSION, BACKGROUND_JOB_WAIT_MS } from '../../engines/worker/backgroundJobProtocol.js'
import { EngineReadError, setEnvironment } from '../../engines/worker/protocol.js'
import { createSnapshotTransport, type SnapshotTransportDeps } from './snapshotTransport.js'

export interface BackgroundJobsDeps extends SnapshotTransportDeps {
  /** The engine's stop runs in its supervised worker. */
  handles(engine: string): boolean
  /** Explicit inline mode and older masters only; a failed worker never selects it. */
  inline(engine: string): StopBackgroundJob | undefined
}

export function createBackgroundJobs(deps: BackgroundJobsDeps) {
  const transport = createSnapshotTransport(deps, { version: BACKGROUND_JOB_VERSION, capabilities: BACKGROUND_JOB_CAPABILITIES,
    capability: 'backgroundJob', inFlight: BACKGROUND_JOB_IN_FLIGHT, queued: BACKGROUND_JOB_QUEUED, waitMs: BACKGROUND_JOB_WAIT_MS,
    replyBytes: BACKGROUND_JOB_REPLY_BYTES })
  return {
    connected: transport.connected,
    disconnected: transport.disconnected,
    /** Stops [engine]'s background job holding the session, and says what became of it in [log]. Never throws. */
    async stop(engine: string, ask: BackgroundJobAsk, log: (line: string) => void): Promise<void> {
      const session = ask.sessionId.slice(0, 8)
      const request: BackgroundJobStop = { bin: ask.bin, sessionId: ask.sessionId, env: setEnvironment(ask.env) }
      let answer: BackgroundJobStopped | null | undefined
      try {
        if (!backgroundJobStop(request)) throw new EngineReadError('ENGINE_INVALID_REQUEST')
        answer = deps.handles(engine)
          ? await transport.read(engine, BACKGROUND_JOB_STOP, { ...request }, backgroundJobStopped) as BackgroundJobStopped | null
          : await deps.inline(engine)?.(request)
      } catch (error) {
        log(`could not ask whether a background job holds session ${session} (${error instanceof EngineReadError ? error.code : 'ENGINE_UNAVAILABLE'}) — resuming anyway`)
        return
      }
      if (!answer) return
      log(answer.stopped ? `stopped background job ${answer.job} holding session ${session}`
        : `could not stop background job ${answer.job} holding session ${session} — resuming anyway`)
    },
  }
}

export type BackgroundJobs = ReturnType<typeof createBackgroundJobs>
