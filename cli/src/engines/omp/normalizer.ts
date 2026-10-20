/**
 * omp (Oh My Pi) JSONL → shared event vocabulary.
 *
 * omp is Pi's fork, and this is a copy of `engines/pi/normalizer.ts` re-measured against omp 18.12.6
 * sessions (`engines/README.md`, "When your agent is a FORK"). The records are Pi's, so the structure
 * carries over; the values below are what measuring 200 real sessions changed.
 *
 *   line 1  {"type":"title","v":1,"title":"…","source":"auto","pad":"   "}  rewritten in place, padded
 *   line 2  {"type":"session","version":3,"id":"<uuid>","timestamp":"…","cwd":"/abs/path"}
 *   then    {"type":"message","id":"<8hex>","parentId":"<8hex>","message":{…}}
 *           {"type":"custom_message"|"model_change"|"thinking_level_change"|"compaction"|"ttsr_injection"|…}
 *
 *   message.role "user"       content: string | [{type:'text',text}]
 *                "assistant"  content: [{type:'thinking',thinking} | {type:'text',text}
 *                                       | {type:'toolCall',id,name,arguments,intent}]
 *                             + stopReason: 'toolUse' | 'stop' | 'error' | 'aborted', + errorMessage
 *                "toolResult" {toolCallId, toolName, content:[{type:'text',text} | {type:'image',…}], isError}
 *                "developer" | "custom"  omp's own injected context, not the conversation
 *
 * A user message opens a turn. An assistant message whose stopReason is `stop` or `error` closes it
 * once every tool call it made has been answered. `aborted` means two different things, told apart by
 * its `errorMessage` (measured on 247 aborts):
 *  - `TTSR matched rule: <name>`: omp stopped its own stream to inject a rule, and goes on with the same
 *    turn (221 of 228; the other 7 were cut short by the user's next prompt). Not a boundary.
 *  - anything else (`Interrupted by user` on Escape, `Request was aborted`): the turn is over, and nothing
 *    else is written until the next prompt. It closes the turn at once, tools still pending or not.
 */

import type { EngineNormalizer } from '../types.js'
import type { LastTurnText, LiveEvent, SessionEvent } from '../../lib/normalize.js'

type JsonObject = Record<string, unknown>

const MAX_OUTPUT = 2_000
const MAX_THINKING = 500

/** omp's tools that are the same tool as a card the web/device renders; the rest keep their own name. */
const TOOL_NAMES: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  bash: 'Bash',
  grep: 'Grep',
  glob: 'Glob',
  task: 'Task',
  web_search: 'WebSearch',
}

