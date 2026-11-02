/**
 * How a client on this computer reaches the daemon. On macOS and Linux that is the daemon's Unix socket, 0600 in a 0700
 * folder, and only that: any account can bind the TCP port while the daemon restarts (a Team agent, audit H1), and would
 * hear what is sent to it, which is the local credential and also the request itself: a message, a file. With the
 * socket gone the daemon is down, and the client says so. TCP remains where a socket cannot exist, a data folder whose
 * path is too long for one, and on Windows, whose own proven pipe is handled by its callers.
 *
 * The folder's mode is the guarantee here, as for every client of this socket (lib/localSocket.ts): nobody else can
 * have put a socket in it.
 */
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { request } from 'node:http'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { readDaemonRecord } from './daemonRecord.js'
import { localCredentialHeaders } from './localCredential.js'
import { unixSocketPath } from './localSocket.js'

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
  if (expected && !expected.startsWith(dataDir) && existsSync(expected) && !socketIsPrivate(expected)) return `${expected}.not-private`
  if (!expected || existsSync(expected)) return expected
  let names: string[] = []
  try { names = readdirSync(dataDir) } catch { return expected }
  for (const name of names) {
    const configured = /^daemon-(\d+)\.json$/.exec(name)?.[1]
    if (!configured || readDaemonRecord(dataDir, Number(configured), platform)?.port !== port) continue
    const socket = unixSocketPath(dataDir, Number(configured), platform)
    if (socket && existsSync(socket)) return socket
  }
  return expected
}

/** Where a WebSocket to the daemon goes, and the headers it carries: none over the socket. */
export function localWsTarget(dataDir: string, port: number, platform: NodeJS.Platform = process.platform): { url: string; headers: Record<string, string> } {
  const socket = localSocketRoute(dataDir, port, platform)
  if (socket) return { url: `ws+unix://${socket}:${LOCAL_WS_PATH}`, headers: {} }
  return { url: `ws://127.0.0.1:${readDaemonRecord(dataDir, port, platform)?.port ?? port}${LOCAL_WS_PATH}`, headers: localCredentialHeaders(dataDir, platform) }
}

/** One request over the socket, answered as `fetch` answers. The body is whole first: these are JSON and forms up to 10 MB. */
async function overSocket(socketPath: string, input: Request): Promise<Response> {
  const url = new URL(input.url)
  const body = input.body ? Buffer.from(await input.arrayBuffer()) : null
  const headers = Object.fromEntries(input.headers)
  if (body) headers['content-length'] = String(body.length)
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method: input.method, path: `${url.pathname}${url.search}`, headers, signal: input.signal }, (res) => {
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
    req.end(body ?? undefined)
  })
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

/**
 * `fetch` for the daemon on [port] of [dataDir]: a request to its loopback address goes over its socket where it can
 * have one. Any other address, such as a storage link, is the ordinary [base].
 */
export function daemonFetch(dataDir: string, port: number, base: typeof fetch = fetch, platform: NodeJS.Platform = process.platform): typeof fetch {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const saved = readDaemonRecord(dataDir, port, platform)?.port
    const daemon = url.hostname === '127.0.0.1' && (Number(url.port) === port || Number(url.port) === saved)
    const socket = daemon ? localSocketRoute(dataDir, port, platform) : null
    return socket ? overSocket(socket, new Request(input, init)) : base(input, init)
  }
}
