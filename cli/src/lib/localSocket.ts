/**
 * The daemon's Unix domain socket: the desktop app's and hn's way in, beside the loopback TCP port.
 *
 * The loopback port carries no credential — every process on this computer, any user's, can open it,
 * and the Host/Origin checks (lib/loopbackRequest.ts) only keep web pages out. The socket lives in the
 * daemon's data directory (0700) and is itself 0600, so the filesystem is the credential: only this
 * user's processes can connect. A request that arrives over it is from this user, and needs none of
 * the address checks a TCP request does — its peer has no address at all.
 *
 * TCP stays: the CLI, engine hooks and scripts still use it, as do app builds that predate this. On Windows the
 * daemon serves a named pipe instead (`listenAuthenticated` below). Reaching that pipe is no credential, so every
 * request over it proves the daemon's token (lib/windows/pipeAuth.ts).
 */
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import { connect } from 'node:net'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { chmodSync, linkSync, lstatSync, renameSync, unlinkSync, type Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import { readDaemonRecord } from './daemonRecord.js'
import { daemonPipe, type LocalDaemonOptions } from './windows/daemonPipe.js'
import { checkPipeAuth, newPipePath, NonceWindow, PIPE_AUTH_HEADER, PIPE_PROOF_HEADER, pipeIdOf, pipeProofValue } from './windows/pipeAuth.js'
import { pipeAbsent, pipeRequest, PipeUnproven } from './windows/pipeClient.js'

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

/** The shortest daemon token a pipe accepts (the token is 32 random bytes). */
const MIN_TOKEN_BYTES = 32

const trustedSockets = new WeakSet<Socket>()
/** Requests over the daemon's pipe whose auth checked out, and the proof each answer to them carries. */
const pipeProofs = new WeakMap<IncomingMessage, string>()

/** The daemon's Unix socket for `port` in this data directory, or null where there is none: Windows, or a path too long. */
export function unixSocketPath(dataDir: string, port: number, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') return null
  const path = join(dataDir, localSocketName(port))
  return Buffer.byteLength(path) <= MAX_SOCKET_PATH_BYTES ? path : null
}

/**
 * Where a client reaches the daemon on `port` of this data directory, or null where there is nothing to reach. That
 * is its Unix socket; on Windows, the pipe the running daemon recorded in `daemon-<port>.json`, a new name on each
 * start. Reaching that pipe is no trust: every request there proves the daemon's token (lib/windows/pipeAuth.ts).
 * A caller that needs a filesystem socket (`ws+unix://`, the services) uses unixSocketPath.
 */
export function localSocketPath(dataDir: string, port: number, platform: NodeJS.Platform = process.platform): string | null {
  return platform === 'win32' ? readDaemonRecord(dataDir, port, platform)?.pipe ?? null : unixSocketPath(dataDir, port, platform)
}

/** Where a daemon starting on `port` listens: its Unix socket, or on Windows a pipe of a new random name. */
export function localSocketListenPath(dataDir: string, port: number, platform: NodeJS.Platform = process.platform): string | null {
  return platform === 'win32' ? newPipePath() : unixSocketPath(dataDir, port, platform)
}

/** Whether this request (or raw socket) came in over the daemon's own Unix socket, or over its pipe with valid auth. */
export function isTrustedLocal(target: IncomingMessage | Socket | null | undefined): boolean {
  if (!target) return false
  if (pipeProofs.has(target as IncomingMessage)) return true
  const socket = 'socket' in target && target.socket ? target.socket : target as Socket
  return trustedSockets.has(socket)
}

/** The proof every answer to [req] must carry, for a request over the daemon's pipe whose auth checked out. */
export function pipeProofOf(req: IncomingMessage): string | undefined {
  return pipeProofs.get(req)
}

export interface ListenLocalSocketOptions {
  /**
   * The daemon's token (lib/windows/pipeAuth.ts). When given, `path` is a pipe (in the tests, a socket with a pipe's
   * name) whose every request must prove the token: Windows. Absent: the Unix socket, trusted by its file mode.
   */
  token?: Buffer
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
export async function listenLocalSocket(handler: http.RequestListener, path: string, options: ListenLocalSocketOptions = {}): Promise<LocalSocketServer> {
  if (options.token) return listenAuthenticated(handler, path, options.token)
  // A Harness pipe, or any endpoint on Windows, is never trusted by reachability: it needs the daemon's token.
  if (pipeIdOf(path) || process.platform === 'win32') throw new Error(`${path} needs the daemon's token: reaching a pipe is no credential`)
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

/**
 * The daemon's Windows pipe: the same handler, for requests that prove the token. Node cannot set a pipe's DACL,
 * and the default one lets every account open it for reading, so reaching the pipe is no credential. A request
 * without valid auth gets a 401 and never reaches the handler. An upgrade without valid auth is dropped here,
 * before the local WS server's listener (localWsServer.ts), which then finds its socket destroyed. Every answer
 * carries the proof; the local WS server adds it to a 101. There is no file to claim or remove: the name is new on
 * each start (localSocketListenPath), and a pipe goes with its last handle.
 */
function listenAuthenticated(handler: http.RequestListener, path: string, token: Buffer): Promise<LocalSocketServer> {
  if (token.length < MIN_TOKEN_BYTES) return Promise.reject(new Error(`The daemon's token must be at least ${MIN_TOKEN_BYTES} bytes`))
  const pipeId = pipeIdOf(path)
  if (!pipeId) return Promise.reject(new Error(`${path} is not a Harness pipe name`))
  const seen = new NonceWindow()
  const admit = (req: IncomingMessage): boolean => {
    const header = req.headers[PIPE_AUTH_HEADER]
    const auth = checkPipeAuth(token, typeof header === 'string' ? header : undefined, seen, pipeId)
    if (auth) pipeProofs.set(req, pipeProofValue(token, auth.nonce))
    return auth !== null
  }
  const server = http.createServer((req, res) => {
    if (!admit(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(JSON.stringify({ error: 'PIPE_AUTH_REQUIRED' }))
      return
    }
    res.setHeader(PIPE_PROOF_HEADER, pipeProofs.get(req)!)
    handler(req, res)
  })
  // Must stay the first 'upgrade' listener: it drops an unauthenticated upgrade before any other listener sees it.
  server.prependListener('upgrade', (req: IncomingMessage, socket: Duplex) => {
    // Alone, this listener would leave an upgrade nobody takes hanging: nothing serves upgrades here yet.
    if (!admit(req) || server.listenerCount('upgrade') === 1) socket.destroy()
  })
  const closeNow = (): void => {
    server.closeAllConnections()
    server.close()
  }
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      resolve({ server, path, close: async () => closeNow(), closeSync: closeNow })
    })
  })
}

