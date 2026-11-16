/**
 * herdr's agents on the dial, hook or no hook (docs/specs/2026-11-16-device-herdr.md): listed and followed over herdr's
 * socket while a dial is attached, pushed and never polled.
 *
 * The list follows the subscription, never the other way round: once a subscription has started every change is told
 * on it, so one made while `agent.list` is in flight still arrives, and wins over that list, which herdr may have made
 * before it. herdr tells a pane's status only to a subscription that names that pane, so a pane the list brings asks for
 * a new subscription that names it, at most one a second.
 *
 * A pane asks once. herdr replays a detection of each of its agents on every new subscription, and the list leaves out an
 * agent it cannot read (a status a newer herdr adds, or one past 64): asked again for such a pane, each subscription
 * would ask for the next, one a second for ever.
 *
 * The wait on herdr's socket, its retries and its stale rule are socketAttempts.ts's.
 *
 * Everything from the socket is checked here before use, and a log line says only fixed words and counts: herdr's
 * answers name people's folders and agents.
 */
import { basename } from 'node:path'
import {
  HERDR_KIND, HERDR_PANE, herdrPaneKey,
  type HerdrAnswer, type HerdrClient, type HerdrEntry, type HerdrFault, type HerdrPrompt, type HerdrSubscriber,
} from './herdrClient.js'
import { CONTROL, MAX_TEXT } from './orca.js'
import { SocketAttempts } from './socketAttempts.js'
import type { Caps, HostAgent, HostAgentState, HostSource, SendResult } from './types.js'

/** The most agents listed, and the most panes one subscription names. */
export const MAX_AGENTS = 64
const MAX_NAME = 64
export const MAX_CWD = 4096
/** The least time between two subscriptions' starts. */
const SUBSCRIBE_EVERY_MS = 1000
/** A session id as herdr's own integrations report one; anything else is not taken for one. */
const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/
const KINDS: readonly HerdrEntry[] = [{ type: 'pane.agent_detected' }, { type: 'pane.closed' }, { type: 'pane.exited' }]

type HerdrStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'
const STATES: Record<HerdrStatus, HostAgentState> = { idle: 'idle', working: 'working', blocked: 'needs-you', done: 'done', unknown: 'idle' }
const isStatus = (value: unknown): value is HerdrStatus => typeof value === 'string' && Object.hasOwn(STATES, value)

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A name to show: its control characters removed, cut to 64 characters, never half of one. */
export const shown = (value: unknown): string => typeof value === 'string' ? [...value.replace(CONTROL, '')].slice(0, MAX_NAME).join('') : ''

/** herdr's session id of the agent: only an id, of the pane's own agent, in its form. */
const sessionOf = (session: unknown, kind: string): string | undefined =>
  isObject(session) && session.kind === 'id' && session.agent === kind && typeof session.value === 'string'
    && SESSION_ID.test(session.value) ? session.value : undefined

export interface HerdrSourceDeps {
  client: Pick<HerdrClient, 'request' | 'subscribe' | 'socketStamp'>
  /** Tells of each change where herdr's socket lives (unixSocket.ts watchSocket), until its stop is called. */
  watch(changed: () => void): () => void
  /** The dial's words: the herdr adapter's prompt, which keeps the pane's turn with a tap (herdr.ts). */
  prompt(paneId: string, kind: string, text: string): Promise<HerdrPrompt>
  /** A tap: the herdr adapter's focus, as the devices hold it. */
  focus(paneId: string): Promise<boolean>
  /** A timer, as the devices' parts take theirs: its cancel is returned. */
  after(ms: number, run: () => void): () => void
  /** The wall clock, for `lastActivityAt`; and a clock that never steps back, for how long a subscription lived. */
  now(): number
  monotonic(): number
  uuid(): string
  platform: NodeJS.Platform
  log(line: string): void
  count(what: 'herdr' | 'busy' | 'waiting' | 'too-long' | 'no-answer'): void
}

