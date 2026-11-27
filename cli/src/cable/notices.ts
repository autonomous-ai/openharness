// The notice desk: an agent's lines to the dial, as cards every dial pins, up to five waiting cards an agent and one
// other, the dial showing one of them. The devices process holds them; the core knows nothing of notices.

import { truncateUtf8 } from '../lib/deviceRecentTrim.js'
import { NOTICE_LINE_MAX_BYTES, NoticeLimits, noticeKind, type NoticeAsk, type NoticeKind, type NoticeResult } from '../lib/dialNotice.js'
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
  /** Whether the person is with that agent now (services/devices.ts `present`): read once the notice is its agent's,
   *  before the limits are taken. */
  present(agentId: string): boolean
  /** A question to every dial, in its agent's order. */
  ask(agentId: string, id: string, questions: unknown): void
  close(agentId: string, id: string): void
  uuid(): string
  now(): number                    // monotonic ms
  /** Wall-clock ms: when a card was shown must still mean something to the next start. */
  clock(): number
  /** The pending set changed: its file is written again (noticeFile.ts). */
  changed(): void
  /** Each answer, by the caller's engine (`agent` when it names none), for the day's tally. Its kind is read from the
   *  fixed opening the CLI writes (noticeKind), never from what the line says. [present]: shown as a quiet card. */
  count(engine: 'claude' | 'codex' | 'agent', result: NoticeResult, kind: NoticeKind, present: boolean): void
  /** The file's cards at the start (noticeFile.ts). */
  restored: readonly StoredNotice[]
  log(line: string): void
  /** Those agents' rows changed with no question frame to carry them: the dial's drawer is replaced, after what their
   *  order already holds, as a close in it drops its agent's row. */
  redraw(agentIds: readonly string[]): void
  /** The card's question to every dial, held for its row to open, never asked. */
  hold(agentId: string, id: string, questions: unknown): void
  /** A timer: [run] in [ms], and its cancel. */
  after(ms: number, run: () => void): () => void
}

export const NOTICES_PENDING_MAX = 20
/** The asks an agent may hold open at once, none hiding another; a sixth drops the oldest. */
export const NOTICE_WAITING_MAX = 5
/** A card's keys find its agent again after a restart (its session, then its panes): a few short ones, so the file
 *  stays small. */
export const NOTICE_KEYS_MAX = 4
export const NOTICE_KEY_MAX_CHARS = 160
/** A card goes at this age, live or from the file: what it asked for is a day old. */
export const NOTICE_MAX_AGE_MS = 24 * 3_600_000

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

/** An agent on a list the devices hold: `session` its `<engine>:<sessionId>`. */
export interface ListedAgent { agentId: string; session?: string; panes: readonly string[] }

export function listedAgent(agentId: string, agent: KeyedAgent): ListedAgent {
  return { agentId, session: sessionKey(agent), panes: agent.paneKeys ?? [] }
}

/** Why a card went. */
export type NoticeEnd = 'done' | 'sixth' | 'full' | 'replaced' | 'tapped' | 'gone' | 'detached' | 'expired'

/** A notice's answer and, when shown, its card: `id` the agent closes it by, `rang` when it was asked now. */
export interface NoticeOutcome { result: NoticeResult; card?: { id: string; kind: NoticeKind; quiet: boolean; rang: boolean } }

/** The ends logged, in fixed words: never a line, an id or a session. */
const LOGGED: Partial<Record<NoticeEnd, string>> = { done: 'done', sixth: 'dropped · sixth', expired: 'expired' }

const CARD_ID_CHARS = 8
/** A card's id: the first characters of the uuid in its question id (`shown:<uuid>`), which a rouse keeps. */
const cardId = (questionId: string): string => questionId.slice(SHOWN_ONLY_PREFIX.length, SHOWN_ONLY_PREFIX.length + CARD_ID_CHARS)

/** The line, then [place], within NOTICE_LINE_MAX_BYTES: the line cut between letters, with `…`, when they do not fit. */
const fitBytes = (line: string, place = ''): string => Buffer.byteLength(line + place) <= NOTICE_LINE_MAX_BYTES
  ? line + place
  : `${truncateUtf8(line, NOTICE_LINE_MAX_BYTES - Buffer.byteLength(`…${place}`))}…${place}`

