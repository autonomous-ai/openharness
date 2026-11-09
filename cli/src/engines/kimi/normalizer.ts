/**
 * Kimi Code CLI `wire.jsonl` -> Harness's shared event vocabulary.
 *
 * Measured on Kimi Code CLI 2.1.1 (macOS arm64), recorded 2026-11-09: one `kimi -p` session whose
 * turn wrote a file and ran `ls`, the same session resumed with `-S` (second turn appended in place),
 * and a session whose turn spawned a `Task` sub-agent (its wire lives at agents/agent-0/wire.jsonl;
 * the parent records the spawn as an ordinary tool call).
 *
 * The wire is the authority for both live tailing and history. Turn boundaries: `turn.prompt` opens
 * (origin.kind "user" in every measured prompt), `turn.ended` closes — `reason` is "completed" on a
 * clean finish; anything else is read as an early end. `agent.turn.ended` carries the same boundary
 * one record earlier and is deliberately skipped: two closing records for one turn would double-close.
 * Hook boundaries are not used (Stop can fire while final records are still being persisted).
 */

import type { EngineNormalizer } from '../types.js'
import type { LastTurnText, LiveEvent, SessionEvent } from '../../lib/normalize.js'

type JsonObject = Record<string, unknown>

const MAX_OUTPUT = 2_000
const MAX_THINKING = 500

/**
 * Kimi's tools already speak the Claude vocabulary (Write, Bash, Grep, …) — measured in wire
 * tool.call records. The one rename: its sub-agent launcher is `Agent`, which the shared rows call
 * `Task`. Unknown names stay visibly generic rather than being dropped.
 */
export function kimiToolName(name: string): string {
  if (name === 'Agent') return 'Task'
  return name || 'Tool'
}

function obj(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n...[truncated]`
}

export interface KimiRecord {
  type: string
  /** `context.append_loop_event` nests the loop record under `event`. */
  event: JsonObject | null
  raw: JsonObject
}

/** One wire line, discriminated. Garbage lines parse to null and are dropped. */
export function kimiRecord(line: string): KimiRecord | null {
  let raw: JsonObject | null
  try { raw = obj(JSON.parse(line)) } catch { return null }
  if (!raw) return null
  const type = str(raw.type)
  if (!type) return null
  return { type, event: type === 'context.append_loop_event' ? obj(raw.event) : null, raw }
}

interface KimiTurnState {
  open: boolean
  toolNames: Map<string, string>
  endedTools: Set<string>
}

function newKimiTurnState(): KimiTurnState {
  return { open: false, toolNames: new Map(), endedTools: new Set() }
}

/** The user text of a `turn.prompt`: the text parts of its input, joined. */
export function kimiPromptText(raw: JsonObject): string {
  const input = Array.isArray(raw.input) ? raw.input : []
  return input.map(part => str(obj(part)?.text)).filter(Boolean).join('\n').trim()
}

function kimiRecordToEvents(
  record: KimiRecord,
  state: KimiTurnState,
  mode: 'live' | 'replay',
): LiveEvent[] {
  const events: LiveEvent[] = []
  const { type, event, raw } = record

  if (type === 'turn.prompt') {
    const prompt = kimiPromptText(raw)
    if (!prompt) return events
    if (mode === 'replay') {
      events.push({ type: 'user_message', payload: { content: prompt } })
      return events
    }
    // A lost boundary (a daemon restart mid-turn) must not merge the next user turn into a
    // permanently-open one: close the stale turn before opening the next.
    if (state.open) events.push({ type: 'turn_ended', payload: { aborted: true } })
    state.open = true
    state.toolNames.clear()
    state.endedTools.clear()
    events.push({ type: 'turn_started', payload: { userMessage: prompt } })
    return events
  }

  if (type === 'context.append_loop_event' && event) {
    const kind = str(event.type)
    if (kind === 'content.part') {
      const part = obj(event.part)
      const text = str(part?.type) === 'think' ? str(part?.think) : str(part?.text)
      if (!text) return events
      // Thinking is bounded; answer text streams whole, like every other engine's text_delta.
      events.push(str(part?.type) === 'think'
        ? { type: 'thinking_delta', payload: { content: clip(text, MAX_THINKING) } }
        : { type: 'text_delta', payload: { content: text } })
      return events
    }
    if (kind === 'tool.call') {
      const id = str(event.uuid)
      if (!id || state.toolNames.has(id)) return events
      const tool = kimiToolName(str(event.name))
      state.toolNames.set(id, tool)
      state.endedTools.delete(id)
      events.push({ type: 'tool_start', payload: { id, tool, input: event.args ?? {} } })
      return events
    }
    if (kind === 'tool.result') {
      const id = str(event.parentUuid)
      if (!id || state.endedTools.has(id)) return events
      state.endedTools.add(id)
      const result = obj(event.result)
      // Measured shape: { output, durationMs }. A refused or failed tool keeps output readable;
      // nothing in the recording marks an error, so only an explicit boolean is read as one.
      const isError = result?.isError === true
      const output = str(result?.output) || (result ? JSON.stringify(result) : '')
      events.push({
        type: 'tool_end',
        payload: { id, tool: state.toolNames.get(id) ?? 'Tool', output: clip(output, MAX_OUTPUT), isError, summary: '' },
      })
      return events
    }
    return events
  }

  if (type === 'turn.ended') {
    if (mode === 'replay' || !state.open) return events
    state.open = false
    state.toolNames.clear()
    state.endedTools.clear()
    // Measured on a clean finish: "completed". Anything else (an interrupt ends the turn early)
    // is an aborted turn: no recap.
    events.push({ type: 'turn_ended', payload: str(raw.reason) === 'completed' ? {} : { aborted: true } })
    return events
  }

  return events
}

export class KimiNormalizer implements EngineNormalizer {
  private state = newKimiTurnState()

  get turnOpen(): boolean { return this.state.open }

  closeTurn(): void {
    this.state.open = false
    this.state.toolNames.clear()
    this.state.endedTools.clear()
  }

  abortTurn(): LiveEvent[] {
    if (!this.state.open) return []
    this.closeTurn()
    return [{ type: 'turn_ended', payload: { aborted: true } }]
  }

  ingest(line: string): LiveEvent[] {
    const record = kimiRecord(line)
    return record ? kimiRecordToEvents(record, this.state, 'live') : []
  }

  finishReplay(): LiveEvent[] { return [] }
}

export function kimiMessagesToEvents(lines: string[]): SessionEvent[] {
  const state = newKimiTurnState()
  const events: SessionEvent[] = []
  for (const line of lines) {
    const record = kimiRecord(line)
    if (record) events.push(...kimiRecordToEvents(record, state, 'replay') as SessionEvent[])
  }
  events.push({ type: 'done', payload: { result: 'success' } })
  return events
}

export function lastKimiTurnText(lines: string[]): LastTurnText | null {
  let userMessage = ''
  let assistantText = ''
  for (const line of lines) {
    const record = kimiRecord(line)
    if (!record) continue
    if (record.type === 'turn.prompt') {
      userMessage = kimiPromptText(record.raw)
      assistantText = ''
    } else if (record.type === 'context.append_loop_event' && str(record.event?.type) === 'content.part') {
      const part = obj(record.event?.part)
      if (str(part?.type) !== 'text') continue
      const text = str(part?.text).trim()
      if (text) assistantText += `${assistantText ? '\n\n' : ''}${text}`
    }
  }
  return assistantText ? { userMessage, assistantText } : null
}
