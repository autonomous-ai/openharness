/**
 * Which sign-in is on this computer's disk, and which write of it, as the Swarm's loops tell a new or refreshed session from the
 * one the server refused (the reviews of #4221): its epoch, minted when a person signs in, or for a session from before epochs a
 * short hash of its refresh token, which no line or field keeps; and when the session was last written, which a refresh moves
 * (the fifth review: a refresh kept the same epoch). Null with none. A file read; no request.
 */
import { createHash } from 'node:crypto'
import { readAuthSession } from '../lib/authSession.js'

export function signInOnDisk(): string | null {
  const session = readAuthSession()
  if (!session) return null
  const signIn = session.signInEpoch ?? createHash('sha256').update(session.refreshToken ?? session.accessToken).digest('hex').slice(0, 16)
  return `${signIn}:${session.updatedAt}`
}