/** What a start finds when another daemon serves its data folder: `EADDRINUSE`, as the bind it spares would have. */
export const alreadyServing = (path: string): Error =>
  Object.assign(new Error(`A Harness daemon is already serving ${path}`), { code: 'EADDRINUSE' })

/**
 * The core of a master that is gone still serves the data folder once the wait for it is over. Not another
 * daemon: it is leaving, slowly (a client that will not answer its close). Its own code, so start-up ends
 * in an exit its master starts again, and the next core finds it gone, where EADDRINUSE ends it for good,
 * and launchd and systemd do not start a clean exit again (lib/daemonSafeMode.ts).
 */
export const ORPHAN_STILL_SERVING = 'ORPHAN_STILL_SERVING'
export const orphanStillServing = (path: string, corePid: number): Error =>
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

/** What a status answer says: a daemon and its master, or `unknown` when it does not say both pids. */
function folderServerOf(body: string): DataFolderServer {
  try {
    const status = JSON.parse(body) as { pid?: unknown; corePid?: unknown }
    const pid = Number(status.pid)
    // A daemon from before harnessd says no core of its own: it is its own master.
    const corePid = status.corePid === undefined ? pid : Number(status.corePid)
    return Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(corePid) && corePid > 0 ? { pid, corePid } : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Ask the daemon on a data folder's socket who it is. A socket that takes no connection serves nothing
 *  (no socket, a stale one, one that cannot be reached: start-up goes on, and the bind decides); one that
 *  takes it and does not say is `unknown`. With [token] the socket is the Windows pipe: see [askPipeServer]. */
export function askDataFolderServer(path: string, timeoutMs: number, token: Buffer | null = null): Promise<DataFolderServer> {
  if (token) return askPipeServer(path, timeoutMs, token)
  return new Promise((resolve) => {
    let connected = false
    // A connection of its own, never one kept alive from an earlier ask: that one may be to a daemon gone.
    const request = http.request({ socketPath: path, path: '/api/status', method: 'GET', timeout: timeoutMs, agent: false }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { if (body.length < 65_536) body += chunk })
      response.on('end', () => resolve(folderServerOf(body)))
      response.on('error', () => resolve('unknown'))
    })
    request.on('socket', (socket: Socket) => socket.once('connect', () => { connected = true }))
    request.on('timeout', () => { request.destroy(); resolve(connected ? 'unknown' : 'none') })
    request.on('error', () => resolve(connected ? 'unknown' : 'none'))
    request.end()
  })
}

