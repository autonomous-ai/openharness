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

/**
 * Whether a read begun on [session] (a history page, a last turn) still answers for [later], the row its id names once
 * the read is done. Its conversation being bound is no change: a resume its own process confirmed is attached unbound
 * (`boundAt: null`) until that process's first hook or Hermes's terminal record binds it, the same conversation read
 * the same way. A stream is no such read: the binding attaches it again. Copy before yielding.
 */
export function readStillCurrent(session: RegisteredSession): (later: RegisteredSession | undefined) => boolean {
  const identity = transcriptReadIdentity(session), unbound = session.boundAt == null
  return (later) => transcriptReadIdentity(unbound && later ? { ...later, boundAt: null } : later) === identity
}

/** A pane belongs to its process, conversation and current terminal routes. Copy before capture. */
export function paneReadIdentity(session: RegisteredSession | undefined): string {
  return session ? JSON.stringify([transcriptReadIdentity(session), session.active, session.cwd, session.hermesHome,
    session.tmuxPane, session.primaryRuntimeKey, session.runtimes]) : ''
}
