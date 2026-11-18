/**
 * Herdr's agents on the dial, hook or no hook (docs/plans/2026-11-16-herdr-app-design.md): the terminals Herdr's window
 * shows, listed and followed over Herdr Core's socket (hcClient.ts) while a dial is attached, from one subscription,
 * pushed and never polled.
 *
 * Listed is a live terminal of this machine that carries Herdr's `herdr.space` label and whose program reports an agent's
 * status. Left out: hidden workers (an agent's `hc run`, which the window does not show), other machines' terminals, and
 * plain programs, which report no status. hc keeps running when Herdr is closed, so its agents are listed and take words
 * then too; a tap opens Herdr.
 *
 * Every listable terminal is kept (the client keeps 1,024 at most) and the first 64 are listed, so when one leaves the
 * next is listed with no new snapshot. Those past either bound are counted in one over line. The wait on hc's socket,
 * its retries and its stale rule are socketAttempts.ts's.
 *
 * A log line says only fixed words and counts: hc's terminals name people's folders and agents.
 */
import { basename } from 'node:path'
import { hcPaneKey, type HcClient, type HcPrompt, type HcStatus, type HcTerminal } from './hcClient.js'
import { MAX_AGENTS, MAX_CWD, shown } from './herdrSource.js'
import { MAX_TEXT } from './orca.js'
import { SocketAttempts } from './socketAttempts.js'
import type { Caps, HostAgent, HostAgentState, HostSource, PaneSwitch, SendResult } from './types.js'
import type { SocketFault } from './unixSocket.js'

const STATES: Record<HcStatus, HostAgentState> = { idle: 'idle', working: 'working', blocked: 'needs-you', done: 'done', error: 'error' }

/** A live terminal Herdr's window shows, with a status or none. */
const inWindow = (terminal: HcTerminal): boolean => terminal.live && terminal.space
/** A live terminal hc reports an agent's status for: one of its five words, from an app with a kind. */
const reporting = (terminal: HcTerminal): boolean =>
  terminal.live && terminal.status !== undefined && terminal.kind !== undefined
/** A terminal Herdr's window shows that runs an agent now. */
type Listable = HcTerminal & { status: HcStatus; kind: string }
const listable = (terminal: HcTerminal): terminal is Listable => inWindow(terminal) && reporting(terminal)

export interface HcSourceDeps {
  client: Pick<HcClient, 'subscribe' | 'socketStamp'>
  /** Tells of each change where hc's socket lives (unixSocket.ts watchSocket), until its stop is called. */
  watch(changed: () => void): () => void
  /** The dial's words: the Herdr adapter's prompt (herdrApp.ts). */
  prompt(address: string, kind: string, text: string): Promise<HcPrompt>
  /** A tap on that agent at that terminal: the Herdr adapter's focus, as the devices route it. */
  focus(address: string, agentId: string): Promise<boolean>
  /** Whether a rest can show it now, and the rest: the Herdr adapter's canShow and show. */
  canShow(address: string): boolean
  show(address: string, agentId: string): Promise<PaneSwitch>
  /** A timer, as the devices' parts take theirs: its cancel is returned. */
  after(ms: number, run: () => void): () => void
  /** The wall clock, for `lastActivityAt` and a socket's age; and a clock that never steps back, for how long a
   *  subscription lived. */
  now(): number
  monotonic(): number
  uuid(): string
  log(line: string): void
  count(what: 'herdr-app' | 'busy' | 'waiting' | 'too-long' | 'no-answer'): void
}

/** A kept agent, its terminal, and hc's last status and turn of it: a turn that ends `idle` reads the status before, and
 *  one that ran while nothing was subscribed reads the turn. */
interface Row {
  address: string
  status?: HcStatus
  turn?: number
  agent: HostAgent
}

export class HcSource implements HostSource {
  readonly id = 'herdr-app'
  private readonly listeners = new Set<() => void>()
  /** Every listable terminal, by address, in the order each became listable. */
  private readonly rows = new Map<string, Row>()
  /** The live terminals the window shows with their tab, and those hc reports an agent for, listed or not, which the
   *  Herdr adapter asks after (shows, tabOf, reports). Each holds the client's 1,024 at most. */
  private readonly shown = new Map<string, string | undefined>()
  private readonly reported = new Set<string>()
  /** The pid of the program each live terminal runs now (hc's foreground), shown or not, which the devices ask after
   *  (terminalOf). It holds the client's 1,024 at most. */
  private readonly foregrounds = new Map<string, number>()
  private running = false
  private subscription: { close(): void } | undefined
  /** The count of listed agents last said, and of those left out. */
  private said: number | undefined
  private over = 0
  /** The terminals the client left out past its own bound, this subscription's. */
  private unkept = 0
  private readonly attempts = new SocketAttempts({
    name: 'herdr-app',
    socketStamp: () => this.deps.client.socketStamp(),
    watch: (changed) => this.deps.watch(changed),
    after: (ms, run) => this.deps.after(ms, run),
    now: () => this.deps.now(),
    monotonic: () => this.deps.monotonic(),
    log: (line) => this.deps.log(line),
    open: () => this.open(),
    close: () => this.close(),
    clear: () => this.clear(),
  })

