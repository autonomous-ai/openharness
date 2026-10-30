/** The latest compaction summary in a transcript (an engine's `compactSummary` declaration), for Change agent's
 *  handoff: what the old agent itself still remembered of the conversation's start. Read only from a descriptor
 *  the caller has already verified, within a window before the size it verified. */
import type { FileHandle } from 'node:fs/promises'
import type { CompactSummaryRule } from '../engines/facets/sessionStore.js'

/** How far back from the end a summary is looked for. A summary older than this is left out, never guessed at. */
export const SUMMARY_WINDOW = 8 * 1024 * 1024

const field = (record: unknown, path: readonly string[]): unknown => path.reduce<unknown>((value, key) =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined, record)

function summaryText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (!Array.isArray(value)) return null
  const parts = value.flatMap((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
    && typeof (block as { text?: unknown }).text === 'string' ? [(block as { text: string }).text] : [])
  return parts.join('\n').trim() || null
}

/** The summary without the engine's wrapper (`CompactSummaryRule.wrapper`), or null when nothing else is left. */
function unwrap(text: string, wrapper: CompactSummaryRule['wrapper']): string | null {
  if (!wrapper) return text
  let lines = text.split('\n')
  if (wrapper.opening.some((marker) => lines[0].startsWith(marker))) {
    const blank = lines.findIndex((line, index) => index > 0 && !line.trim())
    lines = blank < 0 ? [] : lines.slice(blank + 1)
  }
  const end = lines.findIndex((line) => wrapper.closing.some((marker) => line.startsWith(marker)))
  return (end < 0 ? lines : lines.slice(0, end)).join('\n').trim() || null
}

/** The text of the last record flagged as a summary, or null. `partialFirstLine`: the text starts mid-record. */
export function latestCompactSummary(text: string, rule: CompactSummaryRule, partialFirstLine: boolean): string | null {
  const lines = text.split('\n')
  const first = partialFirstLine ? 1 : 0
  for (let index = lines.length - 1; index >= first; index -= 1) {
    const raw = lines[index]
    if (!raw.includes(rule.flag)) continue
    let record: unknown
    try { record = JSON.parse(raw) } catch { continue }
    if (field(record, [rule.flag]) !== true) continue
    const found = summaryText(field(record, rule.text))
    const unwrapped = found && unwrap(found, rule.wrapper)
    if (unwrapped) return unwrapped
  }
  return null
}

/** The latest summary in the `window` bytes before `end` of an open transcript, or null. */
export async function readCompactSummary(handle: FileHandle, end: number, rule: CompactSummaryRule, window = SUMMARY_WINDOW): Promise<string | null> {
  const start = Math.max(0, end - window)
  const bytes = Buffer.alloc(end - start)
  let read = 0
  while (read < bytes.length) {
    const next = await handle.read(bytes, read, bytes.length - read, start + read)
    if (!next.bytesRead) break
    read += next.bytesRead
  }
  return latestCompactSummary(bytes.subarray(0, read).toString('utf8'), rule, start > 0)
}
