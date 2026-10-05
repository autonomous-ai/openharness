/** Native conversation records, before live-view truncation. Thinking and injected instructions stay out. */
import { digest } from './admission.js'
import type { SourceEvent } from './types.js'
import { stripBashModeBlocks, stripContextSummary, stripSystemBlocks } from '../../../cli/src/lib/normalize.js'
import { askKind, personAsk } from '../../../cli/src/lib/sessionSearch/turns.js'

export interface NativePart {
  nativeEventId: string; role: SourceEvent['role']; text: string; observedAt: number
}
export interface NativeRecord { parts: NativePart[]; ended: boolean; incomplete: boolean }
const empty = (): NativeRecord => ({ parts: [], ended: false, incomplete: false })

export function decodeMemoryRecord(engine: 'claude' | 'codex', text: string): NativeRecord {
  const result = empty()
  let row: Record<string, unknown>
  try { row = object(JSON.parse(text)) } catch { return { ...result, incomplete: true } }
  const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : typeof row.timestamp === 'number' ? row.timestamp : NaN
  const native = typeof row.uuid === 'string' && row.uuid ? row.uuid : digest(row)
  let index = 0
  const add = (role: SourceEvent['role'], value: string): void => {
    if (!value.trim()) return
    if (!Number.isSafeInteger(at) || at < 0 || value.length > 32_000) { result.incomplete = true; return }
    result.parts.push({ nativeEventId: digest([engine, native, index++, role]), role, text: value, observedAt: at })
  }
  const user = (value: string): void => {
    for (const part of memoryUserParts(value)) add(part.role, part.text)
  }

  if (engine === 'claude') {
    if (row.isSidechain === true || row.parentToolUseID || row.parentToolUseId) return result
    const message = object(row.message)
    if (row.type === 'assistant') {
      for (const part of blocks(message.content)) {
        if (part.type === 'text' && typeof part.text === 'string') add('assistant', part.text)
        else if (part.type === 'tool_use') add('assistant', JSON.stringify({ tool: part.name, callId: part.id, input: part.input }))
      }
      result.ended = message.stop_reason === 'end_turn' || message.stop_reason === 'stop_sequence'
    } else if (row.type === 'user' && row.isMeta !== true) {
      for (const part of blocks(message.content)) {
        if (part.type === 'text' && typeof part.text === 'string') user(part.text)
        else if (part.type === 'tool_result') add('tool', JSON.stringify({ callId: part.tool_use_id, isError: part.is_error === true, output: content(part.content) }))
      }
    } else if (row.type === 'attachment') {
      const attachment = object(row.attachment)
      if (attachment.type === 'queued_command' && attachment.commandMode === 'prompt') {
        const origin = object(attachment.origin)
        if (origin.kind !== 'auto-continuation' && origin.kind !== 'agent') user(content(attachment.prompt))
      }
    }
  } else {
    const payload = object(row.payload)
    const item = payload.type === 'item_completed' ? object(payload.item) : payload
    if (row.type === 'event_msg') {
      if (item.type === 'user_message' || item.type === 'UserMessage') user(typeof item.message === 'string' ? item.message : content(item.content))
      else if (item.type === 'agent_message' || item.type === 'AgentMessage') add('assistant', typeof item.message === 'string' ? item.message : content(item.content))
      else if (item.type === 'task_complete' || item.type === 'turn_aborted') result.ended = true
    } else if (row.type === 'response_item') {
      if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        add('assistant', JSON.stringify({ tool: item.name, callId: item.call_id, input: item.arguments ?? item.input }))
      } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
        add('tool', JSON.stringify({ callId: item.call_id, isError: item.is_error === true || item.status === 'failed', output: content(item.output) }))
      }
      // response_item messages duplicate event_msg text or contain system/goal/compaction injections.
    }
  }
  if (result.parts.length > 64) return { parts: [], ended: result.ended, incomplete: true }
  return result
}

/** Shared role boundaries for native user text; provider-specific synthetic flags are checked first. */
export function memoryUserParts(value: string): Array<{ role: 'user' | 'reference'; text: string }> {
  const kind = askKind(value)
  if (kind === 'notice') return []
  if (kind === 'agent') return [{ role: 'reference', text: value }]
  const cleaned = stripBashModeBlocks(stripSystemBlocks(stripContextSummary(personAsk(value)) ?? ''))
    .replace(/<(?:environment_context|user_instructions|user-prompt-submit-hook|turn_aborted)>[\s\S]*?<\/(?:environment_context|user_instructions|user-prompt-submit-hook|turn_aborted)>/g, '')
  // Pasted/fenced material is evidence about its contents, not a preference of the person quoting it.
  const quoted = /<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>|^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*(?:\n|$)|^(?:[ \t]*>[^\n]*(?:\n|$))+/gm
  const result: Array<{ role: 'user' | 'reference'; text: string }> = []
  let end = 0
  for (const match of cleaned.matchAll(quoted)) {
    result.push({ role: 'user', text: cleaned.slice(end, match.index) }, { role: 'reference', text: match[0] })
    end = match.index! + match[0].length
  }
  result.push({ role: 'user', text: cleaned.slice(end) })
  return result.filter(part => part.text.trim())
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function blocks(value: unknown): Record<string, unknown>[] {
  return typeof value === 'string' ? [{ type: 'text', text: value }] : Array.isArray(value) ? value.map(object) : []
}
function content(value: unknown): string {
  if (typeof value === 'string') return value
  return blocks(value).flatMap(part => typeof part.text === 'string' ? [part.text] : []).join('\n')
}
