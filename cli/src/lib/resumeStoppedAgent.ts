import { isTerminalEngine } from '../engines/types.js'
import type { RegisteredSession, ProcessIdentity } from './registry.js'
import { resumesConversation } from './resumeCapability.js'
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
 * The proof is the engine process alive in this row's own pane — the bar `agent_restart` has cleared
 * for every engine for as long as it has existed. Claude and Codex were held to their `SessionStart`
 * hook instead; see the note at the check itself for why that is no longer a precondition.
 *
 * The budget is only reached when NO engine process was ever seen: the pane is up, and nothing this
 * row would recognise is running in it. That is the one state worth reporting as unconfirmed.
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
    // ONE proof, for every engine: this row's own engine process, running in this row's own pane,
    // which the checks above have just confirmed is alive. `deps.process()` resolves the engine
    // binary beneath THAT pane, so it cannot be answered by somebody else's shell.
    //
    // Claude and Codex used to be held to a stricter one — their `SessionStart` hook, carrying the
    // new pid, proving they had reopened this very conversation. It is better evidence, and it is
    // evidence that does not reliably come to a RESUME, which is a narrower thing than "has a
    // startup hook": opencode's plugin posts on `session.created`, which `--session <id>` never
    // emits; a claude hook can announce a transcript path that never appears and be dropped
    // (openharness#189); and measured on machine-remote-1, both resume-only codex rows carried
    // `lastHookAt: 0` while every fresh launch beside them had hooked. Waiting for it turned a
    // working harness into ten minutes of "Starting" and then a permanent "Start failed" over a pane
    // the person could type in — with `active` cleared and the desk refusing to open it, the cost of
    // the strict rule was never the resume, it was the harness. A resume that reopened the WRONG
    // conversation is still caught, by `registry.register`'s mismatch guard, when the hook arrives.
    if (process) return { ok: true, session: row, resumed: resumesConversation(saved.engine, saved.sessionId) }
    await deps.sleep(250)
  }
  return resumeUnconfirmed
}
