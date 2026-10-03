import { isAbsolute, parse, resolve } from 'node:path'
import type { MemoryHostSession } from './runtime.js'
import type { LiveEvent } from '../../../cli/src/lib/normalize.js'

/** A streamed reply or tool result is ongoing work, not a new foreground request. */
export function hasMemoryForegroundActivity(events: readonly Pick<LiveEvent, 'type'>[],
  options?: { resumed?: boolean; replay?: boolean }): boolean {
  return !options?.resumed && !options?.replay
    && events.some(event => event.type === 'turn_started' || event.type === 'user_message')
}

interface RegisteredMemorySession {
  agentId: string; engine: string; sessionId: string; cwd: string | null; transcriptPath: string | null
  dsh?: string | null; forkedFrom?: unknown; registeredAt: number; cliVersion?: string | null
  title?: string | null; defaultName?: string
}
// These bundled DSHs have explicit software-development workflows. A package's arbitrary category
// string, viewer, or use of a coding CLI cannot opt a general-domain DSH into personal coding memory.
const CODING_DSHS = new Set(['autonomous/web-studio', 'autonomous/firmware-studio'])

/** A short grace period finishes native records after a process exits, without scanning archives. */
export class MemorySessionRoster {
  private readonly recent = new Map<string, { session: MemoryHostSession; seenAt: number }>()
  constructor(private readonly home: string, private readonly now: () => number = Date.now,
    private readonly nativeSources: { opencode?: string } = {}) {}

  refresh(live: RegisteredMemorySession[], busy: (sessionId: string) => boolean, subagent: (sessionId: string) => boolean,
    collectionAgentId: string | null = null): MemoryHostSession[] {
    const observed = new Set(live.map(session => session.agentId))
    const current = new Set<string>()
    for (const session of live) {
      const companion = session.dsh === 'autonomous/pair' && session.agentId === collectionAgentId
      // OpenCode keeps all conversations in a host-configured SQLite store. It has no JSONL path.
      const transcriptPath = session.engine === 'opencode' ? this.nativeSources.opencode : session.transcriptPath
      if (!['claude', 'codex', 'opencode'].includes(session.engine) || !session.sessionId || !session.cwd || !transcriptPath
        || !isAbsolute(session.cwd) || !isAbsolute(transcriptPath) || subagent(session.sessionId)
        || (session.dsh && !companion && !CODING_DSHS.has(session.dsh)) || resolve(session.cwd) === resolve(this.home)
        || resolve(session.cwd) === parse(resolve(session.cwd)).root) continue
      current.add(session.agentId)
      this.recent.set(session.agentId, { seenAt: this.now(), session: { agentId: session.agentId,
        name: session.title || session.defaultName, present: true,
        engine: session.engine as MemoryHostSession['engine'], sessionId: session.sessionId, workspace: session.cwd,
        transcriptPath, coding: true, busy: busy(session.sessionId), scope: companion ? 'profile' : 'project',
        ...(session.cliVersion ? { cliVersion: session.cliVersion } : {}),
        ...(session.forkedFrom ? { liveFrom: session.registeredAt } : {}) } })
    }
    for (const [agentId, row] of this.recent) {
      if ((row.session.scope === 'profile' && agentId !== collectionAgentId)
        || (observed.has(agentId) && !current.has(agentId)) || this.now() - row.seenAt > 120_000) this.recent.delete(agentId)
      else if (!current.has(agentId)) row.session = { ...row.session, busy: false, present: false }
    }
    while (this.recent.size > 128) this.recent.delete(this.recent.keys().next().value!)
    return [...this.recent.values()].map(row => ({ ...row.session }))
  }
}
