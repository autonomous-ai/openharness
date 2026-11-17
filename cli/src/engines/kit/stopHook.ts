/**
 * What a Stop or StopFailure hook means for an engine whose contract says its Stop closes turns
 * (facets/hooks.ts `stopClosesTurns`): Claude Code's. Turn mechanics only, on core's immutable turn
 * snapshots, the end it holds for the Stop and its atomic close (core/turns/turnHooks.ts), so it runs in core with
 * no engine code. Moved from engines/claude/hooks.ts.
 */
import { sid } from '../../lib/log.js'
import type { HookStop, HookTurnContext } from '../facets/hooks.js'
import type { LiveTurn } from '../facets/live.js'

/** Capture the arrival's turn before the first await: a drain can open the next turn. */
export async function closeTurnOnStop(
  { turnState, closeTurn, latestPromptAt, drain, noteEngineStopped, emit, graceMs, heldEnd, heldEndWithin, deliverHeldEnd,
    subagentsRun, heldBeforeHook }: HookTurnContext,
  { sessionId, status, firedAt }: HookStop,
): Promise<void> {
  const hook = status === 'error' ? 'StopFailure' : 'Stop'
  // A lead whose subagents run has not finished: its end stays held, and its first Stop with none running, after its
  // wrap-up, ends the turn. A failure ends it whatever runs.
  if (hook === 'Stop' && subagentsRun(sessionId)) { console.log(`[turn] ${sid(sessionId)} Stop left its turn open · subagents run`); return }
  // A Stop closes only the turn it is about. Found by the soak run (e2e/endurance.e2e.ts): under load a turn's
  // Stop reached the daemon 6 s late, after the next prompt's turn had opened, and force-closed that turn
  // with a question open in it, which was then never shown. So:
  // - a Stop its engine ran before the session's latest prompt hook is about an earlier turn, and closes
  //   nothing (the time each hook was run comes with it, hook/notify.mjs);
  // - otherwise it is about the turn whose end is held, else the turn open as it arrives, and not one opened after
  //   that (read in the drain below), whose prompt hook has not come in yet; a StopFailure closes whichever turn is
  //   open or held.
  // - nor, a failure included, a turn its engine opened after it ran the Stop (the opening record's own time):
  //   the same-words end to end run under load (2026-11-10) had a Stop arrive after the queued next turn was read
  //   opening but before that turn's prompt hook, so the check above could not tell, and it force-closed the next
  //   turn 2.5 s in, losing its reply and the question open in it. The record's time, not when the daemon read it:
  //   a turn's own Stop, or a fast StopFailure, runs after its record is written however late it is read. It also
  //   keeps a /goal pass a blocking Stop hook continued from the Stop of the pass before, which reached the daemon
  //   520 ms after the pass began (end to end, under load). (core/AGENTS.md rule 7.)
  // A turn left open with no end of its own is closed by the next prompt (lib/normalize.ts).
  type Turn = { identity?: string; openedAt?: number }
  const stale = firedAt !== undefined && (latestPromptAt(sessionId) ?? 0) > firedAt
  const openedAfter = (st: Turn): boolean => firedAt !== undefined && st.openedAt !== undefined && st.openedAt > firedAt
  const arrived = turnState(sessionId), held = heldEnd(sessionId)
  const about = held ? held.identity : arrived?.turnOpen ? arrived.identity : null
  const itsTurn = (st: Turn): boolean => !stale && !openedAfter(st) && (status === 'error' || (about !== null && st.identity === about))
  /** Says so when the open turn's own opening time is what kept the hook from closing it. */
  const leftAsLater = (st: LiveTurn | undefined): void => {
    if (st?.turnOpen && !stale && openedAfter(st)) console.log(`[turn] ${sid(sessionId)} ${hook} ran before the open turn opened: left open`)
  }
  /** The end the transcript read for this Stop's turn goes on. */
  const delivered = (): boolean => {
    const end = heldEnd(sessionId)
    return !!end && itsTurn(end) && deliverHeldEnd(sessionId)
  }
  await drain(sessionId)
  // A Stop hook is the one precise "the engine stopped writing" signal we get. When the mirror is
  // HOLDING a turn-end for finished async sub-agents, this is what tells it the wrap-up message is
  // on disk — without it the recap fires on its settle timer and can beat claude's closing summary
  // to the punch (measured: recap at 10:18:41, wrap-up written at 10:18:44).
  noteEngineStopped(sessionId)
  // The lead's wrap-up after its last subagent lands about 200 ms after this Stop (lib/commander.ts): an end held
  // since before an earlier hook of its turn comes before it.
  if (heldBeforeHook) { await new Promise(resolve => setTimeout(resolve, graceMs)); await drain(sessionId) }
  if (delivered()) return
  const open = turnState(sessionId)
  if (!open?.turnOpen || !itsTurn(open)) { leftAsLater(open); return } // its end already went on → nothing to do
  // Still open: the Stop hook beats the transcript's final text by about 200 ms (lib/commander.ts). Its end goes on
  // the moment it is read; none within the grace, a re-poll, and only then a force-close of a wedged turn, whose
  // assistant text is on disk by now.
  if (!await heldEndWithin(sessionId, graceMs)) await drain(sessionId)
  if (delivered()) return
  const st = turnState(sessionId)
  if (st?.turnOpen && itsTurn(st) && closeTurn(sessionId, st.identity)) {
    console.log(`[turn] ${sid(sessionId)} force-closed by ${hook} hook (after grace)`)
    emit(sessionId, [{ type: 'turn_ended', payload: {} }])
  } else leftAsLater(st)
}