/** The line a card shows: its own, with its place when its agent holds [m] cards, more than one. */
const placed = (line: string, m: number): string => m > 1 ? fitBytes(line, ` (1/${m})`) : line

/** A card's question, the same for a live card and one rebuilt from its file, which keeps only the line and host. */
const noticeQuestions = (line: string, host: string): unknown =>
  [{ key: 'notice', q: line, options: [`In ${hostDisplayName(host)}`] }]

interface Pending {
  agentId: string
  id: string; line: string; kind: NoticeKind; host: string; who?: NoticeCaller['who']; keys: readonly string[]; at: number
  /** Back from the file: a drawer row whose question is held, never asked, for it rang before the restart. */
  restored?: true
  /** Its agent was present: a drawer row whose question is held, not asked, as the person is already there; its turn's end
   *  with the person gone asks it once and drops this (rouse). Apart from `restored`, which never rouses: it rang before
   *  the restart. */
  quiet?: true
  /** Queued behind another card of its agent, or come up as the one before it went: a drawer row whose question is held,
   *  never asked, as the person was rung for that agent already. Apart from `quiet`, so no rouse asks it. */
  silent?: true
  /** Restored, and no row until its agent is listed: a card no list holds (`who`) never waits. */
  unfound?: true
}

/** What an agent shows on the dial: its oldest waiting card, else its other card, and how many cards it holds. */
interface Face { card: Pending; m: number }

/** The dial still shows one card an agent: the protocol and the firmware hold one question an agent (`held`), so its
 *  other cards wait behind the one shown, and that one's line says how many there are. */
export class Notices {
  // Every card, oldest first, by its id: a Map keeps insertion order, and it holds NOTICES_PENDING_MAX at most, so a
  // scan of it is bounded.
  private readonly cards = new Map<string, Pending>()
  private readonly limits: NoticeLimits
  /** The one timer, due at the oldest card's 24 hours by the wall clock; none with no card. */
  private timer?: { due: number; cancel: () => void }

  constructor(private readonly deps: NoticesDeps) {
    this.limits = new NoticeLimits(deps.now)
    const now = deps.clock()
    let aged = 0
    for (const { agentId, keys, id, line, host, who, at } of deps.restored) {
      if (now - at >= NOTICE_MAX_AGE_MS) { aged += 1; continue }
      this.cards.set(cardId(id),
        { agentId, id, line, kind: noticeKind(line), host, who, keys, at, restored: true, ...(!who && { unfound: true as const }) })
    }
    if (deps.restored.length > 0) deps.log(`[device] notices · restored ${deps.restored.length - aged} · aged out ${aged}`)
    if (aged > 0) deps.changed()
    this.schedule()
  }

