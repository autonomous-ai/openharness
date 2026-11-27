import type { HostAgent, HostSource } from './types.js'

// Dedupe strength: harness first, observed next, any listing source last. The hook's copy beats a listed copy of the
// same agent: it carries the last answer, the question's text and the Codex queue, and reaches the same pane.
// An ended copy (`HostAgent.ended`) is the exception: it has no tap, rest or voice, so it never hides another source's
// live copy, which can still open the session.
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

interface Listed {
  source: HostSource
  agents: HostAgent[]
}

function sessionKey(agent: HostAgent): string | undefined {
  return agent.sessionId ? `${agent.engine}\0${agent.sessionId}` : undefined
}

/** Each session and pane key of a copy that is not ended, with the sources that list such a copy. */
function liveKeys(lists: readonly Listed[]): Map<string, Set<HostSource>> {
  const keys = new Map<string, Set<HostSource>>()
  for (const { source, agents } of lists) {
    for (const agent of agents) {
      if (agent.ended) continue
      const sKey = sessionKey(agent)
      for (const k of sKey ? [sKey, ...(agent.paneKeys ?? [])] : agent.paneKeys ?? []) {
        const holders = keys.get(k) ?? new Set<HostSource>()
        holders.add(source)
        keys.set(k, holders)
      }
    }
  }
  return keys
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
    // Each list is read once: the dial reads this every second.
    const lists: Listed[] = this.ordered.map((source) => ({ source, agents: source.list() }))
    // Gathered only once an ended copy is met: with none, the merge is one pass.
    let live: Map<string, Set<HostSource>> | undefined
    const out: HostEntry[] = []
    const bySession = new Set<string>()
    const byPid = new Set<number>()
    // A pane key folds only another source's copy: two agents of one source in one pane stay two.
    const byPane = new Map<string, HostSource>()
    for (const { source, agents } of lists) {
      for (const agent of agents) {
        const sKey = sessionKey(agent)
        // callerPid is only a fallback for agents without a session id.
        const pid = agent.sessionId ? undefined : agent.callerPid
        const panes = agent.paneKeys ?? []
        const folded = (sKey && bySession.has(sKey)) || (pid !== undefined && byPid.has(pid))
          || panes.some((k) => { const owner = byPane.get(k); return owner !== undefined && owner !== source })
        if (agent.ended) {
          // It takes no key, so it folds no later copy; another source's live copy of it takes the row instead.
          const keys = (live ??= liveKeys(lists))
          const elsewhere = (k: string) => {
            const holders = keys.get(k)
            return !!holders && (holders.size > 1 || !holders.has(source))
          }
          if (!folded && !(sKey && elsewhere(sKey)) && !panes.some(elsewhere)) out.push({ agent, source })
          continue
        }
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
