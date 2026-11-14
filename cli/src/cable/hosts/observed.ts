import { createHash } from 'node:crypto'
import { basename } from 'node:path'
// Types only: the devices process must not load core code.
import type { ObservedAsked, ObservedEvent } from '../../core/observedHook.js'
import { truncateUtf8 } from '../../lib/deviceRecentTrim.js'
import type { OpenSessions, SessionRows } from '../../lib/sessionSearch/external.js'
import { type fileStamp, within } from '../../lib/sessionSearch/externals/support.js'
import type { ExternalEngine, RunningProcess } from '../../lib/sessionSearch/externals/types.js'
import { roundDrawable } from '../roundGlyphs.js'
import { detectHost } from './hostDetect.js'
import type { Delivery } from './inbox.js'
import { MAX_TEXT, ORCA_HANDLE } from './orca.js'
import type { Caps, HostAgent, HostAgentState, HostSource, SendResult } from './types.js'

export { detectHost, hostDisplayName } from './hostDetect.js'

const NAMESPACE = '6f1d0c3e-5b7a-4c92-8e41-3a9d7b2f60c8'
const MAX_SESSIONS = 50
const END_DELAY_MS = 10_000
const NO_GENERATION_TTL_MS = 12 * 60 * 60 * 1000
/** The dial's card is small; keep what it can show. */
const ANSWER_CHARS = 300
/** The core's Stop grace (STOP_HOOK_GRACE_MS, core/turns/turnHooks.ts, which this process must not load): Claude's
 *  transcript can lag its Stop hook, and an answer read at once is the last turn's or none. */
const ANSWER_GRACE_MS = 1_500
/** A turn's hook runs before the engine marks the turn begun in its record: a turn younger than this may still read idle. */
const TURN_SETTLE_MS = 2_000
/** The tool call's line reaches the transcript just after its permission hook ran, and nobody answers a prompt sooner than
 *  this: a write that soon after the prompt is the asking's own, not the app's answer. */
const ASK_SETTLE_MS = 1_000
/** The firmware's activity line, `activity[100]` (ui_habitat.c), less its terminating zero: it cuts a longer one there. */
const LINE_BYTES = 99

/**
 * The dial's line for a prompt that waits: what it asks, and the app to answer it in. What the round dial cannot draw is a
 * `?`, and the summary is cut, never the app: the line is all that tells the person where the prompt is answered.
 */
export function askedLine(summary: string, host: string): string {
  const where = ` · answer in ${host}`
  const room = LINE_BYTES - Buffer.byteLength(where)
  const shown = roundDrawable(summary)
  return `${Buffer.byteLength(shown) <= room ? shown : `${truncateUtf8(shown, room - Buffer.byteLength('…'))}…`}${where}`
}

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
  openSessions: Pick<OpenSessions, 'owners' | 'busy'>
  sessionRows: Pick<SessionRows, 'find'>
  lastAnswer(engine: string, path: string): Promise<string | undefined>
  /** A transcript's last change (externals/support.ts fileStamp): one that grew while its agent waited was answered. */
  fileStamp: typeof fileStamp
  /** Folders whose sessions are Harness's own (its data folder), as the external sessions are given them: never observed. */
  excluded: readonly string[]
  log(line: string): void
  /** The routes for the dial's voice and tap; absent, an agent is status only. */
  actions?: ObservedActions
}

export interface ObservedActions {
  /** The session's mod has a poll open, or closed one moments ago. */
  modReady(sessionId: string): boolean
  toMod(sessionId: string, text: string): Promise<Delivery>
  orcaSend(handle: string, text: string): Promise<boolean>
  orcaOpen(handle: string): Promise<boolean>
  count(what: 'mod' | 'orca' | 'busy' | 'too-long' | 'no-answer'): void
}

interface Entry {
  agent: HostAgent
  /** When its state began (a turn's start renews it): how long a turn has run, and since when an agent waits. */
  since: number
  transcriptPath?: string
  pid: number
  /** The Orca terminal its last event came from. */
  handle?: string
  /** What the permission prompt it waits on asks, from its hook (deviceClaude/asked.ts): '' when it names nothing. */
  asked?: string
  generation?: string
  endAt?: number
  /** The read of the last answer, waiting out the grace. */
  answerTimer?: ReturnType<typeof setTimeout>
}