/** A listed agent, its pane, and herdr's last status of it: a turn that ends `idle` reads the one before. */
interface Row {
  pane: string
  status?: HerdrStatus
  agent: HostAgent
}

interface Subscription {
  /** The panes whose status it hears. */
  panes: ReadonlySet<string>
  handle: { close(): void }
}

/** What a subscription told between its start and the read of its list, which herdr may have made before: 64 each. */
interface Heard {
  /** The last status of each pane, by `<pane>/<kind>`. */
  statuses: Map<string, HerdrStatus>
  dropped: Set<string>
}

export class HerdrSource implements HostSource {
  readonly id = 'herdr'
  private readonly listeners = new Set<() => void>()
  private rows = new Map<string, Row>()
  /** Each pane and kind that asked for a subscription naming it, by `<pane>/<kind>`, until it is listed or leaves. */
  private readonly asked = new Map<string, string>()
  private running = false
  /** The newest subscription that started: its events are heard. */
  private current: Subscription | undefined
  /** One opened that has not started yet; the current one is heard until it has. */
  private next: Subscription | undefined
  /** While the current one's list is in flight. */
  private heard: Heard | undefined
  /** The next subscription's timer. */
  private timer: (() => void) | undefined
  private openedAt: number | undefined
  private said: number | undefined
  private readonly attempts = new SocketAttempts({
    name: 'herdr',
    socketStamp: () => this.deps.client.socketStamp(),
    watch: (changed) => this.deps.watch(changed),
    after: (ms, run) => this.deps.after(ms, run),
    now: () => this.deps.now(),
    monotonic: () => this.deps.monotonic(),
    log: (line) => this.deps.log(line),
    open: () => this.soon(),
    close: () => this.close(),
    clear: () => this.clear(),
  })

  constructor(private readonly deps: HerdrSourceDeps) {}

  start(): void {
    // herdr's socket there is a named pipe, which the client does not speak.
    if (this.deps.platform === 'win32' || this.running) return
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
    return [...this.rows.values()].map(({ agent }) => ({ ...agent }))
  }

  /** Status, words and a tap; an agent blocked in herdr is answered there. */
  capabilities(): Caps {
    return { status: true, voice: true, focus: true, answer: false }
  }

  markSeen(agentId: string): void {
    const row = this.find(agentId)
    if (!row?.agent.unseenDone) return
    row.agent.unseenDone = false
    this.emit()
  }

  /** The dial's words, as the observed source says them. Its own state refuses first; the client reads the pane again
   *  before it types (herdrClient.ts). */
  async send(agent: HostAgent, text: string): Promise<SendResult> {
    const row = this.find(agent.id)
    const name = (row?.agent ?? agent).name
    const refuse = (what: 'busy' | 'waiting' | 'too-long' | 'no-answer', reason: string): SendResult => {
      this.deps.count(what)
      return { ok: false, reason }
    }
    const busy = `${name} is busy. Say it when it is done.`
    if (text.length > MAX_TEXT) return refuse('too-long', 'Too long. Say it shorter.')
    if (!row) return refuse('no-answer', `${name} did not answer.`)
    if (row.agent.state === 'needs-you') return refuse('waiting', `${name} is waiting for your answer in herdr.`)
    // herdr's own status, not the dial's: a turn that ended idle shows done, and is at its prompt.
    if (row.status === 'working' || row.status === 'unknown') return refuse('busy', busy)
    // Words already under way to the pane are the adapter's busy (herdr.ts), which holds the pane's turn with a tap.
    const answer = await this.deps.prompt(row.pane, row.agent.engine, text)
    if (answer.outcome === 'sent') {
      this.deps.count('herdr')
      return { ok: true }
    }
    return answer.outcome === 'busy' ? refuse('busy', busy) : refuse('no-answer', `${name} did not answer.`)
  }

