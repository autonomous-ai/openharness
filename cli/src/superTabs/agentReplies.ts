/**
 * A person's words in their agent's own 1:1 chat reach it as they typed them, and its answer comes back there without the
 * agent running anything (anh Dee, 2026-11-09: "it's a 1:1 conversation, why can't it be just the exact prompt?"). The host
 * owes that reply from the moment it types the message. When the agent's turn ends it reads the turn's final answer, and
 * posts it as the agent, right below the message, if the turn was asked what it typed.
 *
 * What is owed is a few ids and a hash of the words, never the words: it lives in the host's journal (`replies`), so a
 * restart in the middle of a long turn still posts the answer when the turn ends. A reply is taken off what is owed before
 * its post starts, so a second hearing of the same end does nothing, and posted under `reply-<delivery id>` with the same
 * command each time, so the server takes a repeated post for the first. Nothing is posted twice, and nothing is posted for a
 * turn the person did not ask: an end that is not one of the turns owed leaves them all as they were.
 *
 * A reply the post of which failed for good (the server refuses it, or every try is spent) is never lost without a word: the
 * person is told in the same chat, from the agent, where the reply would have been, so they do not wait for it.
 *
 * Known limit: a message queued behind a running turn starts its own turn the moment the first ends, and an engine may have
 * written that prompt before the answer is read, so the first turn's answer is no longer the last turn the transcript shows.
 * That reply stays owed through that end (the last turn has said nothing yet) and is dropped, with a line saying so, when the
 * turn after it ends and answers: rather posted from the wrong turn, it is not posted.
 */
import { createHash } from 'node:crypto'
import type { CoreApi, TurnDelivery, TurnEnd } from '../core/api.js'
import type { LastTurnText } from '../lib/normalize.js'
import { cut } from './deliveryContext.js'
import { backend, identifier, object, SuperTabHostError } from './wire.js'

/** What the backend takes in one message (`message.send`'s text, 32,000 characters). */
export const REPLY_TEXT_MAX = 32_000
/** How long a read of the answer, and one post, may take before it counts as failed. */
export const READ_WAIT_MS = 10_000
export const REPLY_WAIT_MS = 20_000
/** The waits before each new try of a post, which is then dropped: a backend that is rolling out or busy answers within
 *  minutes, and a reply that late is no longer an answer anyone is waiting on. */
export const REPLY_RETRY_MS: readonly number[] = [2_000, 10_000, 30_000, 120_000]
/** How long a reply is owed with its turn unseen (a daemon that was down when it ended, an agent never asked again). Past the
 *  longest hold a delivery has on the server. */
export const OWED_GIVE_UP_MS = 24 * 60 * 60_000
/** The most replies owed one terminal (the oldest go first), and all together: ids and a hash, so a journal stays small. */
export const OWED_PER_AGENT = 16
export const OWED_MAX = 256
/** The longest name of an agent kept with a reply owed it, which is what its person is told if the reply is dropped. */
export const NAME_MAX = 80

/** A reply the host owes, by the delivery that typed the message. */
export interface Owed {
  tabId: string
  /** The member the reply is posted as. */
  agentId: string
  /** The name its person knows the agent by, for the line they are told if the reply is dropped. */
  name: string
  /** The terminal its agent runs in, by the id the core knows it by: the turn that ends says which terminal it ran in. */
  harnessId: string
  conversationId: string
  /** The message answered. The reply goes right below it, or in its thread when it is a reply in one, as the Answer line said. */
  messageId: string
  thread: boolean
  /** A hash of what was typed, as `said` reads it: what the turn's prompt must be, and never the words themselves. */
  asked: string
  at: number
}

export interface RepliesDeps {
  now: () => number
  log: (line: string) => void
  /** Save the journal these replies are in (the host's). */
  save: () => void
  /** The delivery's id as the core knows it, which `onDelivery` says. */
  typedId: (deliveryId: string) => string
  /** A refusal no resend changes. */
  refused: (error: unknown) => boolean
}

