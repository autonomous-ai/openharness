// Every host source's agents as one list, with each real agent once.
import type { HostAgent, HostSource } from './types.js'

// When two sources hold the same agent, the stronger one's row is the one the dial gets: Harness can drive its agents,
// an observed one can only be watched. A Claude Code session started in Ghostty and resumed inside a Harness pane is
// the case that matters. Host adapters (Orca, herdr, …; wave 1) go between the two.
const STRENGTH: Record<HostSource['id'], number> = { harness: 2, observed: 0 }

export class HostRegistry {
  private readonly sources: HostSource[]

  constructor(sources: HostSource[]) {
    // Stable sort: sources of equal strength keep the order they were given in.
    this.sources = [...sources].sort((a, b) => STRENGTH[b.id] - STRENGTH[a.id])
  }

  /** Every source's agents, deduped. */
  agents(): HostAgent[] {
    return this.resolve().map((r) => r.agent)
  }

  /** The source that holds a listed agent; undefined for an id that lost the dedupe or is not listed. */
  source(agentId: string): HostSource | undefined {
    return this.resolve().find((r) => r.agent.id === agentId)?.source
  }

  /** Called once for each change of any source. */
  onChange(cb: () => void): () => void {
    const offs = this.sources.map((s) => s.onChange(cb))
    return () => { for (const off of offs) off() }
  }

  // Identity is engine + sessionId. When either side has no sessionId, the same callerPid is the same agent. Two
  // rows that both name their session are different sessions, even in one process.
  private resolve(): Array<{ agent: HostAgent; source: HostSource }> {
    const kept: Array<{ agent: HostAgent; source: HostSource }> = []
    const sessions = new Set<string>()
    const pids = new Set<number>()
    const sessionlessPids = new Set<number>()
    for (const source of this.sources) {
      for (const agent of source.list()) {
        const pid = agent.callerPid
        const same = agent.sessionId !== undefined
          ? sessions.has(sessionKey(agent.engine, agent.sessionId)) || (pid !== undefined && sessionlessPids.has(pid))
          : pid !== undefined && pids.has(pid)
        if (same) continue
        kept.push({ agent, source })
        if (agent.sessionId !== undefined) sessions.add(sessionKey(agent.engine, agent.sessionId))
        if (pid !== undefined) {
          pids.add(pid)
          if (agent.sessionId === undefined) sessionlessPids.add(pid)
        }
      }
    }
    return kept
  }
}

function sessionKey(engine: string, sessionId: string): string {
  return `${engine}\u0000${sessionId}`
}