  async focus(agent: HostAgent): Promise<boolean> {
    const row = this.find(agent.id)
    return row ? this.deps.focus(row.pane) : false
  }

  private find(agentId: string): Row | undefined {
    return [...this.rows.values()].find(({ agent }) => agent.id === agentId)
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }

  /** A new subscription, now or once a second has passed since the last one opened: one timer, which every ask joins.
   *  One still opening joins too: the list that follows its start asks for each listed pane it does not name. */
  private soon(): void {
    if (this.timer || this.next) return
    const wait = this.openedAt === undefined ? 0 : this.openedAt + SUBSCRIBE_EVERY_MS - this.deps.monotonic()
    if (wait <= 0) return this.open()
    this.timer = this.deps.after(wait, () => {
      this.timer = undefined
      this.open()
    })
  }

  private open(): void {
    const panes = [...new Set([...this.rows.keys(), ...this.asked.values()])].slice(0, MAX_AGENTS)
    // Only the one opening starts, and only the current one tells events: every other one is closed, and a closed one
    // tells nothing (herdrClient.ts).
    const to: HerdrSubscriber = {
      started: () => this.started(sub),
      event: (name, data) => this.event(name, data),
      closed: (reason) => this.closed(sub, reason),
    }
    const entries = [...KINDS, ...panes.map((pane_id) => ({ type: 'pane.agent_status_changed' as const, pane_id }))]
    this.openedAt = this.deps.monotonic()
    const sub: Subscription = { panes: new Set(panes), handle: this.deps.client.subscribe(entries, to) }
    this.next = sub
  }

  private started(sub: Subscription): void {
    this.next = undefined
    // The new one hears every change from here on, so the old one goes only now.
    this.current?.handle.close()
    this.current = sub
    this.attempts.started()
    this.heard = { statuses: new Map(), dropped: new Set() }
    void this.deps.client.request('agent.list', {}).then((answer) => this.listed(sub, answer))
  }

  private listed(sub: Subscription, answer: HerdrAnswer): void {
    // Stopped, failed or replaced meanwhile: the newer subscription's own list says it.
    if (sub !== this.current) return
    const heard = this.heard
    this.heard = undefined
    const agents = answer.ok ? answer.result.agents : undefined
    if (!Array.isArray(agents)) {
      // herdr's own code is not said: a log line says only fixed words.
      return this.attempts.failed('list', answer.ok ? 'bad_answer' : answer.fault)
    }
    this.read(agents, heard)
    this.attempts.listed()
    if ([...this.rows.keys()].some((pane) => !sub.panes.has(pane))) this.soon()
  }

  private closed(sub: Subscription, reason: HerdrFault): void {
    // An old one that ends while the new one opens missed nothing the new one's list will not say.
    if (sub !== (this.next ?? this.current)) return
    this.attempts.failed('closed', reason)
  }

  private close(): void {
    this.current?.handle.close()
    this.next?.handle.close()
    this.current = undefined
    this.next = undefined
    this.heard = undefined
    this.timer?.()
    this.timer = undefined
  }

  private clear(): void {
    this.asked.clear()
    // The next list is said again, even with as many agents as before.
    this.said = undefined
    if (this.rows.size === 0) return
    this.rows.clear()
    this.emit()
  }

  private event(name: string, data: Record<string, unknown>): void {
    const pane = data.pane_id
    if (typeof pane !== 'string' || !HERDR_PANE.test(pane)) return
    if (name === 'pane_closed' || name === 'pane_exited' || (name === 'pane_agent_detected' && data.released === true)) {
      return this.drop(pane)
    }
    const kind = data.agent
    if (typeof kind !== 'string' || !HERDR_KIND.test(kind)) return
    const row = this.rows.get(pane)
    const key = `${pane}/${kind}`
    if (name === 'pane.agent_status_changed') {
      const status = data.agent_status
      if (!isStatus(status)) return
      const statuses = this.heard?.statuses
      if (statuses && (statuses.has(key) || statuses.size < MAX_AGENTS)) statuses.set(key, status)
      if (row?.agent.engine === kind && this.status(row, status)) this.emit()
      return
    }
    if (name !== 'pane_agent_detected' || row?.agent.engine === kind) return
    if (this.asked.has(key) || this.rows.size >= MAX_AGENTS || this.asked.size >= MAX_AGENTS) return
    this.asked.set(key, pane)
    this.soon()
  }

