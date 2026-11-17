/**
 * opencode's sessions on the dial (docs/plans/2026-11-17-dial-opencode-design.md): listed and followed over opencode's
 * local server while a dial is attached, pushed and never polled.
 *
 * The list follows the event stream, never the other way round: the stream is live before the list is asked, so a change
 * made while the list is in flight is still heard, and wins over that list, which opencode may have made before it.
 *
 * A session at rest is first listed with its last answer. The dial reads a tile's history once, as the tile appears, so
 * an answer set later would never reach it; and the devices tell a summary card when a done row's answer changes, which
 * a session only being listed must not.
 *
 * The retries end. An opencode that crashed leaves its service.json, with nothing listening behind it at every plug-in:
 * after the last wait only the watch is left, and the next opencode's new file starts again at once. The waits are
 * socketAttempts.ts's.
 *
 * Everything from the server is checked here before use, and a log line says only fixed words and counts: opencode's
 * answers name people's folders and sessions.
 */
import { basename } from 'node:path'
import {
  OPENCODE_PERMISSION, OPENCODE_SESSION,
  type OpencodeAnswer, type OpencodeClient, type OpencodeEvent, type OpencodeFault,
} from './opencodeClient.js'
import { MAX_CWD, shown } from './herdrSource.js'
import { MAX_TEXT } from './orca.js'
import { LIVE_MS, RETRIES_S } from './socketAttempts.js'
import type { Caps, HostAgent, HostAgentState, HostSource, SendResult } from './types.js'

/** The most sessions listed, of the most read. */
export const MAX_SESSIONS = 16
export const LIST_LIMIT = 50
/** A session at rest this long since its last change is left out. */
export const RECENT_MS = 24 * 3600_000
/** The least time between two lists' starts. */
const LIST_EVERY_MS = 1000
/** The dial's card is small; the observed source keeps as much. */
const ANSWER_CHARS = 300
/** The pending permissions kept a session. */
const MAX_WAITS = 16
/** Unlisted sessions whose turn asked for a list; unlisted sessions, and events of each session, heard while a list is
 *  in flight. */
const MAX_HEARD = 64
const LIST_PATH = `/api/session?parentID=null&archived=false&order=desc&limit=${LIST_LIMIT}`
/** A service that is not this user's opencode 2.x: nothing more is sent to it. */
const REFUSED: ReadonlySet<OpencodeFault> = new Set(['not_local', 'not_ours', 'old_version', 'unauthorized'])

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const dataOf = (answer: OpencodeAnswer): unknown => answer.ok && isObject(answer.json) ? answer.json.data : undefined
const statusOf = (data: Record<string, unknown>): unknown => isObject(data.status) ? data.status.type : undefined

/** A turn under way: its start, or opencode's status busy or retrying. */
const begins = ({ type, data }: OpencodeEvent): boolean =>
  type === 'session.execution.started' || (type === 'session.status' && (statusOf(data) === 'busy' || statusOf(data) === 'retry'))
/** opencode at rest again. */
const rests = ({ type, data }: OpencodeEvent): boolean =>
  type === 'session.idle' || (type === 'session.status' && statusOf(data) === 'idle')

const nameOf = (title: string | undefined, cwd: string | undefined): string =>
  shown(title) || shown(cwd && basename(cwd)) || 'opencode'

export interface OpencodeSourceDeps {
  client: OpencodeClient
  /** Tells of each change where service.json lives, until its stop is called. */
  watch(changed: () => void): () => void
  /** A timer, as the devices' parts take theirs: its cancel is returned. */
  after(ms: number, run: () => void): () => void
  /** The wall clock, for the 24 hours and `lastActivityAt`; and a clock that never steps back, for how long a stream
   *  lived and the second between two lists. */
  now(): number
  monotonic(): number
  uuid(): string
  /** A message id for one dial command (opencodeClient.ts opencodeMessageId). */
  messageId(): string
  log(line: string): void
  count(what: 'opencode' | 'busy' | 'waiting' | 'too-long' | 'no-answer'): void
}

