/**
 * Before a resume, an engine's own background job holding the conversation is stopped: Claude Code refuses
 * `--resume` while a `claude --bg` job holds the session. The engine's worker runs it; core decides when and says
 * what it answered.
 */

/** What core asks: the exact binary and environment the resume will run with, and its session. */
export interface BackgroundJobStop {
  bin: string
  sessionId: string
  env: Record<string, string>
}

/** The job found holding the session, and whether it was stopped. */
export interface BackgroundJobStopped {
  job: string
  stopped: boolean
}

export type StopBackgroundJob = (request: BackgroundJobStop) => Promise<BackgroundJobStopped | null>

/** What a resume passes core (core/engines/backgroundJobs.ts): the binary and environment it is about to run with. */
export interface BackgroundJobAsk { bin: string; sessionId: string; env: NodeJS.ProcessEnv }

/** Core's stop, as a resume calls it: it says what became of the job in [log], and never throws. */
export type ClearBackgroundJob = (engine: string, ask: BackgroundJobAsk, log: (line: string) => void) => Promise<void>
