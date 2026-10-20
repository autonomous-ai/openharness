/**
 * Prime Agent JSONL → shared event vocabulary. A deliberate copy of `engines/pi/normalizer.ts` (Prime is
 * Pi's fork; engines/README.md "When your agent is a FORK"), changed only where a recording disagreed.
 *
 * Prime writes `<agentDir>/sessions/<uuidv7>.jsonl` in Pi's v3 format, plus entries Pi does not have
 * (`custom_message`, `service_tier_change`, `session_state`, `child_usage_attributed`, `request_*`, `git_state`,
 * `agent_status`, …). Measured on prime-agent 0.9.5 across 23 root and 1,618 child sessions on one machine:
 *
 * - MOST TURNS HAVE NO USER MESSAGE. 1,036 user messages against 8,332 `agent_message`, 1,298
 *   `async_bash_completion`, 192 `rlm_child_terminal_notice` and 119 `heartbeat_prompt` custom messages, each
 *   followed by an assistant reply. Read by Pi's rule ("a user line opens a turn") those turns streamed text
 *   and tools with no `turn_started`/`turn_ended` at all: no busy tile, no recap.
 * - Not every displayed custom message is a prompt. `refinement_outcome`, `compaction_outcome`,
 *   `ipython_state_restored` and `autonomous_status` are notices: never once followed by a reply of their own.
 *   Opening a turn on one would hold it open for ever. So a known prompt opens a turn at once; any other
 *   displayed message is only remembered, and opens a turn if an assistant message actually follows.
 * - The one built-in tool is `ipython` (`{code}`), a Python REPL whose `bash()` runs shell commands. It is
 *   labelled `Python`; relabelling it `Bash` would be a guess about the code.
 *
 * NOTE: entries form a TREE (`id`/`parentId`), as in Pi; read in file order.
 */

import type { EngineNormalizer } from '../types.js'
import type { LastTurnText, LiveEvent, SessionEvent } from '../../lib/normalize.js'

type JsonObject = Record<string, unknown>

const MAX_OUTPUT = 2_000
const MAX_THINKING = 500

/** Pi's built-in tools are lowercase (Prime keeps them for a session that enables them); map them onto the vocabulary the web/device cards render. */
const TOOL_NAMES: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  bash: 'Bash',
  grep: 'Grep',
  find: 'Glob',
  ls: 'LS',
  list: 'LS',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  todowrite: 'TodoWrite',
  todoread: 'TodoRead',
  task: 'Task',
  ipython: 'Python',
}

