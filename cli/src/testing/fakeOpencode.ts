/**
 * An opencode V2 service for specs: an HTTP server on 127.0.0.1:0, registered in a `service.json` of a state folder of
 * its own, so no spec reaches the developer's opencode (~/.local/state/opencode). It answers the shapes of opencode
 * v2.3.0's OpenAPI (docs/plans/2026-11-17-dial-opencode-plan.md, "Shapes"), each required field there, and holds what
 * the specs set: sessions, the running ones, pending permissions, the last assistant text. It records every request,
 * and `got` and `stream` resolve on what it saw, so no spec polls it.
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface FakeOpencodeOptions {
  /** `<stateDir>/opencode/service.json` is its registration. A fresh temp folder when unset. */
  stateDir?: string
  /** The file's password, asked of every request; null for a service with none. Default 'e2e-word'. */
  password?: string | null
  /** What the file and /api/info say. Default '2.3.0'. */
  version?: string
}

export interface FakeSession {
  id: string; title?: string; directory?: string; parentID?: string
  updated?: number; idle?: number; viewed?: number; archived?: number
  /** Its last assistant text; none for a session with no assistant message. */
  answer?: string
}

/** `authorized`: the request carried the header the service asks for, the right Basic one, or none for a service with
 *  none. `body`: a POST's JSON, its text when it is no JSON, undefined when empty. */
export interface FakeRequest { method: string; path: string; query: URLSearchParams; authorized: boolean; body: unknown }

/** A status with its JSON and headers, bytes as they are under a 200, nothing with the connection held open (`hold`),
 *  or nothing with it ended (`close`). */
export type FakeAnswer = { status: number; json?: unknown; headers?: Record<string, string> } | { raw: string } | 'hold' | 'close'

export interface FakeOpencode {
  readonly stateDir: string
  readonly servicePath: string
  readonly url: string
  readonly requests: readonly FakeRequest[]
  /** The n-th request (from 1, default 1) of that route, `'GET /api/session/active'`, once it has arrived. */
  got(route: string, n?: number): Promise<FakeRequest>
  /** Once n event streams have been opened in all. */
  stream(n: number): Promise<void>
  /** The event streams open now. */
  readonly streams: number
  /** Adds or replaces a session; `updated` defaults to now. No event. */
  session(session: FakeSession): void
  /** A turn starts: it is active, `time.updated` and `time.busy` now, and `session.execution.started` is told. */
  start(id: string): void
  /** A turn ends: not active, `time.updated` and `time.idle` now, `answer` its last assistant text when given, and the
   *  event told. */
  end(id: string, how: 'succeeded' | 'failed' | 'interrupted', answer?: string): void
  /** A pending permission and `permission.asked`: its id. */
  ask(id: string): string
  /** That permission answered: gone, and `permission.replied` told. */
  reply(id: string, permissionId: string): void
  /** An event to each live stream that asked for its kind. */
  event(type: string, data: Record<string, unknown>): void
  /** Bytes to each live stream; a heartbeat; every stream ended. */
  send(raw: string | Uint8Array): void
  heartbeat(): void
  drop(): void
  /** What a route answers from now on; with no answer, the fake's own again. */
  answer(route: string, answer?: FakeAnswer): void
  /** Writes service.json again, these fields over its own; null leaves a field out. */
  register(over?: { id?: string | null; version?: string | null; url?: string; pid?: number; password?: string | null }): void
  /** Closes every connection and the server, and removes service.json: opencode stopping. */
  stop(): Promise<void>
  /** As `stop`, but service.json stays: an opencode that died. */
  crash(): Promise<void>
  /** Listens again, on another port, and registers again with another id. Its sessions stay, as opencode's do. */
  restart(): Promise<void>
}

/** opencode's own heartbeat, a comment frame. */
const HEARTBEAT_MS = 15_000
const HEARTBEAT = ': heartbeat\n\n'
/** Where a session with no `directory` is. */
const DIRECTORY = '/work'

interface Held extends FakeSession { created: number; updated: number; busy?: number }
interface Permission { id: string; sessionID: string; action: string; resources: string[] }
interface Live { types: string[]; heartbeat: NodeJS.Timeout }

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parse = (text: string): unknown => {
  if (text === '') return undefined
  try { return JSON.parse(text) } catch { return text }
}

