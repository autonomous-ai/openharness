/**
 * opencode's local server (docs/plans/2026-11-17-dial-opencode-design.md): its sessions, their events, and the dial's
 * words, for the opencode source. opencode 2.x runs one background service that its TUIs, desktop app and web page all
 * use, and names it in `service.json`.
 *
 * Everything is checked here. The file is another program's and names where a password goes: it must be a plain file of
 * this user's, within its bound, before it is read, and its url on this computer before anything connects, so the
 * password and the person's words never leave it. The server must then say it is the process the file names. An answer
 * and a frame have a bound, and the session id and the words came from the dial, so each is held to its form before it
 * goes out.
 *
 * A prompt reads the running sessions and the pending permissions first: words for a session that is working or waiting
 * for an answer are refused, never put into its turn. It is still queued: opencode's default delivery steers, joining a
 * turn that started between the reads and the post, where a queued prompt waits for that turn's end.
 *
 * One request a connection, and no redirect followed. Nothing here logs: opencode's answers name people's folders and
 * sessions and the file holds a password, so the source says what happened in its own fixed words.
 */
import { randomInt } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs'
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { CONTROL, MAX_TEXT, RUN_TIMEOUT_MS } from './orca.js'

/** opencode's session and permission ids, `ses_…` and `per_…`. A session id goes into a path, so no `/`, `?` or `.`. */
export const OPENCODE_SESSION = /^ses[A-Za-z0-9_-]{1,96}$/
export const OPENCODE_PERMISSION = /^per[A-Za-z0-9_-]{1,96}$/
/** opencode's message id, the form opencodeMessageId makes. */
export const OPENCODE_MESSAGE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/
/** service.json is five short fields; a bigger file is not opencode's. */
export const MAX_SERVICE_BYTES = 4096
/** The longest answer, and the longest event frame. */
export const MAX_BODY_BYTES = 1024 * 1024
/** Three of opencode's 15 s heartbeats missed. */
export const SILENCE_MS = 45_000
/** The kinds the stream asks for; opencode adds `server.connected` itself. */
export const EVENT_TYPES = [
  'session.created', 'session.unarchived', 'session.archived', 'session.deleted', 'session.renamed',
  'session.execution.started', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted',
  'session.idle', 'session.status', 'permission.asked', 'permission.replied',
] as const

export interface OpencodeClientDeps { servicePath: string; uid: number; platform: NodeJS.Platform }

/** Where opencode registers its service, as opencode works it out, on every platform. A relative or empty
 *  XDG_STATE_HOME counts as unset: opencode would read it against its own folder, which the daemon cannot know. */
export function opencodeServicePath(vars: NodeJS.ProcessEnv, home: string): string {
  const state = vars.XDG_STATE_HOME && isAbsolute(vars.XDG_STATE_HOME) ? vars.XDG_STATE_HOME : join(home, '.local', 'state')
  return join(state, 'opencode', 'service.json')
}