/** A listed session: what the dial is told, and opencode's own turn under it. */
interface Row {
  agent: HostAgent & { sessionId: string }
  turn: 'idle' | 'working' | 'done' | 'error'
  /** Its pending permissions: needs-you while it has any. */
  waits: Set<string>
  /** Turns started, so an answer read before the newest one is not taken for it. */
  turns: number
  reading: boolean
  /** A turn ended while its answer was being read: read once more after it. */
  readAgain: boolean
  /** opencode's `time.idle` in the last list, and whether a turn's end was heard since: a later one with none heard is
   *  a turn that ended while no stream was there. */
  idle?: number
  endHeard: boolean
}

/** A list entry, every field checked. */
interface Entry {
  id: string
  title?: string
  directory?: string
  updated: number
  idle?: number
  viewed?: number
  running: boolean
}

/** A kept entry and what was read for it: a running session's pending permissions, a session at rest's last answer. */
interface Listed {
  entry: Entry
  waits?: Set<string>
  answer?: string
}

/** What the stream told while a list was in flight, which opencode may have made before. */
interface Heard {
  /** Each session's events in order, the last 64; a listed session's too, which marks it as told. */
  events: Map<string, OpencodeEvent[]>
  /** The sessions not listed among them. */
  unlisted: number
  dropped: Set<string>
}

function entryOf(value: unknown, running: Record<string, unknown>): Entry | undefined {
  if (!isObject(value) || !isObject(value.time)) return undefined
  const { id, parentID, title, location } = value
  const { updated, idle, viewed } = value.time
  const directory = isObject(location) ? location.directory : undefined
  // A root has no parentID, or a null one: the list asks for roots alone.
  const root = parentID === undefined || parentID === null
  if (typeof id !== 'string' || !OPENCODE_SESSION.test(id) || !root || !finite(updated)) return undefined
  if ((idle !== undefined && !finite(idle)) || (viewed !== undefined && !finite(viewed))) return undefined
  if ((title !== undefined && typeof title !== 'string') || (directory !== undefined && typeof directory !== 'string')) return undefined
  return { id, title, directory, updated, idle, viewed, running: Object.hasOwn(running, id) }
}

/** A session at rest: a turn the person has not seen in opencode is done, else it is idle. */
const restOf = ({ idle, viewed }: Entry): 'done' | 'idle' => idle !== undefined && (viewed === undefined || idle > viewed) ? 'done' : 'idle'

const stateOf = (row: Row): HostAgentState => row.waits.size > 0 ? 'needs-you' : row.turn
/** A turn the dial last saw under way. */
const ended = (row: Row): boolean => row.turn === 'working' || row.waits.size > 0
/** A shown session's turn that ended with no stream to hear it: one the dial last saw under way, or one whose
 *  `time.idle` is newer than the last list's with no end heard since. */
const unheard = (row: Row, { idle }: Entry): boolean =>
  ended(row) || (!row.endHeard && idle !== undefined && (row.idle === undefined || idle > row.idle))

export class OpencodeSource implements HostSource {
  readonly id = 'opencode'
  private readonly listeners = new Set<() => void>()
  /** By opencode's session id, newest first. */
  private rows = new Map<string, Row>()
  private running = false
  private unwatch: (() => void) | undefined
  /** The registration in hand, none without one. */
  private stamp: string | undefined
  /** Moves at every close: an answer to anything asked before it is dropped. */
  private epoch = 0
  private stream: { close(): void } | undefined
  private retryTimer: (() => void) | undefined
  private retries = 0
  /** Since when a list landed, with no failure since. */
  private liveSince: number | undefined
  /** The refusal said, until the registration changes. */
  private refusal: OpencodeFault | undefined
  private listTimer: (() => void) | undefined
  /** When the last list started; kept across a stop, so a dial plugged in again keeps to the second. */
  private listedAt: number | undefined
  /** While a list is in flight. */
  private heard: Heard | undefined
  /** Asked while a list was in flight: one more after it. */
  private again = false
  /** Sessions not listed whose turn's start asked for a list. */
  private readonly asked = new Set<string>()
  private said: number | undefined
  private saidOver: number | undefined
  /** Sessions with words under way. */
  private readonly sending = new Set<string>()

  constructor(private readonly deps: OpencodeSourceDeps) {}

