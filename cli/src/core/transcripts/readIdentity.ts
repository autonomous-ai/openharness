import type { RegisteredSession } from '../../lib/registry.js'
import { processIdentityKey } from '../../lib/terminalRuntime.js'

/** Copy before yielding: registry rows can be mutated in place while a worker is reading. */
export function transcriptReadIdentity(session: RegisteredSession | undefined): string {
  return session ? JSON.stringify([session.agentId, session.sessionId, session.engine, session.transcriptPath,
    session.codexHome, session.boundAt,
    session.processIdentity ? processIdentityKey(session.engine, session.processIdentity) : undefined,
    ...(session.identityHold ? ['identity-held'] : []),
    ...(session.evidenceRevision === undefined ? [] : [session.evidenceRevision])]) : ''
}

/** A pane belongs to its process, conversation and current terminal routes. Copy before capture. */
export function paneReadIdentity(session: RegisteredSession | undefined): string {
  return session ? JSON.stringify([transcriptReadIdentity(session), session.active, session.cwd, session.hermesHome,
    session.tmuxPane, session.primaryRuntimeKey, session.runtimes]) : ''
}
