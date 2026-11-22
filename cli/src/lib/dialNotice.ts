// An agent's notice to the dial: the one line it may show, and the limits on how often it may ring. Shared by the
// `harness device notify` command, which composes and fits the line before sending, and the devices process, which
// cleans it again (the line is data from outside) and counts it. The command's words are parsed here, with no imports,
// so the dial skill eval reads an agent's flags exactly as the command does.

export const NOTICE_MAX_CHARS = 120
/** The bytes of a line the dial keeps whole: its drawer row cuts at 239, and a question of 256 or more reads "This
 *  question needs the desktop" (firmware ui_habitat.c). 120 letters can be 480 bytes. */
export const NOTICE_LINE_MAX_BYTES = 239
export const NOTICE_SUGGEST_MAX = 40
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

export type NoticeState = 'waiting' | 'proceeding'
export type NoticeKind = NoticeState | 'plain'

// The state opens the line because the round dial cuts near 90 letters and the Pro shows two rows: whether the agent
// waits is what the person must see first.
const ROWS: Record<NoticeKind, { opening: string; label: string }> = {
  waiting: { opening: 'Waiting · ', label: ' · Suggest: ' },
  proceeding: { opening: 'Proceeding · ', label: ' · Doing: ' },
  plain: { opening: '', label: ' · Suggest: ' },
}

/** The line of a question, its suggestion and the agent's state: each part cleaned as noticeLine cleans, the
 *  suggestion 40 letters at most, then the question cut so the line is 120 letters and NOTICE_LINE_MAX_BYTES bytes at
 *  most. '' when the question is empty. */
export function composeNotice(question: string, suggest?: string, state?: NoticeState): string {
  const q = clean(question)
  if (q.length === 0) return ''
  const row = ROWS[state ?? 'plain']
  const s = clean(suggest ?? '')
  const tail = s.length === 0 ? ''
    : `${row.label}${s.length > NOTICE_SUGGEST_MAX ? `${s.slice(0, NOTICE_SUGGEST_MAX - 1).join('').trimEnd()}…` : s.join('')}`
  const fixed = row.opening + tail
  const room = NOTICE_MAX_CHARS - [...fixed].length
  const bytes = NOTICE_LINE_MAX_BYTES - Buffer.byteLength(fixed)
  return `${row.opening}${fitQuestion(q, room, bytes)}${tail}`
}

export interface NoticeWords { question: string; suggest?: string; state?: NoticeState; json: boolean }

/** [words]: what follows `harness device notify`. `--suggest` takes the next word whatever it is, so an agent's slip
 *  (`--suggest --proceeding`) is still a ring; the last one decides. `--waiting` wins over `--proceeding`, the safer
 *  word. Every other word, `-x` and `--suggest=x` too, is the question, joined by one space and not yet cleaned; a
 *  question that is only `--help` or `-h` is none, so asking for the usage never rings the dial. */
export function parseNotice(words: readonly string[]): NoticeWords {
  const question: string[] = []
  let suggest: string | undefined
  let state: NoticeState | undefined
  let json = false
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (word === '--suggest') suggest = words[++i]
    else if (word === '--waiting') state = 'waiting'
    else if (word === '--proceeding') state ??= 'proceeding'
    else if (word === '--json') json = true
    else question.push(word)
  }
  const text = question.join(' ')
  return { question: text === '--help' || text === '-h' ? '' : text, suggest, state, json }
}

// The CLI fits the whole line, so the devices' byte cut never takes the suggestion off its end. A cut leaves no space
// before its `…`, so the dial never shows `word …`.
function fitQuestion(q: string[], room: number, bytes: number): string {
  if (q.length <= room && Buffer.byteLength(q.join('')) <= bytes) return q.join('')
  let k = 0
  let used = Buffer.byteLength('…')
  // By code points, so never inside a surrogate pair.
  while (k + 1 < room && used + Buffer.byteLength(q[k]) <= bytes) used += Buffer.byteLength(q[k++])
  return `${q.slice(0, k).join('').trimEnd()}…`
}

/** The state a line was composed with, read from its opening. */
export function noticeKind(line: string): NoticeKind {
  if (line.startsWith(ROWS.waiting.opening)) return 'waiting'
  return line.startsWith(ROWS.proceeding.opening) ? 'proceeding' : 'plain'
}

/** A folder's name for a card: through noticeLine's cleaning, 64 code points at most, no `…`; '' when nothing is left. */
export function noticeFolder(name: string): string {
  // Trimmed after the cut too: the listener refuses a folder that cleaning again would change, as a last space would.
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
