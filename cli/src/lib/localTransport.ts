/**
 * How a client on this computer reaches the daemon. On macOS and Linux that is the daemon's Unix socket, 0600 in a 0700
 * folder, and only that: any account can bind the TCP port while the daemon restarts (a Team agent, audit H1), and would
 * hear what is sent to it, which is the local credential and also the request itself: a message, a file. With the
 * socket gone the daemon is down, and the client says so. TCP remains where a socket cannot exist, a data folder whose
 * path is too long for one. On Windows it is the daemon's pipe, and only that: the Team account's daemon starts at boot,
 * before the owner's, and can hold the port from then on (audit W1, docs/security/2026-11-02-team-account-windows.md).
 * Reaching the pipe is no trust there, so every request proves the daemon's token and takes only an answer that proves
 * it back (lib/windows/pipeAuth.ts).
 *
 * The folder's mode is the guarantee here, as for every client of this socket (lib/localSocket.ts): nobody else can
 * have put a socket in it.
 */
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { request } from 'node:http'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { configuredPortOf, readDaemonRecord } from './daemonRecord.js'
import { localCredentialHeaders } from './localCredential.js'
import { unixSocketPath } from './localSocket.js'
import { NOT_RUNNING } from './unreachable.js'
import { daemonPipe } from './windows/daemonPipe.js'
import { newPipeNonce, PIPE_AUTH_HEADER, pipeAuthValue, pipeProven, readDaemonToken } from './windows/pipeAuth.js'
import { pipeWebSocket, PipeUnproven, type PipeTarget } from './windows/pipeClient.js'

const LOCAL_WS_PATH = '/api/local-ws'

/**
 * The daemon's socket for [port], or null where it has none. A socket is named for the port the daemon was configured
 * with; [port] may be the one it was given instead, when another account held that one, so its records say which.
 * With neither there, the expected path: connecting to it fails as a daemon that is down does.
 */
export function localSocketRoute(dataDir: string, port: number, platform: NodeJS.Platform = process.platform): string | null {
  const expected = unixSocketPath(dataDir, port, platform)
  // A data folder's own mode covers its socket; a short folder's lies elsewhere, so it is checked, and one that isn't private is refused as
  // a daemon that is down is: connecting to this name fails.
  const checked = (socket: string): string => !socket.startsWith(dataDir) && !socketIsPrivate(socket) ? `${socket}.not-private` : socket
  if (!expected) return expected
  if (existsSync(expected)) return checked(expected)
  let names: string[] = []
  try { names = readdirSync(dataDir) } catch { return expected }
  for (const name of names) {
    const configured = /^daemon-(\d+)\.json$/.exec(name)?.[1]
    if (!configured || readDaemonRecord(dataDir, Number(configured), platform)?.port !== port) continue
    const socket = unixSocketPath(dataDir, Number(configured), platform)
    if (socket && existsSync(socket)) return checked(socket)
  }
  return expected
}

/** Where a WebSocket to the daemon goes, and the headers it carries: none over the socket. */
export function localWsTarget(dataDir: string, port: number, platform: NodeJS.Platform = process.platform): { url: string; headers: Record<string, string> } {
  const socket = localSocketRoute(dataDir, port, platform)
  if (socket) return { url: `ws+unix://${socket}:${LOCAL_WS_PATH}`, headers: {} }
  return { url: `ws://127.0.0.1:${readDaemonRecord(dataDir, port, platform)?.port ?? port}${LOCAL_WS_PATH}`, headers: localCredentialHeaders(dataDir, platform) }
}

/**
 * One request over the socket, or the Windows pipe of [pipe], answered as `fetch` answers. The body is whole first: these
 * are JSON and forms up to 10 MB. Over the pipe it carries a fresh auth, and an answer without the daemon's proof is
 * refused before its body is read (lib/windows/pipeClient.ts `pipeRequest`).
 */
async function overSocket(socketPath: string, input: Request, pipe?: PipeTarget): Promise<Response> {
  const url = new URL(input.url)
  const body = input.body ? Buffer.from(await input.arrayBuffer()) : null
  const headers = Object.fromEntries(input.headers)
  if (body) headers['content-length'] = String(body.length)
  const nonce = pipe ? newPipeNonce(pipe.pipe) : null
  if (pipe && nonce) headers[PIPE_AUTH_HEADER] = pipeAuthValue(pipe.token, nonce)
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method: input.method, path: `${url.pathname}${url.search}`, headers, signal: input.signal }, (res) => {
      if (pipe && nonce && !pipeProven(res.headers, pipe.token, nonce)) {
        reject(new PipeUnproven(pipe.pipe))
        res.destroy()
        req.destroy()
        return
      }
      const answer = new Headers()
      for (const [name, value] of Object.entries(res.headers)) {
        if (value !== undefined) answer.set(name, Array.isArray(value) ? value.join(', ') : value)
      }
      const status = res.statusCode ?? 502
      // A Response may have no body with these (and refuses one).
      if ([101, 204, 205, 304].includes(status)) { res.resume(); resolve(new Response(null, { status, headers: answer })); return }
      resolve(new Response(Readable.toWeb(res) as NodeReadableStream as ReadableStream, { status, headers: answer }))
    })
    // As fetch fails: a TypeError with the reason as its cause, which the callers' "is it running" texts read.
    req.on('error', (error) => { reject(input.signal.aborted ? error : Object.assign(new TypeError('fetch failed'), { cause: error })) })
    // A write the socket finishes after the answer was refused and the request destroyed fails with EPIPE on Linux, when
    // nothing listens on the socket any more: the request has settled by then (Linux CI on #2605).
    req.on('socket', (socket) => { socket.on('error', () => {}) })
    req.end(body ?? undefined)
  })
}