  notify(ask: NoticeAsk): NoticeOutcome {
    // Counted by the engine, the outcome and the line's kind only: the text, session and folder are the person's own.
    const answer = (result: NoticeResult, card?: NoticeOutcome['card']): NoticeOutcome => {
      this.deps.count(ask.engine ?? 'agent', result, noticeKind(ask.text), card?.quiet === true)
      return card ? { result, card } : { result }
    }
    // With no dial a notice is nobody's: it must not use up the agent's minute for when one attaches.
    if (!this.deps.connected()) return answer('no dial')
    const caller = this.deps.resolve(ask)
    // Its cards, and its restored ones still waiting under the id a listing source gave it before the restart, which are
    // its own from now.
    const mine = [...this.cards.values()].filter((card) => card.agentId === caller.agentId
      || (card.unfound && card.keys.some((key) => caller.keys.includes(key))))
    // Behind a waiting card of its agent it waits, unrung: the person was rung for that agent already.
    const reaches = !mine.some((card) => card.kind === 'waiting')
    // Read before the limits: a quiet card takes no part of the hour's twenty, nor does one that rings nothing, so a later
    // ask with the person away still rings.
    const present = this.deps.present(caller.agentId)
    const rang = reaches && !present
    if (!this.limits.take(caller.agentId, ask.text, rang)) return answer('limited')
    // Drawn again while its first characters name a pending card: its agent closes it by them.
    let uuid = this.deps.uuid()
    while (this.cards.has(uuid.slice(0, CARD_ID_CHARS))) uuid = this.deps.uuid()
    const line = fitBytes(roundDrawable(ask.text))
    const card: Pending = {
      agentId: caller.agentId, id: SHOWN_ONLY_PREFIX + uuid, line, kind: noticeKind(line), host: caller.host, who: caller.who,
      keys: caller.keys, at: this.deps.clock(), ...(reaches && present && { quiet: true as const }), ...(!reaches && { silent: true as const }),
    }
    this.change(() => {
      for (const found of mine) {
        delete found.unfound
        if (found.agentId === caller.agentId) continue
        found.agentId = caller.agentId
        this.deps.changed()
      }
      this.cards.set(cardId(card.id), card)
      this.deps.changed()
      this.fit(caller.agentId)
      if (this.cards.size > NOTICES_PENDING_MAX) this.remove(this.cards.values().next().value!, 'full')
    })
    return answer('shown', { id: cardId(card.id), kind: card.kind, quiet: card.quiet === true, rang })
  }

  /** The agent closed that card of its own, by its id, or every one by `all`: how many went. Another agent's id, or one
   *  no card has, closes nothing. */
  done(agentId: string, id: string): number {
    const going = this.of(agentId).filter((card) => id === 'all' || cardId(card.id) === id)
    this.drop(going, 'done')
    return going.length
  }

  /** That agent's cards, oldest first, each with its own line. */
  list(agentId: string): Array<{ id: string; at: number; kind: NoticeKind; line: string }> {
    return this.of(agentId).map(({ id, at, kind, line }) => ({ id: cardId(id), at, kind, line }))
  }

  /** The card the dial shows for that agent. */
  shown(agentId: string): { id: string; kind: NoticeKind } | undefined {
    const card = this.faces().get(agentId)?.card
    return card && { id: cardId(card.id), kind: card.kind }
  }

  /** The person tapped that agent's card. A caller no list holds has no face on the dial to ask on, and with no session
   *  its next turn is never heard: the card shown goes, and the next comes up. Any other's tap keeps it. */
  tapped(agentId: string): void {
    const card = this.faces().get(agentId)?.card
    if (card?.who) this.drop([card], 'tapped')
  }

  /** Its agent left: its cards go. Nothing for an agent with none. */
  ended(agentId: string): void {
    this.drop(this.of(agentId), 'gone')
  }

  /** Another question of that agent closed, which took the card's place on the dial or held it back: the card shown is
   *  asked, under its id, unless one is still open. Nothing for an agent with none. A restored, quiet or silent row comes
   *  back by a drawer replace, as no question frame carries it. */
  reask(agentId: string): void {
    if (this.send(agentId)) this.deps.redraw([agentId])
  }

  /** A dial attached: each agent's card shown is sent again, under its id, a live one asked, a restored, quiet or silent
   *  one held. No redraw: the attach's greeting replaces the drawer after its carousel push, and a close still in an
   *  agent's order came with its own reask, whose redraw waits behind it. */
  attached(): void {
    for (const agentId of this.faces().keys()) this.send(agentId)
  }

  /** One kind of list as it is now: the core's Harness agents (`harness`), or the outside sources'. Each restored card of
   *  that kind still waiting looks for its agent there: by its id; else by its session, for an agent that names one; else
   *  by a pane, for one that names none, so a card never moves to another session in the same pane. Found, in a turn
   *  or not, it is that agent's, under the agent's id, among its other cards and under the same caps: a turn is no
   *  answer (2026-11-27). Its rows are shown by one drawer replace however many were found. A card found is not looked
   *  for again; with none waiting, the list is not read. */
  look(harness: boolean, listed: () => readonly ListedAgent[]): void {
    const unfound = [...this.cards.values()].filter((card) => card.unfound && (card.host === 'harness') === harness)
    if (unfound.length === 0) return
    const agents = listed()
    this.change(() => {
      for (const card of unfound) {
        const agent = agents.find((other) => other.agentId === card.agentId)
          ?? agents.find(({ session, panes }) => session ? card.keys.includes(session) : panes.some((pane) => card.keys.includes(pane)))
        if (!agent) continue
        delete card.unfound
        if (agent.agentId !== card.agentId) {
          card.agentId = agent.agentId
          this.deps.changed()
        }
        this.fit(agent.agentId)
      }
    })
  }

