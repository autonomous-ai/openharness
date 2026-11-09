/**
 * Live turn ends, told to whoever listens: the services in the core's process, and the services in their own processes that asked
 * for them (`TURN_END_HEARERS`). The event funnel says each turn as it goes (core/turns/funnel.ts): its start, what its agent says,
 * the tools it calls, and its end; a turn read back from a transcript at attach is never one. A process that is not connected misses
 * an end, and costs that turn the answer it would have posted, nothing else: the core waits for nobody.
 *
 * Every real end is told, a turn that ends just before a queued follow-up starts included: each message a person sends an agent is
 * its own turn, and the Swarm host answers each in its own order (superTabs/agentReplies.ts). An end names its turn by a hash of its
 * prompt, and what the turn said is kept here as it was said. The transcript cannot be asked for it: a follow-up that began at once
 * has its prompt, and perhaps its first words, in the transcript before the end is heard, and then the last turn there is not the
 * one that ended.
 */
import type { LastTurnText } from '../../engines/kit/events.js'
import { promptHash } from '../../lib/promptIdentity.js'
import type { TurnEnd } from '../api.js'

/** The most of an answer kept: a character more than the 32,000 a Swarm message takes (superTabs/agentReplies.ts), so whoever
 *  posts it can tell it was cut. */
export const ANSWER_KEEP_MAX = 32_001
/** How many ended turns of a session keep their answers: a host asks as it hears an end, so a few cover turns that end close
 *  together. And how many sessions are kept in all, ended turns and open ones, the least recent going first. */
const TURNS_KEPT = 4
const SESSIONS_KEPT = 64

/** Texts, and how long they are together: no more is added once the most kept is reached. */
interface Texts { parts: string[]; size: number }
const none = (): Texts => ({ parts: [], size: 0 })
const add = (texts: Texts, text: string): void => {
  if (texts.size >= ANSWER_KEEP_MAX) return
  texts.parts.push(text)
  texts.size += text.length
}

interface OpenTurn {
  prompt: string
  /** A turn the daemon picked up at attach, whose first part it never saw: what it sees of it is no answer. */
  partial: boolean
  /** What its agent has said since its last tool call, and what it said before them: the answer is the first, and the second
   *  only when the turn said nothing after its tools, as the recaps read a turn (engines/claude/normalize.ts). */
  now: Texts
  before: Texts
}

/** Keeps the entries of [map] that were set last, no more than [SESSIONS_KEPT]. */
const trim = (map: Map<string, unknown>): void => {
  while (map.size > SESSIONS_KEPT) map.delete(map.keys().next().value!)
}

export interface TurnEndsDeps {
  /** The services in their own processes that want each end. */
  hearers: ReadonlySet<string>
  /** Tell one of them (core/serviceLinks.ts `notify`); a process that is not connected hears nothing. */
  tell(service: string, event: TurnEnd): void
  /** A session's last turn as its engine recorded it (`CoreApi.transcripts.lastTurn`). */
  lastTurn(sessionId: string): Promise<LastTurnText | null>
  log?: (line: string) => void
}

export function createTurnEnds(deps: TurnEndsDeps) {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const listeners = new Set<(event: TurnEnd) => void>()
  /** The turn running in each session. */
  const open = new Map<string, OpenTurn>()
  /** The answers of the turns that ended last in each session, the latest last. */
  const done = new Map<string, Array<{ prompt: string; answer: string }>>()
  return {
    /** `CoreApi.turns.onEnd`. */
    onEnd(listener: (event: TurnEnd) => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    /** A turn began in [sessionId]: live, or ([resumed]) one the daemon found open at attach, which a restart interrupted. */
    started(sessionId: string, userMessage: string, resumed: boolean): void {
      open.delete(sessionId)
      open.set(sessionId, { prompt: promptHash(userMessage), partial: resumed, now: none(), before: none() })
      trim(open)
    },
    /** Its agent said [content] in the turn running in [sessionId]. */
    said(sessionId: string, content: string): void {
      const turn = open.get(sessionId), text = content.trim()
      if (turn && text) add(turn.now, text)
    },
    /** Its agent called a tool of its own: what it said until now was narration. */
    worked(sessionId: string): void {
      const turn = open.get(sessionId)
      if (!turn) return
      for (const part of turn.now.parts) add(turn.before, part)
      turn.now = none()
    },
    /** A live turn ended. A listener that throws costs that listener this end, never another listener or the funnel. An end whose
     *  start was never seen is told to nobody: nothing can say which turn it was. */
    ended(event: Omit<TurnEnd, 'prompt'>): void {
      const turn = open.get(event.sessionId)
      if (!turn) return
      open.delete(event.sessionId)
      if (!turn.partial) {
        const kept = done.get(event.sessionId) ?? []
        done.delete(event.sessionId)
        kept.push({ prompt: turn.prompt, answer: (turn.now.parts.length ? turn.now : turn.before).parts.join('\n\n').slice(0, ANSWER_KEEP_MAX) })
        if (kept.length > TURNS_KEPT) kept.shift()
        done.set(event.sessionId, kept)
        trim(done)
      }
      const told: TurnEnd = { ...event, prompt: turn.prompt }
      for (const listener of listeners) {
        try { listener(told) } catch (error) {
          log(`[turns] a turn-end listener failed on ${event.agentId.slice(0, 40)} · ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      for (const service of deps.hearers) deps.tell(service, told)
    },
    /** `CoreApi.turns.answerOf`: what the turn of [sessionId] that was asked [prompt] said last, as the core heard it; else, for
     *  a turn it did not see from its start or heard no words of, the session's last turn in its transcript if that is the one. */
    async answerOf(sessionId: string, prompt: string): Promise<string | null> {
      const kept = done.get(sessionId)?.findLast(turn => turn.prompt === prompt)
      if (kept?.answer) return kept.answer
      const last = await deps.lastTurn(sessionId)
      return (last && promptHash(last.userMessage) === prompt ? last.assistantText.trim().slice(0, ANSWER_KEEP_MAX) : '') || null
    },
  }
}

export type TurnEnds = ReturnType<typeof createTurnEnds>
