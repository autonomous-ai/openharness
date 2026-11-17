import type { HostAgent, HostSource } from './types.js'

// Dedupe strength: harness first, observed next, any listing source last. The hook's copy beats a listed copy of the
// same agent: it carries the last answer, the question's text and the Codex queue, and reaches the same pane.
function strength(id: string): number {
  if (id === 'harness') return 0
  if (id === 'observed') return 1
  return 2
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
    // A pane key folds only another source's copy: two agents of one source in one pane stay two.
    const byPane = new Map<string, HostSource>()
    for (const source of this.ordered) {
      for (const agent of source.list()) {
        const sKey = agent.sessionId ? `${agent.engine}\0${agent.sessionId}` : undefined
        // callerPid is only a fallback for agents without a session id.
        const pid = agent.sessionId ? undefined : agent.callerPid
        const panes = agent.paneKeys ?? []
        const folded = (sKey && bySession.has(sKey)) || (pid !== undefined && byPid.has(pid))
          || panes.some((k) => { const owner = byPane.get(k); return owner !== undefined && owner !== source })
        // Listed or folded, it takes its keys: a copy folded away still folds the next source's copy.
        if (sKey) bySession.add(sKey)
        if (pid !== undefined) byPid.add(pid)
        for (const k of panes) if (!byPane.has(k)) byPane.set(k, source)
        if (!folded) out.push({ agent, source })
      }
    }
    return out
  }

  /** The agent a source other than Harness holds by this id, listed or not: one a stronger source also holds by its
   *  session or pane is left out of the merged list, and the id is still that source's, never a Harness agent's. */
  outside(agentId: string): HostAgent | undefined {
    for (const source of this.ordered) {
      if (source.id === 'harness') continue
      const agent = source.list().find((a) => a.id === agentId)
      if (agent) return agent
    }
    return undefined
  }
}
