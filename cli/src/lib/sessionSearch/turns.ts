/**
 * What one turn of a conversation contributes to session search: what the person asked, what the
 * agent answered, and which files and commands it touched on the way.
 *
 * Built from the engines' normalized `LiveEvent` stream, so every engine's transcript format is
 * already parsed and cleaned by the normalizer that serves the live view. Tool OUTPUT, reasoning and
 * images are left out on purpose: they are nearly all of a transcript's bytes and almost none of what a
 * person remembers about it. Tool INPUT is kept, but only the parts a person would search by — a file
 * path, a command, a URL — never a heredoc body or a patch's contents.
 */

import type { LiveEvent } from '../normalize.js'
import { redactSecretsInText } from '../logBundle.js'

export interface IndexedTurn {
  /** Position in the session, counting from 0. */
  turn: number
  /** Byte offset of the transcript line that opened this turn — where a later pass resumes. */
  offset: number
  /** When the turn opened (epoch ms), or null when the transcript does not say. */
  at: number | null
  ask: string
  answer: string
  tools: string
}

export const ASK_MAX = 8_000
/**
 * What one row holds of a turn's answer and tool calls. A longer turn goes on in continuation rows of
 * its own (below), so an agent that works for hours has every hour indexed, not the first and the last.
 */
export const ANSWER_MAX = 12_000
/** Within one row, a single message longer than the row keeps its start and its end. */
const ANSWER_HEAD = 3_000
export const TOOLS_MAX = 4_000
const TOOL_VALUE_MAX = 300

// Harness and engine wrappers that ride inside a prompt but are not what the person typed.
const WRAPPER_TAGS = [
  'system-reminder', 'command-name', 'command-message', 'command-args', 'local-command-stdout',
  'local-command-stderr', 'local-command-caveat', 'user-prompt-submit-hook', 'environment_context',
  'user_instructions', 'turn_aborted',
]
const WRAPPERS = new RegExp(`<(${WRAPPER_TAGS.join('|')})>[\\s\\S]*?</\\1>`, 'g')

/**
 * Messages that arrive as the person's turn but were written by the harness or another agent: a
 * sub-agent handing back its report, a notice that a limit reset. Searchable — a report says what
 * was done — but as the agent's side, never as what the person asked.
 */
