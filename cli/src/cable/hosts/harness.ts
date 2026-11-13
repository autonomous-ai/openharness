import type { Caps, HostAgent, HostAgentState, HostSource } from './types.js'

/** The device cards that move a Harness agent's state: `cableEventFor`'s kinds, a question, and its close. */
export type HarnessCard = 'processing' | 'done' | 'summary' | 'error' | 'question' | 'question.close'

/** A row of the fleet's flat list, with the engine session bound to it when this computer knows it. */
export interface HarnessRow {
  id: string
  name: string
  engine?: string
  machineId?: string
  sessionId?: string
}

interface Noted {
  state: HostAgentState
  since: number
  unseenDone: boolean
}

/**
 * This computer's Harness agents, for the dial with no window.
 *
 * It reads nothing itself: the cable host hands it the fleet's list as it reads it, and the device cards tell it each
 * agent's state, so the dial's list and its turn cards cannot disagree. No focus: with no window there is nothing
 * to bring an agent forward in.
 */
export class HarnessSource implements HostSource {
  readonly id = 'harness'
  private rows: HarnessRow[] = []
  private times = new Map<string, number>()
  private readonly noted = new Map<string, Noted>()
  private readonly listeners = new Set<() => void>()
  private key = ''

  constructor(private readonly now: () => number = Date.now) {}

  /** The fleet's list and each agent's last activity. Only rows on `localId` are kept; a shell is a tile, not an agent. */
  update(rows: HarnessRow[], localId: string, times: Map<string, number>): void {
    this.rows = rows.filter((r) => r.machineId === localId && r.engine !== 'terminal')
    this.times = times
    const ids = new Set(this.rows.map((r) => r.id))
    for (const id of this.noted.keys()) if (!ids.has(id)) this.noted.delete(id)
    // Called on every read of the list: said only when it changed, or a listener that reads the list again loops.
    const key = this.rows.map((r) => `${r.id}:${r.name}:${r.engine ?? ''}:${r.sessionId ?? ''}:${times.get(r.id) ?? ''}`).join('|')
    if (key === this.key) return
    this.key = key
    this.emit()
  }

  /** A card the devices were sent for one of these agents. A silent one (a sub-agent's, a restored recap) is not news. */
  noteCard(agentId: string, kind: HarnessCard): void {
    const was = this.noted.get(agentId)
    let state: HostAgentState
    if (kind === 'processing') state = 'working'
    else if (kind === 'done' || kind === 'summary') state = 'done'
    else if (kind === 'error') state = 'error'
    else if (kind === 'question') state = 'needs-you'
    else if (was?.state === 'needs-you') state = 'working'
    else return
    const since = was?.state === state ? was.since : this.now()
    const unseenDone = state === 'done' ? true : state === 'working' ? false : was?.unseenDone ?? false
    if (was && was.state === state && was.unseenDone === unseenDone) return
    this.noted.set(agentId, { state, since, unseenDone })
    this.emit()
  }

  /** The person turned the dial to it: a done agent's answer has been seen, rather than staying unseen until its next turn. */
  markSeen(agentId: string): void {
    const noted = this.noted.get(agentId)
    if (!noted?.unseenDone) return
    this.noted.set(agentId, { ...noted, unseenDone: false })
    this.emit()
  }

  list(): HostAgent[] {
    return this.rows.map((r) => {
      const noted = this.noted.get(r.id)
      const lastActivityAt = Math.max(this.times.get(r.id) ?? 0, noted?.since ?? 0)
      return {
        id: r.id, name: r.name, engine: r.engine ?? '',
        ...(r.sessionId ? { sessionId: r.sessionId } : {}),
        host: 'harness',
        state: noted?.state ?? 'idle',
        since: noted?.since ?? lastActivityAt,
        lastActivityAt,
        unseenDone: noted?.unseenDone ?? false,
      }
    })
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  capabilities(): Caps {
    return { status: true, voice: true, focus: false, answer: true }
  }

  private emit(): void {
    for (const l of [...this.listeners]) l()
  }
}
