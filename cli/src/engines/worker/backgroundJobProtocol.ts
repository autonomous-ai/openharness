/** Private and bounded: core asks Claude Code's worker to stop a `claude --bg` job holding the session it resumes (#4146). */
import type { BackgroundJobStop, BackgroundJobStopped } from '../facets/backgroundJob.js'
import { record } from './protocol.js'

export const BACKGROUND_JOB_VERSION = 1
export const BACKGROUND_JOB_CAPABILITIES = 'engine_background_job_capabilities'
export const BACKGROUND_JOB_STOP = 'engine_background_job_stop'
/** Past the stop's own bounds (engines/claude/backgroundJob.ts): a 3 s listing, a 3 s stop, then listings of up to 3 s
 *  each for 5 s. A worker past it is recycled. */
export const BACKGROUND_JOB_WAIT_MS = 20_000
/** Resumes are rare and each is one person's: four at once, the rest refused rather than queued behind them. */
export const BACKGROUND_JOB_IN_FLIGHT = 4
export const BACKGROUND_JOB_QUEUED = 0
/** The launch's environment, as large as a login's ever is; a path as long as a path may be. */
export const BACKGROUND_JOB_ENV_BYTES = 1024 * 1024
const PATH_CHARS = 32_768
/** A job id and a yes or no. */
export const BACKGROUND_JOB_REPLY_BYTES = 1024

export function backgroundJobStop(value: unknown): value is BackgroundJobStop {
  if (!record(value) || Object.keys(value).length !== 3) return false
  const { bin, sessionId, env } = value
  if (typeof bin !== 'string' || !bin || bin.length > PATH_CHARS || bin.includes('\0')) return false
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) return false
  if (!record(env)) return false
  let bytes = 0
  for (const [name, text] of Object.entries(env)) {
    if (typeof text !== 'string') return false
    bytes += Buffer.byteLength(name) + Buffer.byteLength(text)
    if (bytes > BACKGROUND_JOB_ENV_BYTES) return false
  }
  return true
}

export function backgroundJobStopped(value: unknown): value is BackgroundJobStopped | null {
  return value === null || (record(value) && Object.keys(value).length === 2 && typeof value.job === 'string'
    && !!value.job && value.job.length <= 200 && typeof value.stopped === 'boolean')
}