/**
 * The Windows pipe: the ask proves the token and takes only an answer with the daemon's proof (pipeClient.ts).
 * An answer without it serves nothing: whatever took a dead daemon's name must not keep this one down. So does a
 * name that is no Harness pipe, or nothing listening there (a stale record). Silence is not that: a listener that
 * does not answer in time (a real daemon that is only slow) is `unknown`, and start-up refuses, since each Windows
 * start listens on a fresh pipe and this ask is the only guard against a second daemon on the folder. An answer that
 * proves the daemon but is unusable (too large) is `unknown` too, as on a Unix socket.
 */
async function askPipeServer(pipe: string, timeoutMs: number, token: Buffer): Promise<DataFolderServer> {
  if (!pipeIdOf(pipe)) return 'none'
  try {
    const reply = await pipeRequest({ pipe, token }, { method: 'GET', path: '/api/status', timeoutMs, maxBytes: 65_536 })
    return folderServerOf(reply.body)
  } catch (error) {
    return error instanceof PipeUnproven || pipeAbsent(error) ? 'none' : 'unknown'
  }
}

const SERVED_FOLDER_DEFAULTS: ServedFolderDeps = {
  who: askDataFolderServer,
  alive: (pid) => { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' } },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => performance.now(),
  log: (line) => console.log(line),
}

/**
 * What `refuseServedDataFolder` asks with for the daemon of [dataDir] on [configuredPort]. On Windows it asks the
 * recorded pipe with that folder's token (windows/daemonPipe.ts `daemonPipe`). Nothing serves it when there is no token
 * (the core makes the token before it listens), no record of a pipe and pid, or a recorded process proven gone: that
 * pipe is never dialled, so whatever took a dead daemon's name and hangs cannot keep every start down. Elsewhere it
 * asks as it always has.
 */
export function servedFolderDeps(dataDir: string, configuredPort: number, options: LocalDaemonOptions = {}): ServedFolderDeps {
  if ((options.platform ?? process.platform) !== 'win32') return SERVED_FOLDER_DEFAULTS
  const find = options.pipe ?? daemonPipe
  return {
    ...SERVED_FOLDER_DEFAULTS,
    who: async (_path, timeoutMs) => {
      const target = await find(dataDir, configuredPort)
      return target ? askDataFolderServer(target.pipe, timeoutMs, target.token) : 'none'
    },
  }
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
