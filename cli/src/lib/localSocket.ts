/**
 * The daemon's Unix domain socket: the desktop app's and hn's way in, beside the loopback TCP port.
 *
 * The loopback port carries no credential — every process on this computer, any user's, can open it,
 * and the Host/Origin checks (lib/loopbackRequest.ts) only keep web pages out. The socket lives in the
 * daemon's data directory (0700) and is itself 0600, so the filesystem is the credential: only this
 * user's processes can connect. A request that arrives over it is from this user, and needs none of
 * the address checks a TCP request does — its peer has no address at all.
 *
 * TCP stays: the CLI, engine hooks and scripts still use
 * it, as do app builds that predate this. Windows has no socket here; there everything is TCP.
 */
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import { connect } from 'node:net'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { chmodSync, linkSync, lstatSync, renameSync, unlinkSync, type Stats } from 'node:fs'
import { dirname, join } from 'node:path'

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
 * only a stale socket. CLI startup is serialized by the per-user spawn lock; two daemons that start at
 * once anyway (two masters) get one socket between them, never one each.
 */
export async function listenLocalSocket(handler: http.RequestListener, path: string): Promise<LocalSocketServer> {
  // A TCP collision can now move this user to another port. Holding a TCP port no longer proves
  // an existing Unix socket is stale: never unlink a live daemon belonging to this user.
  await refuseLiveSocket(path)
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
  // only then put in place, so no client ever sees it looser than 0600, and the umask (process-wide,
  // shared with whatever fs work is in flight) is never touched.
  //
  // Put in place by a hard link, which fails when the name is taken, where a rename replaces it. Two
  // claims at once (two masters racing) both got the socket before — measured, every time in
  // localSocket.spec.ts: they staged under one shared name and each renamed into place, and the one
  // replaced kept listening where nothing could reach it, bound as far as its master knew. A private
  // staging name per claim, no longer than the socket's own (a socket path has 96 bytes: localSocketPath).
  const staging = join(dirname(path), `.claim-${randomBytes(3).toString('hex')}`)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(staging, () => {
      server.off('error', reject)
      void (async () => {
        try {
          chmodSync(staging, 0o600)
          await claim(staging, path)
        } catch (error) {
          server.closeAllConnections()
          server.close()
          try { unlinkSync(staging) } catch { /* never created, or already moved */ }
          reject(error)
          return
        }
        // The socket is at `path` now; the staged name goes (a rename already took it).
        try { unlinkSync(staging) } catch { /* renamed into place */ }
        resolve({ server, path, close: async () => closeNow(), closeSync: closeNow })
      })()
    })
  })
}

const alreadyServing = (path: string): Error =>
  Object.assign(new Error(`A Harness daemon is already serving ${path}`), { code: 'EADDRINUSE' })

/**
 * The core of a master that is gone still serves the data folder once the wait for it is over. Not another
 * daemon: it is leaving, slowly (a client that will not answer its close). Its own code, so start-up ends
 * in an exit its master starts again, and the next core finds it gone, where EADDRINUSE ends it for good,
 * and launchd and systemd do not start a clean exit again (lib/daemonSafeMode.ts).
 */
export const ORPHAN_STILL_SERVING = 'ORPHAN_STILL_SERVING'
const orphanStillServing = (path: string, corePid: number): Error =>
  Object.assign(new Error(`The core (pid ${corePid}) of a master that is gone still serves ${path}`), { code: ORPHAN_STILL_SERVING })

/**
 * Put the staged socket at `path`. The name taken: by a daemon serving it (refused), or by the socket of
 * one that crashed (replaced). Decided here, at the claim, never earlier: a liveness check made before
 * the listen is stale by the time a second daemon claims, and the unlink that followed it removed the
 * first daemon's live socket. Only the very file found dead is removed: a socket another daemon has put
 * there since is a different file, and is left to it.
 */
async function claim(staging: string, path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      linkSync(staging, path)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        // A filesystem without hard links: the rename it always used, which replaces rather than refuses.
        renameSync(staging, path)
        return
      }
    }
    if (attempt > 0) throw alreadyServing(path)
    let found: Stats
    try { found = lstatSync(path) } catch { continue } // gone meanwhile: try the name again
    if (!found.isSocket()) throw new Error(`${path} exists and is not a socket; not replacing it`)
    await refuseLiveSocket(path)
    try { if (lstatSync(path).ino === found.ino) unlinkSync(path) } catch { /* gone meanwhile */ }
  }
}

/** What answers on a data folder's socket: nothing, something that does not say who it is, or a daemon
 *  and its master (`pid`, the pid file's: the master's under one, its own otherwise) and its core. */
export type DataFolderServer = 'none' | 'unknown' | { pid: number; corePid: number }

export interface ServedFolderDeps {
  /** Who serves the socket at `path` (`GET /api/status` over it). */
  who(path: string, timeoutMs: number): Promise<DataFolderServer>
  alive(pid: number): boolean
  sleep(ms: number): Promise<void>
  now(): number
  log(line: string): void
}

