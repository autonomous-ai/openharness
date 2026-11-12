/**
 * Which sign-in is on this computer's disk, as the Swarm's loops tell a new one from the one the server refused (the reviews of
 * #4221): its epoch, minted when a person signs in and kept through every refresh, or for a session from before epochs a short
 * hash of its refresh token, which no line or field keeps. Null with none. A file read; no request.
 */
import { createHash } from 'node:crypto'
import { readAuthSession } from '../lib/authSession.js'

export function signInOnDisk(): string | null {
  const session = readAuthSession()
  if (!session) return null
  return session.signInEpoch ?? createHash('sha256').update(session.refreshToken ?? session.accessToken).digest('hex').slice(0, 16)
}
