import type { RegisteredSession } from '../../lib/registry.js'
/** Registry records can change in place while an engine answers. Retain scalar identity, never an alias. */
export function sessionBinding(session: RegisteredSession | undefined): string {
  return session ? JSON.stringify([session.agentId, session.sessionId, session.engine, session.active,
    session.registeredAt, session.boundAt, session.transcriptPath, session.tmuxPane,
    session.primaryRuntimeKey, session.runtimes, session.processIdentity]) : ''
}

/**
 * The record a write begun under `typed` finishes under: `now` when it is `typed`'s launch, bound since,
 * otherwise `typed` itself, whose binding a fenced reading then refuses. An engine draws its composer
 * before its first hook binds the conversation, so a message typed in that gap sees its record rebuilt
 * before the Enter, the same agent in the same pane and process. A first startup can finish this
 * intent; a rebind, a rotation, another pane or another process cannot resume it.
 */
export function launchBound(typed: RegisteredSession, now: RegisteredSession | undefined): RegisteredSession {
  const starting = typed.launch !== undefined && typed.boundAt === null
  return starting && now !== undefined && now.agentId === typed.agentId && now.engine === typed.engine
    && now.registeredAt === typed.registeredAt && now.tmuxPane === typed.tmuxPane && now.primaryRuntimeKey === typed.primaryRuntimeKey
    // Unknown while starting, a process found since is the one the pane started; one known when typed must stay.
    && (!typed.processIdentity || JSON.stringify(now.processIdentity) === JSON.stringify(typed.processIdentity))
    ? now : typed
}
