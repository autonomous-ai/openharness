import { createHash } from 'node:crypto'
import { basename } from 'node:path'
// Types only: the devices process must not load core code.
import type { ObservedHookEvent } from '../../core/observedHook.js'
import type { OpenSessions } from '../../lib/sessionSearch/external.js'
import { detectHost } from './hostDetect.js'
import type { Caps, HostAgent, HostAgentState, HostSource } from './types.js'

export { detectHost, hostDisplayName } from './hostDetect.js'

const NAMESPACE = '6f1d0c3e-5b7a-4c92-8e41-3a9d7b2f60c8'
const MAX_SESSIONS = 50
const END_DELAY_MS = 10_000
const NO_PID_TTL_MS = 12 * 60 * 60 * 1000
/** The dial's card is small; keep what it can show. */
const ANSWER_CHARS = 300

/** A name-based UUID (v5 layout, SHA-1) of engine + sessionId, so the same session always gets the same id. */
export function observedAgentId(engine: string, sessionId: string): string {
  const ns = Buffer.from(NAMESPACE.replace(/-/g, ''), 'hex')
  const h = createHash('sha1').update(ns).update(`${engine}\0${sessionId}`).digest()
  h[6] = (h[6] & 0x0f) | 0x50
  h[8] = (h[8] & 0x3f) | 0x80
  const x = h.subarray(0, 16).toString('hex')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`
}

export interface ObservedDeps {
  now(): number
  pidGeneration(pid: number): string | null
  openSessions: Pick<OpenSessions, 'fresh' | 'working' | 'owner'>
  externalSessions: {
    scan(): Promise<unknown>
    get(id: string): { cwd?: string; transcriptPath?: string | null } | undefined
  }
  lastAnswer(engine: string, path: string): Promise<string | undefined>
  log(line: string): void
}

interface Entry {
  agent: HostAgent
  transcriptPath?: string
  pid?: number
  generation?: string
  endAt?: number
}

export class ObservedSource implements HostSource {
  readonly id = 'observed'
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly deps: ObservedDeps) {}

  list(): HostAgent[] {
    return [...this.entries.values()].map((e) => ({ ...e.agent }))
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  capabilities(_agent?: HostAgent): Caps {
    return { status: true, voice: false, focus: false, answer: false }
  }

  private emit(): void {
    for (const l of [...this.listeners]) l()
  }

  ingest(e: ObservedHookEvent): void {
    const now = this.deps.now()
    const entry = this.entry(e.engine, e.sessionId, now, {
      cwd: e.cwd, transcriptPath: e.transcriptPath, pid: e.callerPid, hints: e.hostHints,
    })
    if (!entry) return
    const a = entry.agent
    a.lastActivityAt = now
    if (e.cwd) { a.cwd = e.cwd; a.name = basename(e.cwd) || a.name }
    if (e.transcriptPath) entry.transcriptPath = e.transcriptPath
    if (e.event === 'session-end') {
      entry.endAt = now
      this.emit()
      return
    }
    // A session that comes back after its end (a resume) is a live one again.
    entry.endAt = undefined
    switch (e.event) {
      case 'session-start':
        // A start must not undo a state a faster event already set.
        break
      case 'turn-start':
        this.setState(a, 'working', now)
        a.unseenDone = false
        // The last turn's answer is not this one's: cleared, the same answer at this turn's end is a change the dial hears.
        a.lastAnswer = undefined
        break
      case 'needs-input':
        this.setState(a, 'needs-you', now)
        break
      case 'turn-error':
        this.setState(a, 'error', now)
        break
      case 'turn-stop':
        this.setState(a, 'done', now)
        a.unseenDone = true
        void this.readAnswer(entry)
        break
    }
    this.emit()
  }

  private setState(a: HostAgent, state: HostAgentState, now: number): void {
    if (a.state !== state) a.since = now
    else if (state === 'working') a.since = now
    a.state = state
  }

  /** The existing entry, or a new one if there is room. */
  private entry(
    engine: string, sessionId: string, now: number,
    init: { cwd?: string; transcriptPath?: string | null; pid?: number; hints?: Record<string, string> },
  ): Entry | undefined {
    const id = observedAgentId(engine, sessionId)
    const have = this.entries.get(id)
    if (have) {
      if (init.pid && have.pid === undefined) this.setPid(have, init.pid)
      return have
    }
    if (this.entries.size >= MAX_SESSIONS && !this.evict()) {
      this.deps.log(`[observed] full; dropped ${engine} session`)
      return undefined
    }
    const entry: Entry = {
      agent: {
        id, engine, sessionId, cwd: init.cwd,
        name: (init.cwd && basename(init.cwd)) || engine,
        host: detectHost(init.hints ?? {}),
        state: 'idle', since: now, lastActivityAt: now, unseenDone: false,
        ...(init.pid ? { callerPid: init.pid } : {}),
      },
      ...(init.transcriptPath ? { transcriptPath: init.transcriptPath } : {}),
    }
    if (init.pid) this.setPid(entry, init.pid)
    this.entries.set(id, entry)
    return entry
  }

  private setPid(entry: Entry, pid: number): void {
    entry.pid = pid
    entry.agent.callerPid = pid
    const gen = this.deps.pidGeneration(pid)
    if (gen) entry.generation = gen
  }

  /** Drops the oldest idle session; failing that the oldest finished one. False when every session is busy. */
  private evict(): boolean {
    const oldest = (states: HostAgentState[]): Entry | undefined =>
      [...this.entries.values()]
        .filter((e) => states.includes(e.agent.state))
        .sort((x, y) => x.agent.lastActivityAt - y.agent.lastActivityAt)[0]
    const victim = oldest(['idle']) ?? oldest(['done', 'error'])
    if (!victim) return false
    this.entries.delete(victim.agent.id)
    return true
  }

  private async readAnswer(entry: Entry): Promise<void> {
    if ((entry.agent.engine !== 'claude' && entry.agent.engine !== 'codex') || !entry.transcriptPath) return
    let text: string | undefined
    try {
      text = await this.deps.lastAnswer(entry.agent.engine, entry.transcriptPath)
    } catch (error) {
      this.deps.log(`[observed] last answer not read: ${error instanceof Error ? error.message : error}`)
      return
    }
    if (!text || this.entries.get(entry.agent.id) !== entry) return
    // A newer turn began while the file was read; its answer is not this one's.
    if (entry.agent.state !== 'done') return
    entry.agent.lastAnswer = text.length > ANSWER_CHARS ? `${text.slice(0, ANSWER_CHARS - 1)}…` : text
    this.emit()
  }

  /** Adds the sessions found open in a terminal or app, as idle, until their next hook event. */
  async scanOpen(): Promise<void> {
    try {
      await this.deps.externalSessions.scan()
    } catch (error) {
      this.deps.log(`[observed] scan failed: ${error instanceof Error ? error.message : error}`)
    }
    let changed = false
    const now = this.deps.now()
    // A fresh look, each of its process reads under a timeout (externals/support.ts): the cached answer is empty
    // before the first look, so the scan a dial's attach runs would find nothing until the next one, 60 s later.
    for (const [sessionId, openIn] of await this.deps.openSessions.fresh()) {
      if (openIn === 'harness') continue
      const owner = await this.deps.openSessions.owner(sessionId)
      const engine = owner?.engine
      if (!engine) continue
      if (this.entries.has(observedAgentId(engine, sessionId))) continue
      const ext = this.deps.externalSessions.get(sessionId)
      const entry = this.entry(engine, sessionId, now, {
        cwd: ext?.cwd, transcriptPath: ext?.transcriptPath, pid: owner?.pid,
      })
      if (entry) changed = true
    }
    if (changed) this.emit()
  }

  /** Removals: ended sessions, dead or reused pids, and pidless sessions silent for 12 h. Called every 30 s by the owner. */
  tick(): void {
    const now = this.deps.now()
    let changed = false
    for (const [id, e] of this.entries) {
      let gone = false
      if (e.endAt !== undefined && now - e.endAt >= END_DELAY_MS) gone = true
      else if (e.pid !== undefined && e.generation) gone = this.deps.pidGeneration(e.pid) !== e.generation
      else if (now - e.agent.lastActivityAt >= NO_PID_TTL_MS) gone = true
      if (gone) { this.entries.delete(id); changed = true }
    }
    if (changed) this.emit()
  }

  /** Codex sends no end-of-turn hook: a working session is done once the open-session check says it stopped. Called every 3 s. */
  async checkWorking(): Promise<void> {
    for (const e of [...this.entries.values()]) {
      if (e.agent.engine !== 'codex' || e.agent.state !== 'working' || !e.agent.sessionId) continue
      let working: boolean | null
      try {
        working = await this.deps.openSessions.working(e.agent.sessionId)
      } catch {
        continue
      }
      if (working !== false || e.agent.state !== 'working' || this.entries.get(e.agent.id) !== e) continue
      const now = this.deps.now()
      this.setState(e.agent, 'done', now)
      e.agent.unseenDone = true
      e.agent.lastActivityAt = now
      this.emit()
      await this.readAnswer(e)
    }
  }

  markSeen(agentId: string): void {
    const e = this.entries.get(agentId)
    if (!e?.agent.unseenDone) return
    e.agent.unseenDone = false
    this.emit()
  }
}
