/**
 * Each session's engine state: Claude Code's and Codex's live parser (or the handle of one in their worker), and the
 * other engines' streams in theirs (core/engines/otherStreams.ts). One table, so the questions asked of all of them —
 * does this session have any, is its turn open, forget it, close its turn, stop them all — each have one answer.
 *
 * Moved out of `runForeground` (the core boundary, step 4: docs/design/2026-10-03-harnessd.md). The other fourteen
 * engines' normalizers and readers left for their worker (docs/design/2026-11-15-core-plan/engines.md, step 1b).
 */
import type { LiveState } from '../../engines/facets/live.js'
import type { OtherStreams } from '../engines/otherStreams.js'
import type { TurnHooks } from '../turns/turnHooks.js'

export function createSessionNormalizers(others: Pick<OtherStreams, 'get' | 'has' | 'forget' | 'stop'>,
  turns?: Pick<TurnHooks, 'held' | 'closed' | 'forget'>) {
  // Per-session web turn-lifecycle state; the device mirror keeps its own state + recap.
  const liveParsers = new Map<string, LiveState>()

  /** Whether this session's engine state says a turn is open right now, whichever engine it is. A turn whose end is
   *  held for its Stop is open, whatever its parser says (core/turns/turnHooks.ts). */
  const sessionTurnState = (sessionId: string): boolean | undefined =>
    turns?.held(sessionId) || (liveParsers.get(sessionId)?.turnOpen ?? others.get(sessionId)?.turnOpen)
  const sessionTurnOpen = (sessionId: string): boolean => sessionTurnState(sessionId) ?? false

  /** Whether any engine state exists for this session: an attach that finds some is not a first one. */
  const hasState = (sessionId: string): boolean => liveParsers.has(sessionId) || others.has(sessionId)

  /** Drop all of a forgotten session's engine state; its stream in the other engines' worker is told to stop. */
  const forget = (sessionId: string): void => {
    liveParsers.delete(sessionId)
    others.forget(sessionId)
    turns?.forget(sessionId)
  }

  /** Mark the session's turn closed in whichever engine holds it (a cancel). Nothing it closes is emitted: a cancel
   *  sends no turn end, and an end held for its Stop is dropped. */
  const closeTurns = (sessionId: string): void => {
    liveParsers.get(sessionId)?.closeTurn('cancel')
    others.get(sessionId)?.closeTurn('cancel')
    turns?.closed(sessionId)
  }

  /** Stop following every other engine's stream (shutdown, and the handoff to an update). */
  const stopPollers = (): void => others.stop()

  return { liveParsers, sessionTurnState, sessionTurnOpen, hasState, forget, closeTurns, stopPollers }
}

export type SessionNormalizers = ReturnType<typeof createSessionNormalizers>
