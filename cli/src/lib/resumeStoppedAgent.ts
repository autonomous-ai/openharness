import { LAUNCH_RESUME_FLAG } from './engineLaunch.js'
import { isTerminalEngine } from '../engines/types.js'
import type { RegisteredSession } from './registry.js'
import type { RestartAgentReply } from './restartAgent.js'

export interface ResumeStoppedDeps {
  live: () => RegisteredSession | undefined
  saved: () => RegisteredSession | null
  current: () => boolean
  canLaunch: (saved: RegisteredSession) => Promise<boolean>
  launch: (saved: RegisteredSession, resumeSessionId: string | undefined) => Promise<RestartAgentReply>
}

/** Enter means attach or resume. There is deliberately no fresh-conversation fallback. */
export async function resumeStoppedAgent(deps: ResumeStoppedDeps): Promise<RestartAgentReply> {
  const existing = deps.live()
  if (existing) return { ok: true, session: existing, resumed: true }
  const saved = deps.saved()
  if (!saved) return { ok: false, error: 'AGENT_NOT_FOUND', detail: 'The saved harness is no longer available.' }
  if (!isTerminalEngine(saved.engine) && (!saved.sessionId || !LAUNCH_RESUME_FLAG[saved.engine])) {
    return { ok: false, error: 'RESUME_UNAVAILABLE', detail: 'This harness has no resumable conversation. You can start a new conversation separately.' }
  }
  if (!await deps.canLaunch(saved)) {
    return { ok: false, error: 'AGENT_BUSY', detail: 'The previous process has not stopped yet. Try again when it has finished.' }
  }
  if (!deps.current()) return { ok: false, error: 'AGENT_CHANGED' }
  // Another client or discovery may have restored it while the process was checked.
  const attached = deps.live()
  if (attached) return { ok: true, session: attached, resumed: true }
  return deps.launch(saved, isTerminalEngine(saved.engine) ? undefined : saved.sessionId)
}
