/**
 * How much of a paused harness can be brought back, per engine, and what counts as proof that it
 * came back.
 *
 * Pause/Resume used to be offered for claude and codex alone. Every other engine was refused at
 * `resumeStoppedAgent`, which is stricter than the rest of the daemon already is: `agent_restart`
 * and the post-reboot restore relaunch EVERY engine with its own resume argv and fall back to a
 * fresh session when that fails (`restartAgent.ts`, `restoreAgents.ts`). This module is the one
 * place that says what each engine can promise, so Pause, the wire frame and the desktop's wording
 * all read the same answer instead of three copies of an engine list.
 */

import { isTerminalEngine, type AgentEngine } from '../engines/types.js'
import { supportsLaunchResume } from './engineLaunch.js'

/**
 * - `shell` — a terminal. There is no conversation; relaunching the login shell in the same pane IS
 *   the resume, and what is lost (the scrollback, whatever was running) is what Stop Terminal
 *   already says is lost.
 * - `conversation` — the engine has a documented resume argv (`LAUNCH_RESUME_FLAG`), so a paused
 *   harness with a recorded session id comes back where it left off.
 * - `fresh` — no resume argv exists for this engine (today: `devin`). Pausing still works and the
 *   harness still comes back — same pane, same folder, same name — but as a NEW conversation, and
 *   every surface says so rather than refusing a person the pause.
 */
export type ResumeMode = 'shell' | 'conversation' | 'fresh'

export function resumeMode(engine: AgentEngine): ResumeMode {
  if (isTerminalEngine(engine)) return 'shell'
  return supportsLaunchResume(engine) ? 'conversation' : 'fresh'
}

/** Whether THIS resume is bringing a conversation back, for the row it is resuming. An engine that
 *  could resume one but never recorded an id is in the same position as one with no resume argv. */
export function resumesConversation(engine: AgentEngine, sessionId: string | null | undefined): boolean {
  return resumeMode(engine) === 'conversation' && !!sessionId
}

/**
 * Whether this engine's startup hook fires on a RESUMED launch, so `SessionStart` carrying the new
 * pid is proof that it reopened the requested conversation.
 *
 * Measured, not assumed — and the measurement is narrower than "has a startup hook". OpenCode's
 * plugin posts on `session.created`, which a resume does not emit: relaunched with `--session <id>`
 * it re-attaches the conversation it already has, sends nothing, and a resume waiting for that hook
 * sat there until its ten-minute budget ran out (measured 2026-09-23, `scripts/pause-resume-e2e.mts`
 * against a bound opencode session). Copilot's `sessionStart` fires after the first prompt; pi's and
 * amp's plugins post on a turn; muse has no hooks at all (`sessionRepair.ts`: its store scan is "the
 * ONLY way a muse pane is ever bound").
 *
 * That leaves claude and codex, the two the strict path was written for and has always been proven
 * with. For every other engine the live engine process in its own pane is the proof — exactly the
 * bar `agent_restart` clears for all of them today (`restartAgent.ts` waits for the process and
 * nothing else). A new engine defaults to the weaker proof, which fails towards "answers in a
 * second" rather than "hangs for ten minutes".
 */
export function confirmsResumeByHook(engine: AgentEngine): boolean {
  return engine === 'claude' || engine === 'codex'
}

/**
 * Whether a resumed row must WAIT for that hook before anything may call it started.
 *
 * Both halves have to hold: a conversation was actually requested (so there is something for a hook
 * to confirm), and this engine hooks at launch. Where either fails, the engine process alive in the
 * row's own pane is the proof, and whoever observes it says so.
 *
 * The one place this is read from is worth naming, because getting it wrong is invisible until a
 * person is looking at it: a strict-resume row that nobody marks ready stays `launch: starting`,
 * which every surface renders as "Starting" for ever. Measured 2026-09-23 — an opencode harness
 * opened from the catalog, then brought back by the post-reboot restore, sat at "Starting" while its
 * engine was up and typeable, because restore marks every row `starting` and hands the flip to
 * discovery, and discovery refused it for being resume-only. opencode's plugin posts on
 * `session.created`, which relaunching with `--session <id>` never emits, so the hook it was waiting
 * for was never coming.
 */
export function awaitsResumeHook(engine: AgentEngine, sessionId: string | null | undefined): boolean {
  return resumesConversation(engine, sessionId) && confirmsResumeByHook(engine)
}
