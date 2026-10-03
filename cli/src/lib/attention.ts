// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

/**
 * One typed answer to "what does this agent need from me right now", derived from signals the daemon
 * already has: turn start/end, the question watcher, permission dialogs, cancels, engine errors and
 * whether a window has looked at the agent since it finished. Today the frame only says active or
 * offline; the bar, the device, the brakes and the inbox all need this instead.
 *
 * Pure: no I/O. The daemon feeds it and asks for snapshots. Every state carries a non-colour glyph and a
 * short label so a screen with no colour, or a person who cannot tell red from green, reads the same thing.
 */
export type AttentionState = 'working' | 'waiting' | 'permission' | 'failed' | 'done' | 'idle' | 'offline'

export interface AttentionEntry {
  agentId: string
  state: AttentionState
  since: number
  detail: string
}

export interface AttentionRow extends AttentionEntry {
  name: string
  engine: string
  machine: string
  sessionId: string
  tmuxPane: string | null
  glyph: string
  label: string
}

export const ATTENTION_GLYPH: Record<AttentionState, string> = {
  working: '~', waiting: '?', permission: '!', failed: 'x', done: '*', idle: '-', offline: '.',
}
export const ATTENTION_LABEL: Record<AttentionState, string> = {
  working: 'working', waiting: 'waiting on you', permission: 'needs permission', failed: 'failed',
  done: 'done, unreviewed', idle: 'idle', offline: 'offline',
}

/** States that deserve a human's attention, in priority order (first wins when summarising a fleet). */
export const ATTENTION_PRIORITY: AttentionState[] = ['permission', 'waiting', 'failed', 'done', 'working', 'idle', 'offline']

export interface AttentionSessionLike {
  agentId: string
  sessionId: string
  engine: string
  active: boolean
  tmuxPane?: string
  name: string
}

export class AttentionTracker {
  private readonly entries = new Map<string, AttentionEntry>()
  private readonly listeners = new Set<(row: AttentionEntry, previous: AttentionState | null) => void>()

  constructor(private readonly now: () => number = Date.now) {}

  onChange(cb: (row: AttentionEntry, previous: AttentionState | null) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  get(agentId: string): AttentionEntry | undefined { return this.entries.get(agentId) }

  /** Set the state; a no-op when unchanged so listeners only hear real transitions. */
  set(agentId: string, state: AttentionState, detail = ''): AttentionEntry {
    const prev = this.entries.get(agentId)
    if (prev && prev.state === state && prev.detail === detail) return prev
    const entry: AttentionEntry = { agentId, state, since: prev?.state === state ? prev.since : this.now(), detail }
    this.entries.set(agentId, entry)
    for (const cb of this.listeners) cb(entry, prev?.state ?? null)
    return entry
  }

  turnStarted(agentId: string, userMessage = ''): void { this.set(agentId, 'working', userMessage.slice(0, 120)) }
  question(agentId: string, permission: boolean, detail = ''): void { this.set(agentId, permission ? 'permission' : 'waiting', detail.slice(0, 120)) }
  answered(agentId: string): void { if (this.isAsking(agentId)) this.set(agentId, 'working', 'answer delivered') }
  turnEnded(agentId: string, opts: { aborted?: boolean; error?: string } = {}): void {
    if (opts.error) this.set(agentId, 'failed', opts.error.slice(0, 120))
    else if (opts.aborted) this.set(agentId, 'idle', 'cancelled')
    else this.set(agentId, 'done', '')
  }
  failed(agentId: string, message: string): void { this.set(agentId, 'failed', message.slice(0, 120)) }
  cancelled(agentId: string): void { this.set(agentId, 'idle', 'cancelled') }
  /** A window showed this agent: "done, unreviewed" is reviewed now. Other states are unchanged. */
  seen(agentId: string): void { if (this.entries.get(agentId)?.state === 'done') this.set(agentId, 'idle', 'reviewed') }
  offline(agentId: string): void { this.set(agentId, 'offline', '') }
  forget(agentId: string): void { this.entries.delete(agentId) }

  isAsking(agentId: string): boolean {
    const s = this.entries.get(agentId)?.state
    return s === 'waiting' || s === 'permission'
  }

  /** Rows for every session the daemon advertises, in fleet priority order then by recency. */
  snapshot(sessions: AttentionSessionLike[], machine: string): AttentionRow[] {
    const rows = sessions.map((s): AttentionRow => {
      const e = this.entries.get(s.agentId)
      const state: AttentionState = !s.active ? 'offline' : e?.state ?? 'idle'
      return {
        agentId: s.agentId, sessionId: s.sessionId, engine: s.engine, machine, name: s.name,
        tmuxPane: s.tmuxPane ?? null,
        state, since: e?.since ?? 0, detail: state === 'offline' ? '' : e?.detail ?? '',
        glyph: ATTENTION_GLYPH[state], label: ATTENTION_LABEL[state],
      }
    })
    return rows.sort((a, b) => ATTENTION_PRIORITY.indexOf(a.state) - ATTENTION_PRIORITY.indexOf(b.state) || b.since - a.since)
  }
}

/** The one thing a fleet-level indicator shows: the most urgent state present, and how many share it. */
export function summarizeAttention(rows: AttentionRow[]): { state: AttentionState; count: number; agentId: string | null } {
  for (const state of ATTENTION_PRIORITY) {
    const hits = rows.filter((r) => r.state === state)
    if (hits.length) return { state, count: hits.length, agentId: hits[0]!.agentId }
  }
  return { state: 'offline', count: 0, agentId: null }
}
