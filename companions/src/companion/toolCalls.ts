import type { LiveEvent } from '../../../cli/src/lib/normalize.js'

/** Exact open tool calls used by companion permission policy, outside the core recap pipeline. */
export class CompanionToolCalls {
  private readonly calls = new Map<string, Map<string, { name: string; input: unknown }>>()

  open(sessionId: string): Array<{ name: string; input: unknown }> {
    return [...(this.calls.get(sessionId)?.values() ?? [])]
  }

  forget(sessionId: string): void { this.calls.delete(sessionId) }

  observe(sessionId: string, event: LiveEvent): void {
    if (event.type === 'turn_started' || event.type === 'turn_ended') { this.forget(sessionId); return }
    if (event.type === 'tool_start') {
      let open = this.calls.get(sessionId)
      if (!open) { open = new Map(); this.calls.set(sessionId, open) }
      open.set(String(event.payload.id), { name: String(event.payload.tool || ''), input: event.payload.input })
      if (open.size > 32) open.delete(open.keys().next().value as string)
    } else if (event.type === 'tool_end') {
      this.calls.get(sessionId)?.delete(String(event.payload.id))
    }
  }
}
