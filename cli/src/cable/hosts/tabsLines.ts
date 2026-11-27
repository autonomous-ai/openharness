/**
 * The lines that carry a person's words to a terminal tab: the devices process sends a typing to the watch, the watch
 * hands it to Harness Device, and Harness Device answers `wrote`. These lines reach a terminal's script, so every hop
 * checks them again as outside text. The watch loads this file, so it imports only tabs.ts and text.ts.
 */
import { TAB_TTY, type TabApp } from './tabs.js'
import { CONTROL, MAX_TEXT } from './text.js'

// Terminal.app is not one: its only per-tab write appends a newline in the same write, sending words unchecked. Nor is
// iTerm2: its write reaches every pane its Broadcast Input joins, where a shell would run them, and nothing can see that.
export const TYPE_APPS = ['ghostty'] as const satisfies readonly TabApp[]
export type TypeApp = (typeof TYPE_APPS)[number]

export const WRITE_ID = /^[0-9a-f]{16}$/
/** A typing line's most bytes, its newline included: Harness Device reads no longer line. */
export const TYPE_LINE_MAX = 65_536
export const TYPE_ANSWER_MS = 3_000

export type TabsWrite = { write: { app: TypeApp; tty: string; text: string } } | { enter: { app: TypeApp; tty: string } }

export type TabsTyping =
  | { write: { id: string; app: TypeApp; tty: string; text: string } }
  | { enter: { id: string; app: TypeApp; tty: string } }

/**
 * `refused`: the watch told `ok:false`. `unanswered`: no answer in TYPE_ANSWER_MS, a line over TYPE_LINE_MAX, too many
 * writes already waiting, or the stream not writable. `ended`: the stream ended first.
 */
export type WroteAnswer = 'ok' | 'refused' | 'unanswered' | 'ended'

/** The devices process's side of the watch's tabs stream. */
export interface TabsLine {
  writable(): boolean
  ready(ms: number): Promise<boolean>
  /** `settled` resolves once the answer arrived or the stream ended, whichever first: the tty's lock waits on it. */
  send(line: TabsWrite): { answer: Promise<WroteAnswer>; settled: Promise<void> }
  readonly ended: AbortSignal
}

/** [value] as a record of exactly [keys], or null. */
function exactly(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const own = Object.keys(value)
  return own.length === keys.length && own.every((key) => keys.includes(key)) ? (value as Record<string, unknown>) : null
}

function target(line: Record<string, unknown>): { id: string; app: TypeApp; tty: string } | null {
  const { id, app, tty } = line
  if (typeof id !== 'string' || !WRITE_ID.test(id)) return null
  if (!(TYPE_APPS as readonly unknown[]).includes(app)) return null
  if (typeof tty !== 'string' || !TAB_TTY.test(tty)) return null
  return { id, app: app as TypeApp, tty }
}

/** A lone surrogate has no UTF-8 form: the devices type it as the replacement character, so one here was never cleaned. */
const LONE_SURROGATE = /\p{Cs}/u

/** Words as every hop counts them: UTF-16 units, as Harness Device's encode_utf16. */
function isWords(text: unknown): text is string {
  // search, not test: CONTROL is global, and test would keep its lastIndex from one text to the next.
  return typeof text === 'string' && text !== '' && text.length <= MAX_TEXT && text.search(CONTROL) === -1
    && text.search(LONE_SURROGATE) === -1
}

export function typingOf(value: unknown): TabsTyping | null {
  const top = exactly(value, ['write']) ?? exactly(value, ['enter'])
  if (!top) return null
  if ('write' in top) {
    const write = exactly(top.write, ['id', 'app', 'tty', 'text'])
    const to = write && target(write)
    return write && to && isWords(write.text) ? { write: { ...to, text: write.text } } : null
  }
  const enter = exactly(top.enter, ['id', 'app', 'tty'])
  const to = enter && target(enter)
  return to ? { enter: to } : null
}

/** The typing's JSON line with its newline, or null past TYPE_LINE_MAX bytes. */
export function typingLine(typing: TabsTyping): string | null {
  const line = `${JSON.stringify(typing)}\n`
  return Buffer.byteLength(line) <= TYPE_LINE_MAX ? line : null
}

export function wroteOf(value: unknown): { id: string; ok: boolean } | null {
  const wrote = exactly(value, ['id', 'ok'])
  if (!wrote) return null
  const { id, ok } = wrote
  return typeof id === 'string' && WRITE_ID.test(id) && typeof ok === 'boolean' ? { id, ok } : null
}
