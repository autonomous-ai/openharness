/**
 * cmux's agents on the dial, hook or no hook (docs/plans/2026-11-17-dial-cmux-design.md): each agent cmux tracks,
 * listed from `cmux sessions list` (cmuxCli.ts) while a dial is attached, and read again for one agent when its store in
 * `~/.cmuxterm` changes: pushed by the folder's watch, never polled. The list reads cmux's stores without its socket, so
 * it works whatever cmux's socket mode is.
 *
 * A working agent's hooks write its store several times a second, so each agent has one run at a time, and the changes
 * during it give one more after it: one cmux process after another, never a pile.
 *
 * Every listable agent is kept (1,024 at most) and the first 64 are listed, so when one leaves the next is listed with
 * no new run. Those past either bound, and a run's records past the 1,024 it reads, are counted in one over line.
 *
 * A log line says only fixed words and counts: cmux's records name people's folders and agents.
 */
import { basename } from 'node:path'
import {
  CMUX_AUTOMATION_OFF, CMUX_STORE, cmuxPaneId, cmuxPaneKey,
  type CmuxClient, type CmuxLifecycle, type CmuxPrompt, type CmuxSession, type CmuxSessions,
} from './cmuxCli.js'
import { MAX_AGENTS, shown } from './herdrSource.js'
import { MAX_TEXT } from './orca.js'
import type { Caps, HostAgent, HostAgentState, HostSource, PaneSwitch, SendResult } from './types.js'

/** The agents kept, listed or not. */
const MAX_KEPT = 1024
/** cmux processes at a time: cmux v0.65.2.2 tracks 20 agents, each with a store of its own. */
const MAX_RUNS = 32
const STATES: Record<CmuxLifecycle, HostAgentState> = { running: 'working', needsInput: 'needs-you', idle: 'idle', unknown: 'idle' }

export interface CmuxSourceDeps {
  client: Pick<CmuxClient, 'sessions'>
  /** Tells of each change where cmux's stores live, with the changed file's name when the OS gave one
   *  (unixSocket.ts watchSocket), until its stop is called. */
  watch(changed: (file?: string) => void): () => void
  /** Whether the stores' folder is there now. */
  folder(): boolean
  /** Whether that process is alive, asked of the OS alone. */
  alive(pid: number): boolean
  /** The dial's words: the cmux adapter's prompt (cmuxApp.ts). `pane` is `<workspace>/<surface>`. */
  prompt(pane: string, kind: string, text: string): Promise<CmuxPrompt>
  /** A tap on that agent at that pane, as the devices route it. */
  focus(pane: string, agentId: string): Promise<boolean>
  canShow(pane: string): boolean
  show(pane: string, agentId: string): Promise<PaneSwitch>
  now(): number
  monotonic(): number
  uuid(): string
  log(line: string): void
  count(what: 'cmux' | 'busy' | 'waiting' | 'too-long' | 'no-answer' | 'refused (cmux)'): void
}

/** A kept agent, its pane (`<workspace>/<surface>`, as cmux printed them), and cmux's last word for its turn. */
interface Row {
  pane: string
  lifecycle?: CmuxLifecycle
  agent: HostAgent
}

/** A run under way, and whether a change came during it. */
interface Run {
  again: boolean
}

/** One agent's records, and the place in the order runs started of the run that read them. */
interface Kept {
  order: number
  sessions: CmuxSession[]
}