const AGENT_WRITTEN = /^(?:Another \w+ session sent a message|<agent-message\b|\[Subagent hand-back\])/
/** Notices with nothing to find: dropped. */
const NOTICE = /^(?:Your claude\.ai usage limit has reset|\[Request interrupted by user|\[SYSTEM NOTIFICATION)/

export type AskKind = 'person' | 'agent' | 'notice'

export function askKind(text: string): AskKind {
  const start = text.trimStart()
  if (NOTICE.test(start)) return 'notice'
  if (AGENT_WRITTEN.test(start)) return 'agent'
  return 'person'
}

// A paste's markers: what was pasted is the person's, and searchable; the tags around it are not.
// Nor are the tags around another agent's message.
const PASTE_TAGS = /<\/?(?:pasted_content|agent-message)\b[^>]*>/g
/**
 * What Claude Code puts around another agent's message: a label before it, and after it an
 * instruction to the model about trusting it. Neither was said in the conversation, and the
 * instruction ran to 800 characters in every hand-back.
 */
const AGENT_NOTES = /^Another \w+ session sent a message:[^\S\n]*|That "other \w+ session" is an agent working inside this same session[\s\S]*?permission laundering\.?/gm

/**
 * What the person typed, when the Codex app or an editor sent it with context in front: the files
 * they attached (`# Files mentioned by the user:`), the page open in the app's browser (`# In app
 * browser:`), the editor's open tabs (`# Context from my IDE setup:`). Each block ends at a
 * `## My request:` heading (`## My request for Codex:` in older versions), and what follows is the
 * request. The blocks were not said, so they are not the ask; a message can carry more than one.
 */
const CODEX_CONTEXT = /^# (?:Files mentioned by the user|In app browser|Context from my IDE setup):[\s\S]*?^#{1,2} My request(?: for Codex)?:[^\S\n]*\n?/gm

// The label sits at a line's start, so dropping it joins nothing. The instruction can sit mid-line:
// it leaves a space, so the text on both sides is not glued into one whitespace-free run, which the
// shared secret patterns scan in cubic time.
const dropNote = (note: string): string => (note.startsWith('Another') ? '' : ' ')

export function personAsk(text: string): string {
  return text.replace(CODEX_CONTEXT, '')
}

/**
 * Text as it is stored and searched: wrappers and Claude Code's notes around another agent's message out,
 * secrets blanked, bounded. Line breaks and each line's indentation stay, so a preview can show it as it
 * was written; any other run of spaces is one space, and blank lines are at most one.
 */
export function searchableText(text: string, max: number): string {
  const folded = redactSecretsInText(text.replace(WRAPPERS, ' ').replace(PASTE_TAGS, ' ').replace(AGENT_NOTES, dropNote))
    .replace(/\r\n?/g, '\n')
    .replace(/(\S)[^\S\n]+/g, '$1 ')
    .replace(/[^\S\n]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return folded.length > max ? folded.slice(0, max) : folded
}

function boundedAnswer(text: string): string {
  const folded = searchableText(text, Number.MAX_SAFE_INTEGER)
  if (folded.length <= ANSWER_MAX) return folded
  return `${folded.slice(0, ANSWER_HEAD)} … ${folded.slice(folded.length - (ANSWER_MAX - ANSWER_HEAD))}`
}

const TOOL_KEYS = [
  'file_path', 'filePath', 'notebook_path', 'path', 'paths', 'command', 'cmd', 'pattern', 'url',
  'query', 'description', 'subject', 'skill', 'subagent_type',
]
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm

function patchFiles(text: string): string[] {
  return [...text.matchAll(PATCH_FILE)].map((match) => match[1].trim())
}

// An unbroken run this long is an encoded blob (Codex seals sub-agent context this way), never a word.
const BLOB = /[A-Za-z0-9+/=_-]{81,}/g

function clip(value: string): string {
  const firstLine = value.split('\n', 1)[0].replace(BLOB, ' ').replace(/\s+/g, ' ').trim()
  return firstLine.length > TOOL_VALUE_MAX ? firstLine.slice(0, TOOL_VALUE_MAX) : firstLine
}

/** The searchable part of one tool call: its name and the paths, commands and queries it was given. */
export function toolText(tool: string, input: unknown): string {
  const parts: string[] = []
  const take = (value: unknown): void => {
    if (typeof value === 'string') {
      const files = patchFiles(value)
      if (files.length) parts.push(...files)
      else if (value.trim()) parts.push(clip(value.trim()))
    } else if (Array.isArray(value)) {
      for (const item of value.slice(0, 20)) if (typeof item === 'string') take(item)
    }
  }
  let value = input
  if (typeof value === 'string') {
    const text = value.trim()
    if (text.startsWith('{')) {
      try { value = JSON.parse(text) } catch { /* a plain string input */ }
    }
  }
  if (typeof value === 'string') take(value)
  else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of TOOL_KEYS) if (key in record) take(record[key])
    // apply_patch and friends carry the patch as `input`/`patch`: only its file names are kept.
    for (const key of ['input', 'patch']) {
      if (typeof record[key] === 'string') parts.push(...patchFiles(record[key] as string))
    }
  }
  return [tool, ...parts.filter(Boolean)].join(' ')
}

const opensTurn = (event: LiveEvent): boolean => event.type === 'turn_started' || event.type === 'user_message'

/** Whether one line's text or tool calls would take a row that already holds some past its bounds. */
function overflows(draft: Draft, events: readonly LiveEvent[], calls: ReadonlyArray<string | null>): boolean {
  let text = 0
  let tools = 0
  for (const [index, event] of events.entries()) {
    if (event.type === 'text_delta') text += event.payload.content.length + 1
    const call = calls[index]
    if (call !== null) tools += call.length + 1
  }
  // `answerLength` leaves out the line breaks the parts are joined with.
  return (text > 0 && draft.answerLength > 0 && draft.answerLength + draft.answer.length + text > ANSWER_MAX)
    || (tools > 0 && draft.toolsLength > 0 && draft.toolsLength + tools > TOOLS_MAX)
}

interface Draft {
  /** The message that opened the turn, as it arrived: a second announcement of it is the same turn. */
  opener: string
  turn: number
  offset: number
  at: number | null
  ask: string
  answer: string[]
  answerLength: number
  tools: string[]
  toolsLength: number
}

/**
 * Folds a stream of normalized events into turns. A turn opens on a prompt (`turn_started`, or a
 * `user_message` from an engine that replays without the turn lifecycle) and closes when the next one
 * opens; the last turn stays open because more of it may still be written.
 */
export class TurnCollector {
  private draft: Draft | null = null
  private readonly closed: IndexedTurn[] = []

  constructor(private nextTurn: number) {}

  /** The number the next turn will take. */
  get next(): number { return this.nextTurn }

  /** Events normalized from one transcript line, with that line's offset and time. */
  feed(events: readonly LiveEvent[], offset: number, at: number | null): void {
    const calls = events.map((event) => event.type === 'tool_start' ? toolText(event.payload.tool, event.payload.input) : null)
    // A turn whose row this line would overflow goes on in a continuation: a row with no ask that opens
    // at this line. Split only between lines, so a pass resumed at the continuation reads it the same way.
    if (this.draft && !events.some(opensTurn) && overflows(this.draft, events, calls)) {
      this.close()
      this.current(offset, at)
    }
    for (const [index, event] of events.entries()) {
      switch (event.type) {
        case 'turn_started':
          this.open(event.payload.userMessage, offset, at)
          break
        case 'user_message': {
          const content = event.payload.content
          // The live normalizers announce a prompt twice (the turn, then the message): one turn.
          if (this.draft && this.draft.opener === content && this.draft.answerLength === (askKind(content) === 'agent' ? content.length : 0)) break
          this.open(content, offset, at)
          break
        }
        case 'text_delta':
          this.current(offset, at).answer.push(event.payload.content)
          this.draft!.answerLength += event.payload.content.length
          // Bounded while reading: a runaway turn must not hold megabytes until it closes.
          if (this.draft!.answerLength > ANSWER_MAX * 4) this.compactAnswer()
          break
        case 'tool_start': {
          const draft = this.current(offset, at)
          if (draft.toolsLength >= TOOLS_MAX) break
          const text = calls[index]!
          draft.tools.push(text)
          draft.toolsLength += text.length + 1
          break
        }
        default:
          break
      }
    }
  }

  /** Every turn closed so far, then the one still open (if any). Call once, after the last line. */
  finish(): { closed: IndexedTurn[]; open: IndexedTurn | null } {
    const open = this.draft ? this.seal(this.draft) : null
    this.draft = null
    return { closed: this.closed, open }
  }

  private open(ask: string, offset: number, at: number | null): void {
    if (this.draft) this.close()
    const kind = askKind(ask)
    this.draft = {
      opener: ask,
      turn: this.nextTurn++, offset, at,
      ask: kind === 'person' ? searchableText(personAsk(ask), ASK_MAX) : '',
      answer: kind === 'agent' ? [ask] : [],
      answerLength: kind === 'agent' ? ask.length : 0,
      tools: [], toolsLength: 0,
    }
  }

  /** Text or a tool call before any prompt: a turn the transcript picked up in the middle. */
  private current(offset: number, at: number | null): Draft {
    if (!this.draft) this.draft = { opener: '', turn: this.nextTurn++, offset, at, ask: '', answer: [], answerLength: 0, tools: [], toolsLength: 0 }
    return this.draft
  }

  private compactAnswer(): void {
    const draft = this.draft!
    const text = boundedAnswer(draft.answer.join('\n'))
    draft.answer = [text]
    draft.answerLength = text.length
  }

  private close(): void {
    const sealed = this.seal(this.draft!)
    if (sealed) this.closed.push(sealed)
    this.draft = null
  }

  private seal(draft: Draft): IndexedTurn | null {
    const answer = boundedAnswer(draft.answer.join('\n'))
    const tools = draft.tools.join('\n').slice(0, TOOLS_MAX)
    if (!draft.ask && !answer && !tools) return null
    return { turn: draft.turn, offset: draft.offset, at: draft.at, ask: draft.ask, answer, tools }
  }
}
