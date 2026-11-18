// The notice desk: an agent's one line to the dial, as a card the dial pins until the agent's next turn. The devices
// process holds it; the core knows nothing of notices.

import { truncateUtf8 } from '../lib/deviceRecentTrim.js'
import { NoticeLimits, type NoticeAsk, type NoticeResult } from '../lib/dialNotice.js'
import type { UnreadNotification } from '../lib/notificationRead.js'
import { SHOWN_ONLY_PREFIX } from './cableSession.js'
import { hostDisplayName } from './hosts/hostDetect.js'
import { roundDrawable } from './roundGlyphs.js'

export interface NoticeCaller {
  agentId: string
  /** What finds its agent again after a restart (noticeKeys); none for a caller no list holds. */
  keys: readonly string[]
  /** The host its app is named by; '' when nothing says. */
  host: string
  /** Only for a caller no list holds: what its card carries. */
  who?: { name: string; engine: string; machine: string }
}

export interface NoticesDeps {
  connected(): boolean
  resolve(ask: NoticeAsk): NoticeCaller
  /** Whether another question of that agent is open on the dials. A dial, and its cable session, hold one question an
   *  agent: a notice asked over it would hide it and drop its close, so the notice waits until it closes. */
  held(agentId: string): boolean
  /** A question to every dial, in its agent's order. */
  ask(agentId: string, id: string, questions: unknown): void
  close(agentId: string, id: string): void
  uuid(): string
  now(): number                    // monotonic ms
  /** Wall-clock ms: when a card was shown must still mean something to the next start. */
  clock(): number
  /** The pending set changed: its file is written again (noticeFile.ts). */
  changed(): void
  /** Each answer, by the caller's engine (`agent` when it names none), for the day's tally. */
  count(engine: 'claude' | 'codex' | 'agent', result: NoticeResult): void
  /** The file's cards at the start (noticeFile.ts). */
  restored: readonly StoredNotice[]
  log(line: string): void
  /** Those agents' rows changed with no question frame to carry them: the dial's drawer is replaced, after what their
   *  order already holds, as a close in it drops its agent's row. */
  redraw(agentIds: readonly string[]): void
  /** The card's question to every dial, held for its row to open, never asked. */
  hold(agentId: string, id: string, questions: unknown): void
}

export const NOTICES_PENDING_MAX = 20
/** The bytes of a line the dial keeps whole: its drawer row cuts at 239, and a question of 256 or more reads "This
 *  question needs the desktop" (firmware ui_habitat.c). 120 letters can be 360 bytes. */
export const NOTICE_LINE_MAX_BYTES = 239
/** A card's keys find its agent again after a restart (its session, then its panes): a few short ones, so the file
 *  stays small. */
export const NOTICE_KEYS_MAX = 4
export const NOTICE_KEY_MAX_CHARS = 160
/** A card of the file older than this is not restored: what it asked for is a day old. */
export const NOTICE_RESTORE_MAX_MS = 24 * 3_600_000

/** A pending card as `dial-notices.json` keeps it; `at` is the wall-clock ms it was shown. */
export interface StoredNotice {
  agentId: string
  keys: string[]
  id: string
  line: string
  host: string
  who?: NoticeCaller['who']
  at: number
}

type KeyedAgent = { engine: string; sessionId?: string; paneKeys?: readonly string[] }

/** The key of an agent's session, the one way a card and a list name it. */
const sessionKey = ({ engine, sessionId }: KeyedAgent): string | undefined => sessionId ? `${engine}:${sessionId}` : undefined

/** An agent's keys as its list entry holds them now: its session first, which names it alone, then its panes. */
export function noticeKeys(agent: KeyedAgent): string[] {
  const session = sessionKey(agent)
  return [...session ? [session] : [], ...agent.paneKeys ?? []].filter((key) => key.length <= NOTICE_KEY_MAX_CHARS).slice(0, NOTICE_KEYS_MAX)
}

/** An agent on a list the devices hold: `session` its `<engine>:<sessionId>`, `busy` in a turn as listed. */
export interface ListedAgent { agentId: string; session?: string; panes: readonly string[]; busy: boolean }

