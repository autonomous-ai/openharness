/**
 * The one-line summary of what a harness is doing, shown beside it in a shared tab's sidebar (shared-tab activity
 * design, ruling T2). A line a person typed to an agent, so it is cut and cleaned before it leaves this computer and
 * again where another account's is read (messages/tabActivity.ts): a bidi override or an escape sequence must never
 * reach another account's screen.
 */
export const SUMMARY_MAX = 120
/** How much of a prompt is kept per agent: its first line, however long the paste was. */
export const PROMPT_KEPT = 400

/** Control and format characters (an escape, a bidi override, a zero-width space) and the line and paragraph separators
 *  (U+2028, U+2029), which would split a one-line row. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/** The first non-empty line of a prompt, capped: what the core keeps for an agent, so memory does not grow with a paste. */
export function promptLine(message: string): string | undefined {
  return message.split('\n').find((l) => l.trim())?.slice(0, PROMPT_KEPT)
}

/** What another account sent as a summary: text only, cleaned, cut to SUMMARY_MAX characters (never through a surrogate pair). */
export function cleanSummary(value: unknown): string {
  return typeof value === 'string' ? [...value.replace(UNSAFE, '')].slice(0, SUMMARY_MAX).join('') : ''
}

/** The summary of an agent (T2): what it is doing while it works, else what it last did. */
export function summaryOf(state: 'working' | 'idle' | 'unknown', running: string | undefined, recap: string | undefined): string | undefined {
  const pick = state === 'working' ? running : (recap ?? running)
  const line = pick?.split('\n').find((l) => l.trim())?.replace(UNSAFE, '').trim()
  if (!line) return undefined
  const chars = [...line]
  return chars.length > SUMMARY_MAX ? `${chars.slice(0, SUMMARY_MAX - 1).join('')}…` : line
}
