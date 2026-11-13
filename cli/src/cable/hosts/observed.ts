import { createHash } from 'node:crypto'
import { basename } from 'node:path'
// Types only: the devices process must not load core code.
import type { ObservedHookEvent } from '../../core/observedHook.js'
import type { OpenSessions, SessionRows } from '../../lib/sessionSearch/external.js'
import { within } from '../../lib/sessionSearch/externals/support.js'
import type { ExternalEngine, RunningProcess } from '../../lib/sessionSearch/externals/types.js'
import { detectHost } from './hostDetect.js'
import type { Caps, HostAgent, HostAgentState, HostSource } from './types.js'

export { detectHost, hostDisplayName } from './hostDetect.js'

const NAMESPACE = '6f1d0c3e-5b7a-4c92-8e41-3a9d7b2f60c8'
const MAX_SESSIONS = 50
const END_DELAY_MS = 10_000
const NO_GENERATION_TTL_MS = 12 * 60 * 60 * 1000
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
  /** The machine's processes, read once for every session (externals/support.ts listProcesses); none when unreadable. */
  processes(): Promise<readonly Pick<RunningProcess, 'pid' | 'generation'>[]>
  /** Whether a pid is running, for a session whose process has no generation to read (Windows has no `ps` here). */
  alive(pid: number): boolean
  openSessions: Pick<OpenSessions, 'owners' | 'working'>
  sessionRows: Pick<SessionRows, 'find'>
  lastAnswer(engine: string, path: string): Promise<string | undefined>
  /** Folders whose sessions are Harness's own (its data folder), as the external sessions are given them: never observed. */
  excluded: readonly string[]
  log(line: string): void
}

interface Entry {
  agent: HostAgent
  transcriptPath?: string
  pid: number
  generation?: string
  endAt?: number
}

export class ObservedSource implements HostSource {
  readonly id = 'observed'
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  private scanning: Promise<void> | null = null

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
    init: { cwd?: string; transcriptPath?: string | null; pid: number; hints?: Record<string, string> },
  ): Entry | undefined {
    const id = observedAgentId(engine, sessionId)
    // Harness's own session (the voice router's Claude Code runs in the data folder, outside a pane) is never an agent
    // outside it: one first heard of without its folder (a hook cut to its bound) goes once the folder is known.
    if (init.cwd && this.deps.excluded.some((dir) => within(dir, init.cwd!))) {
      if (this.entries.delete(id)) this.emit()
      return undefined
    }
    const have = this.entries.get(id)
    if (have) return have
    if (this.entries.size >= MAX_SESSIONS && !this.evict()) {
      this.deps.log(`[observed] full; dropped ${engine} session`)
      return undefined
    }
    const entry: Entry = {
      agent: {
        id, engine, sessionId, cwd: init.cwd,
        name: (init.cwd && basename(init.cwd)) || engine,
        host: detectHost(init.hints ?? {}),
        state: 'idle', since: now, lastActivityAt: now, unseenDone: false, callerPid: init.pid,
      },
      pid: init.pid,
      ...(init.transcriptPath ? { transcriptPath: init.transcriptPath } : {}),
    }
    this.entries.set(id, entry)
    return entry
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

  /** Adds the sessions found open in a terminal or app, as idle, until their next hook event. One look at a time. */
  scanOpen(): Promise<void> {
    this.scanning ??= this.scanOnce().finally(() => { this.scanning = null })
    return this.scanning
  }

  private async scanOnce(): Promise<void> {
    // One fresh look at the machine's processes for every session, each of its reads under a timeout
    // (externals/support.ts): the cached answer is empty before the first look, so the scan a dial's attach runs would
    // find nothing until the next one, 60 s later. Then the rows of only the sessions it found, from their own stores.
    const owners = await this.deps.openSessions.owners()
    const open = new Map<string, ExternalEngine>()
    for (const [sessionId, owner] of owners) {
      if (!owner.harness && !this.entries.has(observedAgentId(owner.engine, sessionId))) open.set(sessionId, owner.engine)
    }
    if (!open.size) return
    const rows = await this.deps.sessionRows.find(open)
    let changed = false
    const now = this.deps.now()
    for (const [sessionId, engine] of open) {
      // No row, no folder to tell Harness's own from a person's (the voice router's transcript is a program's, in the data
      // folder) or to name it by. A hook may also have told of it while the rows were read.
      const row = rows.get(sessionId)
      if (!row || this.entries.has(observedAgentId(engine, sessionId))) continue
      const entry = this.entry(engine, sessionId, now, { cwd: row.cwd, transcriptPath: row.transcriptPath, pid: owners.get(sessionId)!.pid })
      if (entry) changed = true
    }
    if (changed) this.emit()
  }

  /** Removals: ended sessions, dead or reused pids, and sessions with no generation silent for 12 h. Called every 30 s by the owner. */
  async tick(): Promise<void> {
    if (!this.entries.size) return
    // One read of the machine's processes for every session: a `ps` each blocked the loop for seconds with 50 of them.
    // A table that cannot be read is empty: it always holds the process reading it.
    const table = new Map((await this.deps.processes()).map((p) => [p.pid, p.generation]))
    const now = this.deps.now()
    let changed = false
    for (const [id, e] of this.entries) {
      // Its process's generation, noted at the first look that sees it.
      const gen = table.get(e.pid)
      if (gen) e.generation ??= gen
      let gone: boolean
      if (e.endAt !== undefined && now - e.endAt >= END_DELAY_MS) gone = true
      else if (table.size && !table.has(e.pid)) gone = true
      else if (gen) gone = gen !== e.generation
      // No generation to tell a reused pid by: running, and heard from in the last 12 h.
      else gone = !this.deps.alive(e.pid) || now - e.agent.lastActivityAt >= NO_GENERATION_TTL_MS
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