  constructor(private readonly deps: HcSourceDeps) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.attempts.start()
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.close()
    this.attempts.stop()
    this.clear()
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  list(): HostAgent[] {
    return this.listed().map(({ agent }) => ({ ...agent }))
  }

  /** Status, words, a tap and a rest; an agent blocked in Herdr is answered there. */
  capabilities(): Caps {
    return { status: true, voice: true, focus: true, answer: false }
  }

  markSeen(agentId: string): void {
    const row = this.find(agentId)
    if (!row?.agent.unseenDone) return
    row.agent.unseenDone = false
    this.emit()
  }

  /** The dial's words, as the observed source says them. Its own state refuses first; the client reads the terminal
   *  again before it types (hcClient.ts). */
  async send(agent: HostAgent, text: string): Promise<SendResult> {
    const row = this.find(agent.id)
    const name = (row?.agent ?? agent).name
    const refuse = (what: 'busy' | 'waiting' | 'too-long' | 'no-answer', reason: string): SendResult => {
      this.deps.count(what)
      return { ok: false, reason }
    }
    const busy = `${name} is busy. Say it when it is done.`
    const silent = `${name} did not answer.`
    if (text.length > MAX_TEXT) return refuse('too-long', 'Too long. Say it shorter.')
    if (!row) return refuse('no-answer', silent)
    if (row.agent.state === 'needs-you') return refuse('waiting', `${name} is waiting for your answer in herdr.`)
    // hc's own status, not the dial's: a turn that ended idle shows done, and is at its prompt.
    if (row.status === 'working') return refuse('busy', busy)
    // An agent that errored is at no prompt to take them (spec Q7).
    if (row.status === 'error') return refuse('no-answer', silent)
    const answer = await this.deps.prompt(row.address, row.agent.engine, text)
    if (answer.outcome === 'sent') {
      this.deps.count('herdr-app')
      return { ok: true }
    }
    return answer.outcome === 'busy' ? refuse('busy', busy) : refuse('no-answer', silent)
  }

  async focus(agent: HostAgent): Promise<boolean> {
    const row = this.find(agent.id)
    return row ? this.deps.focus(row.address, row.agent.id) : false
  }

  hasPane(agent: HostAgent): boolean {
    const row = this.find(agent.id)
    return row ? this.deps.canShow(row.address) : false
  }

  async showPane(agent: HostAgent): Promise<PaneSwitch> {
    const row = this.find(agent.id)
    return row ? this.deps.show(row.address, row.agent.id) : 'failed'
  }

  /** Whether Herdr's window shows that terminal: a live one labeled `herdr.space`, with a status or none, listed or past
   *  the 64. */
  shows(address: string): boolean {
    return this.shown.has(address)
  }

  /** The tab of Herdr's window that holds a terminal it shows, its `herdr.tab` label as hc tells it now: a stroke
   *  matches it with the tab `herdr-app status` names on screen (herdrApp.ts onScreen). */
  tabOf(address: string): string | undefined {
    return this.shown.get(address)
  }

  /** Whether hc reports an agent's status for that live terminal, shown or not: a hidden worker's hooked copy takes
   *  words too. */
  reports(address: string): boolean {
    return this.reported.has(address)
  }

  /** The one live terminal whose foreground is that pid. Two terminals naming one pid leave no certain terminal, and a
   *  wrong one would take that session's words (docs/plans/2026-11-17-dial-recap-after-restart-design.md, Addendum). */
  terminalOf(pid: number): string | undefined {
    let found: string | undefined
    for (const [address, foreground] of this.foregrounds) {
      if (foreground !== pid) continue
      if (found !== undefined) return undefined
      found = address
    }
    return found
  }

