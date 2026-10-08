/** Private, stateless submission readings. A worker receives text, never a terminal handle or a lease. */
import type { PromptSpan, SubmissionReading } from '../facets/submission.js'
import { record } from './protocol.js'
import { screenCapture } from './screenProtocol.js'

export const SUBMISSION_VERSION = 1
export const SUBMISSION_CAPABILITIES = 'engine_submission_capabilities'
/** The pane after a paste, against the prompt typed into it. */
export const SUBMISSION_READ = 'engine_submission_read'
/** A turn's prompt as the engine recorded it: where the typed text lies within it. */
export const SUBMISSION_ECHO = 'engine_submission_echo'
/** The same budget as a screen read: a verification waits on both, one after the other. */
export const SUBMISSION_WAIT_MS = 1_000
export const SUBMISSION_IN_FLIGHT = 8
export const SUBMISSION_QUEUED = 64
/** A prompt as typed or recorded. Larger than any message the apps send; beyond it nothing is read, and
 *  core decides as it does for any reading it could not get. The capture keeps the screen's bound. */
export const SUBMISSION_TEXT_BYTES = 1024 * 1024
/** An answer is three facts or two offsets. */
export const SUBMISSION_REPLY_BYTES = 4 * 1024

export const submissionCapture = screenCapture

export function submissionText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= SUBMISSION_TEXT_BYTES && Buffer.byteLength(value) <= SUBMISSION_TEXT_BYTES
}

const DRAFTS = ['pending', 'clear', 'unreadable']
export function submissionReading(value: unknown): value is SubmissionReading {
  return record(value) && Object.keys(value).length === 3 && typeof value.draft === 'boolean'
    && typeof value.composer === 'boolean' && DRAFTS.includes(value.nativeDraft as string)
}

/** A span of the very text core sent: offsets inside it, in order, and nothing else. */
export function promptSpan(value: unknown, recorded: string): value is PromptSpan {
  return record(value) && Object.keys(value).length === 2 && Number.isInteger(value.start) && Number.isInteger(value.end)
    && (value.start as number) >= 0 && (value.start as number) <= (value.end as number) && (value.end as number) <= recorded.length
}
