import type { IncomingMessage } from 'node:http'
import { hookCredentialMatches, readHookCredential } from './hookAuth.js'

/**
 * The daemon's local credential: what a process must show to use its loopback TCP API (REST and the
 * local WebSocket). It is the 0600, uid-checked `hook-credential` file in the data dir
 * (lib/hookAuth.ts), so a process of THIS OS user reads it and any other user's process cannot —
 * which is the whole point once another account's harnesses run as their own OS user on this machine
 * (docs/plans/2026-10-19-guest-machine-sharing-plan.md, "Loopback credential"). The daemon's Unix socket
 * (lib/localSocket.ts) needs none: the filesystem already says who is on it.
 *
 * Sent as `X-Harness-Local: <credential>`, or `Authorization: Bearer <credential>` for a client that
 * can only set that one.
 */
export const LOCAL_CREDENTIAL_HEADER = 'X-Harness-Local'

/** What a refused request is answered. */
export const LOCAL_CREDENTIAL_REQUIRED = 'LOCAL_CREDENTIAL_REQUIRED'

/** The credential as a client reads it, or null when this process may not (another OS user, no file). */
export function readLocalCredential(dataDir: string): string | null {
  return readHookCredential(dataDir)
}

/** The headers a client adds to every loopback TCP request: none when it cannot read the credential. */
export function localCredentialHeaders(dataDir: string): Record<string, string> {
  const credential = readLocalCredential(dataDir)
  return credential ? { [LOCAL_CREDENTIAL_HEADER]: credential } : {}
}

/** The credential a request carries, if any: the named header first, else a bearer. */
export function suppliedLocalCredential(req: Pick<IncomingMessage, 'headers'>): string | undefined {
  const named = req.headers[LOCAL_CREDENTIAL_HEADER.toLowerCase()]
  if (typeof named === 'string' && named) return named
  const auth = req.headers.authorization
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined
}

/** Whether [req] carries [expected], compared in constant time. */
export function localCredentialMatches(expected: string, req: Pick<IncomingMessage, 'headers'>): boolean {
  return hookCredentialMatches(expected, suppliedLocalCredential(req))
}
