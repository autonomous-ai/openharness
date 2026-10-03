/**
 * The daemon's Unix domain socket: the desktop app's and hn's way in, beside the loopback TCP port.
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
import { connect } from 'node:net'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { chmodSync, lstatSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/**
 * One socket per configured port in this OS user's data directory: `daemon-<port>.sock`. Its name
 * stays stable when a different user's daemon holds the requested TCP port and this daemon receives
 * another one. Native clients derive this private path; CLI TCP clients read the saved actual port.
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
 * Serve `handler` on a Unix socket at `path`. Refuse a live listener or a non-socket file, and remove
 * only a stale socket. CLI startup is serialized by the per-user spawn lock.
 */
export async function listenLocalSocket(handler: http.RequestListener, path: string): Promise<LocalSocketServer> {
  // A TCP collision can now move this user to another port. Holding a TCP port no longer proves
  // an existing Unix socket is stale: never unlink a live daemon belonging to this user.
  await refuseLiveSocket(path)
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
  // CLI startup holds the per-user spawn lock while claiming this stable socket name.
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

async function refuseLiveSocket(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(path)
    socket.once('connect', () => {
      socket.destroy()
      reject(Object.assign(new Error(`A Harness daemon is already serving ${path}`), { code: 'EADDRINUSE' }))
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED' || error.code === 'ENOTSOCK') resolve()
      else reject(error)
    })
    socket.setTimeout(1_000, () => {
      socket.destroy()
      reject(new Error(`Could not verify whether ${path} is in use`))
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
