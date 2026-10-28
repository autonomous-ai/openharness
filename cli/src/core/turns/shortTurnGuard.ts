/**
 * The short-turn guard: an agent whose turns keep ending in seconds and starting again at once is held from
 * automatic input for a while, so no path that types into it on its own can loop.
 *
 * Diego's daily report, 2026-10-28: 106k turns in a day against 1.2k–4.9k a day the week before, 104.5k of them
 * under 10 s, from a few macOS computers. The paths that type into an agent on their own (Swarm messages, Agent
 * Messages) each send once per message, but nothing stopped them typing again and again into an agent whose
 * every turn ends at once. Ten turns in a row, each under 10 s and starting within 10 s of the one before, is not a
 * person's pace: the agent's automatic input is held for 30 s, doubling while it goes on, up to 30 minutes. A turn
 * of 10 s or more lifts it. A person's input is never held.
 *
 * The log line has one fixed shape, so the prod watch can count it by session and agent.
 */
import { sid } from '../../lib/log.js'

export const SHORT_TURN_MS = 10_000
export const LOOP_TURNS = 10
const HOLD_FIRST_MS = 30_000
const HOLD_MAX_MS = 30 * 60_000
/** Sessions remembered; past it the oldest is forgotten. A daemon runs tens of agents. */
const KEPT = 1_000

interface Turns { agentId: string; startedAt?: number; endedAt?: number; streak: number; trips: number; holdUntil: number }

export interface ShortTurnGuardDeps {
  now: () => number
  log: (line: string) => void
}

export function createShortTurnGuard({ now, log }: ShortTurnGuardDeps) {
  const sessions = new Map<string, Turns>()
  return {
    get size(): number { return sessions.size },

    /** A turn started now (never a replayed one). */
    started(sessionId: string, agentId: string): void {
      let turns = sessions.get(sessionId)
      if (!turns) {
        turns = { agentId, streak: 0, trips: 0, holdUntil: 0 }
        sessions.set(sessionId, turns)
        if (sessions.size > KEPT) sessions.delete(sessions.keys().next().value!)
      }
      turns.agentId = agentId
      // Not back to back: the count starts again, the backoff stays (a held agent's pause is its hold).
      if (turns.endedAt === undefined || now() - turns.endedAt >= SHORT_TURN_MS) turns.streak = 0
      turns.startedAt = now()
    },

    ended(sessionId: string): void {
      const turns = sessions.get(sessionId)
      if (turns?.startedAt === undefined) return
      const lasted = now() - turns.startedAt
      turns.startedAt = undefined
      turns.endedAt = now()
      if (lasted >= SHORT_TURN_MS) { turns.streak = 0; turns.trips = 0; turns.holdUntil = 0; return }
      if (++turns.streak < LOOP_TURNS) return
      const hold = Math.min(HOLD_MAX_MS, HOLD_FIRST_MS * 2 ** turns.trips++)
      turns.holdUntil = now() + hold
      turns.streak = 0
      log(`[turn-guard] loop session=${sid(sessionId)} agent=${sid(turns.agentId)} turns=${LOOP_TURNS} hold=${hold / 1000}s`)
    },

    /** How long automatic input to the agent is still held, in ms; 0 when it is not. */
    holding(sessionId: string): number {
      const turns = sessions.get(sessionId)
      return turns ? Math.max(0, turns.holdUntil - now()) : 0
    },
  }
}

export type ShortTurnGuard = ReturnType<typeof createShortTurnGuard>
