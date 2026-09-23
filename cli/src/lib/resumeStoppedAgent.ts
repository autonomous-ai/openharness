import { isTerminalEngine } from '../engines/types.js'
import type { RegisteredSession, ProcessIdentity } from './registry.js'
import { confirmsResumeByHook, resumesConversation } from './resumeCapability.js'
import type { RestartAgentReply } from './restartAgent.js'
import type { RuntimeCheck } from './tmux.js'

export interface ResumeStoppedDeps {
  live: () => RegisteredSession | undefined
  saved: () => RegisteredSession | null
  current: () => boolean
  checkLive: (session: RegisteredSession) => Promise<RuntimeCheck>
  canLaunch: (saved: RegisteredSession) => Promise<boolean>
  /** Only called after the engine is confirmed gone; never destroys the surviving shell. */
  retain: (session: RegisteredSession) => Promise<void>
  waitForReady: (session: RegisteredSession) => Promise<RestartAgentReply>
  launch: (saved: RegisteredSession, resumeSessionId: string | undefined) => Promise<RestartAgentReply>
}

export const resumeChanged = { ok: false, error: 'AGENT_CHANGED', detail: 'The harness changed while opening. Select it again.' } as const
export const resumeUnconfirmed = { ok: false, error: 'RESUME_UNCONFIRMED', detail: 'The saved conversation has not been confirmed yet. Check the terminal, then select the harness again to check its status.' } as const

/** Enter means attach or exact resume. A route, shell or allocated pane alone is not success. */
export async function resumeStoppedAgent(deps: ResumeStoppedDeps): Promise<RestartAgentReply> {
  if (!deps.current()) return resumeChanged
  const existing = deps.live()
  let saved = deps.saved()
  if (existing) {
    // Compatibility with an archive written before surviving shells got a new identity.
    if (isTerminalEngine(existing.engine) && saved && !isTerminalEngine(saved.engine)) {
      await deps.retain(existing)
    } else if (existing.resumeOnly && existing.launch?.state === 'starting') {
      return deps.waitForReady(existing)
    } else {
      const runtime = await deps.checkLive(existing)
      if (!deps.current() || deps.live() !== existing) return resumeChanged
      if (runtime.state === 'unknown') return resumeUnconfirmed
      if (runtime.state === 'alive') {
        if (existing.resumeOnly && existing.launch?.state === 'failed') {
          // Still running and never disproved — only never confirmed (its startup hook was dropped).
          // Selecting it again asks for confirmation again rather than repeating the old verdict.
          return existing.launch.error === 'RESUME_UNCONFIRMED' ? deps.waitForReady(existing) : resumeUnconfirmed
        }
        return { ok: true, session: existing, resumed: true }
      }
      saved = { ...existing }
      await deps.retain(existing)
    }
  }
  if (!deps.current()) return resumeChanged
  if (!saved) return { ok: false, error: 'AGENT_NOT_FOUND', detail: 'The saved harness is no longer available.' }
  // No engine is refused here any more. An engine with a resume argv and a recorded id comes back
  // where it left off; one with neither still comes back — same pane, same folder, same name — as a
  // new conversation, which `resumed: false` and the client's wording say out loud. Refusing the
  // pause instead was the stricter rule: `agent_restart` has relaunched every engine this way for as
  // long as it has existed (`restartAgent.ts`).
  if (!await deps.canLaunch(saved)) {
    return { ok: false, error: 'AGENT_BUSY', detail: 'The previous process is still running or could not be checked. Wait for it to stop, then retry.' }
  }
  if (!deps.current()) return resumeChanged
  // Discovery won the race. Recheck it through the same verified attach path.
  if (deps.live()) return resumeStoppedAgent(deps)
  return deps.launch(saved, resumesConversation(saved.engine, saved.sessionId) ? saved.sessionId : undefined)
}

export interface ResumeReadinessDeps {
  current: () => boolean
  session: () => RegisteredSession | undefined
  process: () => Promise<ProcessIdentity | null>
  pane: () => Promise<{ dead: boolean; engineExit?: number | null } | null>
  sleep: (ms: number) => Promise<void>
  now?: () => number
  budgetMs?: number
}

/**
 * Wait for the replacement process to prove it came back.
 *
 * For an engine that hooks at LAUNCH, the proof is its `SessionStart` carrying the new pid: process
 * discovery and a resume argument alone do not prove the conversation loaded. An engine that hooks
 * later — or not at all — cannot produce that, and waiting for it turns a working resume into ten
 * minutes of "Starting"; there the live engine process in its own pane is the proof, which is the
 * bar `agent_restart` clears for every engine today. See `resumeCapability.ts`.
 */
export async function waitForResumedAgent(saved: RegisteredSession, deps: ResumeReadinessDeps): Promise<RestartAgentReply> {
  const now = deps.now ?? Date.now
  const until = now() + (deps.budgetMs ?? 10 * 60_000)
  while (now() < until) {
    if (!deps.current()) return resumeChanged
    const process = await deps.process()
    const pane = await deps.pane()
    if (!deps.current()) return resumeChanged
    const row = deps.session()
    if (!row) return { ok: false, error: 'RESUME_FAILED', detail: 'The resume runtime disappeared. The saved conversation is still retained.' }
    if (row.sessionId !== saved.sessionId || row.engine !== saved.engine) return resumeChanged
    if (row.launch?.state === 'failed') return { ok: false, error: row.launch.error, detail: row.launch.detail }
    if (!pane || pane.dead || pane.engineExit != null) {
      return { ok: false, error: 'RESUME_FAILED', detail: 'The agent exited before confirming the saved conversation. Its terminal output and conversation have been retained.' }
    }
    // Two things decide what proof is available. A conversation was only REQUESTED when the engine
    // can reopen one and a row recorded one — otherwise there is nothing for a hook to confirm and
    // the id it eventually reports is a new one by design. And only some engines hook at launch at
    // all. Where both hold, the hook carrying the new pid is the proof; everywhere else the engine
    // process alive in its own pane is, which is the bar `agent_restart` clears for every engine.
    const resumed = resumesConversation(saved.engine, saved.sessionId)
    if (process && resumed && confirmsResumeByHook(saved.engine)) {
      if (row.lastHookAt > 0 && row.launch?.state !== 'starting'
        && row.processIdentity?.pid === process.pid && row.processIdentity.startMarker === process.startMarker) {
        return { ok: true, session: row, resumed }
      }
    } else if (process) {
      // The row's own `processIdentity` stays null until a hook binds it (`resumePendingAgent`), so
      // the evidence here is the pane's engine process itself, checked against a pane confirmed
      // alive above.
      return { ok: true, session: row, resumed }
    }
    await deps.sleep(250)
  }
  return resumeUnconfirmed
}