  /** That agent's turn ended and the person is no longer with it (services/devices.ts): its card shown, when quiet, is
   *  asked once, under a new question id, while a dial is attached and the hour has one left. The kind of the card asked;
   *  undefined when none was. */
  rouse(agentId: string): NoticeKind | undefined {
    const card = this.faces().get(agentId)?.card
    if (!card?.quiet || !this.deps.connected() || !this.limits.takeHour()) return undefined
    // A dial mutes a question under an id it holds, so the held one closes and the card rings under a new one, in the
    // same place of the order. It keeps the card's id: the agent closes it by the id it was given.
    this.deps.close(agentId, card.id)
    card.id = SHOWN_ONLY_PREFIX + cardId(card.id) + this.deps.uuid().slice(CARD_ID_CHARS)
    delete card.quiet
    this.deps.changed()
    this.send(agentId)
    return card.kind
  }

  /** The last dial went. A Harness agent's next turn is told to the devices only while a dial listens
   *  (services/recaps.ts), so its cards cannot wait for it through the unplug: they go now. Another agent's next turn is
   *  heard without a dial, so its cards stay to be asked again. */
  detached(): void {
    this.drop([...this.cards.values()].filter(({ host }) => host === 'harness'), 'detached')
  }

  /** The card each agent shows as a row of its drawer, with its place, newest first: a drawer replaced whole must keep
   *  them. */
  rows(machineId: string): UnreadNotification[] {
    const faces = this.faces()
    return [...this.cards.values()].reverse().flatMap((card) => {
      const face = faces.get(card.agentId)
      return face?.card === card && !card.unfound && !this.deps.held(card.agentId)
        ? [{ agentId: card.agentId, machineId, question: true, text: placed(card.line, face.m) }]
        : []
    })
  }

  /** Whether that agent's card shown is held quiet. */
  quiet(agentId: string): boolean {
    return this.faces().get(agentId)?.card.quiet === true
  }

  /** Whether that agent has a card still pending, asked or held back. */
  pending(agentId: string): boolean {
    return [...this.cards.values()].some((card) => card.agentId === agentId)
  }

  /** Every pending card as its file keeps it, oldest first. */
  stored(): StoredNotice[] {
    return [...this.cards.values()].map(({ agentId, keys, id, line, host, who, at }) =>
      ({ agentId, keys: [...keys], id, line, host, ...(who && { who }), at }))
  }

  /** Who the caller of the card shown is, when no list holds it. */
  from(agentId: string): { name: string; engine: string; machine: string } | undefined {
    return this.faces().get(agentId)?.card.who
  }

  /** That agent's cards, oldest first. */
  private of(agentId: string): Pending[] {
    return [...this.cards.values()].filter((card) => card.agentId === agentId)
  }

  /** What each agent shows: its oldest waiting card, else its other card. */
  private faces(): Map<string, Face> {
    const faces = new Map<string, Face>()
    for (const card of this.cards.values()) {
      const face = faces.get(card.agentId)
      if (!face) faces.set(card.agentId, { card, m: 1 })
      else {
        face.m += 1
        if (face.card.kind !== 'waiting' && card.kind === 'waiting') face.card = card
      }
    }
    return faces
  }

  /** An agent's five newest waiting cards and its newest other card are kept. */
  private fit(agentId: string): void {
    const mine = this.of(agentId)
    for (const card of mine.filter(({ kind }) => kind === 'waiting').slice(0, -NOTICE_WAITING_MAX)) this.remove(card, 'sixth')
    for (const card of mine.filter(({ kind }) => kind !== 'waiting').slice(0, -1)) this.remove(card, 'replaced')
  }

