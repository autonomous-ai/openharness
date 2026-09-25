/**
 * How much of a paused harness can be brought back, per engine.
 *
 * What counts as PROOF that it came back is no longer an engine-by-engine question and does not
 * live here: one verified engine process in the row's own pane answers it for all of them (see
 * `resumeStoppedAgent.ts`).
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
