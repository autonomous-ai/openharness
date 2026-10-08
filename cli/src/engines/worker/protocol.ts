/** Private reader messages. These names are never added to the public request router. */
import type { LastTurnText, SessionEvent } from '../../lib/normalize.js'
import type { HistoryAnswer } from '../facets/transcript.js'

export const READER_SERVICES = { claude: 'engine-claude', codex: 'engine-codex' } as const
export type ReaderEngine = keyof typeof READER_SERVICES
export const READER_VERSION = 1
export const READER_HISTORY = 'engine_history_page'
export const READER_LAST_TURN = 'engine_last_turn'
/** Below the local service transport's 6 MiB ceiling, including its envelope and request id. */
export const READER_REPLY_BYTES = 4 * 1024 * 1024
export const READER_IN_FLIGHT = 4
/** The existing link bounds cold start and execution separately: at most twice this when cold. */
export const READER_WAIT_MS = 5_000

export const READER_ERRORS = [
  'ENGINE_UNAVAILABLE', 'ENGINE_BUSY', 'ENGINE_INVALID_REQUEST', 'ENGINE_INVALID_REPLY',
  'ENGINE_REPLY_TOO_LARGE', 'ENGINE_STALE_REPLY',
] as const
export type ReaderErrorCode = typeof READER_ERRORS[number]

export class EngineReadError extends Error {
  constructor(readonly code: ReaderErrorCode) { super(code) }
  get retryable(): boolean { return this.code !== 'ENGINE_INVALID_REQUEST' && this.code !== 'ENGINE_REPLY_TOO_LARGE' }
}

export function readerEngine(name: string): name is ReaderEngine { return Object.hasOwn(READER_SERVICES, name) }
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string'
const optionalNumber = (value: unknown): boolean => value === undefined || (typeof value === 'number' && Number.isFinite(value))

function subagent(value: unknown): boolean {
  return value === undefined || (record(value) && optionalString(value.agentId) && optionalString(value.agentType)
    && optionalNumber(value.totalTokens) && optionalNumber(value.totalDurationMs) && optionalNumber(value.totalToolUseCount))
}

/** Reject malformed adapter output before handing it to a window; never accept live turn mutations. */
export function sessionEvent(value: unknown): value is SessionEvent {
  if (!record(value) || !record(value.payload)) return false
  const p = value.payload
  switch (value.type) {
    case 'user_message':
      return typeof p.content === 'string' && (p.images === undefined || (Array.isArray(p.images)
        && p.images.every((image) => record(image) && typeof image.media_type === 'string' && typeof image.data === 'string')))
    case 'thinking_delta': return typeof p.content === 'string' && optionalString(p.thinkingId)
    case 'thinking_title': return typeof p.title === 'string' && optionalString(p.thinkingId)
    case 'text_delta': return typeof p.content === 'string'
    case 'tool_start': return typeof p.id === 'string' && typeof p.tool === 'string' && optionalString(p.parentToolUseId)
    case 'tool_end': return typeof p.id === 'string' && typeof p.tool === 'string' && typeof p.output === 'string'
      && typeof p.summary === 'string' && typeof p.isError === 'boolean' && optionalString(p.parentToolUseId)
      && subagent(p.subagent) && optionalNumber(p.durationSeconds)
    case 'context_compact': return typeof p.message === 'string' && optionalString(p.trigger)
    case 'done': return typeof p.result === 'string'
    default: return false
  }
}

export function historyAnswer(value: unknown): value is HistoryAnswer {
  return record(value) && Object.keys(value).every(key => ['events', 'timestamp', 'hasMore', 'oldestCursor', 'staleCursor'].includes(key))
    && typeof value.timestamp === 'string' && Number.isFinite(Date.parse(value.timestamp))
    && Array.isArray(value.events) && value.events.every(sessionEvent)
    && (value.hasMore === undefined || typeof value.hasMore === 'boolean')
    && (value.oldestCursor === undefined || value.oldestCursor === null || typeof value.oldestCursor === 'string')
    && (value.staleCursor === undefined || value.staleCursor === true)
}

export function lastTurnAnswer(value: unknown): value is LastTurnText | null {
  return value === null || (record(value) && Object.keys(value).every(key => key === 'userMessage' || key === 'assistantText')
    && typeof value.userMessage === 'string' && typeof value.assistantText === 'string')
}
