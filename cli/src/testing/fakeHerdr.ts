/**
 * A herdr server for specs, on a Unix socket in a temp folder of its own, so no spec reaches the developer's herdr
 * (~/.config/herdr). It answers as herdr 0.8.0 did in the spike (docs/specs/2026-11-16-device-herdr.md): newline-delimited
 * JSON, one request a connection, closed after its answer; a subscription held open, and closed by a second request on
 * it. It records every request, and `got` and `ended` resolve on what it saw, so no spec polls it.
 */
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** What herdr 0.8.0 wrote on a subscription in the spike, line by line: its folders read /work/hh. */
export const RECORDED = {
  /** An agent's turn: working, blocked, idle (pane.created was subscribed to as well). */
  status: [
    '{"id":"r1","result":{"type":"subscription_started"}}',
    '{"data":{"agent":"claude","pane_id":"w1:p1","type":"pane_agent_detected","workspace_id":"w1"},"event":"pane_agent_detected"}',
    '{"data":{"pane":{"agent_status":"unknown","cwd":"/work/hh","focused":true,"foreground_cwd":"/work/hh","pane_id":"w1:p1","revision":0,"scroll":{"max_offset_from_bottom":0,"offset_from_bottom":0,"viewport_rows":24},"tab_id":"w1:t1","terminal_id":"term_6605959a0d8531","workspace_id":"w1"},"type":"pane_created"},"event":"pane_created"}',
    '{"data":{"agent":"claude","agent_status":"working","pane_id":"w1:p1","workspace_id":"w1"},"event":"pane.agent_status_changed"}',
    '{"data":{"agent":"claude","agent_status":"blocked","pane_id":"w1:p1","workspace_id":"w1"},"event":"pane.agent_status_changed"}',
    '{"data":{"agent":"claude","agent_status":"idle","pane_id":"w1:p1","workspace_id":"w1"},"event":"pane.agent_status_changed"}',
    '{"data":{"pane":{"agent_status":"unknown","cwd":"/work/hh","focused":false,"foreground_cwd":"/work/hh","pane_id":"w2:p1","revision":0,"scroll":{"max_offset_from_bottom":0,"offset_from_bottom":0,"viewport_rows":23},"tab_id":"w2:t1","terminal_id":"term_660595a9e12f42","workspace_id":"w2"},"type":"pane_created"},"event":"pane_created"}',
  ],
  /** A new subscription with two agents present: one detection each, and no status. */
  replay: [
    '{"id":"r1","result":{"type":"subscription_started"}}',
    '{"data":{"agent":"claude","pane_id":"w1:p1","type":"pane_agent_detected","workspace_id":"w1"},"event":"pane_agent_detected"}',
    '{"data":{"agent":"claude","pane_id":"w2:p1","type":"pane_agent_detected","workspace_id":"w2"},"event":"pane_agent_detected"}',
  ],
  /** The replay, then the second agent's process exits and its pane closes. */
  released: [
    '{"id":"r1","result":{"type":"subscription_started"}}',
    '{"data":{"agent":"claude","pane_id":"w1:p1","type":"pane_agent_detected","workspace_id":"w1"},"event":"pane_agent_detected"}',
    '{"data":{"agent":"claude","pane_id":"w2:p1","type":"pane_agent_detected","workspace_id":"w2"},"event":"pane_agent_detected"}',
    '{"data":{"agent":"claude","final_status":"done","pane_id":"w2:p1","released":true,"type":"pane_agent_detected","workspace_id":"w2"},"event":"pane_agent_detected"}',
    '{"data":{"agent_status":"unknown","pane_id":"w2:p1","workspace_id":"w2"},"event":"pane.agent_status_changed"}',
    '{"data":{"pane_id":"w2:p1","type":"pane_closed","workspace_id":"w2"},"event":"pane_closed"}',
  ],
}

/** What a method answers: a line (the request's id goes first, so a line's own `id` takes its place), bytes as they are
 *  (a RECORDED answer's id, the spike's `r1`, becomes the request's), nothing with the connection held open (`hold`), or
 *  nothing with it ended (`close`). */
