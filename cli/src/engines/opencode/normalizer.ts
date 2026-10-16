/**
 * OpenCode → web ServerEvent conversion.
 *
 * Unlike claude/codex/cursor, OpenCode does NOT write a per-session transcript file — it persists
 * `session`/`message`/`part` rows in a SQLite DB (`~/.local/share/opencode/opencode.db`). The live
 * tailer is `OpencodeReader` (polls the DB); this module holds the pure row→event mapping it shares
 * with the replay / recap paths (`session_get`, device recap).
 *
 * OpenCode 2 stopped writing those tables: a conversation lives in `session_v2` and `session_message`, one row per
 * user prompt, assistant step or turn end (`ocMessageFromV2` below turns a row into the same `OcMessage` shape, so
 * everything downstream reads both versions alike).
 *
 * On-disk shapes of v1 (validated against opencode 1.18.6):
 *   message.data = { role:'user'|'assistant', model:{providerID,modelID}, parentID?, path:{cwd,root}, tokens{…} }
 *   part.data    = discriminated by `type`:
 *     text{text} · reasoning{text} · step-start{} · step-finish{reason:'stop',…} ·
 *     tool{tool, state:{status:'pending'|'running'|'completed'|'error', input, output, title}}
 */

import type { LastTurnText, SessionEvent, SubagentSummary } from '../../lib/normalize.js'

export const MAX_OUTPUT = 2_000
export const MAX_THINKING = 500

export interface OcPart {
  id: string
  type: string
  data: Record<string, unknown>
}

