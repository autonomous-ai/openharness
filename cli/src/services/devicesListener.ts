/**
 * The devices' own local listener: the one way a local tool tells the devices process something, so the core never
 * hears it (cli/AGENTS.md, Protect the core, rule 7). `harness hardware watch` tells it the app in front, the selected
 * tab (`tab`), the thread the ChatGPT app shows (`thread`) and the Notifications setting (`notify`), the harness-device
 * mod the session the Claude app shows (`attach`), and `harness device notify` an agent's one line for the dial
 * (`notice`); later device routes register a handler of their own beside these, each with its own body and rate limit.
 *
 * Who may connect is the core's own answer (lib/localSocket.ts): a 0600 socket in a folder that is this account's
 * alone, so the kernel refuses another account's connect. Node reads no peer's uid. A client checks the socket's owner
 * and mode before it sends (lib/localTransport.ts `socketIsPrivate`).
 *
 * On Windows Node cannot set a pipe's DACL, so any account can reach the devices' pipe: who may send is whoever proves
 * `devices-token`, a file in this account's profile, on each request, as the daemon's pipe proves its own token
 * (lib/windows/pipeAuth.ts). A new pipe each start, named in `devices.json` beside the token for clients to find
 * (devices/listenerPipe.ts).
 *
 * One message is one `POST /` whose body is a JSON object with a string `type`. A dropped one is answered with a status
 * and an empty body, and counted: what a sender wrote is never echoed or logged, since a front names the app a person
 * has in front of them.
 *
 * A stream type (`tabs`, `dial`) is answered with NDJSON lines that stay open: the way the devices process says something
 * to a watch without the watch asking each time. One of a type is open at once, across every connection, or, for a keyed
 * type, one per key up to its limit, a new key past it answered 409: a newer one ends the older with a last line,
 * `{"replaced":true}`, and one asked with `"standby":true` opens only while none is.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { lstatSync, type Stats } from 'node:fs'
import { dirname } from 'node:path'
import { DEVICES_TOKEN_FILE, removeDevicesRecord, writeDevicesRecord } from '../devices/listenerPipe.js'
import { listenLocalSocket, type LocalSocketServer } from '../lib/localSocket.js'
import { errorKind } from '../lib/log.js'
import { ensureDaemonToken } from '../lib/windows/pipeAuth.js'
import type { DialAgent } from '../cable/cableSession.js'
import { APP_IDS } from '../cable/hosts/hostDetect.js'
import { FRONT_NONE } from '../cable/hosts/frontApp.js'
import { ORCA_HANDLE } from '../cable/hosts/orca.js'
import { REPLACED_LINE, tabOf, type Tab } from '../cable/hosts/tabs.js'
import { threadTitleOf } from '../cable/hosts/threadTitle.js'
import { isNotifyMode, type NotifyMode } from '../cable/notifyMode.js'
import { NOTICE_SESSION, noticeFolder, noticeLine, type NoticeAsk, type NoticeResult } from '../lib/dialNotice.js'

/** Connections at once. Each type's rate across them is what this many could send at its rate on one, so a sender that
 *  opens one per message is held to that too. */
export const LISTENER_MAX_CONNECTIONS = 16
/** Messages dropped in a second, of every kind and connection together, past which a message is refused before its body
 *  is read: a sender that keeps to the rates is refused a few, a loop thousands. */
export const LISTENER_DROPPED_PER_SECOND = 100
/** From a connection's opening, or its last answer, to its next answer: a message is a few dozen bytes on a local
 *  socket, so a connection slower than that is holding one of the slots, not sending. */
const LISTENER_TIMEOUT_MS = 2_000

/** What a handler returns for a body that is not a message of its type. */
export const REFUSED: unique symbol = Symbol('refused')

export interface ListenerHandler {
  /** The largest body of this type, in bytes. */
  maxBytes: number
  /** How many of this type one connection may send in any second; every connection together, LISTENER_MAX_CONNECTIONS
   *  times that. */
  perSecond: number
  /** The parsed body, `type` included. `REFUSED`, nothing (taken), or the answer, or a promise of one. `gone` aborts
   *  when the sender's connection closes before the answer, or the listener does. */
  handle(message: Record<string, unknown>, gone: AbortSignal): unknown
}