export function ompToolName(name: string): string {
  const key = name.toLowerCase()
  if (TOOL_NAMES[key]) return TOOL_NAMES[key]
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'tool'
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parse(line: string): JsonObject | null {
  try { return object(JSON.parse(line)) } catch { return null }
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n…[truncated]` : value
}

/** `content` is either a plain string or an array of typed parts — flatten the text of both. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const p = object(part)
      return p && p.type === 'text' ? str(p.text) : ''
    })
    .filter(Boolean)
    .join('')
}

function contentParts(content: unknown): JsonObject[] {
  if (Array.isArray(content)) return content.map(object).filter((p): p is JsonObject => p !== null)
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return []
}

function toolSummary(name: string, output: string, isError: boolean): string {
  const first = output.split('\n').map((line) => line.trim()).find(Boolean) ?? ''
  if (isError) return first ? `${name} failed: ${first}` : `${name} failed`
  return first || `${name} completed`
}

function compactEvent(): LiveEvent {
  return {
    type: 'context_compact',
    payload: { message: 'Context was compacted — the previous conversation has been summarized to free up space.' },
  }
}

/** `stop` and `error` end a turn. `toolUse` means a tool runs next; `aborted` is `userAbort`'s to judge. */
function isTerminalStop(stopReason: string): boolean {
  return stopReason === 'stop' || stopReason === 'error'
}

/** An abort the user (or a cancelled request) made, not omp's own rule injection. */
function userAbort(message: JsonObject): boolean {
  return str(message.stopReason) === 'aborted' && !str(message.errorMessage).startsWith('TTSR matched rule')
}

export class OmpNormalizer implements EngineNormalizer {
  private open = false
  private pendingTools = new Set<string>()
  private toolNames = new Map<string, string>()
  private thinkingCounter = 0

  constructor(private readonly mode: 'live' | 'replay') {}

  get turnOpen(): boolean { return this.open }

  closeTurn(): void { this.open = false; this.pendingTools.clear() }

  ingest(line: string): LiveEvent[] {
    const raw = parse(line)
    if (!raw) return []
    const type = str(raw.type)
    if (type === 'compaction') return [compactEvent()]
    if (type !== 'message') return [] // title, session header, custom_message, model_change, …
    const message = object(raw.message)
    if (!message) return []

    const role = str(message.role)
    if (role === 'user') return this.userMessage(message)
    if (role === 'assistant') return this.assistantMessage(message)
    if (role === 'toolResult') return this.toolResult(message)
    return [] // developer, custom: omp's own context
  }

  finishReplay(): LiveEvent[] {
    return this.mode === 'replay' ? [{ type: 'done', payload: { result: 'success' } }] : []
  }

  private userMessage(message: JsonObject): LiveEvent[] {
    const text = contentText(message.content).trim()
    if (!text) return []
    if (this.mode === 'replay') return [{ type: 'user_message', payload: { content: text } }]
    const events: LiveEvent[] = []
    if (this.open) events.push({ type: 'turn_ended', payload: {} })
    this.open = true
    this.pendingTools.clear()
    events.push({ type: 'turn_started', payload: { userMessage: text } })
    return events
  }

  private assistantMessage(message: JsonObject): LiveEvent[] {
    const events: LiveEvent[] = []
    for (const part of contentParts(message.content)) {
      const type = str(part.type)
      if (type === 'thinking') {
        const thinking = str(part.thinking)
        if (!thinking) continue
        events.push({
          type: 'thinking_delta',
          payload: { content: clip(thinking, MAX_THINKING), thinkingId: `thinking-omp-${this.thinkingCounter++}` },
        })
      } else if (type === 'text') {
        const text = str(part.text)
        if (text) events.push({ type: 'text_delta', payload: { content: text } })
      } else if (type === 'toolCall') {
        const id = str(part.id)
        if (!id) continue
        const tool = ompToolName(str(part.name))
        this.toolNames.set(id, tool)
        this.pendingTools.add(id)
        events.push({ type: 'tool_start', payload: { id, tool, input: part.arguments ?? {} } })
      }
    }
    if (this.mode === 'replay' || !this.open) return events
    if (userAbort(message)) {
      this.open = false
      this.pendingTools.clear()
      events.push({ type: 'turn_ended', payload: { aborted: true } })
    } else if (isTerminalStop(str(message.stopReason)) && this.pendingTools.size === 0) {
      this.open = false
      events.push({ type: 'turn_ended', payload: {} })
    }
    return events
  }

  private toolResult(message: JsonObject): LiveEvent[] {
    const id = str(message.toolCallId)
    if (!id) return []
    this.pendingTools.delete(id)
    const tool = this.toolNames.get(id) || ompToolName(str(message.toolName))
    this.toolNames.delete(id)
    const output = contentText(message.content)
    const isError = message.isError === true
    return [{
      type: 'tool_end',
      payload: { id, tool, output: clip(output, MAX_OUTPUT), isError, summary: toolSummary(tool, output, isError) },
    }]
  }
}

/** Full-session replay (session_get) — same render path as the live stream. */
export function ompMessagesToEvents(rawLines: string[]): SessionEvent[] {
  const normalizer = new OmpNormalizer('replay')
  const events: SessionEvent[] = []
  for (const line of rawLines) events.push(...normalizer.ingest(line) as SessionEvent[])
  events.push(...normalizer.finishReplay() as SessionEvent[])
  return events
}

/** Last user prompt + the assistant text that followed it — the recap source of truth. */
export function lastOmpTurnText(rawLines: string[]): LastTurnText | null {
  let userMessage = ''
  let assistantText = ''
  for (const line of rawLines) {
    const raw = parse(line)
    if (!raw || str(raw.type) !== 'message') continue
    const message = object(raw.message)
    if (!message) continue
    const role = str(message.role)
    if (role === 'user') {
      const text = contentText(message.content).trim()
      if (text) { userMessage = text; assistantText = '' }
    } else if (role === 'assistant') {
      const text = contentParts(message.content)
        .filter((part) => str(part.type) === 'text')
        .map((part) => str(part.text))
        .join('')
        .trim()
      if (text) assistantText += `${assistantText ? '\n\n' : ''}${text}`
    }
  }
  return assistantText ? { userMessage, assistantText } : null
}

/**
 * Turn-snapped pagination window for `session_get {limit, before}`; cursor format `omp:<lineIndex>`.
 * The start snaps back to a user message so a window never splits a turn (the replay is stateful:
 * a tool_start's name must still be known when its tool_end is rendered).
 */
export function windowOmpLines(
  rawLines: string[],
  opts: { limit: number; before?: string },
): { window: string[]; hasMore: boolean; oldestCursor: string | null; staleCursor?: boolean } {
  let endIndex = rawLines.length
  if (opts.before) {
    const match = /^omp:(\d+)$/.exec(opts.before)
    if (!match) return { window: [], hasMore: false, oldestCursor: null, staleCursor: true }
    endIndex = Number(match[1])
    if (!Number.isSafeInteger(endIndex) || endIndex < 0 || endIndex > rawLines.length) {
      return { window: [], hasMore: false, oldestCursor: null, staleCursor: true }
    }
  }

  let start = Math.max(0, endIndex - opts.limit)
  while (start > 0) {
    const raw = parse(rawLines[start])
    if (raw && str(raw.type) === 'message' && str(object(raw.message)?.role) === 'user') break
    start--
  }
  return {
    window: rawLines.slice(start, endIndex),
    hasMore: start > 0,
    oldestCursor: `omp:${start}`,
  }
}
