import type { RegisteredSession } from '../../lib/registry.js'
/** Registry records can change in place while an engine answers. Retain scalar identity, never an alias. */
export function sessionBinding(session: RegisteredSession | undefined): string {
  return session ? JSON.stringify([session.agentId, session.sessionId, session.engine, session.active,
    session.registeredAt, session.boundAt, session.transcriptPath, session.tmuxPane,
    session.primaryRuntimeKey, session.runtimes, session.processIdentity]) : ''
}
