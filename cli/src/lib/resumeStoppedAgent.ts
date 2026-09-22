import { isTerminalEngine } from '../engines/types.js'
import type { RegisteredSession, ProcessIdentity } from './registry.js'
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
  if (!isTerminalEngine(saved.engine) && (!saved.sessionId || !['claude', 'codex'].includes(saved.engine))) {
    return { ok: false, error: 'RESUME_UNAVAILABLE', detail: 'This harness has no supported saved conversation to resume. Start a new conversation separately.' }
  }
  if (!await deps.canLaunch(saved)) {
    return { ok: false, error: 'AGENT_BUSY', detail: 'The previous process is still running or could not be checked. Wait for it to stop, then retry.' }
  }
  if (!deps.current()) return resumeChanged
  // Discovery won the race. Recheck it through the same verified attach path.
  if (deps.live()) return resumeStoppedAgent(deps)
  return deps.launch(saved, isTerminalEngine(saved.engine) ? undefined : saved.sessionId)
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

/** SessionStart from the new process must confirm the requested vendor conversation.
 * Process discovery and a resume argument alone do not prove that it loaded. */
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
    if (process && row.lastHookAt > 0 && row.launch?.state !== 'starting'
      && row.processIdentity?.pid === process.pid && row.processIdentity.startMarker === process.startMarker) {
      return { ok: true, session: row, resumed: true }
    }
    await deps.sleep(250)
  }
  return resumeUnconfirmed
}