export function listedAgent(agentId: string, agent: KeyedAgent, busy: boolean): ListedAgent {
  return { agentId, session: sessionKey(agent), panes: agent.paneKeys ?? [], busy }
}

/** The line within NOTICE_LINE_MAX_BYTES, cut between letters, with `…` when cut. */
const fitBytes = (line: string): string => Buffer.byteLength(line) <= NOTICE_LINE_MAX_BYTES
  ? line
  : `${truncateUtf8(line, NOTICE_LINE_MAX_BYTES - Buffer.byteLength('…'))}…`

/** A card's question, the same for a live card and one rebuilt from its file, which keeps only the line and host. */
const noticeQuestions = (line: string, host: string): unknown =>
  [{ key: 'notice', q: line, options: [`In ${hostDisplayName(host)}`] }]

interface Pending {
  id: string; line: string; questions: unknown; host: string; who?: NoticeCaller['who']; keys: readonly string[]; at: number
  /** Back from the file: a drawer row whose question is held, never asked, for it rang before the restart. */
  restored?: true
  /** Restored, and no row until its agent is listed: a card no list holds (`who`) never waits. */
  waiting?: true
}

export class Notices {
  // One card an agent, oldest first: a Map keeps insertion order, and a replaced card is put back at the end.
  private readonly cards = new Map<string, Pending>()
  private readonly limits: NoticeLimits

  constructor(private readonly deps: NoticesDeps) {
    this.limits = new NoticeLimits(deps.now)
    const now = deps.clock()
    let aged = 0
    for (const { agentId, keys, id, line, host, who, at } of deps.restored) {
      if (now - at > NOTICE_RESTORE_MAX_MS) { aged += 1; continue }
      this.cards.set(agentId,
        { id, line, questions: noticeQuestions(line, host), host, who, keys, at, restored: true, ...(!who && { waiting: true as const }) })
    }
    if (deps.restored.length > 0) deps.log(`[device] notices · restored ${deps.restored.length - aged} · aged out ${aged}`)
    if (aged > 0) deps.changed()
  }

  notify(ask: NoticeAsk): NoticeResult {
    // Counted by the engine and the outcome only: the text, session and folder are the person's own.
    const answer = (result: NoticeResult): NoticeResult => {
      this.deps.count(ask.engine ?? 'agent', result)
      return result
    }
    // With no dial a notice is nobody's: it must not use up the agent's minute for when one attaches.
    if (!this.deps.connected()) return answer('no dial')
    const caller = this.deps.resolve(ask)
    if (!this.limits.take(caller.agentId, ask.text)) return answer('limited')
    this.ended(caller.agentId)
    // Its restored card, still waiting under the id a listing source gave it before the restart: one card an agent, and
    // nothing found later moves onto the new one.
    for (const [agentId, card] of [...this.cards]) {
      if (card.waiting && card.keys.some((key) => caller.keys.includes(key))) this.ended(agentId)
    }
    if (this.cards.size >= NOTICES_PENDING_MAX) this.ended(this.cards.keys().next().value!)
    const id = SHOWN_ONLY_PREFIX + this.deps.uuid()
    const line = fitBytes(roundDrawable(ask.text))
    this.cards.set(caller.agentId, {
      id, line, questions: noticeQuestions(line, caller.host), host: caller.host, who: caller.who, keys: caller.keys, at: this.deps.clock(),
    })
    this.deps.changed()
    this.reask(caller.agentId)
    return answer('shown')
  }

  /** Its agent's next turn started, the person opened it, or its agent left: its card goes. Nothing for an agent with none. */
  ended(agentId: string): void {
    const card = this.cards.get(agentId)
    if (!card) return
    this.cards.delete(agentId)
    this.deps.changed()
    this.deps.close(agentId, card.id)
  }

  /** Another question of that agent closed, which took the card's place on the dial or held it back: the card is asked,
   *  under its id, unless one is still open. Nothing for an agent with none. A restored row comes back by a drawer
   *  replace, as no question frame carries it. */
  reask(agentId: string): void {
    if (this.send(agentId)) this.deps.redraw([agentId])
  }

