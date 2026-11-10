/**
 * Live turn ends, told to whoever listens: the services in the core's process, and the services in their own processes that asked
 * for them (`TURN_END_HEARERS`). The event funnel says each turn as it goes (core/turns/funnel.ts): its start, what its agent says,
 * the tools it calls, and its end; a turn read back from a transcript at attach is never one. A process that is not connected misses
 * an end, and costs that turn the answer it would have posted, nothing else: the core waits for nobody.
 *
 * Every real end is told, a turn that ends just before a queued follow-up starts included: each message a person sends an agent is
 * its own turn, and the Swarm host answers each in its own order (superTabs/agentReplies.ts). An end names its turn by a hash of its
 * prompt, which says which message it answers, and by a number, which tells it from another turn asked the same words; what the
 * turn said is kept here as it was said. The transcript cannot be asked for it: a follow-up that began at once
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
const SESSIONS_KEPT = 256
/** The engines whose texts reach the funnel as whole messages, each text a message the agent wrote. Another engine's may be chunks of
 *  one, which joined with paragraphs between would be mangled: its answer is read from its transcript when its turn ends. */
export const WHOLE_TEXT_ENGINES: ReadonlySet<string> = new Set(['claude', 'codex'])

/** Texts, and how long they are together: no more is kept than [ANSWER_KEEP_MAX], the last text cut to what is left of it, so
 *  that a text of megabytes is not held for the turn's length. */
interface Texts { parts: string[]; size: number }
const none = (): Texts => ({ parts: [], size: 0 })
const add = (texts: Texts, text: string): void => {
  const room = ANSWER_KEEP_MAX - texts.size
  if (room <= 0) return
  const part = text.length > room ? text.slice(0, room) : text
  texts.parts.push(part)
  texts.size += part.length
}

interface OpenTurn {
  prompt: string
  /** The number this turn is told by. */
  turnId: number
  /** A turn whose words are not kept: one the daemon picked up at attach, whose first part it never saw; one that began before anyone
   *  could ask for them (`hearing`); or an engine's whose texts are not whole messages. Named all the same, and answered from the
   *  transcript. */
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
  const done = new Map<string, Array<{ prompt: string; turnId: number; answer: string }>>()
  let turns = 0
  /** The services that hear turn ends and have connected in this core's life. Until one has, or something here listens, nobody can
   *  ask what a turn said, so what it says is not kept (a machine that never opens the Swarm pays nothing per text for it), and a
   *  Swarm process that goes and comes back still has the turns that began while it was away. A turn is named either way: it may
   *  end after one connects, and a daemon that restarted in the middle of one picks it up before its Swarm process is back. */
  const hearing = new Set<string>()
  const wanted = (): boolean => hearing.size > 0 || listeners.size > 0
  return {
    /** A service connected (each time): one of those that hear turn ends is from now on someone. */
    connected(service: string): void {
      if (deps.hearers.has(service)) hearing.add(service)
    },
    /** `CoreApi.turns.onEnd`. */
    onEnd(listener: (event: TurnEnd) => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    /** A turn began in [sessionId]: live, or ([partial]) one whose words are not kept whole: one the daemon found open at attach, which
     *  a restart interrupted, or an engine's whose texts are not whole messages (`WHOLE_TEXT_ENGINES`). Its words are kept only if
     *  someone can ask for them from its start. */
    started(sessionId: string, userMessage: string, partial: boolean): void {
      open.delete(sessionId)
      open.set(sessionId, { prompt: promptHash(userMessage), turnId: ++turns, partial: partial || !wanted(), now: none(), before: none() })
      trim(open)
    },
    /** Its agent said [content] in the turn running in [sessionId]: on the way ([commentary], what Codex says of what it is about to do)
     *  or not. What is said on the way is no part of an answer, as its engine reader reads a turn (lastCodexTurnText). */
    said(sessionId: string, content: string, commentary = false): void {
      const turn = open.get(sessionId)
      if (!turn || turn.partial || commentary) return
      const text = content.slice(0, ANSWER_KEEP_MAX).trim()
      if (text) add(turn.now, text)
    },
    /** Its agent called a tool of its own: what it said until now was narration. */
    worked(sessionId: string): void {
      const turn = open.get(sessionId)
      if (!turn || turn.partial) return
      for (const part of turn.now.parts) add(turn.before, part)
      turn.now.parts.length = 0
      turn.now.size = 0
    },
    /** A live turn ended. A listener that throws costs that listener this end, never another listener or the funnel. An end whose
     *  start was never seen is told to nobody: nothing can say which turn it was. */
    ended(event: Omit<TurnEnd, 'prompt' | 'turnId'>): void {
      const turn = open.get(event.sessionId)
      if (!turn) return
      open.delete(event.sessionId)
      // A turn whose words were not kept is kept without an answer, so that an earlier turn asked the same words is not given the
      // transcript's last turn, which may be this one's (answerOf).
      const kept = done.get(event.sessionId) ?? []
      done.delete(event.sessionId)
      kept.push({ prompt: turn.prompt, turnId: turn.turnId, answer: (turn.now.parts.length ? turn.now : turn.before).parts.join('\n\n').slice(0, ANSWER_KEEP_MAX) })
      if (kept.length > TURNS_KEPT) kept.shift()
      done.set(event.sessionId, kept)
      trim(done)
      const told: TurnEnd = { ...event, prompt: turn.prompt, turnId: turn.turnId }
      for (const listener of listeners) {
        try { listener(told) } catch (error) {
          log(`[turns] a turn-end listener failed on ${event.agentId.slice(0, 40)} · ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      for (const service of deps.hearers) deps.tell(service, told)
    },
    /** `CoreApi.turns.answerOf`: what the turn that ended [end] said, as the core heard it; else, for a turn it did not see from
     *  its start or heard no words of, the session's last turn in its transcript if that was asked [end]'s prompt. */
    async answerOf(end: Pick<TurnEnd, 'sessionId' | 'prompt' | 'turnId'>): Promise<string | null> {
      const ended = done.get(end.sessionId) ?? [], running = open.get(end.sessionId)
      const kept = ended.find(turn => turn.turnId === end.turnId && turn.prompt === end.prompt)
      if (kept?.answer) return kept.answer
      // The transcript's last turn is found by its prompt, which a later turn asked the same words may share: then it may be that
      // one's, and not this turn's to give.
      if (ended.some(turn => turn.turnId > end.turnId && turn.prompt === end.prompt) || (running && running.turnId > end.turnId && running.prompt === end.prompt)) return null
      const last = await deps.lastTurn(end.sessionId)
      return (last && promptHash(last.userMessage) === end.prompt ? last.assistantText.trim().slice(0, ANSWER_KEEP_MAX) : '') || null
    },
  }
}

export type TurnEnds = ReturnType<typeof createTurnEnds>
