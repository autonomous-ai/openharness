import type { RegisteredSession } from '../../lib/registry.js'
import { processIdentityKey } from '../../lib/terminalRuntime.js'

/** Copy before yielding: registry rows can be mutated in place while a worker is reading. */
export function transcriptReadIdentity(session: RegisteredSession | undefined): string {
  return session ? JSON.stringify([session.agentId, session.sessionId, session.engine, session.transcriptPath,
    session.codexHome, session.boundAt,
    session.processIdentity ? processIdentityKey(session.engine, session.processIdentity) : undefined]) : ''
}