  /** Those cards go, and what their agents show is settled; nothing at all for none, as an agent's leaving or a close by
   *  an id no card has names none. */
  private drop(cards: readonly Pending[], end: NoticeEnd): void {
    if (cards.length > 0) this.change(() => { for (const card of cards) this.remove(card, end) })
  }

  private remove(card: Pending, end: NoticeEnd): void {
    this.cards.delete(cardId(card.id))
    this.deps.changed()
    this.deps.close(card.agentId, card.id)
    const said = LOGGED[end]
    if (said) this.deps.log(`[device] notice · ${said}`)
  }

  /** A change to the cards, then each agent's card shown settled, and one drawer replace for every one held by it. */
  private change(run: () => void): void {
    // A card still waiting for its agent was on no dial.
    const before = new Map([...this.faces()].map(([agentId, face]) => [agentId, face.card.unfound ? undefined : face]))
    run()
    const after = this.faces()
    const held = [...new Set([...before.keys(), ...after.keys()])]
      .filter((agentId) => this.settle(agentId, before.get(agentId), after.get(agentId)))
    if (held.length > 0) this.deps.redraw(held)
    this.schedule()
  }

  /** The timer set again for the oldest card. A turn start no longer ends a card (2026-11-27), so a live card ages as a
   *  restored one does: one nobody closes goes at 24 hours. Pushed, one timer for every card, never a poll. */
  private schedule(): void {
    const due = this.cards.size > 0 ? Math.min(...[...this.cards.values()].map(({ at }) => at)) + NOTICE_MAX_AGE_MS : undefined
    if (this.timer?.due === due) return
    this.timer?.cancel()
    this.timer = undefined
    if (due === undefined) return
    // A card ahead of a clock set back waits a day at most for the next look: a delay past what a timer holds fires at
    // once, and again.
    const ms = Math.min(Math.max(0, due - this.deps.clock()), NOTICE_MAX_AGE_MS)
    this.timer = { due, cancel: this.deps.after(ms, () => this.expire()) }
  }

  /** The timer fired: every card 24 hours old goes, by the wall clock, so a sleep that held the timer back ends each
   *  aged card at once; the next comes up as after any close. */
  private expire(): void {
    this.timer = undefined
    const now = this.deps.clock()
    this.drop([...this.cards.values()].filter(({ at }) => now - at >= NOTICE_MAX_AGE_MS), 'expired')
    this.schedule()
  }

  /** That agent's cards after a change: one shown before that another took the dial from closes, still pending; every
   *  card not shown is silent; the card shown is sent when it is new there, or held again when its place changed.
   *  Whether one was held. */
  private settle(agentId: string, was: Face | undefined, now: Face | undefined): boolean {
    if (was && was.card !== now?.card && was.card.agentId === agentId && this.cards.get(cardId(was.card.id)) === was.card) {
      this.deps.close(agentId, was.card.id)
    }
    for (const card of this.of(agentId)) {
      if (card === now?.card) continue
      card.silent = true
      delete card.quiet
    }
    if (!now) return false
    if (now.card !== was?.card) return this.send(agentId)
    return now.m !== was.m && this.send(agentId, true)
  }

  /** The card that agent shows, with its place, to every dial: a live one asked; a restored, quiet or silent one held, as
   *  is one whose place alone changed, whose new line the drawer's replace carries with no second ring. Nothing for one
   *  waiting for its agent or covered by another question of it. Whether one was held. */
  private send(agentId: string, placeChanged = false): boolean {
    const face = this.faces().get(agentId)
    if (!face || face.card.unfound || this.deps.held(agentId)) return false
    const { card, m } = face
    const questions = noticeQuestions(placed(card.line, m), card.host)
    if (placeChanged || card.restored || card.quiet || card.silent) {
      this.deps.hold(agentId, card.id, questions)
      return true
    }
    this.deps.ask(agentId, card.id, questions)
    return false
  }
}