export class CmuxSource implements HostSource {
  readonly id = 'cmux'
  private readonly listeners = new Set<() => void>()
  /** Every listable agent, by its surface in lower case (cmux prints upper case, a hook or a link may hold lower), in
   *  the order each was first listed. */
  private readonly rows = new Map<string, Row>()
  /** Each agent's records by cmux's word, and the records each run's word (none: all) read past the 1,024. */
  private readonly records = new Map<string, Kept>()
  private readonly cut = new Map<string | undefined, number>()
  /** This start's runs under way, by word (none: all); and the cmux processes under way, any start's. */
  private readonly runs = new Map<string | undefined, Run>()
  private active = 0
  /** A change found every run taken: one all-agents run when one ends, which reads that agent too. */
  private waiting = false
  /** The count of runs started, which orders their answers; and the start a run belongs to. */
  private order = 0
  private epoch = 0
  private running = false
  private unwatch: (() => void) | undefined
  /** Whether the stores' folder was there, as last said: kept across a detach, so a dial plugged in again says nothing. */
  private there: boolean | undefined
  /** The words (none: all) whose run's fault was said, until a run of each answers. */
  private readonly failing = new Set<string | undefined>()
  /** The slowest read said by word (none: all), this start's. */
  private readonly slowest = new Map<string | undefined, number>()
  /** The count of listed agents last said, and of those left out: past the 1,024, and of the over line. */
  private said: number | undefined
  private unkept = 0
  private over = 0

  constructor(private readonly deps: CmuxSourceDeps) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.slowest.clear()
    // Held before the folder is asked after, so a folder made between the two is still heard.
    this.unwatch = this.deps.watch((file) => this.changed(file))
    if (this.look()) this.read(undefined)
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.unwatch?.()
    this.unwatch = undefined
    this.forget()
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  list(): HostAgent[] {
    return this.listed().map(({ agent }) => ({ ...agent }))
  }

  /** Status, words, a tap and a rest; an agent waiting in cmux is answered there. */
  capabilities(): Caps {
    return { status: true, voice: true, focus: true, answer: false }
  }

  /** The dial's words, as the observed source says them. Its own state refuses first; the adapter reads the prompt
   *  again before it pastes (cmuxApp.ts). */
  async send(agent: HostAgent, text: string): Promise<SendResult> {
    const row = this.find(agent.id)
    const name = (row?.agent ?? agent).name
    const refuse = (what: 'busy' | 'waiting' | 'too-long' | 'no-answer' | 'refused (cmux)', reason: string): SendResult => {
      this.deps.count(what)
      return { ok: false, reason }
    }
    const busy = `${name} is busy. Say it when it is done.`
    const waiting = `${name} is waiting for your answer in cmux.`
    const silent = `${name} did not answer.`
    if (text.length > MAX_TEXT) return refuse('too-long', 'Too long. Say it shorter.')
    if (!row) return refuse('no-answer', silent)
    if (row.agent.state === 'needs-you') return refuse('waiting', waiting)
    if (row.agent.state === 'working') return refuse('busy', busy)
    const answer = await this.deps.prompt(row.pane, row.agent.engine, text)
    if (answer === 'sent') {
      this.deps.count('cmux')
      return { ok: true }
    }
    if (answer === 'busy') return refuse('busy', busy)
    if (answer === 'waiting') return refuse('waiting', waiting)
    if (answer === 'automation-off') return refuse('refused (cmux)', CMUX_AUTOMATION_OFF)
    return refuse('no-answer', silent)
  }

  async focus(agent: HostAgent): Promise<boolean> {
    const row = this.find(agent.id)
    return row ? this.deps.focus(row.pane, row.agent.id) : false
  }

  hasPane(agent: HostAgent): boolean {
    const row = this.find(agent.id)
    return row ? this.deps.canShow(row.pane) : false
  }

  async showPane(agent: HostAgent): Promise<PaneSwitch> {
    const row = this.find(agent.id)
    return row ? this.deps.show(row.pane, row.agent.id) : 'failed'
  }

  /** The kind of the agent cmux lists at that surface, whatever the id's case, listed or past the 64; else none. */
  kindAt(surface: string): string | undefined {
    return this.rows.get(surface.toLowerCase())?.agent.engine
  }

