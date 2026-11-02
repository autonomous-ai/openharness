import type { IncomingMessage } from 'node:http'
import { hookCredentialMatches, readHookCredential } from './hookAuth.js'
import { unixSocketPath } from './localSocket.js'

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
 *
 * Reaching a port proves nothing: another account can bind it while the daemon restarts, and would hear the credential
 * (audit H1). So where the socket or, on Windows, the pipe can exist, nothing here adds the credential to a TCP request,
 * and clients use them (lib/localTransport.ts). The daemon also refuses it from another account (lib/peerAccount.ts), for
 * old clients.
 */
export const LOCAL_CREDENTIAL_HEADER = 'X-Harness-Local'

/** What a refused request is answered. */
export const LOCAL_CREDENTIAL_REQUIRED = 'LOCAL_CREDENTIAL_REQUIRED'

/** The credential as a client reads it, or null when this process may not (another OS user, no file). */
export function readLocalCredential(dataDir: string): string | null {
  return readHookCredential(dataDir)
}

/**
 * The headers a client adds to a loopback TCP request: none when it cannot read the credential, none on Windows, and none
 * on macOS and Linux unless the data folder's path is too long to hold the socket, the one case with no way but TCP.
 * Windows clients reach the daemon over its proven pipe (lib/localTransport.ts): the Team account's daemon starts at boot,
 * before the owner's, and can hold the port from then on (audit W1, docs/security/2026-11-02-team-account-windows.md).
 */
export function localCredentialHeaders(dataDir: string, platform: NodeJS.Platform = process.platform): Record<string, string> {
  if (platform === 'win32' || unixSocketPath(dataDir, 65_535, platform)) return {}
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
