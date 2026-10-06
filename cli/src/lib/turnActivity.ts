/** Connectivity and an unfinished transcript are not evidence of current work.
 * This lease is renewed only by live engine events or a fresh runtime reading.
 * Expiry withdraws the Working claim; it never completes or cancels a turn. */
import { randomUUID } from 'node:crypto'

export type ActivityState = 'working' | 'idle' | 'unknown'
export interface ActivityFrame {
  state: ActivityState
  epoch: string
  revision: number
  /** Remaining lease, not a remote wall clock. Zero for idle/unknown. */
  validForMs: number
}
export interface ActivityRuntime { key: string; turnOpen: boolean }
interface Entry {
  runtime: string
  state: ActivityState
  revision: number
  until: number
  pending?: Promise<void>
}
export const WORK_EVIDENCE_MS = 30_000
export const WORK_HEARTBEAT_LEASE_MS = WORK_EVIDENCE_MS
const PROGRESS = new Set(['turn_started', 'text_delta', 'thinking_delta', 'thinking_title', 'tool_start', 'tool_end', 'subagent_finished'])

export class TurnActivity {
  private readonly entries = new Map<string, Entry>()
  private readonly epoch = randomUUID()
  private revision = 0
  constructor(private readonly deps: {
    runtime(sessionId: string): ActivityRuntime | undefined
    probe(sessionId: string): Promise<ActivityState>
    drain(sessionId: string): Promise<void>
    now?: () => number
  }) {}
  private now(): number { return this.deps.now?.() ?? performance.now() }
  private entry(sessionId: string): Entry | undefined {
    const runtime = this.deps.runtime(sessionId)
    if (!runtime) { this.entries.delete(sessionId); return undefined }
    let entry = this.entries.get(sessionId)
    if (!entry || entry.runtime !== runtime.key) {
      entry = { runtime: runtime.key, state: runtime.turnOpen ? 'unknown' : 'idle', revision: ++this.revision, until: 0 }
      this.entries.set(sessionId, entry)
    }
    // A Working claim whose evidence ran out reads as unknown while a turn is open: the heartbeat probes
    // open turns and settles it. With no turn open nothing probes it again, so unknown stuck until the
    // next prompt. That is what a cancel left when the aborted tool's output landed after it and read as
    // work (a real Codex 0.160, found by daemon QA). The transcript says no turn is open and nothing
    // renewed the claim: idle.
    if (entry.state === 'working' && this.now() >= entry.until) this.set(entry, runtime.turnOpen ? 'unknown' : 'idle')
    return entry
  }
  private set(entry: Entry, state: ActivityState): void {
    entry.state = state
    entry.until = state === 'working' ? this.now() + WORK_EVIDENCE_MS : 0
    entry.revision = ++this.revision
  }
  observe(sessionId: string, type: string, replay = false): void {
    const entry = this.entry(sessionId)
    if (!entry) return
    if (replay) {
      // A completed history is a baseline. An unfinished history has no live
      // claim; subsequent polling must establish it independently.
      if (type === 'turn_started' && entry.state !== 'working') this.set(entry, 'unknown')
      if (type === 'turn_ended' && entry.state !== 'working') this.set(entry, 'idle')
      return
    }
    if (type === 'turn_ended') this.set(entry, 'idle')
    else if (PROGRESS.has(type)) this.set(entry, 'working')
  }
  snapshot(sessionId: string): ActivityFrame | undefined {
    const entry = this.entry(sessionId)
    if (!entry) return undefined
    return { state: entry.state, epoch: this.epoch, revision: entry.revision,
      validForMs: entry.state === 'working' ? Math.max(0, Math.min(WORK_HEARTBEAT_LEASE_MS, entry.until - this.now())) : 0 }
  }
  forget(sessionId: string): void { this.entries.delete(sessionId) }
  async check(sessionId: string): Promise<void> {
    const entry = this.entry(sessionId)
    if (!entry || entry.pending) return entry?.pending
    const run = async () => {
      await this.deps.drain(sessionId)
      if (this.entry(sessionId) !== entry) return
      const revision = entry.revision
      const result = await this.deps.probe(sessionId)
      await this.deps.drain(sessionId)
      // A completion, a new prompt, or a replaced process wins over a probe
      // started before it. Failed reads never mean idle.
      if (this.entry(sessionId) !== entry || entry.revision !== revision) return
      if (result === 'working' || (result === 'idle' && entry.state !== 'working')) this.set(entry, result)
    }
    entry.pending = run().catch(() => {}).finally(() => { entry.pending = undefined })
    await entry.pending
  }
}
