// An agent's notice to the dial: the one line it may show, and the limits on how often it may ring. Shared by the
// `harness device notify` command, which cleans the line before sending, and the devices process, which cleans it
// again (the line is data from outside) and counts it.

export const NOTICE_MAX_CHARS = 120
export const NOTICE_FOLDER_MAX = 64
export const NOTICE_SESSION = /^[A-Za-z0-9._-]{1,128}$/

// White space (which takes in U+2028 and U+2029) and control characters alike become one space, so a pasted command
// output is one line the dial draws as text.
const BREAKS = /[\p{Cc}\s]+/gu

const clean = (text: string): string[] => [...text.replace(BREAKS, ' ').trim()]

/** One line a dial can show: each run of control characters (\p{Cc}), U+2028 and U+2029 is one space, runs of
 *  white space are one space, trimmed; past 120 code points, the first 119 and `…`. */
export function noticeLine(text: string): string {
  const chars = clean(text)
  // Cut by code points, never inside a surrogate pair.
  return chars.length > NOTICE_MAX_CHARS ? `${chars.slice(0, NOTICE_MAX_CHARS - 1).join('')}…` : chars.join('')
}

/** A folder's name for a card: through noticeLine's cleaning, 64 code points at most, no `…`; '' when nothing is left. */
export function noticeFolder(name: string): string {
  // Trimmed after the cut too: the listener refuses a folder that cleaning again would change, as a space left last would.
  return clean(name).slice(0, NOTICE_FOLDER_MAX).join('').trimEnd()
}

export interface NoticeAsk { text: string; engine?: 'claude' | 'codex'; sessionId?: string; folder?: string }

const RESULTS = ['shown', 'no dial', 'limited'] as const
export type NoticeResult = typeof RESULTS[number]
export const isNoticeResult = (value: unknown): value is NoticeResult => (RESULTS as readonly unknown[]).includes(value)

export const NOTICE_AGENT_MS = 60_000
export const NOTICE_SAME_MS = 600_000
export const NOTICE_HOUR_MS = 3_600_000
export const NOTICE_HOUR_MAX = 20

interface Counted { agent: string; line: string; at: number }

export class NoticeLimits {
  // What was counted in the last hour, oldest first: never more than NOTICE_HOUR_MAX, as a twenty-first is refused.
  private counted: Counted[] = []

  constructor(private readonly now: () => number) {}

  /** True when [agent]'s [line] may ring now; it is then counted. A refusal counts nothing. */
  take(agent: string, line: string): boolean {
    const at = this.now()
    this.counted = this.counted.filter((c) => at - c.at < NOTICE_HOUR_MS)
    if (this.counted.length >= NOTICE_HOUR_MAX) return false
    const refused = this.counted.some((c) => c.agent === agent
      && (at - c.at < NOTICE_AGENT_MS || (c.line === line && at - c.at < NOTICE_SAME_MS)))
    if (refused) return false
    this.counted.push({ agent, line, at })
    return true
  }
}