/** Why a stream ended: its client went (it closed, its socket errored, or it sent a second message), a line did not
 *  drain in 2 s, a newer stream of its type opened, or `closed`: the listener closed, the handler's `onWritable` run
 *  threw, or its open was refused or threw. */
export type StreamEnd = 'gone' | 'stalled' | 'replaced' | 'closed'

export interface ListenerStream {
  /** One NDJSON line. False, with nothing written, inside `open`, once the stream has ended or while an earlier line has
   *  not drained. */
  write(line: unknown): boolean
  /** `run` is called each time the stream can take a line: once it has opened, and each time a written line has drained.
   *  Never once it has ended. A later call replaces the listener. */
  onWritable(run: () => void): void
  /** Aborts when the stream ends; its `reason` is a StreamEnd. */
  readonly ended: AbortSignal
}

export interface ListenerStreamHandler {
  maxBytes: number
  perSecond: number
  /** A keyed type keeps one stream per key instead of one of its type: `key` is an opening message's key, or REFUSED
   *  for a message that has none; `limit` is the most streams of the type open at once. */
  keyed?: { key(message: Record<string, unknown>): string | typeof REFUSED; limit: number }
  /** `REFUSED` for a body that is not a message of its type. Otherwise the stream is open, and the handler's to write on. */
  open(message: Record<string, unknown>, stream: ListenerStream): typeof REFUSED | void
}

export interface DevicesListenerOptions {
  /** devices/listenerPath.ts; null where there is no socket: Windows, or a data folder and a home both too long. */
  path: string | null
  /** Windows: the pipe served instead of `path` (lib/windows/pipeAuth.ts `newPipePath`), and the data folder that holds
   *  its token and record. */
  pipe?: { path: string; dataDir: string }
  handlers: Readonly<Record<string, ListenerHandler | ListenerStreamHandler>>
  log(line: string): void
  /** Monotonic milliseconds. */
  now?: () => number
}

export interface DevicesListener {
  close(): Promise<void>
}

type Dropped = 'unknown' | 'oversized' | 'rate' | 'refused' | 'failed'

const NONE_DROPPED: Readonly<Record<Dropped, number>> = { unknown: 0, oversized: 0, rate: 0, refused: 0, failed: 0 }
const SECOND_MS = 1_000
const MINUTE_MS = 60_000

/** At most `limit` in any second: the times of the last `limit` taken, so a first second holds no more than the rest. */
class PerSecond {
  private readonly times: number[] = []
  private oldest = 0
  constructor(private readonly limit: number) {}

  /** A clock that stepped back frees nothing. */
  full(at: number): boolean {
    return this.times.length === this.limit && at - this.times[this.oldest]! < SECOND_MS
  }

  take(at: number): void {
    if (this.full(at)) return
    if (this.times.length < this.limit) this.times.push(at)
    else {
      this.times[this.oldest] = at
      this.oldest = (this.oldest + 1) % this.limit
    }
  }
}

/**
 * Serve `handlers` on the devices' socket or pipe, or nothing: no path, a folder that is not this account's own, a token
 * that cannot be trusted, a name a live listener holds, a socket that cannot be made, or a record that cannot be
 * written. Each is one log line, and the devices run on without it.
 */