/** Working, or waiting on the person: its turn has not ended. */
const inTurn = (agent: HostAgent): boolean => agent.state === 'working' || agent.state === 'needs-you'

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

  capabilities(agent?: HostAgent): Caps {
    const e = agent && this.entries.get(agent.id)
    const actions = this.deps.actions
    if (!e || !actions) return { status: true, voice: false, focus: false, answer: false }
    // An ended session's terminal holds a shell now, where its words would run.
    const live = this.live(e)
    return {
      status: true,
      voice: live && (!!e.handle || this.modReady(e, actions)),
      focus: live && !!e.handle,
      // Its prompts are answered in its own app: the dial only shows them.
      answer: false,
    }
  }

  /** Only Claude Code runs the mod; another engine's session id is no poll. */
  private modReady(e: Entry, actions: ObservedActions): boolean {
    return e.agent.engine === 'claude' && actions.modReady(e.agent.sessionId!)
  }

  /** The dial's words for an idle agent: to its mod, else typed into its Orca terminal. Nothing is queued. */
  async send(agent: HostAgent, text: string): Promise<SendResult> {
    const e = this.entries.get(agent.id)
    const actions = this.deps.actions
    const refuse = (what: 'busy' | 'too-long' | 'no-answer', reason: string): SendResult => {
      actions?.count(what)
      return { ok: false, reason }
    }
    if (text.length > MAX_TEXT) return refuse('too-long', 'Too long. Say it shorter.')
    const current = e?.agent ?? agent
    const busy = (): SendResult => refuse('busy', `${current.name} is busy. Say it when it is done.`)
    const noAnswer = (): SendResult => refuse('no-answer', `${current.name} did not answer.`)
    // Its session ended: its terminal holds a shell now, where these words would run.
    if (e && !this.live(e)) return noAnswer()
    // A prompt typed into a turn would answer its question or queue behind it, unseen.
    if (inTurn(current)) return busy()
    if (e && actions) {
      const handle = e.handle
      if (this.modReady(e, actions)) {
        const delivery = await actions.toMod(e.agent.sessionId!, text)
        if (delivery === 'taken') {
          actions.count('mod')
          return { ok: true }
        }
        // One before it still waits for the mod's next poll: typed into Orca now, this one would land before it. And the
        // wait ran up to 5 s, in which a turn may have begun in its terminal.
        if (delivery === 'busy' || inTurn(e.agent)) return busy()
      }
      // In that wait the session may also have ended, moved to another terminal or gone: the old one holds something else.
      if (handle && this.live(e) && e.handle === handle && await actions.orcaSend(handle, text)) {
        actions.count('orca')
        return { ok: true }
      }
    }
    return noAnswer()
  }

  /** Still listed, and its session has not ended. */
  private live(e: Entry): boolean {
    return this.entries.get(e.agent.id) === e && e.endAt === undefined
  }

  focus(agent: HostAgent): Promise<boolean> {
    const e = this.entries.get(agent.id)
    const actions = this.deps.actions
    return e?.handle && actions && this.live(e) ? actions.orcaOpen(e.handle) : Promise.resolve(false)
  }

  private emit(): void {
    for (const l of [...this.listeners]) l()
  }

  /** What the permission prompt the agent waits on asks, while it waits; '' for a prompt that names nothing. */
  waitingOn(agentId: string): string | undefined {
    return this.entries.get(agentId)?.asked
  }

  ingest(e: ObservedEvent): void {
    if (e.event === 'asked') {
      this.asked(e)
      return
    }
    // The end of a session never listed (one of the 50 dropped when full, or ended before the devices started) lists none.
    if (e.event === 'session-end' && !this.entries.has(observedAgentId(e.engine, e.sessionId))) return
    const now = this.deps.now()
    const entry = this.entry(e.engine, e.sessionId, now, {
      cwd: e.cwd, transcriptPath: e.transcriptPath, pid: e.callerPid,
    })
    if (!entry) return
    const a = entry.agent
    a.lastActivityAt = now
    // Only a hook says where a session runs: one the open scan found is a plain terminal until its first.
    a.host = detectHost(e.hostHints)
    // Every event's own: a session resumed elsewhere must not be typed into the terminal it left.
    const handle = e.hostHints.ORCA_TERMINAL_HANDLE
    entry.handle = handle && ORCA_HANDLE.test(handle) ? handle : undefined
    if (e.cwd) { a.cwd = e.cwd; a.name = basename(e.cwd) || a.name }
    if (e.transcriptPath) entry.transcriptPath = e.transcriptPath
    if (e.event === 'session-end') {
      entry.endAt = now
      this.clearAsked(entry)
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
        this.setState(entry, 'working', now)
        a.unseenDone = false
        // The last turn's answer is not this one's: cleared, the same answer at this turn's end is a change the dial hears.
        a.lastAnswer = undefined
        break
      case 'needs-input':
        // Only a turn waits on the person: a notice to an idle or finished agent is stale.
        if (a.state === 'working') this.setState(entry, 'needs-you', now)
        break
      case 'turn-error':
        this.setState(entry, 'error', now)
        break
      case 'turn-stop':
        this.setState(entry, 'done', now)
        a.unseenDone = true
        clearTimeout(entry.answerTimer)
        entry.answerTimer = setTimeout(() => { void this.readAnswer(entry) }, ANSWER_GRACE_MS)
        entry.answerTimer.unref()
        break
    }
    this.emit()
  }

  /**
   * A permission prompt the session waits on: the agent waits, and the dial's line says for what. Only on an agent the
   * session's own hooks listed: the plugin's hook runs in a Harness pane too, whose agent is Harness's, and says nothing
   * of where a session runs.
   */
  private asked(e: ObservedAsked): void {
    const entry = this.entries.get(observedAgentId(e.engine, e.sessionId))
    if (!entry || !this.live(entry)) return
    const now = this.deps.now()
    this.setState(entry, 'needs-you', now)
    // A new prompt, though the agent may still read needs-you for the last one: what was written before is not its answer.
    entry.since = now
    entry.agent.lastActivityAt = now
    entry.asked = e.summary || e.tool || ''
    // Counts only: never the prompt, the tool or the session.
    this.deps.log('[observed] waiting prompt · shown')
    this.emit()
  }

  /** The prompt it waited on is over. */
  private clearAsked(entry: Entry): void {
    if (entry.asked === undefined) return
    entry.asked = undefined
    this.deps.log('[observed] waiting prompt · cleared')
  }

  private setState(entry: Entry, state: HostAgentState, now: number): void {
    if (entry.agent.state !== state || state === 'working') entry.since = now
    entry.agent.state = state
    if (state !== 'needs-you') this.clearAsked(entry)
  }

  /** The existing entry, or a new one if there is room. */
  private entry(
    engine: string, sessionId: string, now: number,
    init: { cwd?: string; transcriptPath?: string | null; pid: number },
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
        host: 'terminal',
        state: 'idle', lastActivityAt: now, unseenDone: false, callerPid: init.pid,
      },
      since: now,
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
    // By code point: a cut through an emoji's surrogate pair leaves a broken character on the card.
    const chars = Array.from(text)
    entry.agent.lastAnswer = chars.length > ANSWER_CHARS ? `${chars.slice(0, ANSWER_CHARS - 1).join('')}…` : text
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
    // Only the sessions known as the read begins: one first heard of while `ps` runs may have a process it did not see.
    const judged = [...this.entries]
    // One read of the machine's processes for every session: a `ps` each blocked the loop for seconds with 50 of them.
    // A table that cannot be read is empty: it always holds the process reading it.
    const table = new Map((await this.deps.processes()).map((p) => [p.pid, p.generation]))
    const now = this.deps.now()
    let changed = false
    for (const [id, e] of judged) {
      if (this.entries.get(id) !== e) continue
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

  /**
   * The turns no hook moves, every 3 s. A person who answers a prompt in their own terminal sends no hook: the transcript
   * growing past the moment the agent began waiting says the turn goes on. Codex sends no end-of-turn hook, and a Claude
   * turn stopped with Esc gets no Stop: the owner's record reading idle says each is over.
   */
  async checkWorking(): Promise<void> {
    const all = [...this.entries.values()]
    // A prompt its hook told of writes a line of its own as it asks.
    const answeredAfter = (e: Entry): number => e.since + (e.asked === undefined ? 0 : ASK_SETTLE_MS)
    for (const e of all) {
      if (e.agent.state !== 'needs-you' || !e.transcriptPath) continue
      const stamp = await this.deps.fileStamp(e.transcriptPath)
      if (!stamp || stamp.mtime <= answeredAfter(e) || e.agent.state !== 'needs-you' || this.entries.get(e.agent.id) !== e) continue
      const now = this.deps.now()
      this.setState(e, 'working', now)
      e.agent.lastActivityAt = now
      this.emit()
    }
    const at = this.deps.now()
    const turns = all.filter((e) => (e.agent.engine === 'codex' || e.agent.engine === 'claude')
      && e.agent.state === 'working' && at - e.since >= TURN_SETTLE_MS)
    if (!turns.length) return
    const owners = await this.deps.openSessions.owners()
    for (const e of turns) {
      // Not found says nothing (a process read that timed out finds nobody): only an owner that reads idle ends a turn.
      const owner = owners.get(e.agent.sessionId ?? '')
      if (!owner || await this.deps.openSessions.busy(owner)) continue
      if (e.agent.state !== 'working' || this.entries.get(e.agent.id) !== e) continue
      const now = this.deps.now()
      e.agent.lastActivityAt = now
      if (e.agent.engine === 'claude') {
        // Stopped with Esc: no answer, nothing to tell as done.
        this.setState(e, 'idle', now)
        this.emit()
        continue
      }
      this.setState(e, 'done', now)
      e.agent.unseenDone = true
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
