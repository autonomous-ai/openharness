/**
 * OpenClaw transcript rows → the shared event vocabulary. Read off OpenClaw 2026.11.2 (`__fixtures__/`).
 *
 * The rows are Pi's shapes, one decoded `transcript_events` record each:
 *
 *   {type:'message', message:{role:'user', content:'<text>', __openclaw:{senderIsOwner, …}}}
 *   {type:'message', message:{role:'assistant', content:[{type:'thinking'|'text'|'toolCall', …}], stopReason}}
 *   {type:'message', message:{role:'toolResult', toolCallId, toolName, content:[{type:'text', text}], isError}}
 *   {type:'custom_message', customType:'run-failed-before-reply', content:'<what the TUI shows>', display:true}
 *
 * and rows nobody reads (`session`, `thinking_level_change`, `reset`, `leaf`, `custom` and the hidden
 * `custom_message`s), which give nothing.
 *
 * Every run starts with its own user row, and nothing marks its end, so the turn follows Pi's rule: a user row opens
 * it, and an assistant row whose `stopReason` is not `toolUse` closes it once every call it made was answered. Two
 * cases differ from Pi, both recorded:
 * - A failed run writes an empty assistant row with `stopReason:'error'`, then a `run-failed-before-reply` row with the
 *   message the TUI shows. The turn closes on that second row, so the message is inside the turn.
 * - Esc writes nothing: the call stays unanswered and only the session's status says the run was killed. The reader
 *   calls `closeTurn` then. A user row that arrives after an answered but unclosed turn means that run is over too.
 *
 * Heartbeat polls on `main` are not the person's: the whole run, from its poll row to its reply, gives no event.
 */

import type { LastTurnText, LiveEvent, SessionEvent } from '../../lib/normalize.js'
import type { OpenclawEvent } from './reader.js'

type JsonObject = Record<string, unknown>

const MAX_OUTPUT = 2_000
const MAX_THINKING = 500

/** The user row the Gateway writes for a heartbeat, with `senderIsOwner:false`. */
const HEARTBEAT_POLL = '[OpenClaw heartbeat poll]'

/** `exec` runs a shell command (`arguments:{command, title}`): the Bash card renders it. */
const TOOL_NAMES: Record<string, string> = { exec: 'Bash' }

/** How a card that never got its result ends, by why the run stopped. */
const CLOSED_CARD = {
  aborted: { status: 'interrupted', isError: false },
  failed: { status: 'failed', isError: true },
  timeout: { status: 'timed out', isError: true },
} as const

