/**
 * The daemon's Unix domain socket: the desktop app's way in, beside the loopback TCP port.
 *
 * The loopback port carries no credential — every process on this computer, any user's, can open it,
 * and the Host/Origin checks (lib/loopbackRequest.ts) only keep web pages out. The socket lives in the
 * daemon's data directory (0700) and is itself 0600, so the filesystem is the credential: only this
 * user's processes can connect. A request that arrives over it is from this user, and needs none of
 * the address checks a TCP request does — its peer has no address at all.
 *
 * TCP stays: the CLI, engine hooks and the dashboard (a browser cannot reach a socket file) still use
 * it, as do app builds that predate this. Windows has no socket here; there everything is TCP.
 */
import http from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { chmodSync, lstatSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/**
 * One socket per control port: `daemon-<port>.sock`. Holding the port is what makes a daemon the only
 * one, so it is also what makes that daemon the socket's only rightful owner — a file already there is
 * a dead daemon's for that same port. And a client derives the name from the port it would otherwise
 * dial, so the socket it opens always leads to the same daemon its loopback fallback does, even with a
 * second daemon on another port sharing the data directory.
 */
export function localSocketName(port: number): string {
  return `daemon-${port}.sock`
}

/** Whether a file in the data directory is one of these sockets (for `harness reset`). */
export function isLocalSocketName(name: string): boolean {
  return /^daemon-\d+\.sock$/.test(name)
}

/** sockaddr_un.sun_path is 104 bytes on macOS, 108 on Linux, terminator included; the socket is
 *  created under a name 4 bytes longer (see [listenLocalSocket]) and must fit too. */
const MAX_SOCKET_PATH_BYTES = 96

const trustedSockets = new WeakSet<Socket>()

/** Where the socket for the daemon on `port` lives in this data directory, or null where there is none. */
export function localSocketPath(dataDir: string, port: number, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') return null
  const path = join(dataDir, localSocketName(port))
  return Buffer.byteLength(path) <= MAX_SOCKET_PATH_BYTES ? path : null
}

/** Whether this request (or raw socket) came in over the daemon's own Unix socket. */
export function isTrustedLocal(target: IncomingMessage | Socket | null | undefined): boolean {
  if (!target) return false
  const socket = 'socket' in target && target.socket ? target.socket : target as Socket
  return trustedSockets.has(socket)
}

export interface LocalSocketServer {
  server: http.Server
  path: string
  /** Stop listening and remove the socket file. */
  close: () => Promise<void>
  /** The same, for the synchronous boot handoff. */
  closeSync: () => void
}

/**
 * Serve `handler` on a Unix socket at `path` — the socket named for the port this daemon holds
 * ([localSocketName]). Call only once that port is bound: a socket file already there is then a dead
 * daemon's for the same port, and is removed. Anything there that is not a socket is left alone, and
 * this refuses to start.
 */
export async function listenLocalSocket(handler: http.RequestListener, path: string): Promise<LocalSocketServer> {
  removeStaleSocket(path)
  const server = http.createServer(handler)
  server.on('connection', (socket) => trustedSockets.add(socket))
  const unlink = (): void => {
    try { if (lstatSync(path).isSocket()) unlinkSync(path) } catch { /* already gone */ }
  }
  // Stop listening, drop what is connected and remove the file — without waiting on `close`'s
  // callback, which waits for every socket to end: an upgraded WebSocket the peer never finishes
  // closing would otherwise hold a restart-for-update open indefinitely.
  const closeNow = (): void => {
    server.closeAllConnections()
    server.close()
    unlink()
  }
  // `listen` creates the file with the process umask. It is made owner-only under a private name and
  // only then renamed into place — atomically — so no client ever sees it looser than 0600, and the
  // umask (process-wide, shared with whatever fs work is in flight) is never touched.
  // The daemon holding this port is the only one that uses this name, so a fixed suffix cannot clash.
  const staging = `${path}.new`
  try { if (lstatSync(staging).isSocket()) unlinkSync(staging) } catch { /* nothing left over */ }
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(staging, () => {
      server.off('error', reject)
      try {
        chmodSync(staging, 0o600)
        renameSync(staging, path)
      } catch (error) {
        server.closeAllConnections()
        server.close()
        try { unlinkSync(staging) } catch { /* never created, or already moved */ }
        reject(error)
        return
      }
      resolve({ server, path, close: async () => closeNow(), closeSync: closeNow })
    })
  })
}

function removeStaleSocket(path: string): void {
  let isSocket: boolean
  try {
    isSocket = lstatSync(path).isSocket()
  } catch {
    return   // nothing there
  }
  if (!isSocket) throw new Error(`${path} exists and is not a socket; not replacing it`)
  unlinkSync(path)
}