  /** A pane that left. Pane ids are never reused, so it needs no new subscription; its asks go with it. */
  private drop(pane: string): void {
    const dropped = this.heard?.dropped
    if (dropped && dropped.size < MAX_AGENTS) dropped.add(pane)
    for (const [key, of] of this.asked) if (of === pane) this.asked.delete(key)
    if (this.rows.delete(pane)) this.emit()
  }

  /** Sets the list from `agent.list`'s agents, each checked: a pane listed again with the same kind keeps its id. What
   *  the subscription told meanwhile is newer than the list: a pane it dropped is left out, and its status wins. */
  private read(entries: unknown[], heard: Heard | undefined): void {
    const before = JSON.stringify(this.list())
    const rows = new Map<string, Row>()
    let over = 0
    for (const entry of entries) {
      if (!isObject(entry)) continue
      const { pane_id: pane, agent: kind, agent_status: status } = entry
      if (typeof pane !== 'string' || !HERDR_PANE.test(pane) || typeof kind !== 'string' || !HERDR_KIND.test(kind)
        || !isStatus(status) || rows.has(pane) || heard?.dropped.has(pane)) continue
      if (rows.size === MAX_AGENTS) {
        over++
        continue
      }
      const known = this.rows.get(pane)
      const row: Row = known?.agent.engine === kind ? known : {
        pane,
        agent: {
          id: this.deps.uuid(), engine: kind, name: kind, host: 'herdr', app: 'herdr', state: 'idle', unseenDone: false,
          lastActivityAt: this.deps.now(), paneKeys: [herdrPaneKey(pane)],
        },
      }
      const cwd = typeof entry.cwd === 'string' && entry.cwd ? entry.cwd.slice(0, MAX_CWD) : undefined
      row.agent.cwd = cwd
      // herdr's title is what the agent's terminal says it does, not a name.
      row.agent.name = shown(entry.name) || shown(cwd && basename(cwd)) || kind
      row.agent.sessionId = sessionOf(entry.agent_session, kind)
      this.status(row, heard?.statuses.get(`${pane}/${kind}`) ?? status)
      rows.set(pane, row)
      // Listed, it is named as a row: an ask kept would outlive a pane that closes unheard, and take one of the 64.
      this.asked.delete(`${pane}/${kind}`)
    }
    this.rows = rows
    if (rows.size !== this.said) {
      this.said = rows.size
      this.deps.log(`[herdr] listed · ${rows.size} agents`)
    }
    if (over) this.deps.log(`[herdr] over · ${over} left out`)
    if (JSON.stringify(this.list()) !== before) this.emit()
  }

  /** Sets a row's state from herdr's status and the one before it; true when what the row shows changed. */
  private status(row: Row, next: HerdrStatus): boolean {
    const before = row.status
    const { state: was, unseenDone: unseen } = row.agent
    row.status = next
    // herdr says idle, not done, when a turn ends in the pane it has focused: the turn is done all the same, and seen.
    const state = next !== 'idle' ? STATES[next] : before === 'working' || before === 'blocked' ? 'done' : before === 'idle' ? was : 'idle'
    row.agent.state = state
    row.agent.unseenDone = next === 'done' && (before !== 'done' || unseen)
    if (state !== was) row.agent.lastActivityAt = this.deps.now()
    return state !== was || row.agent.unseenDone !== unseen
  }
}