/** What a prompt says, once the markers Claude Code records around a paste are off it and its spacing is one: Claude Code
 *  keeps a typed paste between `<pasted_content id=…>` tags, and an engine may space its lines as it likes. */
const PASTE_MARKS = /<\/?pasted_content\b[^>]*>/g
const said = (text: string): string => text.replace(PASTE_MARKS, ' ').replace(/\s+/g, ' ').trim()
const hashOf = (text: string): string => createHash('sha256').update(said(text)).digest('hex').slice(0, 32)

class Late extends Error { override readonly name = 'TIMEOUT' }
/** [work] or a failure after [ms]. */
function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Late()), ms); timer.unref?.() })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}
/** A failure's name, for a log line: the server's own code, else the error's kind. Never its message, which may hold text. */
const named = (error: unknown): string => error instanceof SuperTabHostError ? error.code : error instanceof Error ? error.name : 'ERROR'

/** The replies a journal holds, as a host that starts from it owes them: each must be one this host could have written, and
 *  the newest of each terminal and of all are kept. Said once, by how many were not. */
export function adoptReplies(saved: unknown, log: (line: string) => void): Record<string, Owed> {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {}
  const rows: Array<[string, Owed]> = []
  let dropped = 0
  for (const [id, value] of Object.entries(saved)) {
    const o = object(value)
    if (identifier(id) && identifier(o.tabId) && identifier(o.agentId) && identifier(o.harnessId) && identifier(o.conversationId) && identifier(o.messageId)
      && typeof o.name === 'string' && o.name.length > 0 && o.name.length <= NAME_MAX
      && typeof o.thread === 'boolean' && typeof o.asked === 'string' && /^[0-9a-f]{32}$/.test(o.asked) && Number.isFinite(o.at)) {
      rows.push([id, { tabId: o.tabId, agentId: o.agentId, name: o.name, harnessId: o.harnessId, conversationId: o.conversationId, messageId: o.messageId,
        thread: o.thread, asked: o.asked, at: o.at as number }])
    } else dropped++
  }
  rows.sort((a, b) => a[1].at - b[1].at)
  const perTerminal = new Map<string, number>()
  const kept = new Set<string>()
  // From the newest back: each terminal keeps its newest, and all together the newest.
  for (let i = rows.length - 1; i >= 0; i--) {
    const [id, owed] = rows[i]!, have = perTerminal.get(owed.harnessId) ?? 0
    if (have < OWED_PER_AGENT && kept.size < OWED_MAX) { perTerminal.set(owed.harnessId, have + 1); kept.add(id) } else dropped++
  }
  if (dropped) log(`Dropped ${dropped} saved replies owed that this host could not use.`)
  return Object.fromEntries(rows.filter(([id]) => kept.has(id)))
}

export class AgentReplies {
  private stopped = false
  /** The tries still to come, by their timers, each with what is said if the host stops before it. */
  private readonly timers = new Map<ReturnType<typeof setTimeout>, string>()

  /** [journal] is the host's: the replies owed are its `replies`, which this edits and the host saves with the rest. */
  constructor(private readonly core: CoreApi, private readonly journal: { replies?: Record<string, Owed> }, private readonly deps: RepliesDeps) {}

  private get log() { return this.deps.log }

  /** The replies owed [harnessId], oldest first. */
  private owedOf(harnessId: string): Array<[string, Owed]> {
    return Object.entries(this.journal.replies ?? {}).filter(([, owed]) => owed.harnessId === harnessId).sort((a, b) => a[1].at - b[1].at)
  }

  private remove(deliveryId: string): void {
    delete this.journal.replies?.[deliveryId]
    if (this.journal.replies && !Object.keys(this.journal.replies).length) delete this.journal.replies
  }

  /** The journal saved, a failure said and gone past: the reply is still posted, and what stays on disk is read as stale. */
  private commit(): void {
    try { this.deps.save() } catch (error) { this.log(`Could not save the replies owed: ${error instanceof Error ? error.message : String(error)}`) }
  }

  /** A reply never asked for, said and taken off. */
  private drop(deliveryId: string, owed: Owed, why: string): void {
    this.log(`Dropped the reply owed for delivery ${deliveryId} of agent ${owed.agentId}: ${why}.`)
    this.remove(deliveryId)
  }

