/**
 * The devices' own local listener: the one way a local tool tells the devices process something, so the core never
 * hears it (cli/AGENTS.md, Protect the core, rule 7). `harness hardware watch` tells it the app in front; later device
 * routes register a handler of their own beside `front`, each with its own body and rate limit.
 *
 * Who may connect is the core's own answer (lib/localSocket.ts): a 0600 socket in a folder that is this account's
 * alone, so the kernel refuses another account's connect. Node reads no peer's uid. A client checks the socket's owner
 * and mode before it sends (lib/localTransport.ts `socketIsPrivate`).
 *
 * One message is one `POST /` whose body is a JSON object with a string `type`. A dropped one is answered with a status
 * and an empty body, and counted: what a sender wrote is never echoed or logged, since a front names the app a person
 * has in front of them.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { lstatSync, type Stats } from 'node:fs'
import { dirname } from 'node:path'
import { listenLocalSocket, type LocalSocketServer } from '../lib/localSocket.js'
import { APP_IDS } from '../cable/hosts/hostDetect.js'
import { FRONT_NONE } from '../cable/hosts/frontApp.js'

/** Connections at once. A sender that opens one per message is held here, where a per-connection rate cannot. */
export const LISTENER_MAX_CONNECTIONS = 16

/** What a handler returns for a body that is not a message of its type. */
export const REFUSED: unique symbol = Symbol('refused')

export interface ListenerHandler {
  /** The largest body of this type, in bytes. */
  maxBytes: number
  /** How many of this type one connection may send a second. */
  perSecond: number
  /** The parsed body, `type` included. `REFUSED`, nothing (taken), or the answer, or a promise of one. `gone` aborts
   *  when the sender's connection closes before the answer, or the listener does. */
  handle(message: Record<string, unknown>, gone: AbortSignal): unknown
}

export interface DevicesListenerOptions {
  /** devices/listenerPath.ts; null where there is no listener (Windows). */
  path: string | null
  handlers: Readonly<Record<string, ListenerHandler>>
  log(line: string): void
  /** Monotonic milliseconds. */
  now?: () => number
}

export interface DevicesListener {
  close(): Promise<void>
}

type Dropped = 'unknown' | 'oversized' | 'rate' | 'refused' | 'failed'

const NONE_DROPPED: Readonly<Record<Dropped, number>> = { unknown: 0, oversized: 0, rate: 0, refused: 0, failed: 0 }
const MINUTE_MS = 60_000

/**
 * Serve `handlers` on the devices' socket, or nothing: no path, a folder that is not this account's own, a name a live
 * listener holds, or a socket that cannot be made. Each is one log line, and the devices run on without it.
 */