  /** A dial attached: each pending card is sent again, under its id, a live one asked and a restored one held. The
   *  attach's greeting draws a restored row, but ahead of a close still in its agent's order: a redraw puts it back. */
  attached(): void {
    const held = [...this.cards.keys()].filter((agentId) => this.send(agentId))
    if (held.length > 0) this.deps.redraw(held)
  }

  /** One kind of list as it is now: the core's Harness agents (`harness`), or the outside sources'. Each restored card of
   *  that kind still waiting looks for its agent there: by its id; else by its session, for an agent that names one; else
   *  by a pane, for one that names none, so a card never moves to another session in the same pane. Found in
   *  a turn, most likely one after its notice, or with a card of its own already, it ends. Found otherwise, it takes the
   *  agent's id in its place, and its row is shown, by one drawer replace however many were found. A card found is not
   *  looked for again; with none waiting, the list is not read. */
  look(harness: boolean, listed: () => readonly ListedAgent[]): void {
    const waiting = [...this.cards].filter(([, card]) => card.waiting && (card.host === 'harness') === harness)
    if (waiting.length === 0) return
    const agents = listed()
    const shown: string[] = []
    for (const [agentId, card] of waiting) {
      const agent = agents.find((other) => other.agentId === agentId)
        ?? agents.find(({ session, panes }) => session ? card.keys.includes(session) : panes.some((pane) => card.keys.includes(pane)))
      if (!agent) continue
      if (agent.busy || (agent.agentId !== agentId && this.cards.has(agent.agentId))) {
        this.ended(agentId)
        continue
      }
      delete card.waiting
      if (agent.agentId !== agentId) this.rename(agentId, agent.agentId)
      if (this.send(agent.agentId)) shown.push(agent.agentId)
    }
    // A covered card shows no row: it comes with its cover's close (reask).
    if (shown.length > 0) this.deps.redraw(shown)
  }

  /** That agent is in a turn: its restored card ends, as the turn most likely came after its notice. A live card stays:
   *  it was shown in this turn. */
  working(agentId: string): void {
    if (this.cards.get(agentId)?.restored) this.ended(agentId)
  }

  /** A card under its agent's new id, in the same place of the order. */
  private rename(from: string, to: string): void {
    const cards = [...this.cards]
    this.cards.clear()
    for (const [agentId, card] of cards) this.cards.set(agentId === from ? to : agentId, card)
    this.deps.changed()
  }

  /** The card to every dial: a live one asked, a restored one held. Nothing for one waiting for its agent or covered by
   *  another question of it. Whether a restored one was held. */
  private send(agentId: string): boolean {
    const card = this.cards.get(agentId)
    if (!card || card.waiting || this.deps.held(agentId)) return false
    if (card.restored) {
      this.deps.hold(agentId, card.id, card.questions)
      return true
    }
    this.deps.ask(agentId, card.id, card.questions)
    return false
  }

  /** The last dial went. A Harness agent's next turn is told to the devices only while a dial listens
   *  (services/recaps.ts), so its card cannot wait for it through the unplug: it goes now. Another agent's next turn is
   *  heard without a dial, so its card stays to be asked again. */
  detached(): void {
    for (const [agentId, card] of this.cards) if (card.host === 'harness') this.ended(agentId)
  }

  /** Each pending card the dial shows as a row of its drawer, newest first: a drawer replaced whole must keep them. */
  rows(machineId: string): UnreadNotification[] {
    return [...this.cards].reverse().filter(([agentId, card]) => !card.waiting && !this.deps.held(agentId))
      .map(([agentId, card]) => ({ agentId, machineId, question: true, text: card.line }))
  }

  /** Whether that agent's card is still pending, asked or held back. */
  pending(agentId: string): boolean {
    return this.cards.has(agentId)
  }

  /** Every pending card as its file keeps it, oldest first. */
  stored(): StoredNotice[] {
    return [...this.cards].map(([agentId, { keys, id, line, host, who, at }]) =>
      ({ agentId, keys: [...keys], id, line, host, ...(who && { who }), at }))
  }

  /** Who a pending notice's caller is, when no list holds it. */
  from(agentId: string): { name: string; engine: string; machine: string } | undefined {
    return this.cards.get(agentId)?.who
  }
}
