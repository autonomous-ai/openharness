import type { HostAgent, HostSource } from './types.js'

// Dedupe strength: harness first, any host adapter next, observed last.
function strength(id: string): number {
  if (id === 'harness') return 0
  if (id === 'observed') return 2
  return 1
}

/** An agent of the merged list and the source whose copy it is. */
export interface HostEntry {
  agent: HostAgent
  source: HostSource
}

/** Merges the sources into one list; when two hold the same agent, the stronger source's copy wins. */
export class HostRegistry {
  private readonly ordered: HostSource[]

  constructor(sources: HostSource[]) {
    // Stable sort: equal-strength sources keep the order they were given.
    this.ordered = [...sources].sort((a, b) => strength(a.id) - strength(b.id))
  }

  /** Every agent with its source, merged afresh from every source's whole list: a caller reads it once per use. */
  entries(): HostEntry[] {
    const out: HostEntry[] = []
    const bySession = new Set<string>()
    const byPid = new Set<number>()
    for (const source of this.ordered) {
      for (const agent of source.list()) {
        const sKey = agent.sessionId ? `${agent.engine}\0${agent.sessionId}` : undefined
        // callerPid is only a fallback for agents without a session id.
        const pid = agent.sessionId ? undefined : agent.callerPid
        if ((sKey && bySession.has(sKey)) || (pid !== undefined && byPid.has(pid))) continue
        if (sKey) bySession.add(sKey)
        if (pid !== undefined) byPid.add(pid)
        out.push({ agent, source })
      }
    }
    return out
  }

  /** The agent a source other than Harness holds by this id, listed or not: one whose session a stronger source also
   *  holds is left out of the merged list, and the id is still that source's, never a Harness agent's. */
  outside(agentId: string): HostAgent | undefined {
    for (const source of this.ordered) {
      if (source.id === 'harness') continue
      const agent = source.list().find((a) => a.id === agentId)
      if (agent) return agent
    }
    return undefined
  }
}
