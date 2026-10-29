/**
 * "While you were away" (Slack parity, 2026-10-29): what a person missed in one conversation since their read mark, in three
 * short lists that each link to their rows. Built from the rows Swarm writes in a fixed form, never from a model reading the
 * words: shipped rows (ship.ts), the status rows of `work.status` (commands.ts) and a Lead's tags (mentions.ts). Agents read
 * every message as it comes, so only people get one. The rows given are those the reader may read (store.ts catchUp).
 */
import { STATUS_LABELS } from './model.js'
import { SHIP_KIND } from './ship.js'

/** How many rows past the mark one summary reads at most; a longer span says so (`more`). */
export const CATCH_UP_SCAN = 1000
/** How many items each list shows: its newest. */
export const CATCH_UP_ITEMS = 5
const ITEM_CHARS = 140

export interface CatchUpRow { id: string; sequence: number; author: unknown; source: unknown; text: string; thread: string | null
  alsoInChat: boolean | null; mentions: string[] }
export interface CatchUpItem { messageId: string; sequence: number; author: string; text: string }
export interface CatchUpList { total: number; items: CatchUpItem[] }
export interface CatchUp {
  /** The mark the span starts after, and the newest row it read. */
  after: number
  through: number
  /** Main-stream messages from others past the reader's own newest one. */
  unread: number
  /** More rows past `through` than one summary reads. */
  more: boolean
  /** Decisions waiting for the reader in this conversation (decisions.ts). */
  decisions: number
  landed: CatchUpList
  blocked: CatchUpList
  needsYou: CatchUpList
}
export interface CatchUpSpan { after: number; more: boolean; decisions: number }

type RowAuthor = { kind?: unknown; id?: unknown; name?: unknown; displayName?: unknown }
const LANDED = new Set<string>([STATUS_LABELS.done])
const BLOCKED = new Set<string>([STATUS_LABELS.blocked, STATUS_LABELS.needs_human])
const LABELS = new Set<string>(Object.values(STATUS_LABELS))

const authorOf = (row: CatchUpRow) => (row.author ?? {}) as RowAuthor
const kindOf = (row: CatchUpRow) => (row.source as { kind?: unknown } | null)?.kind
/** A row of the chat itself: top-level, from before threads, or a reply also sent to the chat (threads.ts). */
const inMainStream = (row: CatchUpRow) => !row.thread || row.thread === row.id || !!row.alsoInChat
const own = (row: CatchUpRow, personId: string) => authorOf(row).kind === 'person' && authorOf(row).id === personId

function authorName(row: CatchUpRow): string {
  const { kind, name, displayName } = authorOf(row)
  if (typeof displayName === 'string' && displayName) return displayName
  const named = typeof name === 'string' ? name : ''
  return kind === 'person' ? named.split('@')[0]! : named
}

/** The first line of `text`, at most ITEM_CHARS long. */
function shortened(text: string): string {
  const line = text.trim().split('\n')[0]!.trim()
  return line.length > ITEM_CHARS ? `${line.slice(0, ITEM_CHARS - 1)}…` : line
}

/** A status row's label and its result's first line, or null for any other row. */
function statusOf(row: CatchUpRow): { label: string; text: string } | null {
  if (kindOf(row) !== 'system') return null
  const [label, ...rest] = row.text.split('\n')
  if (!LABELS.has(label!)) return null
  const result = shortened(rest.join('\n'))
  return { label: label!, text: result ? `${label}: ${result}` : label! }
}

const item = (row: CatchUpRow, text: string): CatchUpItem => ({ messageId: row.id, sequence: row.sequence, author: authorName(row), text: shortened(text) })
const list = (items: CatchUpItem[]): CatchUpList => ({ total: items.length, items: items.slice(-CATCH_UP_ITEMS) })

/**
 * The summary of `rows`, the reader's (`personId`) unread span in sequence order. As the New messages line does (Desktop
 * unread_line.dart), the reader's own newest main-stream message reads everything before it. Only the latest status counts,
 * so a task that was stuck and moved on is not listed as blocked.
 */
export function catchUpSummary(rows: CatchUpRow[], personId: string, span: CatchUpSpan): CatchUp {
  const read = rows.reduce((at, row) => own(row, personId) && inMainStream(row) ? row.sequence : at, span.after)
  const unread = rows.filter(row => row.sequence > read && !own(row, personId))
  const shipped = unread.filter(row => kindOf(row) === SHIP_KIND).map(row => {
    const title = (row.source as { title?: unknown }).title
    return item(row, typeof title === 'string' && title ? title : row.text)
  })
  const latest = unread.filter(inMainStream).flatMap(row => {
    const status = statusOf(row)
    return status ? [{ row, ...status }] : []
  }).at(-1)
  const landed = latest && LANDED.has(latest.label) ? [...shipped, item(latest.row, latest.text)].sort((a, b) => a.sequence - b.sequence) : shipped
  const blocked = latest && BLOCKED.has(latest.label) ? [item(latest.row, latest.text)] : []
  const needsYou = unread.filter(row => row.mentions.includes(personId)).map(row => item(row, row.text))
  return { after: span.after, through: rows.at(-1)?.sequence ?? span.after, unread: unread.filter(inMainStream).length, more: span.more,
    decisions: span.decisions, landed: list(landed), blocked: list(blocked), needsYou: list(needsYou) }
}
