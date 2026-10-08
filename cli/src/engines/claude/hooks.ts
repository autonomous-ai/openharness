import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { sid } from '../../lib/log.js'
import type { LiveTurn } from '../facets/live.js'
import type { EngineHooks, HookSession, HookStop, HookTurnContext } from '../facets/hooks.js'
import { installSessionHooks } from './installHooks.js'

/**
 * `claude --resume` from a folder other than the conversation's own: Claude Code announces a transcript
 * under the CURRENT cwd's project dir, then keeps writing the original file (measured: a resume of
 * 73f090ca from `cli/` announced `…-openharness-cli/73f090ca.jsonl`, and every later turn still landed
 * in `…-openharness/73f090ca.jsonl`). The announced file never appears, the hook is dropped, and the
 * resume is never confirmed — "Start failed" over a pane that is working. The row being resumed already
 * knows the real file; take it when it names this very conversation.
 */
export function transcriptFor(body: HookSession, agent: HookSession | undefined): string | undefined {
  const announced = body.transcriptPath ?? undefined
  if (!announced || existsSync(announced)) return announced
  const known = agent?.transcriptPath
  if (!known || !body.sessionId || agent.sessionId !== body.sessionId) return announced
  if (basename(known) !== `${body.sessionId}.jsonl` || !existsSync(known)) return announced
  return known
}

/** Capture the arrival's turn before the first await: a drain can open the next turn. */
async function onStop(
  { turnState, closeTurn, latestPromptAt, drain, noteEngineStopped, emit, graceMs }: HookTurnContext,
  { sessionId, status, firedAt }: HookStop,
): Promise<void> {
  // A pass a blocking Stop hook continued (a /goal loop) is the transcript's to close, by its end_turn or
  // turn_duration: the Stop of the pass before it reached the daemon 520 ms after it began (end to end,
  // under load) and force-closed it while it ran. Only a StopFailure still closes one here.
  const leftToTranscript = (st: LiveTurn): boolean => st.continued === true && status !== 'error'
  // A Stop closes only the turn it is about. Found by the soak run (e2e/endurance.e2e.ts): under load a turn's
  // Stop reached the daemon 6 s late, after the next prompt's turn had opened, and force-closed that turn
  // with a question open in it, which was then never shown. So:
  // - a Stop its engine ran before the session's latest prompt hook is about an earlier turn, and closes
  //   nothing (the time each hook was run comes with it, hook/notify.mjs);
  // - otherwise it is about the turn open as it arrives, and not one opened after that (read in the drain
  //   below), whose prompt hook has not come in yet; a StopFailure closes whichever turn is open.
  // A turn left open with no end of its own is closed by the next prompt (lib/normalize.ts).
  const stale = firedAt !== undefined && (latestPromptAt(sessionId) ?? 0) > firedAt
  const arrived = turnState(sessionId)
  const about = arrived?.turnOpen ? arrived.identity : null
  const itsTurn = (st: LiveTurn): boolean => !stale && (status === 'error' || (about !== null && st.identity === about))
  await drain(sessionId)
  // A Stop hook is the one precise "the engine stopped writing" signal we get. When the mirror is
  // HOLDING a turn-end for finished async sub-agents, this is what tells it the wrap-up message is
  // on disk — without it the recap fires on its settle timer and can beat claude's closing summary
  // to the punch (measured: recap at 10:18:41, wrap-up written at 10:18:44).
  noteEngineStopped(sessionId)
  const open = turnState(sessionId)
  if (!open?.turnOpen || leftToTranscript(open) || !itsTurn(open)) return // natural JSONL close already won → nothing to do
  // Still open: the transcript may just be lagging the Stop hook. Wait, re-poll, and only force-close
  // if it STILL hasn't closed — a genuinely wedged turn, whose assistant text is on disk by now.
  await new Promise((r) => setTimeout(r, graceMs))
  await drain(sessionId)
  const st = turnState(sessionId)
  if (st?.turnOpen && !leftToTranscript(st) && itsTurn(st) && closeTurn(sessionId, st.identity)) {
    console.log(`[turn] ${sid(sessionId)} force-closed by ${status === 'error' ? 'StopFailure' : 'Stop'} hook (after grace)`)
    emit(sessionId, [{ type: 'turn_ended', payload: {} }])
  }
}

export const hooks: EngineHooks = {
  install: installSessionHooks,
  installIn: (port, home) => installSessionHooks(port, join(home, 'settings.json')),
  transcriptFor,
  onStop,
}