  /** A reply the turn that ended will never have, said and taken off. */
  private none(deliveryId: string, owed: Owed, why: string): void {
    this.log(`No reply posted for delivery ${deliveryId} of agent ${owed.agentId}: ${why}.`)
    this.remove(deliveryId)
  }

  /** What has waited a day is not asked for any more. Whether anything went. */
  private expire(): boolean {
    const now = this.deps.now()
    let gone = false
    for (const [id, owed] of Object.entries(this.journal.replies ?? {})) {
      if (now - owed.at >= OWED_GIVE_UP_MS) { this.drop(id, owed, 'its turn was not seen in 24 hours'); gone = true }
    }
    return gone
  }

  /** The host types [text], its person's message [message], into [entry]'s agent, which [entry.name] is what its person calls: a
   *  reply is owed. The host saves the journal with the delivery that records the hand-over, so what is owed and what was typed
   *  are one write. */
  owe(entry: { deliveryId: string; tabId: string; agentId: string; harnessId: string; name: string }, message: Record<string, unknown>, text: string): void {
    this.expire()
    const owed = this.journal.replies ??= {}
    // The pane held it and it is typed again, perhaps in another terminal (its member moved to a new session while it waited): the
    // same message, the same reply, owed from where it is typed now.
    const held = owed[entry.deliveryId]
    if (held) { held.harnessId = entry.harnessId; return }
    owed[entry.deliveryId] = { tabId: entry.tabId, agentId: entry.agentId, name: cut(entry.name, NAME_MAX - 1), harnessId: entry.harnessId, conversationId: String(message.conversationId),
      messageId: String(message.id), thread: identifier(message.thread) && message.thread !== message.id, asked: hashOf(text), at: this.deps.now() }
    const mine = this.owedOf(entry.harnessId)
    for (const [id, old] of mine.slice(0, Math.max(0, mine.length - OWED_PER_AGENT))) this.drop(id, old, `more than ${OWED_PER_AGENT} are owed it`)
    const all = Object.entries(owed).sort((a, b) => a[1].at - b[1].at)
    for (const [id, old] of all.slice(0, Math.max(0, all.length - OWED_MAX))) this.drop(id, old, `more than ${OWED_MAX} are owed in all`)
  }

  /** The host could not save the hand-over of a delivery it had said it owes a reply for: nothing was typed. Nothing is saved. */
  forget(deliveryId: string): void {
    this.remove(deliveryId)
  }

  /** What the core says became of a delivery: one it refused for good (not for a busy pane, which the host asks again) was never
   *  typed, so no turn will answer it. One that may have been typed stays owed. */
  delivery(event: TurnDelivery): void {
    if (event.state !== 'rejected' || event.reason?.startsWith('team_waiting_')) return
    const id = Object.keys(this.journal.replies ?? {}).find(owed => this.deps.typedId(owed) === event.deliveryId)
    if (id === undefined) return
    this.remove(id)
    this.commit()
  }

  /** A live turn ended. Resolves once its reply, if it owed one, had its first try (and, when the server refused that for good,
   *  the line that tells its person so). */
  async ended(event: TurnEnd): Promise<void> {
    if (this.stopped || !this.journal.replies) return
    if (this.expire()) this.commit()
    const first = this.owedOf(event.agentId)[0]
    if (!first) return
    let turn: LastTurnText | null
    try { turn = await bounded(this.core.transcripts.lastTurn(event.sessionId), READ_WAIT_MS) } catch (error) {
      this.log(`Could not read the answer of the turn that ended for agent ${first[1].agentId}: ${named(error)}.`)
      return
    }
    if (this.stopped || !turn) return
    // The last turn the transcript shows is the one this end answers when it has said something, to the prompt of one of
    // these. One that has said nothing is a turn still at work (a queued follow-up begins the moment one ends, and its prompt
    // may already be written) or one that said nothing, and neither is over for certain; a prompt that is none of these is a turn
    // its person typed in the terminal, or an automatic one. Either way nothing is posted and what is owed stays owed.
    const answer = turn.assistantText.trim()
    // Read again: an earlier hearing of this end may have taken it while this read was out.
    const mine = this.owedOf(event.agentId)
    const asked = answer ? hashOf(turn.userMessage) : null
    const at = asked ? mine.findIndex(([, owed]) => owed.asked === asked) : -1
    if (at < 0) return
    // Each message that waited behind this one had its turn after it, so the ones before it went without: it was queued
    // and the engine took it into the turn that followed, or its turn was never seen.
    for (const [id, older] of mine.slice(0, at)) this.none(id, older, 'its turn went on without it')
    const [id, owed] = mine[at]!
    this.remove(id)
    this.commit()
    if (event.aborted) return this.log(`No reply posted for delivery ${id} of agent ${owed.agentId}: its turn was interrupted.`)
    await this.attempt(id, owed, answer.length > REPLY_TEXT_MAX ? cut(answer, REPLY_TEXT_MAX - 1) : answer, 0)
  }

