import type { HostAgent, HostSource } from './types.js'

// Dedupe strength: harness first, any host adapter next, observed last.
function strength(id: string): number {
  if (id === 'harness') return 0
  if (id === 'observed') return 2
  return 1
}

/** Merges the sources into one list; when two hold the same agent, the stronger source's copy wins. */
export class HostRegistry {
  private readonly ordered: HostSource[]

  constructor(private readonly sources: HostSource[]) {
    // Stable sort: equal-strength sources keep the order they were given.
    this.ordered = [...sources].sort((a, b) => strength(a.id) - strength(b.id))
  }

  private merged(): { agent: HostAgent; source: HostSource }[] {
    const out: { agent: HostAgent; source: HostSource }[] = []
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

  agents(): HostAgent[] {
    return this.merged().map((m) => m.agent)
  }

  onChange(cb: () => void): () => void {
    const offs = this.sources.map((s) => s.onChange(cb))
    return () => {
      for (const off of offs) off()
    }
  }

  source(agentId: string): HostSource | undefined {
    return this.merged().find((m) => m.agent.id === agentId)?.source
  }
}