const notFound = (sessionID: string): FakeAnswer =>
  ({ status: 404, json: { _tag: 'SessionNotFoundError', sessionID, message: 'Session not found' } })
const UNAUTHORIZED: FakeAnswer = { status: 401, json: { _tag: 'UnauthorizedError', message: 'Unauthorized' } }
const NO_ROUTE: FakeAnswer = { status: 404, json: { _tag: 'RouteNotFound', message: 'Not found' } }

/** A session's id in a session route's path, `active` aside. */
const SESSION_PATH = /^\/api\/session\/([^/]+)(?:\/.*)?$/

export async function fakeOpencode(options: FakeOpencodeOptions = {}): Promise<FakeOpencode> {
  const stateDir = options.stateDir ?? await mkdtemp(join(tmpdir(), 'opencode-'))
  const folder = join(stateDir, 'opencode')
  const servicePath = join(folder, 'service.json')
  const password = options.password === undefined ? 'e2e-word' : options.password
  const version = options.version ?? '2.3.0'
  const basic = password === null ? undefined : `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`

  const requests: FakeRequest[] = []
  const answers = new Map<string, FakeAnswer>()
  const sessions = new Map<string, Held>()
  const active = new Set<string>()
  const permissions = new Map<string, Permission[]>()
  const posted = new Set<string>()
  const sockets = new Set<Socket>()
  const live = new Map<ServerResponse, Live>()
  // What `got` and `stream` wait for, asked again on every request and every stream.
  const waits = new Set<() => boolean>()
  const settle = () => { for (const done of waits) if (done()) waits.delete(done) }
  let server: Server | undefined
  let port = 0
  let serviceId = ''
  let opened = 0
  let events = 0
  let asked = 0
  let messages = 0
  let stamped = 0

  const url = () => `http://127.0.0.1:${port}`
  // Each stamp later than the last: two in one millisecond would tie, and the list's order rest on the clock.
  const stamp = () => (stamped = Math.max(Date.now(), stamped + 1))

  const sessionInfo = (held: Held) => ({
    id: held.id,
    ...(held.parentID === undefined ? {} : { parentID: held.parentID }),
    projectID: 'prj_1',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: {
      created: held.created,
      updated: held.updated,
      ...(held.busy === undefined ? {} : { busy: held.busy }),
      ...(held.idle === undefined ? {} : { idle: held.idle }),
      ...(held.viewed === undefined ? {} : { viewed: held.viewed }),
      ...(held.archived === undefined ? {} : { archived: held.archived }),
    },
    ...(held.title === undefined ? {} : { title: held.title }),
    location: { directory: held.directory ?? DIRECTORY },
  })

  // opencode's message ids: `msg_`, 12 hex characters that sort by time, then 14 of [0-9A-Za-z].
  const messageId = () => `msg_${(++messages).toString(16).padStart(12, '0')}${'A'.repeat(14)}`

  const list = (query: URLSearchParams): FakeAnswer => {
    const parent = query.get('parentID')
    const archived = query.get('archived')
    const sign = query.get('order') === 'asc' ? 1 : -1
    const limit = Number(query.get('limit') ?? 50)
    const data = [...sessions.values()]
      .filter((held) => parent === null || (parent === 'null' ? held.parentID === undefined : held.parentID === parent))
      .filter((held) => archived === null || (archived === 'true') === (held.archived !== undefined))
      .sort((a, b) => sign * (a.updated - b.updated))
      .slice(0, limit)
      .map(sessionInfo)
    return { status: 200, json: { data, cursor: {} } }
  }

  const lastAnswer = (held: Held, query: URLSearchParams): FakeAnswer => {
    const type = query.get('type')
    const data = held.answer === undefined || (type !== null && type !== 'assistant') ? [] : [{
      id: messageId(), type: 'assistant', time: { created: held.idle ?? held.updated }, agent: 'build',
      model: { id: 'm', providerID: 'p' },
      content: [{ type: 'reasoning', text: 'Thinking it over.' }, { type: 'text', text: held.answer }],
    }]
    return { status: 200, json: { data, cursor: {} } }
  }

  const prompt = (sessionID: string, body: unknown): FakeAnswer => {
    const fields = isObject(body) ? body : {}
    const id = typeof fields.id === 'string' ? fields.id : messageId()
    if (posted.has(id)) {
      return { status: 409, json: { _tag: 'ConflictError', message: 'Prompt message ID conflicts with an existing durable record' } }
    }
    posted.add(id)
    return { status: 200, json: { data: {
      id, sessionID, time: { created: Date.now() }, type: 'user', payload: { text: fields.text }, delivery: fields.delivery,
    } } }
  }

  const opencodes = (request: FakeRequest): FakeAnswer => {
    const { method, path, query } = request
    const route = `${method} ${path}`
    if (route === 'GET /api/info') {
      return { status: 200, json: { version, pid: process.pid, urls: [url()], paths: { tmp: '/tmp/opencode' } } }
    }
    if (route === 'GET /api/session') return list(query)
    if (route === 'GET /api/session/active') {
      return { status: 200, json: { data: Object.fromEntries([...active].map((id) => [id, { type: 'running' }])) } }
    }
    const named = SESSION_PATH.exec(path)?.[1]
    if (named === undefined) return NO_ROUTE
    const sessionID = decodeURIComponent(named)
    const held = sessions.get(sessionID)
    if (!held) return notFound(sessionID)
    const tail = path.slice(`/api/session/${named}`.length)
    if (method === 'GET' && tail === '/permission') return { status: 200, json: { data: permissions.get(sessionID) ?? [] } }
    if (method === 'GET' && tail === '/message') return lastAnswer(held, query)
    if (method === 'POST' && tail === '/prompt') return prompt(sessionID, request.body)
    return NO_ROUTE
  }

  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`

  const openStream = (response: ServerResponse, request: FakeRequest) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    response.write(frame({ id: `evt_${++events}`, type: 'server.connected', data: {} }))
    // An unref'd timer, so a test longer than the client's 45 s silence keeps its stream, and a spec that fakes timers
    // drives it; re-armed each time, so one that fakes setTimeout alone drives it too.
    const beat = () => {
      response.write(HEARTBEAT)
      entry.heartbeat = setTimeout(beat, HEARTBEAT_MS).unref()
    }
    const entry: Live = { types: request.query.getAll('types'), heartbeat: setTimeout(beat, HEARTBEAT_MS).unref() }
    live.set(response, entry)
    response.on('close', () => {
      clearTimeout(entry.heartbeat)
      live.delete(response)
    })
    opened++
    settle()
  }

  const write = (response: ServerResponse, answer: FakeAnswer) => {
    if (answer === 'hold') return
    if (answer === 'close') return void response.socket?.destroy()
    if ('raw' in answer) {
      response.writeHead(200, { 'content-type': 'application/json' })
      return void response.end(answer.raw)
    }
    response.writeHead(answer.status, {
      ...(answer.json === undefined ? {} : { 'content-type': 'application/json' }),
      ...answer.headers,
    })
    response.end(answer.json === undefined ? undefined : JSON.stringify(answer.json))
  }

  const receive = (message: IncomingMessage, response: ServerResponse, text: string) => {
    const target = new URL(message.url ?? '/', 'http://127.0.0.1')
    const header = message.headers.authorization
    const request: FakeRequest = {
      method: message.method ?? 'GET',
      path: target.pathname,
      query: target.searchParams,
      authorized: header === basic,
      body: parse(text),
    }
    requests.push(request)
    settle()
    if (basic !== undefined && !request.authorized) return write(response, UNAUTHORIZED)
    const route = `${request.method} ${request.path}`
    const set = answers.get(route)
    if (set) return write(response, set)
    if (route === 'GET /api/event') return openStream(response, request)
    write(response, opencodes(request))
  }

  const bind = () => new Promise<Server>((resolve, reject) => {
    const next = createServer((message, response) => {
      let text = ''
      message.setEncoding('utf8')
      message.on('data', (chunk: string) => { text += chunk })
      message.on('end', () => receive(message, response, text))
    })
    next.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    next.once('error', reject)
    next.listen(0, '127.0.0.1', () => resolve(next))
  })
  const portOf = (bound: Server) => {
    const address = bound.address()
    return typeof address === 'object' && address ? address.port : 0
  }

  const listen = async () => {
    let next = await bind()
    // A restart is on another port, which an address just freed could otherwise be again.
    if (portOf(next) === port) {
      const taken = next
      next = await bind()
      taken.close()
    }
    server = next
    port = portOf(next)
  }

  const close = async () => {
    const was = server
    server = undefined
    for (const socket of sockets) socket.destroy()
    if (was) await new Promise((resolve) => was.close(resolve))
  }

  const register: FakeOpencode['register'] = (over = {}) => {
    const fields: Record<string, unknown> = { id: serviceId, version, url: url(), pid: process.pid, password, ...over }
    for (const [key, value] of Object.entries(fields)) if (value === null) delete fields[key]
    // Whole or not at all, as a reader may read it at any moment: a temp file of its own, then a rename.
    const temp = `${servicePath}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(temp, JSON.stringify(fields), { mode: 0o600 })
    renameSync(temp, servicePath)
  }
  const registerAnew = () => {
    serviceId = `svc_${randomBytes(6).toString('hex')}`
    register()
  }

  const until = <T>(found: () => T | undefined): Promise<T> => new Promise((resolve) => {
    const done = () => {
      const value = found()
      if (value !== undefined) resolve(value)
      return value !== undefined
    }
    if (!done()) waits.add(done)
  })

  const event: FakeOpencode['event'] = (type, data) => {
    const told = frame({ id: `evt_${++events}`, created: Date.now(), type, data })
    for (const [response, { types }] of live) if (types.length === 0 || types.includes(type)) response.write(told)
  }

  const fake: FakeOpencode = {
    stateDir,
    servicePath,
    get url() { return url() },
    requests,
    got: (route, n = 1) => until(() => requests.filter((request) => `${request.method} ${request.path}` === route)[n - 1]),
    stream: async (n) => { await until(() => opened >= n || undefined) },
    get streams() { return live.size },
    session: (session) => {
      const updated = session.updated ?? stamp()
      sessions.set(session.id, { ...session, updated, created: sessions.get(session.id)?.created ?? updated })
    },
    start: (id) => {
      active.add(id)
      const held = sessions.get(id)
      if (held) held.updated = held.busy = stamp()
      event('session.execution.started', { sessionID: id })
    },
    end: (id, how, answer) => {
      active.delete(id)
      const held = sessions.get(id)
      if (held) {
        held.updated = held.idle = stamp()
        if (answer !== undefined) held.answer = answer
      }
      const more = how === 'failed' ? { error: { type: 'unknown', message: 'The turn failed.' } }
        : how === 'interrupted' ? { reason: 'user' } : {}
      event(`session.execution.${how}`, { sessionID: id, ...more })
    },
    ask: (id) => {
      const permission = { id: `per_${++asked}`, sessionID: id, action: 'bash', resources: ['npm test'] }
      permissions.set(id, [...permissions.get(id) ?? [], permission])
      event('permission.asked', { ...permission })
      return permission.id
    },
    reply: (id, permissionId) => {
      permissions.set(id, (permissions.get(id) ?? []).filter((permission) => permission.id !== permissionId))
      event('permission.replied', { sessionID: id, requestID: permissionId, reply: 'once' })
    },
    event,
    send: (raw) => { for (const response of live.keys()) response.write(raw) },
    heartbeat: () => { for (const response of live.keys()) response.write(HEARTBEAT) },
    drop: () => { for (const response of live.keys()) response.end() },
    answer: (route, answer) => {
      if (answer) answers.set(route, answer)
      else answers.delete(route)
    },
    register,
    stop: async () => {
      await close()
      rmSync(servicePath, { force: true })
    },
    crash: close,
    restart: async () => {
      await close()
      await listen()
      registerAnew()
    },
  }

  mkdirSync(folder, { recursive: true, mode: 0o700 })
  // mkdir's mode is masked by the umask, and leaves a folder that was there as it was.
  chmodSync(folder, 0o700)
  await listen()
  registerAnew()
  return fake
}