export function primeToolName(name: string): string {
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

/**
 * Displayed custom messages that hand the model a new prompt (each measured followed by an assistant reply).
 * `goal_context` and `session_slash_command` were seen too rarely to classify, so they take the lazy path.
 */
const PROMPTING_CUSTOM_TYPES = new Set([
  'agent_message', 'async_bash_completion', 'rlm_child_terminal_notice', 'rlm_child_failure', 'heartbeat_prompt',
])

/** A custom message's prompt text, or '' when it is hidden from the person (`display: false`). */
function customPrompt(raw: JsonObject): { text: string; prompting: boolean } | null {
  if (raw.display !== true) return null
  const text = contentText(raw.content).trim()
  if (!text) return null
  return { text, prompting: PROMPTING_CUSTOM_TYPES.has(str(raw.customType)) }
}

/** A turn ends on any stop reason other than `toolUse` (which means the assistant is calling a tool). */
function isTerminalStop(stopReason: string): boolean {
  return !!stopReason && stopReason !== 'toolUse'
}

export class PrimeNormalizer implements EngineNormalizer {
  private open = false
  /** A displayed notice that may yet turn out to be a prompt — see the file comment. */
  private pendingPrompt: string | null = null
  private pendingTools = new Set<string>()
  private toolNames = new Map<string, string>()
  private thinkingCounter = 0

  constructor(private readonly mode: 'live' | 'replay') {}

  get turnOpen(): boolean { return this.open }

  closeTurn(): void { this.open = false; this.pendingTools.clear(); this.pendingPrompt = null }

  ingest(line: string): LiveEvent[] {
    const raw = parse(line)
    if (!raw) return []
    const type = str(raw.type)
    if (type === 'compaction') return [compactEvent()]
    if (type === 'custom_message') return this.customMessage(raw)
    if (type !== 'message') return [] // session header, model_change, thinking_level_change, label, request_*, …
    const message = object(raw.message)
    if (!message) return []

    const role = str(message.role)
    if (role === 'user') return this.userMessage(message)
    if (role === 'assistant') return this.assistantMessage(message)
    if (role === 'toolResult') return this.toolResult(message)
    if (role === 'bashExecution') return this.bashExecution(raw, message)
    return []
  }

  finishReplay(): LiveEvent[] {
    return this.mode === 'replay' ? [{ type: 'done', payload: { result: 'success' } }] : []
  }

  private userMessage(message: JsonObject): LiveEvent[] {
    const text = contentText(message.content).trim()
    if (!text) return []
    return this.openTurn(text)
  }

  private openTurn(text: string): LiveEvent[] {
    this.pendingPrompt = null
    if (this.mode === 'replay') return [{ type: 'user_message', payload: { content: text } }]
    const events: LiveEvent[] = []
    if (this.open) events.push({ type: 'turn_ended', payload: {} })
    this.open = true
    this.pendingTools.clear()
    events.push({ type: 'turn_started', payload: { userMessage: text } })
    return events
  }

  /**
   * A message Prime delivered on the model's behalf. Inside an open turn it is steering, already part of that
   * turn. Between turns a known prompt opens one; anything else waits for a reply to prove it was one.
   */
  private customMessage(raw: JsonObject): LiveEvent[] {
    const prompt = customPrompt(raw)
    if (!prompt) return []
    if (this.open && this.mode !== 'replay') return []
    if (prompt.prompting) return this.openTurn(prompt.text)
    this.pendingPrompt = prompt.text
    return []
  }

  private assistantMessage(message: JsonObject): LiveEvent[] {
    // A reply with no turn open: a pending notice was a prompt after all, or Prime delivered a prompt this
    // reader does not know. Either way something is answering, so the turn has to exist (Amp's lesson).
    const events: LiveEvent[] = !this.open && (this.mode !== 'replay' || this.pendingPrompt !== null)
      ? this.openTurn(this.pendingPrompt ?? '')
      : []
    for (const part of contentParts(message.content)) {
      const type = str(part.type)
      if (type === 'thinking') {
        const thinking = str(part.thinking)
        if (!thinking) continue
        events.push({
          type: 'thinking_delta',
          payload: { content: clip(thinking, MAX_THINKING), thinkingId: `thinking-prime-${this.thinkingCounter++}` },
        })
      } else if (type === 'text') {
        const text = str(part.text)
        if (text) events.push({ type: 'text_delta', payload: { content: text } })
      } else if (type === 'toolCall') {
        const id = str(part.id)
        if (!id) continue
        const tool = primeToolName(str(part.name))
        this.toolNames.set(id, tool)
        this.pendingTools.add(id)
        events.push({ type: 'tool_start', payload: { id, tool, input: part.arguments ?? {} } })
      }
    }
    if (this.mode !== 'replay' && this.open && isTerminalStop(str(message.stopReason)) && this.pendingTools.size === 0) {
      this.open = false
      events.push({ type: 'turn_ended', payload: {} })
    }
    return events
  }

  private toolResult(message: JsonObject): LiveEvent[] {
    const id = str(message.toolCallId)
    if (!id) return []
    this.pendingTools.delete(id)
    const tool = this.toolNames.get(id) || primeToolName(str(message.toolName))
    this.toolNames.delete(id)
    const output = contentText(message.content)
    const isError = message.isError === true
    return [{
      type: 'tool_end',
      payload: { id, tool, output: clip(output, MAX_OUTPUT), isError, summary: toolSummary(tool, output, isError) },
    }]
  }

  /** `!cmd` typed directly in the TUI — render it as a Bash card so the remote sees what ran. */
  private bashExecution(raw: JsonObject, message: JsonObject): LiveEvent[] {
    const command = str(message.command)
    if (!command) return []
    const id = `bash-${str(raw.id) || this.thinkingCounter++}`
    const output = str(message.output)
    const isError = typeof message.exitCode === 'number' && message.exitCode !== 0
    return [
      { type: 'tool_start', payload: { id, tool: 'Bash', input: { command } } },
      {
        type: 'tool_end',
        payload: { id, tool: 'Bash', output: clip(output, MAX_OUTPUT), isError, summary: toolSummary('Bash', output, isError) },
      },
    ]
  }
}

/** Full-session replay (session_get) — same render path as the live stream. */
export function primeMessagesToEvents(rawLines: string[]): SessionEvent[] {
  const normalizer = new PrimeNormalizer('replay')
  const events: SessionEvent[] = []
  for (const line of rawLines) events.push(...normalizer.ingest(line) as SessionEvent[])
  events.push(...normalizer.finishReplay() as SessionEvent[])
  return events
}

/** Last user prompt + the assistant text that followed it — the recap source of truth. */
export function lastPrimeTurnText(rawLines: string[]): LastTurnText | null {
  let userMessage = ''
  let assistantText = ''
  for (const line of rawLines) {
    const raw = parse(line)
    if (!raw) continue
    if (str(raw.type) === 'custom_message') {
      const prompt = customPrompt(raw)
      if (prompt?.prompting) { userMessage = prompt.text; assistantText = '' }
      continue
    }
    if (str(raw.type) !== 'message') continue
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

/** Session id + cwd from the header line, for registration/repair. */
export function primeSessionMeta(rawLines: string[]): { id: string; cwd: string } | null {
  for (const line of rawLines) {
    const raw = parse(line)
    if (!raw || str(raw.type) !== 'session') continue
    const id = str(raw.id)
    if (id) return { id, cwd: str(raw.cwd) }
  }
  return null
}

/**
 * Turn-snapped pagination window for `session_get {limit, before}`; cursor format `prime:<lineIndex>`.
 * The start snaps back to a user message (or a prompting custom message) so a window never splits a turn (the replay is stateful:
 * a tool_start's name must still be known when its tool_end is rendered).
 */
export function windowPrimeLines(
  rawLines: string[],
  opts: { limit: number; before?: string },
): { window: string[]; hasMore: boolean; oldestCursor: string | null; staleCursor?: boolean } {
  let endIndex = rawLines.length
  if (opts.before) {
    const match = /^prime:(\d+)$/.exec(opts.before)
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
    if (raw && str(raw.type) === 'custom_message' && customPrompt(raw)?.prompting) break
    start--
  }
  return {
    window: rawLines.slice(start, endIndex),
    hasMore: start > 0,
    oldestCursor: `prime:${start}`,
  }
}
