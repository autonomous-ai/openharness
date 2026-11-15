/** What a reader worker checks of what the core sends it, before it reads: Claude Code's and Codex's, and the other engines'. */
import { isAbsolute } from 'node:path'
import type { HistoryAsk } from '../facets/transcript.js'
import { record } from './protocol.js'

/** A path the core named: absolute, bounded, and with no NUL. */
export const readerPath = (value: unknown): value is string => typeof value === 'string' && value.length <= 32_768
  && !value.includes('\0') && isAbsolute(value)

/** A page asked for: none is the whole conversation; a limit of 1 to 500 events, before a cursor of at most 2,000 characters. */
export function askOf(value: unknown): HistoryAsk | null {
  if (value === undefined) return {}
  if (!record(value) || (value.limit !== undefined && (typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 500))
    || (value.before !== undefined && (typeof value.before !== 'string' || value.before.length > 2_000))) return null
  return { limit: value.limit as number | undefined, before: value.before as string | undefined }
}