/** How long start-up waits for the core of a master that is gone to leave: well inside the minute the
 *  master gives a core to bind, and longer than such a core takes to stop. */
export const ORPHAN_WAIT_MS = 20_000
const ORPHAN_POLL_MS = 250

/** Ask the daemon on a data folder's socket who it is. A socket that takes no connection serves nothing
 *  (no socket, a stale one, one that cannot be reached: start-up goes on, and the bind decides); one that
 *  takes it and does not say is `unknown`. */
export function askDataFolderServer(path: string, timeoutMs: number): Promise<DataFolderServer> {
  return new Promise((resolve) => {
    let connected = false
    // A connection of its own, never one kept alive from an earlier ask: that one may be to a daemon gone.
    const request = http.request({ socketPath: path, path: '/api/status', method: 'GET', timeout: timeoutMs, agent: false }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { if (body.length < 65_536) body += chunk })
      response.on('end', () => {
        try {
          const status = JSON.parse(body) as { pid?: unknown; corePid?: unknown }
          const pid = Number(status.pid)
          // A daemon from before harnessd says no core of its own: it is its own master.
          const corePid = status.corePid === undefined ? pid : Number(status.corePid)
          resolve(Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(corePid) && corePid > 0 ? { pid, corePid } : 'unknown')
        } catch { resolve('unknown') }
      })
      response.on('error', () => resolve('unknown'))
    })
    request.on('socket', (socket: Socket) => socket.once('connect', () => { connected = true }))
    request.on('timeout', () => { request.destroy(); resolve(connected ? 'unknown' : 'none') })
    request.on('error', () => resolve(connected ? 'unknown' : 'none'))
    request.end()
  })
}

const SERVED_FOLDER_DEFAULTS: ServedFolderDeps = {
  who: askDataFolderServer,
  alive: (pid) => { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' } },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => performance.now(),
  log: (line) => console.log(line),
}

/**
 * Refuse to start a daemon whose data folder another daemon already serves: start-up asks this before it
 * reads or writes anything of that daemon's. Rejects with `EADDRINUSE`, as the bind it spares would have.
 * No socket, or a stale one, lets start-up go on, and the bind decides.
 *
 * A second `harness start --foreground` (a launchd or systemd unit beside the app's daemon), and the core
 * of a second master, used to get as far as that bind first: on the way they marked the running daemon's
 * agents inactive on disk and reaped its harness viewers as the orphans of a daemon that had died
 * (e2e/twodaemons.e2e.ts).
 *
 * ⚠️ Except the core of a master that is gone, which serves only until it notices and stops. Under launchd
 * or systemd a master that died is started again at once, and its new core found the old one still
 * there: refused, it exits for good, its master with it, cleanly, and neither launchd's
 * `SuccessfulExit=false` nor systemd's `Restart=on-failure` starts a clean exit again, so the daemon stayed
 * down until the next login. Such a core is waited for, a bounded while, and once it has said so, so is
 * a silence from it while it stops. A daemon whose master is alive, or that runs without one, is another
 * daemon, and refused at once as before. So is one that answers without saying who it is: every release
 * with this socket has said its pid in `/api/status`, so a silence or an answer without one is a daemon
 * that is busy or hung, not one that is leaving, and a person waiting on `harness start` or the app must
 * not wait out the orphan's bound for it (cliCommand.spec.ts, the CI runs of #819).
 */
export async function refuseServedDataFolder(
  path: string | null, timeoutMs = 1_000, deps: ServedFolderDeps = SERVED_FOLDER_DEFAULTS, waitMs = ORPHAN_WAIT_MS,
): Promise<void> {
  if (!path) return
  const deadline = deps.now() + waitMs
  let orphanSeen = false
  let orphanCore = 0
  for (;;) {
    const server = await deps.who(path, timeoutMs)
    if (server === 'none') {
      if (orphanSeen) deps.log('[cli] the core whose master is gone has left — starting')
      return
    }
    if (server === 'unknown') {
      // Only the core already seen to be an orphan may go quiet while it stops.
      if (!orphanSeen) throw alreadyServing(path)
    } else {
      if (server.pid === server.corePid || deps.alive(server.pid)) throw alreadyServing(path)
      if (!orphanSeen) deps.log(`[cli] this data folder is still served by the core (pid ${server.corePid}) of a master that is gone (pid ${server.pid}) — waiting for it to leave`)
      orphanSeen = true
      orphanCore = server.corePid
    }
    if (deps.now() >= deadline) throw orphanSeen ? orphanStillServing(path, orphanCore) : alreadyServing(path)
    await deps.sleep(ORPHAN_POLL_MS)
  }
}

async function refuseLiveSocket(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(path)
    socket.once('connect', () => {
      socket.destroy()
      reject(alreadyServing(path))
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