  /** The pane (`<workspace>/<surface>`) of a row it lists, by the row's id; else none. devices.ts places the open
   *  scan's copy of that session there (decided 7). */
  paneAt(agentId: string): string | undefined {
    return this.find(agentId)?.pane
  }

  private listed(): Row[] {
    return [...this.rows.values()].slice(0, MAX_AGENTS)
  }

  private find(agentId: string): Row | undefined {
    return this.listed().find(({ agent }) => agent.id === agentId)
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }

  /** Whether the stores' folder is there, said when that changed. */
  private look(): boolean {
    const there = this.deps.folder()
    if (there !== this.there) {
      this.there = there
      this.deps.log(`[cmux] watch · ${there ? 'on' : 'none'}`)
    }
    return there
  }

  /** A change where the stores live. With the folder's parent held, it tells every change of the home folder too: only
   *  the folder coming or going, or a store's own name, starts a run. */
  private changed(file?: string): void {
    if (!this.running) return
    const was = this.there
    const there = this.look()
    if (there !== was) {
      if (there) this.read(undefined)
      else this.forget()
      return
    }
    if (!there) return
    if (file === undefined) {
      this.read(undefined)
      return
    }
    const store = CMUX_STORE.exec(file)
    if (store) this.read(store[1])
  }

  /** Drops every run under way, every record and every row: a run that answers after is not taken. */
  private forget(): void {
    this.epoch++
    this.runs.clear()
    this.waiting = false
    this.records.clear()
    this.cut.clear()
    // The next list is said again, even with as many agents as before.
    this.said = undefined
    this.unkept = 0
    this.over = 0
    if (this.rows.size === 0) return
    this.rows.clear()
    this.emit()
  }

  /** One run of that agent's records (none: every agent's), or one more after the one under way. */
  private read(word: string | undefined): void {
    if (word === undefined) this.waiting = false
    const under = this.runs.get(word)
    if (under) {
      under.again = true
      return
    }
    if (this.active >= MAX_RUNS) {
      this.waiting = true
      return
    }
    const run: Run = { again: false }
    this.runs.set(word, run)
    this.active++
    const { epoch } = this
    const order = ++this.order
    const began = this.deps.monotonic()
    void this.deps.client.sessions(word)
      .catch((): CmuxSessions => ({ ok: false, fault: 'failed' }))
      .then((answer) => this.ended(word, run, epoch, order, began, answer))
  }

  private ended(word: string | undefined, run: Run, epoch: number, order: number, began: number, answer: CmuxSessions): void {
    this.active--
    if (epoch === this.epoch) {
      this.runs.delete(word)
      this.answered(word, order, this.deps.monotonic() - began, answer)
      if (run.again) this.read(word)
    }
    if (this.waiting) this.read(undefined)
  }

  /** A run with no answer keeps the rows, and says so once until a run of that word answers. */
  private answered(word: string | undefined, order: number, ms: number, answer: CmuxSessions): void {
    if (!answer.ok) {
      if (this.failing.has(word)) return
      this.failing.add(word)
      this.deps.log(`[cmux] list · ${answer.fault === 'too-big' ? 'too-big' : 'failed'}`)
      return
    }
    this.failing.delete(word)
    this.timed(word, ms)
    const before = JSON.stringify(this.list())
    this.take(word, order, answer.sessions)
    this.counted()
    if (JSON.stringify(this.list()) !== before) this.emit()
  }

  /** A word's first run after a start, then only one slower than every one said: the number the read's target needs,
   *  not a line per hook of a working agent. */
  private timed(word: string | undefined, ms: number): void {
    const slowest = this.slowest.get(word)
    if (slowest !== undefined && ms <= slowest) return
    this.slowest.set(word, ms)
    this.deps.log(`[cmux] read · ${word ?? 'all'} · ${Math.round(ms)}`)
  }