export function opencodeClientDeps(): OpencodeClientDeps {
  return { servicePath: opencodeServicePath(process.env, homedir()), uid: process.getuid?.() ?? -1, platform: process.platform }
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
let lastMs = 0
let counter = 0

/** A message id of our own, in opencode's form (packages/schema/src/identifier.ts, v2.3.0): `msg_`, 12 hex characters of
 *  the time in ms × 4096 and a counter, then 14 of [0-9A-Za-z]. opencode's ids sort by time, so ours do too. */
export function opencodeMessageId(): string {
  const now = Date.now()
  counter = now === lastMs ? counter + 1 : 1
  lastMs = now
  const time = ((BigInt(now) * 0x1000n + BigInt(counter)) & 0xffff_ffff_ffffn).toString(16).padStart(12, '0')
  let random = ''
  for (let at = 0; at < 14; at++) random += BASE62[randomInt(BASE62.length)]
  return `msg_${time}${random}`
}

/** Why there is no answer: the word a log line says. */
export type OpencodeFault = 'no_service' | 'not_local' | 'not_ours' | 'old_version' | 'refused' | 'timeout' | 'oversize'
  | 'bad_json' | 'unauthorized' | 'not_found' | 'conflict' | `http_${number}`
export type OpencodeAnswer = { ok: true; json: unknown } | { ok: false; fault: OpencodeFault }
export type OpencodePrompt = 'sent' | 'busy' | 'waiting' | 'gone' | 'failed'
export interface OpencodeEvent { type: string; data: Record<string, unknown> }
export interface OpencodeClient {
  /** service.json as it is now, every file check passed, with nothing sent: its stamp, never logged. */
  registration(): { stamp: string } | { fault: 'no_service' | 'not_local' }
  /** Reads the registration and asks it who it is. A stamp: the calls below go to that service until the next find. */
  find(): Promise<{ stamp: string } | { fault: OpencodeFault }>
  request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<OpencodeAnswer>
  events(onEvent: (event: OpencodeEvent) => void, onClose: (reason: OpencodeFault | 'ended') => void): { close(): void }
  prompt(sessionId: string, text: string, messageId: string): Promise<OpencodePrompt>
}

/** A registration that passed every check. */
interface Service {
  stamp: string
  hostname: string
  port: number
  pid: number
  version?: string
  /** The Basic header, the only place the password goes. */
  authorization?: string
}

const LOOPBACK: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]', 'localhost'])
const ASKED: ReadonlySet<string> = new Set(EVENT_TYPES)
const EVENT_PATH = `/api/event?${new URLSearchParams(EVENT_TYPES.map((type): [string, string] => ['types', type]))}`

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const optional = (value: unknown): value is string | undefined => value === undefined || typeof value === 'string'

/** A url only on this computer, over plain http with no user in it; else none. */
const loopback = (text: string): URL | undefined => {
  try {
    const url = new URL(text)
    return url.protocol === 'http:' && LOOPBACK.has(url.hostname) && url.username === '' && url.password === '' ? url : undefined
  } catch {
    return undefined
  }
}

const faultOf = (status: number): OpencodeFault =>
  status === 401 ? 'unauthorized' : status === 404 ? 'not_found' : status === 409 ? 'conflict' : `http_${status}`

const parsed = (text: string): OpencodeAnswer => {
  try {
    return { ok: true, json: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, fault: 'bad_json' }
  }
}

const outcome = (fault: OpencodeFault): OpencodePrompt => fault === 'not_found' ? 'gone' : 'failed'