export async function openDevicesListener(
  { path, pipe, handlers, log, now = () => performance.now() }: DevicesListenerOptions,
): Promise<DevicesListener | null> {
  const where = pipe?.path ?? path
  if (where === null) {
    log('[devices] listener not opened · no path')
    return null
  }
  let token: Buffer | undefined
  if (pipe) {
    // The folder check on Windows is the daemon token's own: inside the profile, and no link (lib/secureState.ts).
    try {
      token = ensureDaemonToken(pipe.dataDir, DEVICES_TOKEN_FILE)
    } catch (error) {
      log(`[devices] listener not opened · token · ${errorKind(error)}`)
      return null
    }
  } else {
    let folder: Stats | undefined
    try { folder = lstatSync(dirname(where)) } catch { /* a short folder not made yet: listenLocalSocket makes it owner only */ }
    // What a client asks of the socket's folder before it sends (socketIsPrivate): a real folder of this account that no
    // one else can write to, where no other account can put a socket of its own in this one's place.
    if (folder && (!folder.isDirectory() || folder.uid !== process.getuid?.() || (folder.mode & 0o022) !== 0)) {
      log('[devices] listener not opened · folder not private')
      return null
    }
  }

  const largest = Math.max(...Object.values(handlers).map(({ maxBytes }) => maxBytes))
  // A rate per type per connection, gone with the connection: no table to bound or clean. And one per type across them.
  const rates = new WeakMap<Socket, Map<string, PerSecond>>()
  const wide = new Map(Object.entries(handlers).map(([type, { perSecond }]) => [type, new PerSecond(perSecond * LISTENER_MAX_CONNECTIONS)]))
  const droppedRate = new PerSecond(LISTENER_DROPPED_PER_SECOND)
  // Each connection's deadline, gone with it.
  const deadlines = new WeakMap<Socket, NodeJS.Timeout>()
  const waiting = new Set<AbortController>()
  // The open streams of each type by key ('' for a type that has none), as how to end each; and the connections that
  // hold one.
  const streams = new Map<string, Map<string, (reason: StreamEnd) => void>>()
  const streaming = new WeakSet<Socket>()
  let dropped = { ...NONE_DROPPED }
  let minute: NodeJS.Timeout | undefined

  const count = (kind: Dropped): void => {
    dropped[kind]++
    droppedRate.take(now())
    minute ??= setTimeout(() => {
      minute = undefined
      log(`[devices] listener in the last minute: ${dropped.unknown} unknown, ${dropped.oversized} oversized, ${dropped.rate} over rate, ${dropped.refused} refused, ${dropped.failed} failed`)
      dropped = { ...NONE_DROPPED }
    }, MINUTE_MS).unref()
  }

  const drop = (res: ServerResponse, status: number, kind: Dropped, close = false): void => {
    count(kind)
    res.writeHead(status, close ? { Connection: 'close' } : undefined).end()
  }

  // A connection that holds a stream sends nothing more on it: its answer would wait behind a stream that never ends.
  const heldByStream = (socket: Socket): boolean => {
    if (!streaming.has(socket)) return false
    count('refused')
    socket.destroy()
    return true
  }

  const allowed = (socket: Socket, type: string, perSecond: number): boolean => {
    let own = rates.get(socket)
    if (!own) rates.set(socket, own = new Map())
    let rate = own.get(type)
    if (!rate) own.set(type, rate = new PerSecond(perSecond))
    const across = wide.get(type)!
    const at = now()
    if (rate.full(at) || across.full(at)) return false
    rate.take(at)
    across.take(at)
    return true
  }

  const openStream = (type: string, handler: ListenerStreamHandler, message: Record<string, unknown>, socket: Socket, res: ServerResponse): void => {
    const { standby } = message
    if (standby !== undefined && typeof standby !== 'boolean') return drop(res, 400, 'refused')
    let key: string | typeof REFUSED
    // The handler's code, as its open below: a throw would go unanswered and reject settle() with nobody to catch it.
    try {
      key = handler.keyed ? handler.keyed.key(message) : ''
    } catch {
      return drop(res, 500, 'failed')
    }
    if (key === REFUSED) return drop(res, 400, 'refused')
    let ofType = streams.get(type)
    if (!ofType) streams.set(type, ofType = new Map())
    // A watch a newer one replaced stands by: it never takes the stream from one that is open, so two watches at once do
    // not take it from each other. Not counted: it is the answer a standing watch waits on, not a message dropped. A new
    // key past its type's limit is the same answer, before its handler opens anything: a key already open is replaced.
    if ((standby && ofType.has(key)) || (handler.keyed && !ofType.has(key) && ofType.size >= handler.keyed.limit)) {
      res.writeHead(409).end()
      return
    }
    const ended = new AbortController()
    // At most one line waits to drain, and only for the 2 s a connection has to answer: a client that stops reading
    // would otherwise hold the stream and its buffered lines.
    let writable = false
    let stall: NodeJS.Timeout | undefined
    let whenWritable: (() => void) | undefined
    // The first reason stays: the close that follows any end reads as the client gone.
    const end = (reason: StreamEnd): void => {
      if (ended.signal.aborted) return
      writable = false
      ended.abort(reason)
      clearTimeout(stall)
      ofType.delete(key)
      // Its connection has no deadline left to free its slot. A replaced one's goes once its last line is taken, which
      // tells its watch to stand by, or 2 s on for a client that has stopped reading.
      if (reason !== 'replaced') return void socket.destroy()
      const unread = setTimeout(() => socket.destroy(), LISTENER_TIMEOUT_MS).unref()
      socket.once('close', () => clearTimeout(unread))
      res.end(`${REPLACED_LINE}\n`, () => socket.destroy())
    }
    // The handler's code, run from the socket's write callback too: a throw there would end the devices process, so it
    // ends only this stream.
    const ready = (): void => {
      writable = true
      try {
        whenWritable?.()
      } catch {
        count('failed')
        end('closed')
      }
    }
    let answer: typeof REFUSED | void
    try {
      answer = handler.open(message, {
        ended: ended.signal,
        onWritable: (run) => { whenWritable = run },
        write: (line) => {
          if (!writable) return false
          writable = false
          stall = setTimeout(() => end('stalled'), LISTENER_TIMEOUT_MS).unref()
          // Called once the socket has taken the line, or with an error as its connection goes, before the close that
          // ends the stream: it stays unwritable then.
          res.write(`${JSON.stringify(line)}\n`, (error) => {
            clearTimeout(stall)
            if (!error && !ended.signal.aborted) ready()
          })
          return true
        },
      })
    } catch {
      ended.abort('closed')
      return drop(res, 500, 'failed')
    }
    if (answer === REFUSED) {
      ended.abort('closed')
      return drop(res, 400, 'refused')
    }
    ofType.get(key)?.('replaced')
    ofType.set(key, end)
    streaming.add(socket)
    clearTimeout(deadlines.get(socket))
    res.once('close', () => end('gone'))
    // Every end destroys its connection, so a client must not keep it for another message.
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', Connection: 'close' }).flushHeaders()
    ready()
  }

  const settle = async (req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> => {
    // Sent in the same write as the message that opened its connection's stream, it came before the stream was open.
    if (heldByStream(req.socket)) return
    const message = messageOf(body)
    if (!message) return drop(res, 400, 'refused')
    const type = message.type as string
    const handler = Object.hasOwn(handlers, type) ? handlers[type] : undefined
    if (!handler) return drop(res, 404, 'unknown')
    if (body.length > handler.maxBytes) return drop(res, 413, 'oversized')
    if (!allowed(req.socket, type, handler.perSecond)) return drop(res, 429, 'rate')
    if ('open' in handler) return openStream(type, handler, message, req.socket, res)
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
    if (heldByStream(req.socket)) return
    // A next message on a connection kept alive has the same time, counted from this answer.
    res.once('finish', () => deadlines.get(req.socket)?.refresh())
    // Its body is never read, so the connection closes after the answer rather than reading through that body, of any
    // size, to a next message.
    if (req.method !== 'POST' || req.url !== '/') return drop(res, 405, 'refused', true)
    // A loop of what is dropped costs a read and a parse each: past the dropped rate, neither.
    if (droppedRate.full(now())) return drop(res, 429, 'rate', true)
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
    listening = await listenLocalSocket(onRequest, where, { token })
  } catch (error) {
    log(`[devices] listener not opened · ${(error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 'in use' : 'failed'}`)
    return null
  }
  listening.server.maxConnections = LISTENER_MAX_CONNECTIONS
  // A deadline of its own, as Node's timeouts hold a slot far longer: it checks headersTimeout and requestTimeout every
  // 30 s, and keeps a connection idle after its answer for keepAliveTimeout and a second (measured: 30 s for a sender of
  // a byte at a time, 6 s for one that sends nothing more).
  listening.server.on('connection', (socket: Socket) => {
    const deadline = setTimeout(() => socket.destroy(), LISTENER_TIMEOUT_MS).unref()
    deadlines.set(socket, deadline)
    socket.once('close', () => clearTimeout(deadline))
  })
  // Said in each answer (`Keep-Alive: timeout=2`): a Node client lets go of an idle connection a second before the
  // deadline, rather than send on one the listener is closing.
  listening.server.keepAliveTimeout = LISTENER_TIMEOUT_MS
  // A listener never keeps its process up.
  listening.server.unref()
  if (pipe) {
    // Clients find the pipe only by its record: a pipe nobody can find is not open.
    try {
      writeDevicesRecord(pipe.dataDir, { pipe: pipe.path, pid: process.pid })
    } catch (error) {
      await listening.close()
      log(`[devices] listener not opened · record · ${errorKind(error)}`)
      return null
    }
  }
  // No path: a path holds the account's name.
  log('[devices] listener open')

  let closed: Promise<void> | undefined
  return {
    close: () => closed ??= (async () => {
      clearTimeout(minute)
      for (const ofType of streams.values()) for (const end of ofType.values()) end('closed')
      const gone = listening.close()
      for (const each of waiting) each.abort()
      await gone
      if (pipe) removeDevicesRecord(pipe.dataDir, pipe.path)
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

export const ATTACH_PER_SECOND = 10
/** The message, `{"type":"attach","sessionId":"<uuid>"}`, is 68 bytes. */
export const ATTACH_MAX_BYTES = 96

/** Claude Code's session id: a UUID in lower case, as it makes them; the agent's id is hashed from the string as given,
 *  so an upper-case one would name no session. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The session the Claude app shows, from the harness-device mod: its own session id, handed on. It keeps nothing and
 *  logs nothing, as the id names a person's session. */
export function attachHandler(attach: (sessionId: string) => void): ListenerHandler {
  return {
    maxBytes: ATTACH_MAX_BYTES,
    perSecond: ATTACH_PER_SECOND,
    handle: ({ sessionId }) => {
      if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return REFUSED
      attach(sessionId)
    },
  }
}

/** One a second on a connection: the notice desk's own limits are a minute an agent, so more would only be refused. */
export const NOTICE_PER_SECOND = 1
/** The longest notice, 120 four-byte letters, a 128-character session id and a 64-letter folder, is under 1 KiB. */
export const NOTICE_MAX_BYTES = 2048

const NOTICE_ENGINES: ReadonlySet<unknown> = new Set(['claude', 'codex'])

/** An agent's notice, from `harness device notify`: handed on as four typed fields, answered `{ result }`. It keeps
 *  nothing and logs nothing: the line is the agent's words. */
export function noticeHandler(notify: (ask: NoticeAsk) => NoticeResult): ListenerHandler {
  return {
    maxBytes: NOTICE_MAX_BYTES,
    perSecond: NOTICE_PER_SECOND,
    handle: ({ text, engine, sessionId, folder }) => {
      // The command cleans the line and the folder before it sends: one that differs did not come from it.
      if (typeof text !== 'string' || text === '' || text !== noticeLine(text)) return REFUSED
      if (engine !== undefined && !NOTICE_ENGINES.has(engine)) return REFUSED
      // A session id ties a notice to an agent only beside the engine that made it.
      if (sessionId !== undefined && (typeof sessionId !== 'string' || !NOTICE_SESSION.test(sessionId) || engine === undefined)) return REFUSED
      if (folder !== undefined && (typeof folder !== 'string' || folder === '' || folder !== noticeFolder(folder))) return REFUSED
      const ask: NoticeAsk = { text }
      if (engine !== undefined) ask.engine = engine as NoticeAsk['engine']
      if (sessionId !== undefined) ask.sessionId = sessionId
      if (folder !== undefined) ask.folder = folder
      return { result: notify(ask) }
    },
  }
}

export const NOTIFY_PER_SECOND = 2
/** Its message, `{"type":"notify","mode":"full"}`, is 31 bytes. */
export const NOTIFY_MAX_BYTES = 64

/** The Notifications setting, from `harness hardware watch`: handed on, answered with what `set` answers. */
export function notifyHandler(set: (mode: NotifyMode) => { mode: NotifyMode } | { error: string }): ListenerHandler {
  return {
    maxBytes: NOTIFY_MAX_BYTES,
    perSecond: NOTIFY_PER_SECOND,
    handle: ({ mode }) => isNotifyMode(mode) ? set(mode) : REFUSED,
  }
}

export const TAB_PER_SECOND = 10
/** The longest message tab takes, `{"type":"tab","app":"terminal-app","tty":"/dev/ttys9999"}`, is 57 bytes. */
export const TAB_MAX_BYTES = 96

/** The selected tab of the tab app in front, from `harness hardware watch`: its app and tty, handed on and nothing else.
 *  It keeps nothing and logs nothing, as a tty is as private as the app in front. */
export function tabHandler(report: (tab: Tab) => void): ListenerHandler {
  return {
    maxBytes: TAB_MAX_BYTES,
    perSecond: TAB_PER_SECOND,
    handle: (message) => {
      const tab = tabOf(message)
      if (!tab) return REFUSED
      report(tab)
    },
  }
}

export const THREAD_PER_SECOND = 10
/** The longest message thread takes, `{"type":"thread","title":…}` with 256 three-byte letters, is 796 bytes. */
export const THREAD_MAX_BYTES = 1024

/** The title of the ChatGPT app's window, from `harness hardware watch`: checked again by Harness Device's own rules,
 *  then handed on. The empty title is handed on too: it clears a waiting report. It keeps nothing and logs nothing, as
 *  a title is a person's words. */
export function threadHandler(report: (title: string) => void): ListenerHandler {
  return {
    maxBytes: THREAD_MAX_BYTES,
    perSecond: THREAD_PER_SECOND,
    handle: ({ title }) => {
      const checked = threadTitleOf(title)
      if (checked === null) return REFUSED
      report(checked)
    },
  }
}

/** Two a second on a connection: a watch opens it again after it ends, and a loop cannot churn it. */
export const TABS_PER_SECOND = 2
/** Its longest message, `{"type":"tabs","standby":false}`, is 31 bytes. */
export const TABS_MAX_BYTES = 32

export interface TabsStream {
  handler: ListenerStreamHandler
  isOpen(): boolean
  /** One line for the watch to select the tab; a tap's raises its window too. False with no stream open. */
  select(tab: Tab, raise: boolean): boolean
}

/** The stream a watch holds open to hear which tab to select. Nothing waits for one that is not open: a select then is
 *  not sent. */
export function tabsStream(): TabsStream {
  let open: ListenerStream | undefined
  return {
    handler: {
      maxBytes: TABS_MAX_BYTES,
      perSecond: TABS_PER_SECOND,
      open: (_message, stream) => {
        open = stream
        // A newer stream is the open one by the time the older ends.
        stream.ended.addEventListener('abort', () => { if (open === stream) open = undefined })
      },
    },
    isOpen: () => open !== undefined,
    select: ({ app, tty }, raise) => open?.write(raise ? { app, tty, raise: true } : { app, tty }) ?? false,
  }
}

/** One a second on a connection: the plugin's worker opens it again after it ends, and a loop cannot churn it. */
export const DIAL_PER_SECOND = 1
/** Its message, `{"type":"dial","standby":true}`, is 30 bytes. */
export const DIAL_MAX_BYTES = 64
/** The longest name a line holds, in code points: a line stays under 400 bytes in any script. */
export const DIAL_NAME_MAX = 64

export type DialLine = { attached: false } | { attached: true; agent: DialAgent | null }

export interface DialStream {
  handler: ListenerStreamHandler
  /** Whether a stream is open: from its open until it ends. */
  isOpen(): boolean
  /** Whether any dial is attached. */
  attached(on: boolean): void
  /** The agent the dial shows, or null for none. */
  shows(agent: DialAgent | null): void
}

/**
 * The stream Orca's Harness Device plugin holds open to show the dial's state
 * (docs/specs/2026-11-16-orca-device-plugin.md): the state as it opens, then a line each time it changes. Only the latest
 * state is written, once the stream can take a line and only when it differs from the last one written, so a swipe
 * across ten agents while a line drains is two lines, and no timer writes one. A name leaves the process here and
 * nowhere else: the log says only that the stream opened, why it ended and how many lines a minute.
 */
export function dialStream({ log, after, ended }: {
  log(line: string): void
  after(ms: number, run: () => void): () => void
  /** Run once the open stream ends, for any reason: what the plugin told the devices lives no longer than its stream. */
  ended?(): void
}): DialStream {
  let on = false
  let agent: DialAgent | null = null
  /** Writes the latest line on the open stream; none with no stream open. */
  let writer: (() => void) | undefined
  let written = 0

  const latest = (): DialLine => on ? { attached: true, agent } : { attached: false }

  return {
    handler: {
      maxBytes: DIAL_MAX_BYTES,
      perSecond: DIAL_PER_SECOND,
      open: (message, stream) => {
        // A standby open never takes the stream from another Orca that holds it, so this one is never replaced.
        if (message.standby !== true) return REFUSED
        let last: string | undefined
        const write = (): void => {
          const line = latest()
          const text = JSON.stringify(line)
          // One that answers false is not remembered: the next writable call writes the then latest line.
          if (text === last || !stream.write(line)) return
          last = text
          if (written++ === 0) after(MINUTE_MS, () => {
            log(`[devices] dial stream · lines in the last minute: ${written}`)
            written = 0
          })
        }
        writer = write
        log('[devices] dial stream · open')
        stream.ended.addEventListener('abort', () => {
          log(`[devices] dial stream · ended · ${stream.ended.reason}`)
          // A newer stream is the open one by the time the older ends: only the open stream's end closes it and runs `ended`.
          if (writer !== write) return
          writer = undefined
          ended?.()
        })
        stream.onWritable(write)
      },
    },
    isOpen: () => writer !== undefined,
    attached: (next) => {
      on = next
      writer?.()
    },
    shows: (next) => {
      // Made anew: the line's keys in its own order, and nothing else the caller holds. Cut by code point, so a pair
      // stays whole.
      agent = next && { name: [...next.name].slice(0, DIAL_NAME_MAX).join(''), app: next.app }
      writer?.()
    },
  }
}

/** Ten a second on a connection: the plugin sends one each time Orca's worktree on screen changes. */
export const ORCA_FRONT_PER_SECOND = 10
/** Its longest message, 50 handles, is 2234 bytes. */
export const ORCA_FRONT_MAX_BYTES = 4096
/** The most terminals of a workspace Orca tells a plugin (its PLUGIN_WORKSPACE_TERMINAL_LIMIT). */
export const ORCA_FRONT_MAX_TERMINALS = 50

/**
 * The terminals of the worktree on Orca's screen, from Orca's Harness Device plugin
 * (docs/plans/2026-11-18-dial-orca-tab-scope-design.md): their handles in Orca's order, or null for none, handed on as
 * given. Taken only while the plugin's dial stream is open, as the devices drop them when that stream ends: one taken
 * with none open, a late retry, would leave a scope nobody clears. It keeps nothing and logs nothing.
 */
export function orcaFrontHandler(isOpen: () => boolean, front: (terminals: readonly string[] | null) => void): ListenerHandler {
  return {
    maxBytes: ORCA_FRONT_MAX_BYTES,
    perSecond: ORCA_FRONT_PER_SECOND,
    handle: ({ terminals }) => {
      if (!isOpen()) return REFUSED
      if (terminals !== null && !(Array.isArray(terminals) && terminals.length <= ORCA_FRONT_MAX_TERMINALS
        && terminals.every((handle): handle is string => typeof handle === 'string' && ORCA_HANDLE.test(handle)))) return REFUSED
      front(terminals)
    },
  }
}