  /** The terminal of a listed agent, for the dial's scroll: an agent only hc lists has no other pane to name. */
  paneOf(agentId: string): string | undefined {
    return this.find(agentId)?.address
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

  /** One attempt: one subscription. A closed one tells nothing (hcClient.ts), so only the current one is heard. */
  private open(): void {
    let listed = false
    // A subscription tells its own count as it changes, from none.
    this.unkept = 0
    this.subscription = this.deps.client.subscribe({
      snapshot: (terminals) => {
        listed = true
        this.attempts.started()
        // Before the rows, whose change a listener may answer with a stop.
        this.attempts.listed()
        this.snapshot(terminals)
      },
      changed: (terminal) => this.changed(terminal),
      closed: (reason) => this.closed(listed, reason),
      over: (count) => {
        this.unkept = count
        this.counted()
      },
    })
  }

  /** A core that answered no snapshot of the generation this speaks says why in a `list ·` line; every other end is
   *  `closed ·`. */
  private closed(listed: boolean, reason: SocketFault): void {
    this.subscription = undefined
    this.attempts.failed(!listed && (reason === 'rejected' || reason === 'bad_answer') ? 'list' : 'closed', reason)
  }

  private close(): void {
    this.subscription?.close()
    this.subscription = undefined
  }

  private clear(): void {
    // The next list is said again, even with as many agents as before.
    this.said = undefined
    this.over = 0
    this.unkept = 0
    const held = this.rows.size > 0 || this.foregrounds.size > 0
    this.shown.clear()
    this.reported.clear()
    this.foregrounds.clear()
    this.rows.clear()
    if (held) this.emit()
  }

  /** hc's whole list: a row that stays listable with the same kind keeps its id and its place. */
  private snapshot(terminals: readonly HcTerminal[]): void {
    const before = JSON.stringify(this.list())
    const foregrounds = new Map(this.foregrounds)
    this.shown.clear()
    this.reported.clear()
    this.foregrounds.clear()
    for (const terminal of terminals) this.note(terminal)
    const fresh = new Map(terminals.filter(listable).map((terminal) => [terminal.address, terminal]))
    for (const [address, row] of this.rows) if (fresh.get(address)?.kind !== row.agent.engine) this.rows.delete(address)
    for (const terminal of fresh.values()) this.take(terminal, true)
    const moved = foregrounds.size !== this.foregrounds.size
      || [...foregrounds].some(([address, pid]) => this.foregrounds.get(address) !== pid)
    this.told(before, moved)
  }

  private changed(terminal: HcTerminal): void {
    const before = JSON.stringify(this.list())
    const pid = this.foregrounds.get(terminal.address)
    this.note(terminal)
    if (listable(terminal)) this.take(terminal, false)
    else this.rows.delete(terminal.address)
    this.told(before, this.foregrounds.get(terminal.address) !== pid)
  }

  /** Notes whether the window shows a terminal and in which tab, whether hc reports an agent there, and the pid it runs
   *  now. */
  private note(terminal: HcTerminal): void {
    const { address } = terminal
    if (inWindow(terminal)) this.shown.set(address, terminal.tab)
    else this.shown.delete(address)
    if (reporting(terminal)) this.reported.add(address)
    else this.reported.delete(address)
    if (terminal.live && terminal.foregroundPid !== undefined) this.foregrounds.set(address, terminal.foregroundPid)
    else this.foregrounds.delete(address)
  }

  /** Sets a terminal's row. Another kind at its address is another agent, whose first status ends no turn of the one
   *  before: a new row. `snapshot` is hc's whole list, after a time nothing of the terminal was heard. */
  private take(terminal: Listable, snapshot: boolean): void {
    const { address, kind } = terminal
    let row = this.rows.get(address)
    if (row?.agent.engine !== kind) {
      this.rows.delete(address)
      row = {
        address,
        agent: {
          id: this.deps.uuid(), engine: kind, name: kind, host: 'herdr', app: 'herdr', state: 'idle', unseenDone: false,
          lastActivityAt: this.deps.now(), paneKeys: [hcPaneKey(address)],
        },
      }
      this.rows.set(address, row)
    }
    const cwd = terminal.cwd ? terminal.cwd.slice(0, MAX_CWD) : undefined
    row.agent.cwd = cwd
    row.agent.name = shown(terminal.name) || shown(cwd && basename(cwd)) || kind
    this.status(row, terminal.status, terminal.turn, snapshot)
  }

  /** The counts said when they change, and one onChange when anything a listed row shows changed, or a terminal's
   *  foreground pid did (`moved`): the devices pair a session with its terminal by it, listed or not. */
  private told(before: string, moved: boolean): void {
    this.counted()
    if (moved || JSON.stringify(this.list()) !== before) this.emit()
  }

  /** The listed agents, and those left out: past the dial's 64, and the terminals past the client's own bound, which
   *  may hold agents too. */
  private counted(): void {
    const count = Math.min(this.rows.size, MAX_AGENTS)
    if (count !== this.said) {
      this.said = count
      this.deps.log(`[herdr-app] listed · ${count} agents`)
    }
    const over = this.rows.size - count + this.unkept
    if (over !== this.over) {
      this.over = over
      if (over > 0) this.deps.log(`[herdr-app] over · ${over} left out`)
    }
  }

  /** Sets a row's state from hc's status and the one before it, and in a snapshot from hc's turn. */
  private status(row: Row, next: HcStatus, turn: number | undefined, snapshot: boolean): void {
    const before = row.status
    // A turn that ran while nothing was heard (a reconnect, or hc's `missed`) may end on the word it started from: only
    // hc's count of turns, which went up, says so. Live, each status line is heard and ends its own turn; the turn line
    // after it, which may follow a new agent's first status, ends none.
    const ended = snapshot && turn !== undefined && row.turn !== undefined && turn > row.turn
    const { state: was, unseenDone: unseen } = row.agent
    row.status = next
    row.turn = turn
    // An agent may report idle, not done, as its turn ends: the turn is done all the same, with nothing unseen.
    const state = next !== 'idle' ? STATES[next]
      : ended || before === 'working' || before === 'blocked' ? 'done' : before === 'idle' ? was : 'idle'
    row.agent.state = state
    row.agent.unseenDone = next === 'done' && (before !== 'done' || ended || unseen)
    if (state !== was || ended) row.agent.lastActivityAt = this.deps.now()
  }
}