  /** A run's records replace its agent's (every agent's, for an all-agents run), unless a run that started after it
   *  already replaced them; the rows are then made again from every agent's records. */
  private take(word: string | undefined, order: number, sessions: CmuxSession[]): void {
    const read = sessions.slice(0, MAX_KEPT)
    this.cut.set(word, sessions.length - read.length)
    const byWord = new Map<string, CmuxSession[]>()
    for (const session of read) {
      const same = byWord.get(session.word)
      if (same) same.push(session)
      else byWord.set(session.word, [session])
    }
    const words = word === undefined ? new Set([...this.records.keys(), ...byWord.keys()]) : [word]
    for (const each of words) {
      if ((this.records.get(each)?.order ?? 0) > order) continue
      this.records.set(each, { order, sessions: byWord.get(each) ?? [] })
    }
    this.rebuild()
  }

  /** Each surface shows its newest record. A row keeps its id, place and turn while its surface, kind and pid stay;
   *  another kind or pid there is another agent, whose first state ends no turn of the one before: a new row. */
  private rebuild(): void {
    const newest = new Map<string, CmuxSession>()
    for (const kept of this.records.values()) {
      // An agent killed with no hook leaves its store as it was: its pid, any agent's, says it is gone.
      kept.sessions = kept.sessions.filter(({ pid }) => this.deps.alive(pid))
      for (const session of kept.sessions) {
        const surface = session.surface.toLowerCase()
        if (session.updatedAt > (newest.get(surface)?.updatedAt ?? -Infinity)) newest.set(surface, session)
      }
    }
    for (const [surface, row] of this.rows) {
      const session = newest.get(surface)
      if (session?.kind !== row.agent.engine || session.pid !== row.agent.callerPid) this.rows.delete(surface)
    }
    this.unkept = 0
    for (const [surface, session] of newest) {
      if (!this.rows.has(surface) && this.rows.size >= MAX_KEPT) this.unkept++
      else this.set(surface, session)
    }
  }

  private set(surface: string, session: CmuxSession): void {
    const { kind, cwd } = session
    const pane = cmuxPaneId(session.workspace, session.surface)
    let row = this.rows.get(surface)
    if (!row) {
      row = {
        pane,
        agent: {
          id: this.deps.uuid(), engine: kind, name: kind, host: 'cmux', app: 'cmux', state: 'idle', unseenDone: false,
          lastActivityAt: this.deps.now(), callerPid: session.pid, paneKeys: [cmuxPaneKey(session.surface)],
        },
      }
      this.rows.set(surface, row)
    }
    // A tab moved to another workspace keeps its surface: the link takes the workspace it is in now.
    row.pane = pane
    row.agent.sessionId = session.sessionId
    row.agent.cwd = cwd
    row.agent.name = shown(cwd && basename(cwd)) || kind
    this.status(row, session.lifecycle)
  }

  /** cmux has no done word: a turn that leaves running or needsInput for idle is done, with nothing unseen, as hc's
   *  idle after working (hcSource.ts), and stays done while it stays idle. */
  private status(row: Row, next: CmuxLifecycle): void {
    const before = row.lifecycle
    const was = row.agent.state
    row.lifecycle = next
    const state = next !== 'idle' ? STATES[next]
      : before === 'running' || before === 'needsInput' ? 'done' : before === 'idle' ? was : 'idle'
    row.agent.state = state
    if (state !== was) row.agent.lastActivityAt = this.deps.now()
  }

  /** The listed agents, said when their count changes, and those left out: past the dial's 64, past the 1,024 kept,
   *  and a run's records past the 1,024 it reads. */
  private counted(): void {
    const count = Math.min(this.rows.size, MAX_AGENTS)
    if (count !== this.said) {
      this.said = count
      this.deps.log(`[cmux] listed · ${count} agents`)
    }
    let over = this.rows.size - count + this.unkept
    for (const left of this.cut.values()) over += left
    if (over !== this.over) {
      this.over = over
      if (over > 0) this.deps.log(`[cmux] over · ${over} left out`)
    }
  }
}