/** One request on a connection of its own, to the service's loopback address, with its password when it has one. */
function send(
  service: Service, method: string, path: string, payload: string | undefined,
  answered: (response: IncomingMessage) => void, failed: () => void,
): ClientRequest {
  const request = httpRequest({
    hostname: service.hostname,
    port: service.port,
    method,
    path,
    agent: false,
    headers: {
      ...(service.authorization === undefined ? {} : { authorization: service.authorization }),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
  }, answered)
  // Another program's connection never keeps the devices process up.
  request.on('socket', (socket) => socket.unref())
  request.on('error', failed)
  request.end(payload)
  return request
}

/** One request, 10 s for its whole answer. */
const call = (service: Service, method: 'GET' | 'POST', path: string, body?: unknown) => new Promise<OpencodeAnswer>((resolve) => {
  let done = false
  const finish = (answer: OpencodeAnswer) => {
    if (done) return
    done = true
    clearTimeout(deadline)
    request.destroy()
    resolve(answer)
  }
  const deadline = setTimeout(() => finish({ ok: false, fault: 'timeout' }), RUN_TIMEOUT_MS)
  deadline.unref()
  const request = send(service, method, path, body === undefined ? undefined : JSON.stringify(body), (response) => {
    const status = response.statusCode ?? 0
    // A redirect is a fault like any other status, never followed: the password would go wherever it points.
    if (status < 200 || status > 299) return finish({ ok: false, fault: faultOf(status) })
    const chunks: Buffer[] = []
    let size = 0
    response.on('data', (chunk: Buffer) => {
      size += chunk.length
      // Cut off as it passes, never read to its end.
      if (size > MAX_BODY_BYTES) return finish({ ok: false, fault: 'oversize' })
      chunks.push(chunk)
    })
    response.on('end', () => finish(parsed(Buffer.concat(chunks).toString('utf8'))))
    // Closed before its end: no whole answer.
    response.on('close', () => finish({ ok: false, fault: 'refused' }))
  }, () => finish({ ok: false, fault: 'refused' }))
})

export function createOpencodeClient(deps: OpencodeClientDeps): OpencodeClient {
  let held: Service | undefined

  /** The file's text while it is a plain file of this user's within its bound; else none. */
  const readService = (): string | undefined => {
    // Windows has no owner to check.
    const usable = (file: Stats) =>
      file.isFile() && file.size <= MAX_SERVICE_BYTES && (deps.platform === 'win32' || file.uid === deps.uid)
    let fd: number | undefined
    try {
      // Checked before it is opened: a symlink is refused, and a FIFO would never answer the open.
      if (!usable(lstatSync(deps.servicePath))) return undefined
      // One swapped in since is neither followed nor waited on, and what was opened is checked again.
      fd = openSync(deps.servicePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      if (!usable(fstatSync(fd))) return undefined
      const bytes = Buffer.alloc(MAX_SERVICE_BYTES + 1)
      const size = readSync(fd, bytes, 0, bytes.length, 0)
      // One that grew since is past its bound.
      return size > MAX_SERVICE_BYTES ? undefined : bytes.toString('utf8', 0, size)
    } catch {
      return undefined
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }

  const service = (): Service | { fault: 'no_service' | 'not_local' } => {
    let fields: unknown
    try {
      fields = JSON.parse(readService() ?? '')
    } catch {
      // Missing, or half written: no service, and the next change reads it again.
      return { fault: 'no_service' }
    }
    if (!isObject(fields)) return { fault: 'no_service' }
    const { url, pid, id, version, password } = fields
    if (typeof url !== 'string' || typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1
      || !optional(id) || !optional(version) || !optional(password)) return { fault: 'no_service' }
    const at = loopback(url)
    if (!at) return { fault: 'not_local' }
    return {
      // The same service while these are; the password is not in it.
      stamp: JSON.stringify([id ?? null, pid, url]),
      // http takes an IPv6 address without the url's brackets.
      hostname: at.hostname.replace(/^\[(.*)\]$/, '$1'),
      port: Number(at.port || 80),
      pid,
      version,
      authorization: password === undefined ? undefined : `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
    }
  }

  const registration = (): ReturnType<OpencodeClient['registration']> => {
    const found = service()
    return 'fault' in found ? found : { stamp: found.stamp }
  }

  const find = async (): Promise<{ stamp: string } | { fault: OpencodeFault }> => {
    held = undefined
    const found = service()
    if ('fault' in found) return found
    const info = await call(found, 'GET', '/api/info')
    // A server with no /api/info has no V2 API.
    if (!info.ok) return { fault: info.fault === 'not_found' ? 'old_version' : info.fault }
    const { pid, version } = isObject(info.json) ? info.json : {}
    // opencode's own client takes a service only when it answers the file's pid, and its version when the file has one.
    if (pid !== found.pid || (found.version !== undefined && version !== found.version)) return { fault: 'not_ours' }
    const major = typeof version === 'string' ? /^(\d+)\./.exec(version) : null
    if (!major || Number(major[1]) < 2) return { fault: 'old_version' }
    held = found
    return { stamp: found.stamp }
  }

  const request = (method: 'GET' | 'POST', path: string, body?: unknown): Promise<OpencodeAnswer> =>
    held ? call(held, method, path, body) : Promise.resolve({ ok: false, fault: 'no_service' })

  const events = (onEvent: (event: OpencodeEvent) => void, onClose: (reason: OpencodeFault | 'ended') => void) => {
    let over = false
    let request: ClientRequest | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    // onClose is told once, and the caller's own close tells nothing.
    const end = (reason?: OpencodeFault | 'ended') => {
      if (over) return
      over = true
      clearTimeout(timer)
      request?.destroy()
      if (reason) onClose(reason)
    }
    const wait = (ms: number) => {
      clearTimeout(timer)
      timer = setTimeout(() => end('timeout'), ms)
      timer.unref()
    }
    const handle = { close: () => end() }
    const service = held
    if (!service) {
      // Told once the caller holds its close, as every other end is.
      queueMicrotask(() => end('no_service'))
      return handle
    }
    // Until server.connected the request's deadline, then no byte for three heartbeats.
    wait(RUN_TIMEOUT_MS)
    let connected = false
    let answered = false
    let line: Buffer[] = []
    let data: string[] = []
    // The frame's bytes so far, its line being read among them.
    let size = 0

    const tell = (frame: string) => {
      let value: unknown
      try {
        value = JSON.parse(frame)
      } catch {
        return end('bad_json')
      }
      if (!isObject(value) || typeof value.type !== 'string') return end('bad_json')
      if (value.type === 'server.connected') {
        connected = true
        wait(SILENCE_MS)
      } else if (!ASKED.has(value.type)) return
      onEvent({ type: value.type, data: isObject(value.data) ? value.data : {} })
    }

    // As SSE reads a line: a blank one ends the frame, and only the data field is read. A comment (opencode's heartbeat)
    // is a field with no name.
    const read = (text: string) => {
      if (text === '') {
        const frame = data
        data = []
        size = 0
        if (frame.length > 0) tell(frame.join('\n'))
        return
      }
      const colon = text.indexOf(':')
      if ((colon === -1 ? text : text.slice(0, colon)) !== 'data') return
      const value = colon === -1 ? '' : text.slice(colon + 1)
      data.push(value.startsWith(' ') ? value.slice(1) : value)
    }

    request = send(service, 'GET', EVENT_PATH, undefined, (response) => {
      answered = true
      if (response.statusCode !== 200) return end(faultOf(response.statusCode ?? 0))
      response.on('data', (chunk: Buffer) => {
        if (connected) wait(SILENCE_MS)
        // Lines are cut as bytes, so a character split across chunks is whole once its line is.
        let from = 0
        while (!over) {
          const newline = chunk.indexOf(0x0a, from)
          const piece = chunk.subarray(from, newline === -1 ? chunk.length : newline)
          size += piece.length
          if (size > MAX_BODY_BYTES) return end('oversize')
          line.push(piece)
          if (newline === -1) return
          from = newline + 1
          const text = Buffer.concat(line).toString('utf8')
          line = []
          read(text.endsWith('\r') ? text.slice(0, -1) : text)
        }
      })
      response.on('close', () => end('ended'))
    }, () => end(answered ? 'ended' : 'refused'))
    return handle
  }

  const prompt = async (sessionId: string, text: string, messageId: string): Promise<OpencodePrompt> => {
    // The words are shown in opencode's screen: an escape there would steer it, so they are one line of plain text, as
    // Orca's and herdr's are.
    const words = text.replace(CONTROL, ' ')
    if (!OPENCODE_SESSION.test(sessionId) || !OPENCODE_MESSAGE.test(messageId) || text.length > MAX_TEXT || words.trim() === '') {
      return 'failed'
    }
    const active = await request('GET', '/api/session/active')
    if (!active.ok) return outcome(active.fault)
    const running = isObject(active.json) ? active.json.data : undefined
    if (!isObject(running)) return 'failed'
    if (Object.hasOwn(running, sessionId)) return 'busy'
    const session = `/api/session/${sessionId}`
    const asked = await request('GET', `${session}/permission`)
    if (!asked.ok) return outcome(asked.fault)
    const pending = isObject(asked.json) ? asked.json.data : undefined
    if (!Array.isArray(pending)) return 'failed'
    if (pending.length > 0) return 'waiting'
    const body = { text: words, id: messageId, delivery: 'queue' }
    let sent = await request('POST', `${session}/prompt`, body)
    // With no answer the words may have landed or not. Posted once more under the same id, they land once: a 409 says the
    // first did. Any answer is opencode's own, and is never posted again.
    if (!sent.ok && (sent.fault === 'refused' || sent.fault === 'timeout')) sent = await request('POST', `${session}/prompt`, body)
    // A 409 is only ever our own id: an earlier post of these same words.
    return sent.ok || sent.fault === 'conflict' ? 'sent' : outcome(sent.fault)
  }

  return { registration, find, request, events, prompt }
}