  /** A post of [text] in the chat [owed] was owed in, as the agent would have made it itself (`harness super-tab post --answers`,
   *  superTabs/command.ts): below the message it answers, or in its thread. The same command under the same operation each time,
   *  so the server answers a post it already took with the first. */
  private post(operationId: string, owed: Owed, text: string): Promise<unknown> {
    const command = { type: 'message.send', conversationId: owed.conversationId, text, replyTo: owed.thread ? owed.messageId : null,
      ...(owed.thread ? {} : { answers: owed.messageId }), recipientIds: [] }
    return backend(this.core, 'POST', `/api/super-tabs/${owed.tabId}/commands`, { operationId, asAgentId: owed.agentId, command })
  }

  /** One try of the reply's post. */
  private async attempt(deliveryId: string, owed: Owed, text: string, tried: number): Promise<void> {
    try {
      await bounded(this.post(`reply-${deliveryId}`, owed, text), REPLY_WAIT_MS)
    } catch (error) {
      const dropped = `Dropped the reply to delivery ${deliveryId} of agent ${owed.agentId}`
      if (this.stopped) return this.log(`${dropped}: the host stopped.`)
      const code = named(error), tries = REPLY_RETRY_MS.length + 1
      const gone = this.deps.refused(error) ? `${code}; no later try changes it` : tried >= REPLY_RETRY_MS.length ? `${code} after ${tries} tries` : null
      if (gone) { this.log(`${dropped}: ${gone}.`); return this.tell(deliveryId, owed) }
      const wait = REPLY_RETRY_MS[tried]!
      this.log(`Could not post the reply to delivery ${deliveryId} of agent ${owed.agentId}: ${code} (try ${tried + 1} of ${tries}); trying again in ${wait / 1_000} s.`)
      const timer = setTimeout(() => { this.timers.delete(timer); void this.attempt(deliveryId, owed, text, tried + 1) }, wait)
      timer.unref?.()
      this.timers.set(timer, `${dropped}: the host stopped.`)
    }
  }

  /** What its person is told when a reply is dropped for good, so they do not wait for it: one line in the chat it was owed in,
   *  where the reply would have been, from the agent. Only tried: the backend that turned the reply away may turn this away too,
   *  so it is neither waited on past REPLY_WAIT_MS nor sent again, and a failure is the log's. */
  private async tell(deliveryId: string, owed: Owed): Promise<void> {
    try {
      await bounded(this.post(`dropped-reply-${deliveryId}`, owed, `${owed.name}'s answer could not be posted.`), REPLY_WAIT_MS)
    } catch (error) {
      this.log(`Could not tell the person that the reply to delivery ${deliveryId} of agent ${owed.agentId} was dropped: ${named(error)}.`)
    }
  }

  /** The host stops: no end is heard and no try is made again. A reply waiting for its next try is dropped, said; the ones
   *  still owed stay in the journal for the host that starts from it. */
  stop(): void {
    this.stopped = true
    for (const [timer, line] of this.timers) { clearTimeout(timer); this.log(line) }
    this.timers.clear()
  }
}
