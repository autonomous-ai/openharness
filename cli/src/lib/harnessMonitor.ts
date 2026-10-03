import type { RegisteredSession } from './registry.js'

export type MonitorActivity = 'working' | 'needsInput' | 'done' | 'failed' | 'idle'

/** Same live turn events the tab bar consumes. Replayed history never becomes fresh completion. */
export class MonitorCompletions {
  private readonly values = new Map<string, { state: 'done' | 'failed'; at: number; sessionId: unknown }>()
  observe(frame: { type?: unknown; agentId?: unknown; dbSessionId?: unknown; replay?: unknown; subagent?: unknown; payload?: unknown }): void {
    if (typeof frame.agentId !== 'string' || frame.replay || frame.subagent) return
    if (frame.type === 'turn_started' || frame.type === 'agent_deleted') this.values.delete(frame.agentId)
    if (frame.type !== 'turn_ended') return
    const payload = frame.payload as { aborted?: boolean; error?: unknown } | undefined
    if (payload?.aborted) { this.values.delete(frame.agentId); return }
    this.values.delete(frame.agentId)
    this.values.set(frame.agentId, { state: payload?.error ? 'failed' : 'done', at: Date.now(), sessionId: frame.dbSessionId })
    if (this.values.size > 4096) this.values.delete(this.values.keys().next().value!)
  }
  state(session: RegisteredSession): 'done' | 'failed' | 'idle' {
    const value = this.values.get(session.agentId)
    return value && value.sessionId === session.sessionId && value.at > (session.lastOpenedAt ?? 0) ? value.state : 'idle'
  }
}