export interface OcMessage {
  id: string
  role: string
  timeCreated: number
  /** OpenCode 2 only: the row's `session_message.seq`, the order of a session's messages (time and id can tie or disagree). */
  seq?: number
  data: Record<string, unknown>
  parts: OcPart[]
}

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n…[truncated]` : value
}

/** A row of OpenCode 2's `session_message` table, its `data` column parsed. */
export interface OcV2Row {
  id: string
  type: string
  seq: number
  timeCreated: number
  data: Record<string, unknown>
}

/** The `session_message` types that are turns: what the user asked, what the model did, and the end of the turn. */
export const OC_V2_TURN_TYPES = ['user', 'assistant', 'idle'] as const

/**
 * One OpenCode 2 `session_message` row as the v1 message it stands for, or null for the rows that are not part
 * of the conversation (compaction, shell, synthetic, system). Shapes read off 2.0.29's own store:
 *
 *   user      {text, time{created}, files[], agents[]}
 *   assistant {content[], finish, time{created,completed}, tokens, error?} — one row per model step, rewritten in
 *             place while it streams; content items are {type:'text'|'reasoning', text} or
 *             {type:'tool', id, name, state{status, input, content[{type:'text',text}|{type:'file'}], error?, metadata}, time{created,ran,completed}}
 *   idle      {outcome:'succeeded'|'interrupted'|'failed', time} — written when a turn ends, whatever the outcome
 *
 * Tool names are v1's, except the two v2 added that v1 has an equivalent of: `shell` is a `bash` (`TOOL_NAMES`) and
 * `subagent` a `task`, whose sub-agent session is in `metadata.sessionID`.
 *
 * A turn ends in a `step-finish` with reason `stop` in v1, which every reader already closes on, so both ways a v2
 * turn ends get one: the assistant step that finished with `stop`, and the `idle` row (the only mark of a turn that
 * was interrupted or failed). A step that finished with `tool-calls` is not an end.
 */
export function ocMessageFromV2(row: OcV2Row): OcMessage | null {
  const { id, data } = row
  const message = (role: string, parts: OcPart[]): OcMessage => ({ id, role, timeCreated: row.timeCreated, seq: row.seq, data, parts })
  const stop = (): OcPart => ({ id: `${id}:stop`, type: 'step-finish', data: { type: 'step-finish', reason: 'stop' } })
  if (row.type === 'user') {
    return message('user', [{ id: `${id}:0`, type: 'text', data: { type: 'text', text: str(data.text) } }])
  }
  if (row.type === 'idle') return message('assistant', [stop()])
  if (row.type !== 'assistant') return null
  const content = Array.isArray(data.content) ? data.content : []
  const parts: OcPart[] = []
  content.forEach((raw, index) => {
    const item = object(raw)
    if (!item) return
    const type = str(item.type)
    const partId = str(item.id) || `${id}:${index}`
    if (type === 'text' || type === 'reasoning') parts.push({ id: partId, type, data: { type, text: str(item.text) } })
    else if (type === 'tool') parts.push({ id: partId, type, data: v2ToolData(item) })
  })
  if (str(data.finish) === 'stop') parts.push(stop())
  return message('assistant', parts)
}

/** A v2 tool item in the shape of a v1 `tool` part, which `toolPartEvents` and the readers render. */
function v2ToolData(item: Record<string, unknown>): Record<string, unknown> {
  const state = object(item.state) ?? {}
  const time = object(item.time) ?? {}
  const metadata = object(state.metadata) ?? {}
  const text = (Array.isArray(state.content) ? state.content : [])
    .map((entry) => object(entry))
    .filter((entry) => entry && str(entry.type) === 'text')
    .map((entry) => str(entry!.text))
    .join('\n')
  const input = object(state.input) ?? {}
  // v2's `subagent` tool starts a child session like `task` does, with `agent` for `subagent_type`. A background
  // one is `completed` as soon as it is started (its metadata says `running`), so the card closes with the call
  // like any other: an open sub-agent row would hold the turn open.
  const subagent = str(item.name) === 'subagent'
  return {
    type: 'tool',
    tool: subagent ? 'task' : str(item.name),
    state: {
      status: str(state.status),
      input: subagent ? { ...input, subagent_type: str(input.agent) || undefined } : input,
      output: text || str(object(state.error)?.message),
      // v2 names the sub-agent's session `sessionId` on `task` and `sessionID` on `subagent`.
      metadata: { ...metadata, sessionId: str(metadata.sessionId) || str(metadata.sessionID) },
      time: { start: Number(time.ran) || Number(time.created) || 0, end: Number(time.completed) || 0 },
    },
  }
}

/** OpenCode tool ids are lowercase (`bash`, `edit`, …). Map to the Claude vocabulary the UI renders. */
const TOOL_NAMES: Record<string, string> = {
  bash: 'Bash',
  // OpenCode 2's own shell tool: the same `command` / `workdir` / `timeout` input as `bash`.
  shell: 'Bash',
  edit: 'Edit',
  multiedit: 'Edit',
  patch: 'Edit',
  write: 'Write',
  read: 'Read',
  grep: 'Grep',
  glob: 'Glob',
  list: 'LS',
  ls: 'LS',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  todowrite: 'TodoWrite',
  todoread: 'TodoRead',
  task: 'Task',
  // OpenCode asks the user through `question`, and its arguments are already the claude shape
  // (`{questions:[{question, header, options:[{label, description}]}]}` — read from its own DB), so the
  // name is the only translation needed for the web's question box and the device's question screen.
  question: 'AskUserQuestion',
}

export function opencodeToolName(name: string): string {
  const key = name.toLowerCase()
  if (TOOL_NAMES[key]) return TOOL_NAMES[key]
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'tool'
}

export function toolOutputText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  const o = object(value)
  if (o && typeof o.text === 'string') return o.text
  try { return JSON.stringify(value) ?? '' } catch { return String(value) }
}

export function toolSummary(name: string, output: string, isError: boolean): string {
  const first = output.split('\n').map((line) => line.trim()).find(Boolean) ?? ''
  if (isError) return first ? `${name} failed: ${first}` : `${name} failed`
  return first || `${name} completed`
}

/** The plain text of a user message (its `text` parts joined). */
export function userMessageText(msg: OcMessage): string {
  return msg.parts
    .filter((p) => p.type === 'text')
    .map((p) => str(p.data.text))
    .filter(Boolean)
    .join('\n')
    .trim()
}

/** Assistant text (its `text` parts joined) — for recap. */
export function assistantMessageText(msg: OcMessage): string {
  return msg.parts
    .filter((p) => p.type === 'text')
    .map((p) => str(p.data.text))
    .filter(Boolean)
    .join('')
    .trim()
}

/** A completed assistant message has a `step-finish` part with reason `stop`. */
export function isAssistantDone(msg: OcMessage): boolean {
  return msg.parts.some((p) => p.type === 'step-finish' && str(p.data.reason) === 'stop')
}

/** Aggregates read from a sub-agent's OWN (child) opencode session. */
export interface ChildStats { totalToolUseCount: number; totalTokens?: number }

export function isTaskPart(part: OcPart): boolean {
  return part.type === 'tool' && str(part.data.tool).toLowerCase() === 'task'
}

/** The `<task_result>…</task_result>` body of a Task tool's output, else the raw text. */
export function extractTaskResult(output: string): string {
  const m = /<task_result>\s*([\s\S]*?)\s*<\/task_result>/.exec(output)
  return (m ? m[1] : output).trim()
}

/** OpenCode's `task` tool spawns a sub-agent (a child session). Render it like Claude/Codex Task cards. */
export function taskStartEvent(part: OcPart): SessionEvent {
  const input = object((object(part.data.state) ?? {}).input) ?? {}
  const description = str(input.description) || str(input.prompt).slice(0, 80) || 'Delegated task'
  const subagentType = str(input.subagent_type) || 'agent'
  return { type: 'tool_start', payload: { id: part.id, tool: 'Task', input: { subagent_type: subagentType, description } } }
}

export function taskEndEvent(part: OcPart, childStats?: ChildStats): SessionEvent {
  const state = object(part.data.state) ?? {}
  const input = object(state.input) ?? {}
  const meta = object(state.metadata) ?? {}
  const time = object(state.time) ?? {}
  const durationMs = (Number(time.end) || 0) - (Number(time.start) || 0)
  const output = extractTaskResult(toolOutputText(state.output))
  const isError = str(state.status) === 'error'
  const subagent: SubagentSummary = {
    agentId: str(meta.sessionId) || undefined,
    agentType: str(input.subagent_type) || 'agent',
    totalToolUseCount: childStats?.totalToolUseCount ?? 0,
    totalTokens: childStats?.totalTokens ?? 0,
    totalDurationMs: durationMs > 0 ? durationMs : 0,
  }
  return {
    type: 'tool_end',
    payload: { id: part.id, tool: 'Task', output: clip(output, MAX_OUTPUT), isError, summary: toolSummary('Task', output, isError), subagent },
  }
}

/** Replay events for one assistant `tool` part. In-flight tools emit only `tool_start`. */
export function toolPartEvents(part: OcPart): SessionEvent[] {
  const state = object(part.data.state) ?? {}
  const status = str(state.status)
  const done = status === 'completed' || status === 'error'
  if (isTaskPart(part)) return done ? [taskStartEvent(part), taskEndEvent(part)] : [taskStartEvent(part)]
  const name = opencodeToolName(str(part.data.tool))
  const id = part.id
  const start: SessionEvent = {
    type: 'tool_start',
    payload: { id, tool: name, input: state.input ?? {} },
  }
  if (!done) return [start]
  const output = toolOutputText(state.output)
  const isError = status === 'error'
  return [start, {
    type: 'tool_end',
    payload: { id, tool: name, output: clip(output, MAX_OUTPUT), isError, summary: toolSummary(name, output, isError) },
  }]
}

/** Replay events for one part (assistant blocks only). */
function partReplayEvents(part: OcPart, thinking: { n: number }): SessionEvent[] {
  if (part.type === 'text') {
    const text = str(part.data.text)
    return text ? [{ type: 'text_delta', payload: { content: text } }] : []
  }
  if (part.type === 'reasoning') {
    const text = str(part.data.text)
    return text
      ? [{ type: 'thinking_delta', payload: { content: clip(text, MAX_THINKING), thinkingId: `thinking-opencode-${thinking.n++}` } }]
      : []
  }
  if (part.type === 'tool') return toolPartEvents(part)
  return []
}

/** Full-session replay (session_get) — same render path as the live stream. */
export function opencodeMessagesToEvents(messages: OcMessage[]): SessionEvent[] {
  const events: SessionEvent[] = []
  const thinking = { n: 0 }
  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = userMessageText(msg)
      if (text) events.push({ type: 'user_message', payload: { content: text } })
      continue
    }
    for (const part of msg.parts) events.push(...partReplayEvents(part, thinking))
  }
  events.push({ type: 'done', payload: { result: 'success' } })
  return events
}

/** Last user prompt + the assistant text that followed it — the recap source of truth. */
export function lastOpencodeTurnText(messages: OcMessage[]): LastTurnText | null {
  let userMessage = ''
  let assistantText = ''
  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = userMessageText(msg)
      if (text) { userMessage = text; assistantText = '' }
      continue
    }
    const text = assistantMessageText(msg)
    if (text) assistantText += `${assistantText ? '\n\n' : ''}${text}`
  }
  return assistantText ? { userMessage, assistantText } : null
}

/**
 * Turn-snapped pagination window over the message list, for `session_get {limit, before}`.
 * `before` = `opencode:<index>` (exclusive upper bound = message index the client already holds).
 * The window start snaps back to a user message so a turn is never split.
 */
export function windowOpencodeMessages(
  messages: OcMessage[],
  opts: { limit: number; before?: string },
): { window: OcMessage[]; hasMore: boolean; oldestCursor: string | null; staleCursor?: boolean } {
  let endIndex = messages.length
  if (opts.before) {
    const match = /^opencode:(\d+)$/.exec(opts.before)
    if (!match) return { window: [], hasMore: false, oldestCursor: null, staleCursor: true }
    endIndex = Number(match[1])
    if (!Number.isSafeInteger(endIndex) || endIndex < 0 || endIndex > messages.length) {
      return { window: [], hasMore: false, oldestCursor: null, staleCursor: true }
    }
  }
  let start = Math.max(0, endIndex - opts.limit)
  while (start > 0 && messages[start].role !== 'user') start--
  return {
    window: messages.slice(start, endIndex),
    hasMore: start > 0,
    oldestCursor: `opencode:${start}`,
  }
}