  start(): void {
    if (this.running) return
    this.running = true
    // Held from start to stop, live or not: a new service.json starts again at once.
    this.unwatch = this.deps.watch(() => this.changed())
    this.look(this.deps.client.registration())
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.unwatch?.()
    this.unwatch = undefined
    this.reset()
    this.stamp = undefined
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  list(): HostAgent[] {
    return [...this.rows.values()].map(({ agent }) => ({ ...agent }))
  }

  /** Status and words. opencode has no way to bring a session forward, and a permission is answered there. */
  capabilities(): Caps {
    return { status: true, voice: true, focus: false, answer: false }
  }

  /** Turning the dial writes nothing to opencode. */
  markSeen(agentId: string): void {
    const row = this.find(agentId)
    if (!row?.agent.unseenDone) return
    row.agent.unseenDone = false
    this.emit()
  }

  /** The dial's words, as the observed source says them. Its own state refuses first; the client reads the session again
   *  right before it posts (opencodeClient.ts). */
  async send(agent: HostAgent, text: string): Promise<SendResult> {
    const row = this.find(agent.id)
    const name = (row?.agent ?? agent).name
    const refuse = (what: 'busy' | 'waiting' | 'too-long' | 'no-answer', reason: string): SendResult => {
      this.deps.count(what)
      return { ok: false, reason }
    }
    const busy = `${name} is busy. Say it when it is done.`
    const waiting = `${name} is waiting for your answer in opencode.`
    const silent = `${name} did not answer.`
    if (text.length > MAX_TEXT) return refuse('too-long', 'Too long. Say it shorter.')
    if (!row) return refuse('no-answer', silent)
    if (row.agent.state === 'needs-you') return refuse('waiting', waiting)
    const session = row.agent.sessionId
    if (row.agent.state === 'working' || this.sending.has(session)) return refuse('busy', busy)
    this.sending.add(session)
    const outcome = await this.deps.client.prompt(session, text, this.deps.messageId())
    this.sending.delete(session)
    if (outcome === 'sent') {
      this.deps.count('opencode')
      return { ok: true }
    }
    if (outcome === 'busy') return refuse('busy', busy)
    return outcome === 'waiting' ? refuse('waiting', waiting) : refuse('no-answer', silent)
  }

  private find(agentId: string): Row | undefined {
    return [...this.rows.values()].find(({ agent }) => agent.id === agentId)
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }

  /** A change where service.json lives. The same registration is the same service, and nothing connects. */
  private changed(): void {
    const found = this.deps.client.registration()
    if ('stamp' in found && found.stamp === this.stamp) return
    this.look(found)
  }

  /** Another registration than the one in hand starts afresh; the one in hand is tried again. */
  private look(found: ReturnType<OpencodeClient['registration']>): void {
    const stamp = 'stamp' in found ? found.stamp : undefined
    // Another opencode may have changed or deleted any session, and a row kept would be another's.
    if (stamp !== this.stamp) this.reset()
    this.stamp = stamp
    if ('fault' in found) return this.refuse(found.fault)
    const epoch = this.epoch
    void this.deps.client.find().then((service) => {
      if (epoch !== this.epoch) return
      if ('stamp' in service) {
        this.stream = this.deps.client.events((event) => this.event(event), (reason) => this.failed('closed', reason))
      } else if (service.fault === 'no_service' || REFUSED.has(service.fault)) this.refuse(service.fault)
      else this.failed('closed', service.fault)
    })
  }

  /** No service to follow: nothing listed, no timer, only the watch. A refusal is said once, until the registration
   *  changes. */
  private refuse(fault: OpencodeFault): void {
    this.close()
    this.clear()
    if (fault === 'no_service') {
      // None in hand: the next file is looked at, the same one written again among them.
      this.stamp = undefined
      this.refusal = undefined
    } else if (fault !== this.refusal) {
      this.refusal = fault
      this.deps.log(`[opencode] service · ${fault}`)
    }
  }

  /** The attempt failed: it ends, and the retries run. */
  private failed(said: 'closed' | 'list', fault: OpencodeFault | 'ended'): void {
    this.deps.log(`[opencode] ${said} · ${fault}`)
    const since = this.liveSince
    this.liveSince = undefined
    this.close()
    // A drop keeps its rows for the retry; a retry that fails empties the list.
    if (since === undefined) this.clear()
    // Only a service followed for a while is retried from the first wait: one that drops each stream soon after it lists
    // goes on to the longer waits.
    else if (this.deps.monotonic() - since >= LIVE_MS) this.retries = 0
    const last = this.retries === RETRIES_S.length
    // Only an attempt that listed nothing gives up: a service that lists is running, and keeps the longest wait.
    if (last && since === undefined) return
    if (!last) this.retries++
    const seconds = RETRIES_S[this.retries - 1]
    this.deps.log(`[opencode] retry · ${seconds}`)
    this.retryTimer = this.deps.after(seconds * 1000, () => {
      this.retryTimer = undefined
      this.look(this.deps.client.registration())
    })
  }

  /** Everything of the service in hand goes: its attempt, its rows, its retries and its refusal. */
  private reset(): void {
    this.close()
    this.clear()
    this.retries = 0
    this.liveSince = undefined
    this.refusal = undefined
  }

  /** Ends the attempt under way: its stream, its timers and its list in flight. */
  private close(): void {
    this.epoch++
    this.stream?.close()
    this.stream = undefined
    this.retryTimer?.()
    this.retryTimer = undefined
    this.listTimer?.()
    this.listTimer = undefined
    this.heard = undefined
    this.again = false
  }

  private clear(): void {
    this.asked.clear()
    // The next list is said again, even with as many sessions as before.
    this.said = undefined
    this.saidOver = undefined
    if (this.rows.size === 0) return
    this.rows = new Map()
    this.emit()
  }

  /** A list now, or once a second has passed since the last one started: one timer, which every ask joins. An ask while
   *  one is in flight is one more after it. */
  private ask(): void {
    if (this.heard) {
      this.again = true
      return
    }
    if (this.listTimer) return
    const wait = this.listedAt === undefined ? 0 : this.listedAt + LIST_EVERY_MS - this.deps.monotonic()
    if (wait <= 0) return void this.run()
    this.listTimer = this.deps.after(wait, () => {
      this.listTimer = undefined
      void this.run()
    })
  }

  private async run(): Promise<void> {
    const epoch = this.epoch
    const heard: Heard = { events: new Map(), unlisted: 0, dropped: new Set() }
    this.heard = heard
    this.listedAt = this.deps.monotonic()
    const sessions = await this.deps.client.request('GET', LIST_PATH)
    if (epoch !== this.epoch) return
    const entries = dataOf(sessions)
    if (!Array.isArray(entries)) return this.failed('list', sessions.ok ? 'bad_json' : sessions.fault)
    const active = await this.deps.client.request('GET', '/api/session/active')
    if (epoch !== this.epoch) return
    const running = dataOf(active)
    if (!isObject(running)) return this.failed('list', active.ok ? 'bad_json' : active.fault)

    const kept: Entry[] = []
    const now = this.deps.now()
    for (const value of entries.slice(0, LIST_LIMIT)) {
      const entry = entryOf(value, running)
      if (entry && !kept.some(({ id }) => id === entry.id) && (entry.running || now - entry.updated <= RECENT_MS)) kept.push(entry)
    }
    kept.sort((a, b) => b.updated - a.updated)
    const listed = await Promise.all(kept.slice(0, MAX_SESSIONS).map((entry) => this.read(entry)))
    if (epoch !== this.epoch) return
    this.heard = undefined
    this.land(listed, heard, Math.max(0, kept.length - MAX_SESSIONS))
    this.liveSince ??= this.deps.monotonic()
    if (!this.again) return
    this.again = false
    this.ask()
  }

  /** What an entry needs before it is listed: a running session's pending permissions; the last answer of a session at
   *  rest first listed, or whose turn ended unheard. */
  private async read(entry: Entry): Promise<Listed> {
    const row = this.rows.get(entry.id)
    if (entry.running) return { entry, waits: await this.waits(entry.id) }
    if (!row || unheard(row, entry)) return { entry, answer: await this.answer(entry.id) }
    return { entry }
  }

  private async waits(id: string): Promise<Set<string>> {
    const pending = dataOf(await this.deps.client.request('GET', `/api/session/${id}/permission`))
    const waits = new Set<string>()
    // A read that fails knows of no wait.
    if (!Array.isArray(pending)) return waits
    for (const asked of pending) {
      if (waits.size < MAX_WAITS && isObject(asked) && typeof asked.id === 'string' && OPENCODE_PERMISSION.test(asked.id)) waits.add(asked.id)
    }
    return waits
  }

  /** The last assistant message's text, cut to the card; none when it has none or the read fails. */
  private async answer(id: string): Promise<string | undefined> {
    const messages = dataOf(await this.deps.client.request('GET', `/api/session/${id}/message?type=assistant&order=desc&limit=1`))
    const last = Array.isArray(messages) ? messages.find((each) => isObject(each) && each.type === 'assistant') : undefined
    const texts: string[] = []
    if (isObject(last) && Array.isArray(last.content)) {
      for (const part of last.content) if (isObject(part) && part.type === 'text' && typeof part.text === 'string') texts.push(part.text)
    }
    const text = texts.join('\n\n').trim()
    if (!text) return undefined
    // By code point: a cut through an emoji's surrogate pair leaves a broken character on the card.
    const chars = Array.from(text)
    return chars.length > ANSWER_CHARS ? `${chars.slice(0, ANSWER_CHARS - 1).join('')}…` : text
  }

  /** Sets the list from a run. A session listed again keeps its id. What the stream told meanwhile is newer than the
   *  list: a session it dropped is left out, and a listed one is set from the list, then told again what it said. */
  private land(listed: Listed[], heard: Heard, over: number): void {
    const before = JSON.stringify(this.list())
    const rows = new Map<string, Row>()
    const told: Array<[Row, OpencodeEvent[], boolean]> = []
    const answers: Array<[Row, string]> = []
    for (const { entry, waits, answer } of listed) {
      if (heard.dropped.has(entry.id)) continue
      const events = heard.events.get(entry.id)
      const known = this.rows.get(entry.id)
      const row: Row = known ?? {
        agent: {
          id: this.deps.uuid(), engine: 'opencode', sessionId: entry.id, name: 'opencode', host: 'opencode', app: 'opencode',
          state: 'idle', unseenDone: false, lastActivityAt: entry.updated,
        },
        turn: 'idle', waits: new Set(), turns: 0, reading: false, readAgain: false, endHeard: false,
      }
      row.agent.cwd = entry.directory ? entry.directory.slice(0, MAX_CWD) : undefined
      row.agent.name = nameOf(entry.title, row.agent.cwd)
      row.agent.lastActivityAt = entry.updated
      if (waits) {
        row.turn = 'working'
        row.waits = waits
        row.agent.unseenDone = false
      } else if (!known || unheard(known, entry)) {
        // A reconnect's list leaves a session still at rest as the stream left it.
        row.turn = restOf(entry)
        row.waits = new Set()
        row.agent.unseenDone = row.turn === 'done'
        // An answer read before a turn heard starting is not that turn's. A row already shown takes it once its done
        // is told, as at a turn heard ending: the devices tell a summary card for an answer that follows a done.
        if (answer !== undefined && !events?.some(begins)) {
          if (known) answers.push([row, answer])
          else row.agent.lastAnswer = answer
        }
      }
      row.idle = entry.idle
      // An end heard while the list was in flight may be newer than it: told again below, it counts as heard since.
      row.endHeard = false
      row.agent.state = stateOf(row)
      rows.set(entry.id, row)
      // Listed, it asks again if it leaves and a turn starts in it.
      this.asked.delete(entry.id)
      if (events) told.push([row, events, known !== undefined])
    }
    this.rows = rows
    for (const [row, events, again] of told) for (const event of events) this.apply(row, event, again)
    if (rows.size !== this.said) {
      this.said = rows.size
      this.deps.log(`[opencode] listed · ${rows.size} sessions`)
    }
    if (over !== this.saidOver) {
      this.saidOver = over
      if (over) this.deps.log(`[opencode] over · ${over} left out`)
    }
    if (JSON.stringify(this.list()) !== before) this.emit()
    const later = answers.filter(([row, answer]) => answer !== row.agent.lastAnswer)
    for (const [row, answer] of later) row.agent.lastAnswer = answer
    if (later.length > 0) this.emit()
  }

  private event(event: OpencodeEvent): void {
    const { type, data } = event
    if (type === 'server.connected') return this.ask()
    const id = data.sessionID
    if (typeof id !== 'string' || !OPENCODE_SESSION.test(id)) return
    // The list itself keeps only root sessions.
    if (type === 'session.created' || type === 'session.unarchived') return this.ask()
    const row = this.rows.get(id)
    if (type === 'session.deleted' || type === 'session.archived') {
      const dropped = this.heard?.dropped
      if (dropped && dropped.size < MAX_HEARD) dropped.add(id)
      this.asked.delete(id)
      if (row && this.rows.delete(id)) this.emit()
      return
    }
    this.hear(id, event)
    if (row) {
      if (this.apply(row, event)) this.emit()
      return
    }
    // A turn starting in a session not listed, one resumed after 24 hours, asks for a list once while it stays unlisted:
    // a sub-agent's child session, which is never listed, costs one list and no more.
    if (!begins(event) || this.asked.has(id)) return
    this.asked.add(id)
    if (this.asked.size > MAX_HEARD) this.asked.delete(this.asked.values().next().value!)
    this.ask()
  }

  /** Keeps what the stream tells of a session while a list is in flight. */
  private hear(id: string, event: OpencodeEvent): void {
    const heard = this.heard
    if (!heard) return
    const events = heard.events.get(id)
    if (!events) {
      // A listed session's are always kept, or the list would set it back: 16 sessions at most. Others' are kept for 64.
      if (!this.rows.has(id)) {
        if (heard.unlisted === MAX_HEARD) return
        heard.unlisted++
      }
      heard.events.set(id, [event])
      return
    }
    events.push(event)
    if (events.length > MAX_HEARD) events.shift()
  }

  /** Sets a listed row from one event; true when what the row shows changed. An event told `again`, to a row a list set
   *  back, sets its state alone: its turn was counted, and its answer read, when it was first heard. */
  private apply(row: Row, event: OpencodeEvent, again = false): boolean {
    const { type, data } = event
    const before = JSON.stringify(row.agent)
    const was = row.agent.state
    if (type === 'session.renamed') {
      if (typeof data.title === 'string') row.agent.name = nameOf(data.title, row.agent.cwd)
    } else if (begins(event)) {
      row.turn = 'working'
      if (!again) row.turns++
      row.agent.unseenDone = false
    } else if (type === 'permission.asked') {
      if (typeof data.id === 'string' && OPENCODE_PERMISSION.test(data.id) && row.waits.size < MAX_WAITS) row.waits.add(data.id)
    } else if (type === 'permission.replied') {
      if (typeof data.requestID === 'string') row.waits.delete(data.requestID)
    } else if (type === 'session.execution.failed') {
      this.end(row, 'error', again)
    } else if (type === 'session.execution.succeeded' || type === 'session.execution.interrupted'
      // opencode's idle ends only a turn under way: an error stays one.
      || (rests(event) && (was === 'working' || was === 'needs-you'))) {
      this.end(row, 'done', again)
    }
    row.agent.state = stateOf(row)
    if (row.agent.state !== was) row.agent.lastActivityAt = this.deps.now()
    return JSON.stringify(row.agent) !== before
  }

  /** A turn's end ends its waits too: one asked and never answered (Esc at the prompt) is gone with it. */
  private end(row: Row, turn: 'done' | 'error', again: boolean): void {
    row.turn = turn
    row.waits.clear()
    row.agent.unseenDone = turn === 'done'
    row.endHeard = true
    if (!again) this.recap(row)
  }

  /** Reads a row's last answer, one read at a time. One that lands after a newer turn started is dropped; a turn that
   *  ended meanwhile is read once more. The answer is kept through the next turn: one interrupted before any answer has
   *  the same last message, and says nothing new. */
  private recap(row: Row): void {
    if (row.reading) {
      row.readAgain = true
      return
    }
    row.reading = true
    const turns = row.turns
    void this.answer(row.agent.sessionId).then((answer) => {
      row.reading = false
      if (this.rows.get(row.agent.sessionId) !== row) return
      if (turns === row.turns && answer !== undefined && answer !== row.agent.lastAnswer) {
        row.agent.lastAnswer = answer
        this.emit()
      }
      if (!row.readAgain) return
      row.readAgain = false
      this.recap(row)
    })
  }
}