export type FakeHerdrAnswer = { line: Record<string, unknown> } | { raw: string } | 'hold' | 'close'

export interface FakeHerdrRequest {
  /** The server's connections count from 1. */
  connection: number
  /** The line as it arrived, parsed. */
  request: unknown
}

export interface FakeHerdr {
  readonly path: string
  /** herdr's AgentInfo of each agent it holds: `agent.list`, `agent.get`, `agent.prompt` and a subscription's replay
   *  answer from these. */
  agents: Array<Record<string, unknown>>
  readonly requests: readonly FakeHerdrRequest[]
  /** The connections it took. */
  readonly connections: number
  /** The n-th request of that method, from 1, once it has arrived. */
  got(method: string, n: number): Promise<FakeHerdrRequest>
  /** Once that connection has closed. */
  ended(connection: number): Promise<void>
  /** What a method answers from now on; with no answer, herdr's own again. */
  answer(method: string, answer?: FakeHerdrAnswer): void
  /** An event, as herdr writes one, to each live subscription that asked for it. */
  event(name: string, data: Record<string, unknown>): void
  /** Bytes to each live subscription. */
  send(raw: string): void
  /** Ends every subscription. */
  drop(): void
  /** Closes every connection and the server, which removes its socket. */
  stop(): Promise<void>
  /** As `stop`, but the socket stays, with nothing listening: a herdr that died. */
  stale(): Promise<void>
  /** Listens again at the same path, in place of a stale socket. */
  start(): Promise<void>
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parse = (text: string): unknown => {
  try { return JSON.parse(text) } catch { return undefined }
}

/** The start of a RECORDED answer: herdr answered the spike's request, `r1`, under its id. */
const RECORDED_ANSWER = /^\{"id":"r1",/

const refused = (code: string): FakeHerdrAnswer => ({ line: { error: { code, message: code } } })
// herdr answers a line it cannot read under "" (the spike); an unknown method is answered the same here.
const INVALID: FakeHerdrAnswer = { line: { id: '', error: { code: 'invalid_request', message: 'invalid request' } } }

/** Whether a subscription's entries ask for that event: herdr names `pane.agent_detected`'s event `pane_agent_detected`,
 *  and sends a status only for a pane named in an entry. */
const asked = (entries: unknown, name: string, data: Record<string, unknown>): boolean =>
  Array.isArray(entries) && entries.some((entry) => isObject(entry) && entry.type === name.replace(/^pane_/, 'pane.')
    && (entry.type !== 'pane.agent_status_changed' || entry.pane_id === data.pane_id))

export async function fakeHerdr(): Promise<FakeHerdr> {
  const path = join(await mkdtemp(join(tmpdir(), 'herdr-')), 'herdr.sock')
  const requests: FakeHerdrRequest[] = []
  const answers = new Map<string, FakeHerdrAnswer>()
  const open = new Set<Socket>()
  // Each subscription's connection, and the entries of each answered one: the live ones.
  const subscribing = new Set<Socket>()
  const live = new Map<Socket, unknown>()
  const closed = new Set<number>()
  // What `got` and `ended` wait for, asked again on every request and every closed connection.
  const waits = new Set<() => boolean>()
  const settle = () => { for (const done of waits) if (done()) waits.delete(done) }
  let server: Server | undefined
  let count = 0

  const of = (method: string) => requests.filter(({ request }) => isObject(request) && request.method === method)

  const herdrs = (method: string, params: Record<string, unknown>): FakeHerdrAnswer => {
    const held = fake.agents.find((agent) => agent.pane_id === params.target)
    switch (method) {
      case 'agent.list': return { line: { result: { type: 'agent_list', agents: fake.agents } } }
      case 'agent.get': return held ? { line: { result: { type: 'agent_info', agent: held } } } : refused('agent_not_found')
      case 'agent.prompt': return held ? { line: { result: { type: 'agent_prompted' } } } : refused('agent_not_found')
      case 'events.subscribe': return { line: { result: { type: 'subscription_started' } } }
      default: return INVALID
    }
  }

  const write = (socket: Socket, id: string, answer: FakeHerdrAnswer) => {
    if (answer === 'hold' || answer === 'close') return
    socket.write('raw' in answer
      ? answer.raw.replace(RECORDED_ANSWER, () => `{"id":${JSON.stringify(id)},`)
      : `${JSON.stringify({ id, ...answer.line })}\n`)
  }
  const reply = (socket: Socket, id: string, answer: FakeHerdrAnswer) => {
    write(socket, id, answer)
    if (answer !== 'hold') socket.end()
  }

  const receive = (socket: Socket, connection: number, text: string) => {
    const request = parse(text)
    requests.push({ connection, request })
    settle()
    // herdr ends a subscription that is sent another request.
    if (subscribing.has(socket)) return void socket.destroy()
    if (!isObject(request) || typeof request.id !== 'string' || typeof request.method !== 'string' || !isObject(request.params)) {
      return reply(socket, '', INVALID)
    }
    const answer = answers.get(request.method) ?? herdrs(request.method, request.params)
    const refusal = answer === 'close' || (typeof answer === 'object' && 'line' in answer && 'error' in answer.line)
    if (request.method !== 'events.subscribe' || refusal) return reply(socket, request.id, answer)
    write(socket, request.id, answer)
    subscribing.add(socket)
    if (answer === 'hold') return
    const entries = request.params.subscriptions
    live.set(socket, entries)
    if (answers.has(request.method)) return
    // herdr replays one detection per agent it holds, and no status, to a subscription that asks for detections.
    for (const agent of fake.agents) {
      const data = { agent: agent.agent, pane_id: agent.pane_id, type: 'pane_agent_detected', workspace_id: String(agent.pane_id).split(':')[0] }
      if (asked(entries, 'pane_agent_detected', data)) socket.write(`${JSON.stringify({ data, event: 'pane_agent_detected' })}\n`)
    }
  }

  const accept = (socket: Socket) => {
    const connection = ++count
    open.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => {
      open.delete(socket)
      subscribing.delete(socket)
      live.delete(socket)
      closed.add(connection)
      settle()
    })
    let held = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      held += chunk
      for (let end = held.indexOf('\n'); end !== -1 && !socket.destroyed; end = held.indexOf('\n')) {
        const text = held.slice(0, end)
        held = held.slice(end + 1)
        receive(socket, connection, text)
      }
    })
  }

  const listen = async () => {
    // herdr starts in place of a socket nothing listens on.
    await rm(path, { force: true })
    const next = createServer(accept)
    await new Promise<void>((resolve, reject) => {
      next.once('error', reject)
      next.listen(path, () => resolve())
    })
    server = next
  }

  // Closing a server removes its socket.
  const close = async () => {
    const was = server
    server = undefined
    for (const socket of open) socket.destroy()
    if (was) await new Promise((resolve) => was.close(resolve))
  }

  const until = <T>(found: () => T | undefined): Promise<T> => new Promise((resolve) => {
    const done = () => {
      const value = found()
      if (value !== undefined) resolve(value)
      return value !== undefined
    }
    if (!done()) waits.add(done)
  })

  const fake: FakeHerdr = {
    path,
    agents: [],
    requests,
    get connections() { return count },
    got: (method, n) => until(() => of(method)[n - 1]),
    ended: async (connection) => { await until(() => closed.has(connection) || undefined) },
    answer: (method, answer) => {
      if (answer) answers.set(method, answer)
      else answers.delete(method)
    },
    event: (name, data) => {
      for (const [socket, entries] of live) {
        if (asked(entries, name, data)) socket.write(`${JSON.stringify({ data, event: name })}\n`)
      }
    },
    send: (raw) => { for (const socket of live.keys()) socket.write(raw) },
    drop: () => { for (const socket of subscribing) socket.destroy() },
    stop: close,
    stale: async () => {
      const aside = `${path}.aside`
      await rename(path, aside)
      await close()
      await rename(aside, path)
    },
    start: listen,
  }
  await listen()
  return fake
}
