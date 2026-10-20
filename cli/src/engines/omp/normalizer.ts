/**
 * omp v18 session JSONL, measured on a live file under ~/.omp/agent/sessions:
 * a `session` line, then `message` lines whose content items are `text`,
 * `thinking`, or `toolCall`. A tool result is a message with `toolCallId`.
 */
import type { EngineNormalizer } from '../types.js'
import type { LiveEvent } from '../kit/events.js'

interface OmpItem { type?: unknown; text?: unknown; id?: unknown; name?: unknown }
interface OmpMessage {
  role?: unknown
  content?: unknown
  toolCallId?: unknown
  toolName?: unknown
  isError?: unknown
}

function textOf(item: OmpItem): string {
  return typeof item.text === 'string' ? item.text : ''
}

export class OmpNormalizer implements EngineNormalizer {
  private open = false
  get turnOpen(): boolean { return this.open }
  private tools = new Map<string, string>()

  ingest(line: string): LiveEvent[] {
    let raw: { type?: unknown; id?: unknown; message?: OmpMessage }
    try { raw = JSON.parse(line) } catch { return [] }
    if (raw.type !== 'message' || !raw.message) return []
    const message = raw.message
    const role = message.role
    const items = Array.isArray(message.content) ? message.content as OmpItem[] : []
    const events: LiveEvent[] = []
    if (role === 'user') {
      if (this.open) events.push({ type: 'turn_ended', payload: {} })
      const content = items.filter(item => item.type === 'text').map(textOf).join('')
      events.push({ type: 'user_message', payload: { content } })
      events.push({ type: 'turn_started', payload: { userMessage: content } })
      this.open = true
      return events
    }
    if (role === 'toolResult') {
      const id = typeof message.toolCallId === 'string' ? message.toolCallId : String(raw.id ?? 'tool')
      const output = items.map(textOf).join('')
      events.push({
        type: 'tool_end',
        payload: {
          id,
          tool: this.tools.get(id) ?? (typeof message.toolName === 'string' ? message.toolName : 'tool'),
          output,
          isError: message.isError === true,
          summary: output.slice(0, 120),
        },
      })
      return events
    }
    if (role !== 'assistant') return events
    if (!this.open) {
      events.push({ type: 'turn_started', payload: { userMessage: '' } })
      this.open = true
    }
    for (const item of items) {
      if (item.type === 'text' && item.text) events.push({ type: 'text_delta', payload: { content: textOf(item) } })
      else if (item.type === 'thinking' && item.text) events.push({ type: 'thinking_delta', payload: { content: textOf(item) } })
      else if (item.type === 'toolCall') {
        const id = typeof item.id === 'string' ? item.id : String(raw.id ?? 'tool')
        const tool = typeof item.name === 'string' ? item.name : 'tool'
        this.tools.set(id, tool)
        events.push({ type: 'tool_start', payload: { id, tool, input: {} } })
      }
    }
    return events
  }

  finishReplay(): LiveEvent[] {
    return this.open ? [{ type: 'turn_ended', payload: {} }] : []
  }

  closeTurn(): void {
    this.open = false
  }
}