/** What `fetch` throws for a daemon that is not there: the callers' "is it running" texts read its cause. */
export function notThere(): TypeError {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED: no Harness pipe'), { code: 'ECONNREFUSED' }) })
}

/** Whether [path] is what the daemon makes: a socket of this account's, owner only, in a real folder nobody else can write to. */
export function socketIsPrivate(path: string): boolean {
  const uid = process.getuid?.()
  try {
    const folder = lstatSync(dirname(path)), file = lstatSync(path)
    return folder.isDirectory() && (folder.mode & 0o022) === 0 && file.isSocket() && (file.mode & 0o077) === 0
      && (uid === undefined || (folder.uid === uid && file.uid === uid))
  } catch { return false }
}

/** `fetch` that sends every request over the private Unix socket at [socketPath], whatever host its address names, and fails as `fetch` does
 *  when the socket is missing or not private: what is sent can carry a key. */
export function fetchOverSocket(socketPath: string): typeof fetch {
  return async (input, init) => {
    if (!socketIsPrivate(socketPath)) throw new TypeError('fetch failed', { cause: new Error('The socket is missing or not private.') })
    return overSocket(socketPath, new Request(input, init))
  }
}

/** `fetch` that sends every request over the pipe [target] names at the time, whatever host its address names: it proves the pipe's
 *  token and takes only an answer that proves it back. With no pipe it fails as `fetch` does for a daemon that is not there. */
export function fetchOverPipe(target: () => PipeTarget | null): typeof fetch {
  return async (input, init) => {
    const pipe = target()
    if (!pipe) throw notThere()
    return overSocket(pipe.pipe, new Request(input, init), pipe)
  }
}

/**
 * `fetch` for the daemon on [port] of [dataDir]: a request to its loopback address goes over its socket where it can
 * have one, and on Windows over its pipe ([pipe], `daemonPipe` by default) or nowhere. Any other address, such as a
 * storage link, is the ordinary [base].
 */
export function daemonFetch(
  dataDir: string, port: number, base: typeof fetch = fetch, platform: NodeJS.Platform = process.platform,
  pipe: (dataDir: string, configuredPort: number) => Promise<PipeTarget | null> = daemonPipe,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const saved = readDaemonRecord(dataDir, configuredPortOf(dataDir, port, platform), platform)?.port
    const daemon = url.hostname === '127.0.0.1' && (Number(url.port) === port || Number(url.port) === saved)
    if (daemon && platform === 'win32') {
      const target = await pipe(dataDir, port)
      if (!target) throw notThere()
      return overSocket(target.pipe, new Request(input, init), target)
    }
    const socket = daemon ? localSocketRoute(dataDir, port, platform) : null
    return socket ? overSocket(socket, new Request(input, init)) : base(input, init)
  }
}

/**
 * Whether this account's process [pid] runs. The daemon is this account's, so EPERM is another account's process, one
 * that took the pid since the daemon exited (processProof.ts `pidAlive` counts it alive): not the daemon.
 */
function ownProcessRuns(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * The daemon's pipe for a client that opens its WebSocket at once (`openLocalWs`): the recorded pipe while the recorded
 * daemon runs, and its token. Not the process table `daemonPipe` also reads: the socket's upgrade must prove the token
 * (`pipeWebSocket`), so a squatter is refused before any frame is sent to it.
 */
export function daemonPipeNow(dataDir: string, port: number): PipeTarget | null {
  const record = readDaemonRecord(dataDir, configuredPortOf(dataDir, port))
  if (!record?.pipe || !record.pid || !ownProcessRuns(record.pid)) return null
  const token = readDaemonToken(dataDir)
  return token ? { pipe: record.pipe, token } : null
}

/**
 * A WebSocket to the daemon on [port] of [dataDir]: [connect] to its socket (or, for a data folder too long to hold one,
 * its port) on macOS and Linux, and on Windows its pipe ([pipe], `daemonPipeNow` by default), never the port. With no
 * pipe there it throws that Harness is not running.
 */
export function openLocalWs<S>(
  dataDir: string, port: number, connect: (url: string, headers: Record<string, string>) => S,
  platform: NodeJS.Platform = process.platform, pipe: (dataDir: string, port: number) => PipeTarget | null = daemonPipeNow,
): S {
  if (platform !== 'win32') {
    const target = localWsTarget(dataDir, port, platform)
    return connect(target.url, target.headers)
  }
  const target = pipe(dataDir, port)
  if (!target) throw new Error(NOT_RUNNING)
  return pipeWebSocket(target) as unknown as S
}