export async function openDevicesListener({ path, handlers, log, now = () => performance.now() }: DevicesListenerOptions): Promise<DevicesListener | null> {
  if (path === null) return null
  let folder: Stats | undefined
  try { folder = lstatSync(dirname(path)) } catch { /* a short folder not made yet: listenLocalSocket makes it owner only */ }
  // What a client asks of the socket's folder before it sends (socketIsPrivate): a real folder of this account that no
  // one else can write to, where no other account can put a socket of its own in this one's place.
  if (folder && (!folder.isDirectory() || folder.uid !== process.getuid?.() || (folder.mode & 0o022) !== 0)) {
    log('[devices] listener not opened · folder not private')
    return null
  }

  const largest = Math.max(...Object.values(handlers).map(({ maxBytes }) => maxBytes))
  // A bucket per type per connection, gone with the connection: no table to bound or clean.
  const buckets = new WeakMap<Socket, Map<string, { tokens: number; at: number }>>()
  const waiting = new Set<AbortController>()
  let dropped = { ...NONE_DROPPED }
  let minute: NodeJS.Timeout | undefined

  const drop = (res: ServerResponse, status: number, kind: Dropped, close = false): void => {
    dropped[kind]++
    minute ??= setTimeout(() => {
      minute = undefined
      log(`[devices] listener in the last minute: ${dropped.unknown} unknown, ${dropped.oversized} oversized, ${dropped.rate} over rate, ${dropped.refused} refused, ${dropped.failed} failed`)
      dropped = { ...NONE_DROPPED }
    }, MINUTE_MS).unref()
    res.writeHead(status, close ? { Connection: 'close' } : undefined).end()
  }

  const allowed = (socket: Socket, type: string, perSecond: number): boolean => {
    let own = buckets.get(socket)
    if (!own) buckets.set(socket, own = new Map())
    const at = now()
    let bucket = own.get(type)
    if (!bucket) own.set(type, bucket = { tokens: perSecond, at })
    // A clock that stepped back refills nothing.
    if (at > bucket.at) {
      bucket.tokens = Math.min(perSecond, bucket.tokens + (at - bucket.at) * perSecond / 1_000)
      bucket.at = at
    }
    if (bucket.tokens < 1) return false
    bucket.tokens--
    return true
  }

  const settle = async (req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> => {
    const message = messageOf(body)
    if (!message) return drop(res, 400, 'refused')
    const type = message.type as string
    const handler = Object.hasOwn(handlers, type) ? handlers[type] : undefined
    if (!handler) return drop(res, 404, 'unknown')
    if (body.length > handler.maxBytes) return drop(res, 413, 'oversized')
    if (!allowed(req.socket, type, handler.perSecond)) return drop(res, 429, 'rate')
    const gone = new AbortController()
    waiting.add(gone)
    res.once('close', () => { if (!res.writableFinished) gone.abort() })
    let reply: string | undefined
    try {
      const answer = await handler.handle(message, gone.signal)
      if (answer === REFUSED) return drop(res, 400, 'refused')
      reply = JSON.stringify(answer)
    } catch {
      return drop(res, 500, 'failed')
    } finally {
      waiting.delete(gone)
    }
    if (reply === undefined) res.writeHead(204).end()
    else res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reply) }).end(reply)
  }

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    // Its body is never read, so the connection closes after the answer rather than reading through that body, of any
    // size, to a next message.
    if (req.method !== 'POST' || req.url !== '/') return drop(res, 405, 'refused', true)
    const chunks: Buffer[] = []
    let size = 0
    const take = (chunk: Buffer): void => {
      size += chunk.length
      if (size <= largest) {
        chunks.push(chunk)
        return
      }
      // Reading stops one chunk past the largest body any type takes, and the connection goes with the rest of it.
      req.off('data', take).off('end', done)
      drop(res, 413, 'oversized', true)
    }
    const done = (): void => void settle(req, res, Buffer.concat(chunks))
    req.on('data', take).on('end', done)
  }

  let listening: LocalSocketServer
  try {
    listening = await listenLocalSocket(onRequest, path)
  } catch (error) {
    log(`[devices] listener not opened · ${(error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 'in use' : 'failed'}`)
    return null
  }
  listening.server.maxConnections = LISTENER_MAX_CONNECTIONS
  // A listener never keeps its process up.
  listening.server.unref()
  // No path: a path holds the account's name.
  log('[devices] listener open')

  let closed: Promise<void> | undefined
  return {
    close: () => closed ??= (async () => {
      clearTimeout(minute)
      const gone = listening.close()
      for (const each of waiting) each.abort()
      await gone
    })(),
  }
}

/** A JSON object with a string `type`, or null. */
function messageOf(body: Buffer): Record<string, unknown> | null {
  try {
    const message: unknown = JSON.parse(body.toString('utf8'))
    return typeof message === 'object' && message !== null && !Array.isArray(message) && typeof (message as { type?: unknown }).type === 'string'
      ? message as Record<string, unknown> : null
  } catch {
    return null
  }
}

export const FRONT_PER_SECOND = 10
/** The longest message front takes, `{"type":"front","app":"terminal-app"}`, is 37 bytes. */
export const FRONT_MAX_BYTES = 64

const FRONT_APPS: ReadonlySet<string> = new Set([...APP_IDS, FRONT_NONE])

/** The app in front, from `harness hardware watch`: an app id or `none`, handed on. It keeps nothing and logs nothing,
 *  as which app a person has in front goes nowhere but the dial. */
export function frontHandler(front: (app: string) => void): ListenerHandler {
  return {
    maxBytes: FRONT_MAX_BYTES,
    perSecond: FRONT_PER_SECOND,
    handle: ({ app }) => {
      if (typeof app !== 'string' || !FRONT_APPS.has(app)) return REFUSED
      front(app)
    },
  }
}