function openclawToolName(name: string): string {
  return TOOL_NAMES[name] ?? (name ? name.charAt(0).toUpperCase() + name.slice(1) : 'tool')
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n…[truncated]` : value
}

function contentParts(content: unknown): JsonObject[] {
  if (Array.isArray(content)) return content.map(object).filter((p): p is JsonObject => p !== null)
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return []
}

function contentText(content: unknown): string {
  return contentParts(content).filter((part) => part.type === 'text').map((part) => str(part.text)).join('')
}

function toolSummary(name: string, output: string, isError: boolean): string {
  const first = output.split('\n').map((line) => line.trim()).find(Boolean) ?? ''
  if (isError) return first ? `${name} failed: ${first}` : `${name} failed`
  return first || `${name} completed`
}

/** The row's message and role, when it is a `message` row. */
function messageOf(record: JsonObject): { message: JsonObject; role: string } | null {
  if (record.type !== 'message') return null
  const message = object(record.message)
  return message ? { message, role: str(message.role) } : null
}

function isRunFailed(record: JsonObject): boolean {
  return record.type === 'custom_message' && record.customType === 'run-failed-before-reply'
}

function isHeartbeatPoll(message: JsonObject): boolean {
  return object(message.__openclaw)?.senderIsOwner === false && contentText(message.content).trim() === HEARTBEAT_POLL
}

/**
 * A run is over at a stop reason other than `toolUse`, except `error`: a failed run's message comes in the
 * `run-failed-before-reply` row after it.
 */
function endsRun(stopReason: string): boolean {
  return !!stopReason && stopReason !== 'toolUse' && stopReason !== 'error'
}

function toolCallIds(message: JsonObject): string[] {
  return contentParts(message.content).filter((part) => part.type === 'toolCall').map((part) => str(part.id)).filter(Boolean)
}

/** Follows a heartbeat run from its poll row to its reply, so every reader of the rows skips the same ones. */
class HeartbeatRun {
  private active = false
  private readonly pending = new Set<string>()

  skips(record: JsonObject): boolean {
    const row = messageOf(record)
    if (row?.role === 'user') {
      this.active = isHeartbeatPoll(row.message)
      this.pending.clear()
      return this.active
    }
    if (!this.active) return false
    if (row?.role === 'assistant') {
      for (const id of toolCallIds(row.message)) this.pending.add(id)
      if (endsRun(str(row.message.stopReason)) && this.pending.size === 0) this.active = false
    } else if (row?.role === 'toolResult') {
      this.pending.delete(str(row.message.toolCallId))
    } else if (isRunFailed(record)) {
      this.active = false
    }
    return true
  }
}

export class OpenclawNormalizer {
  private open = false
  /** An assistant row came in the open turn: a user row after it starts another run. */
  private answered = false
  /** Calls with no result yet, id → tool name. */
  private readonly pendingTools = new Map<string, string>()
  private readonly heartbeat = new HeartbeatRun()
  private thinkingCounter = 0

  constructor(private readonly mode: 'live' | 'replay') {}

  get turnOpen(): boolean { return this.open }

  push(events: OpenclawEvent[]): LiveEvent[] {
    const out: LiveEvent[] = []
    for (const event of events) out.push(...this.ingest(event.record))
    return out
  }

  /** The run ended with no row that says so (the session's status left `running`): end its cards and the turn. */
  closeTurn(reason: 'aborted' | 'failed' | 'timeout'): LiveEvent[] {
    if (!this.open) return []
    const { status, isError } = CLOSED_CARD[reason]
    const events: LiveEvent[] = []
    for (const [id, tool] of this.pendingTools) {
      events.push({ type: 'tool_end', payload: { id, tool, output: `Tool ${status}`, isError, summary: `${tool} ${status}` } })
    }
    this.pendingTools.clear()
    this.open = false
    this.answered = false
    // A run cut short produced no answer to recap.
    events.push({ type: 'turn_ended', payload: { aborted: true } })
    return events
  }

  private ingest(record: JsonObject): LiveEvent[] {
    if (this.heartbeat.skips(record)) return []
    if (isRunFailed(record)) return this.runFailed(record)
    const row = messageOf(record)
    if (row?.role === 'user') return this.userMessage(row.message)
    if (row?.role === 'assistant') return this.assistantMessage(row.message)
    if (row?.role === 'toolResult') return this.toolResult(row.message)
    return []
  }

  private userMessage(message: JsonObject): LiveEvent[] {
    const text = contentText(message.content).trim()
    if (!text) return []
    if (this.mode === 'replay') return [{ type: 'user_message', payload: { content: text } }]
    // Sent before the model answered: the same wait, so the same turn.
    if (this.open && !this.answered) return [{ type: 'user_message', payload: { content: text } }]
    const events = this.closeTurn('aborted')
    this.open = true
    events.push({ type: 'turn_started', payload: { userMessage: text } })
    return events
  }

  private assistantMessage(message: JsonObject): LiveEvent[] {
    this.answered = true
    const events: LiveEvent[] = []
    for (const part of contentParts(message.content)) {
      const type = str(part.type)
      if (type === 'thinking') {
        const thinking = str(part.thinking)
        if (!thinking) continue
        events.push({
          type: 'thinking_delta',
          payload: { content: clip(thinking, MAX_THINKING), thinkingId: `thinking-openclaw-${this.thinkingCounter++}` },
        })
      } else if (type === 'text') {
        const text = str(part.text)
        if (text) events.push({ type: 'text_delta', payload: { content: text } })
      } else if (type === 'toolCall') {
        const id = str(part.id)
        if (!id) continue
        const tool = openclawToolName(str(part.name))
        this.pendingTools.set(id, tool)
        events.push({ type: 'tool_start', payload: { id, tool, input: part.arguments ?? {} } })
      }
    }
    if (this.mode === 'live' && this.open && endsRun(str(message.stopReason)) && this.pendingTools.size === 0) {
      this.open = false
      this.answered = false
      events.push({ type: 'turn_ended', payload: {} })
    }
    return events
  }

  private toolResult(message: JsonObject): LiveEvent[] {
    const id = str(message.toolCallId)
    if (!id) return []
    const tool = this.pendingTools.get(id) ?? openclawToolName(str(message.toolName))
    this.pendingTools.delete(id)
    const output = contentText(message.content)
    const isError = message.isError === true
    return [{
      type: 'tool_end',
      payload: { id, tool, output: clip(output, MAX_OUTPUT), isError, summary: toolSummary(tool, output, isError) },
    }]
  }

  private runFailed(record: JsonObject): LiveEvent[] {
    const text = contentText(record.content).trim()
    const events: LiveEvent[] = text ? [{ type: 'text_delta', payload: { content: text } }] : []
    if (this.mode === 'live') events.push(...this.closeTurn('failed'))
    return events
  }
}

const isSessionEvent = (event: LiveEvent): event is SessionEvent => event.type !== 'turn_started' && event.type !== 'turn_ended'

/** The whole session for history: the same render path as the live stream, with no turn markers. */
export function openclawMessagesToEvents(events: OpenclawEvent[]): SessionEvent[] {
  const out = new OpenclawNormalizer('replay').push(events).filter(isSessionEvent)
  out.push({ type: 'done', payload: { result: 'success' } })
  return out
}

/** The last prompt and the assistant text that followed it, heartbeat runs left out. */
export function lastOpenclawTurnText(events: OpenclawEvent[]): LastTurnText | null {
  const heartbeat = new HeartbeatRun()
  let userMessage = ''
  let assistantText = ''
  for (const { record } of events) {
    if (heartbeat.skips(record)) continue
    const row = messageOf(record)
    if (row?.role === 'user') {
      const text = contentText(row.message.content).trim()
      if (text) { userMessage = text; assistantText = '' }
    } else if (row?.role === 'assistant') {
      const text = contentText(row.message.content).trim()
      if (text) assistantText += `${assistantText ? '\n\n' : ''}${text}`
    }
  }
  return assistantText ? { userMessage, assistantText } : null
}

/**
 * The `limit` rows before the `before` cursor (`openclaw:<index>`, the end when absent), snapped back to a user row so
 * a window never splits a turn: a result must still find its call's tool name, and a heartbeat reply its poll.
 */
export function windowOpenclawEvents(
  events: OpenclawEvent[],
  opts: { limit: number; before?: string },
): { window: OpenclawEvent[]; hasMore: boolean; oldestCursor: string | null; staleCursor?: boolean } {
  let end = events.length
  if (opts.before) {
    const match = /^openclaw:(\d+)$/.exec(opts.before)
    end = match ? Number(match[1]) : -1
    if (!Number.isSafeInteger(end) || end < 0 || end > events.length) return { window: [], hasMore: false, oldestCursor: null, staleCursor: true }
  }
  let start = Math.max(0, end - opts.limit)
  while (start > 0 && messageOf(events[start].record)?.role !== 'user') start--
  return { window: events.slice(start, end), hasMore: start > 0, oldestCursor: `openclaw:${start}` }
}
