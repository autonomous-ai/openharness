/**
 * The Hermes store a REGISTERED session reads from, found once and remembered.
 *
 * `engines/hermes/home.ts` answers "which home holds this session" by looking; this is the half that
 * knows about the registry, so the answer is filled onto the row (`RegisteredSession.hermesHome`) and
 * the next caller pays nothing. Kept out of the engine folder for the same reason the readers are:
 * an engine module reads its own files and knows nothing about agents.
 *
 * Every Hermes-shaped read goes through here — the live mirror, `agent_recent`, the recap fallback —
 * so a profile agent's history is read from ITS store rather than from the default one, which is what
 * left those agents' activity cards empty forever (openharness#191).
 */

import { findHermesHomeForSession, hermesDbPath } from '../engines/hermes/home.js'
import { env } from '../config/env.js'
import { registry, type RegisteredSession } from './registry.js'

/** In flight right now, so N pollers asking at once cost one scan. Keyed by session id. */
const pending = new Map<string, Promise<string>>()

/**
 * The home for a session: what the row already knows, else whichever store holds it, else the default.
 *
 * Falling back to the default home is deliberate — it is what every caller did before this existed, so
 * a machine with one home behaves exactly as it did, and a session whose row has not landed yet reads
 * the same store it would have read anyway. Nothing is remembered in that case: the row lands a moment
 * later and the next call finds it.
 */
export async function hermesHomeForSession(session: Pick<RegisteredSession, 'agentId' | 'sessionId' | 'hermesHome'>): Promise<string> {
  if (session.hermesHome) return session.hermesHome
  const sessionId = session.sessionId
  if (!sessionId) return env.HERMES_HOME
  const existing = pending.get(sessionId)
  if (existing) return existing
  const lookup = findHermesHomeForSession(sessionId)
    .then((home) => {
      if (!home) return env.HERMES_HOME
      // Only a home other than the default is worth a row write: `hermesHome` null means "the default",
      // and writing the default into every row would be noise on every single-home machine.
      if (home !== env.HERMES_HOME && session.agentId) registry.setHermesHome(session.agentId, home)
      return home
    })
    .catch(() => env.HERMES_HOME)
    .finally(() => { pending.delete(sessionId) })
  pending.set(sessionId, lookup)
  return lookup
}

/** The store path for a session — what the readers actually take. */
export async function hermesDbForSession(session: Pick<RegisteredSession, 'agentId' | 'sessionId' | 'hermesHome'>): Promise<string> {
  return hermesDbPath(await hermesHomeForSession(session))
}
