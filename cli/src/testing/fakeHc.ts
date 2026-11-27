/**
 * A Herdr Core (hc) server for specs, on a Unix socket in a temp folder of its own, so no spec reaches the person's hc
 * (~/.local/state/herdr-core). It answers as hc 0.1.21 did in the recording (docs/plans/2026-11-16-herdr-app-design.md,
 * "Task 1 findings"): JSON-RPC 2.0, one message a line, every object's keys sorted at every depth as hc writes them; a
 * connection takes any number of requests, answered in order and left open; after `events.subscribe` it carries
 * notifications only. It records every request, and `got` and `ended` resolve on what it saw, so no spec polls it.
 */
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** What hc 0.1.21 wrote in the spike, line by line: folders read /work/hh, the core is `core`, ids and times fixed. */
export const RECORDED = {
  hello: '{"id":1,"jsonrpc":"2.0","result":{"core":{"id":"00000000000000000000000000000001","name":"core"},"features":["framed","attach","events","status","shell","resize_notifications","automatic_input","restart_environment"],"framed":false,"generation":1,"keeps_running_after_logout":null,"login_session":{"gui":true,"id":100001,"user":501},"logout_linger_user":null,"methods":["hello","server.status","server.stop","server.restart","terminal.run","templates.list","terminal.list","terminal.get","terminal.kill","terminal.rm","terminal.keep","terminal.label","terminal.read","terminal.attach","terminal.send","terminal.wait","terminal.keys","terminal.interrupt","terminal.put","machine.exec","file.read","file.write","file.edit","doc.get","doc.set","events.subscribe","machine.add","machine.list","machine.connect","machine.rename","machine.rm","rpc.discover"],"version":"0.1.21"}}',
  helloRefused: '{"error":{"code":-32000,"data":{"hint":"this core speaks generation 1","kind":"unsupported_generation"},"message":"protocol generation 2 not supported"},"id":1,"jsonrpc":"2.0"}',
  /** A subscription from its answer on (the connection's `hello` was id 1): the snapshot (the agent's terminal and a
   *  hidden worker's), then the scenario: the agent working, blocked, working, done, idle, error, idle; its title; the
   *  worker labeled `herdr.space` and unlabeled, kept and not; a terminal created; the worker killed and removed;
   *  `doc.set` small, about 200 KiB, and null; a heartbeat; the created terminal killed and removed. */
  subscription: [
    '{"id":2,"jsonrpc":"2.0","result":{"channel":null,"seq":11,"terminals":[{"address":"t1","argv":["/usr/local/bin/node","/work/hh/agent.mjs"],"cols":200,"created_ms":1700000000000,"cwd":"/work/hh","die_with_parent":false,"exit_code":null,"finished_ms":null,"foreground":{"argv":["/usr/local/bin/node","/work/hh/agent.mjs"],"cwd":"/work/hh","name":"node","pid":4242},"identity":"ghostty","keep":false,"labels":{"herdr.space":"s1"},"name":null,"notify":true,"parent":null,"pid":4242,"reason":null,"reported":true,"rm":false,"rows":120,"screen":"exact","signal":null,"state":"live","status":{"app":"claude-code","state":"idle"},"status_ms":1700000015794,"template":null,"title":"","turn":2},{"address":"t2","argv":["/bin/sleep","600"],"cols":200,"created_ms":1700000068282,"cwd":"/work/hh","die_with_parent":false,"exit_code":null,"finished_ms":null,"identity":"ghostty","keep":false,"labels":{},"name":null,"notify":true,"parent":null,"pid":4243,"reason":null,"reported":false,"rm":false,"rows":120,"screen":"exact","signal":null,"state":"live","status":null,"status_ms":null,"template":null,"title":"","turn":0}]}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{"argv":["/bin/sleep","600"],"cwd":"/work/hh","name":"sleep","pid":4243},"seq":12,"terminal":"t2","type":"foreground"}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{"records":{},"reported":true,"status":{"app":"claude-code","state":"working"}},"seq":13,"terminal":"t1","type":"status"}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{"records":{},"reported":true,"status":{"app":"claude-code","state":"blocked"}},"seq":14,"terminal":"t1","type":"status"}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{"state":"blocked","turn":3},"seq":15,"terminal":"t1","type":"turn"}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{"records":{},"reported":true,"status":{"app":"claude-code","state":"working"}},"seq":16,"terminal":"t1","type":"status"}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{"records":{},"reported":true,"status":{"app":"claude-code","state":"done"}},"seq":17,"terminal":"t1","type":"status"}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{"state":"done","turn":4},"seq":18,"terminal":"t1","type":"turn"}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{"records":{},"reported":true,"status":{"app":"claude-code","state":"idle"}},"seq":19,"terminal":"t1","type":"status"}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{"records":{},"reported":true,"status":{"app":"claude-code","state":"error"}},"seq":20,"terminal":"t1","type":"status"}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{"records":{},"reported":true,"status":{"app":"claude-code","state":"idle"}},"seq":21,"terminal":"t1","type":"status"}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{"title":"fake title"},"seq":22,"terminal":"t1","type":"title"}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{"labels":{"herdr.space":"s1"}},"seq":23,"terminal":"t2","type":"labels"}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{"labels":{}},"seq":24,"terminal":"t2","type":"labels"}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{"keep":true},"seq":25,"terminal":"t2","type":"keep"}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{"keep":false},"seq":26,"terminal":"t2","type":"keep"}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{"address":"t3","argv":["/bin/sleep","600"],"cols":200,"created_ms":1700000075612,"cwd":"/work/hh","die_with_parent":false,"exit_code":null,"finished_ms":null,"identity":"ghostty","keep":false,"labels":{"herdr.space":"s1"},"name":null,"notify":true,"parent":null,"pid":4244,"reason":null,"reported":false,"rm":false,"rows":120,"screen":"exact","signal":null,"state":"live","status":null,"status_ms":null,"template":null,"title":"","turn":0},"seq":27,"terminal":"t3","type":"created"}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{"argv":["/bin/sleep","600"],"cwd":"/work/hh","name":"sleep","pid":4244},"seq":28,"terminal":"t3","type":"foreground"}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{"exit_code":null,"finished_ms":1700000076241,"reason":"killed","signal":1},"seq":29,"terminal":"t2","type":"finished"}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{},"seq":30,"terminal":"t2","type":"removed"}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{"name":"harness-spike","version":1},"seq":31,"type":"doc"}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{"name":"harness-spike","version":2},"seq":32,"type":"doc"}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{"name":"harness-spike","version":3},"seq":33,"type":"doc"}}',
    '{"jsonrpc":"2.0","method":"heartbeat","params":{"seq":33}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{"exit_code":null,"finished_ms":1700000083318,"reason":"killed","signal":1},"seq":34,"terminal":"t3","type":"finished"}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{},"seq":35,"terminal":"t3","type":"removed"}}',
  ],
  get: '{"id":1,"jsonrpc":"2.0","result":{"address":"t1","argv":["/usr/local/bin/node","/work/hh/agent.mjs"],"cols":200,"created_ms":1700000000000,"cwd":"/work/hh","die_with_parent":false,"exit_code":null,"finished_ms":null,"foreground":{"argv":["/usr/local/bin/node","/work/hh/agent.mjs"],"cwd":"/work/hh","name":"node","pid":4242},"identity":"ghostty","keep":false,"labels":{"herdr.space":"s1"},"name":null,"notify":true,"parent":null,"pid":4242,"reason":null,"reported":true,"rm":false,"rows":120,"screen":"exact","signal":null,"state":"live","status":{"app":"claude-code","state":"idle"},"status_ms":1700000071953,"template":null,"title":"fake title","turn":4}}',
  getUnknown: '{"error":{"code":-32000,"data":{"hint":"see `hc ls --all`","kind":"not_found"},"message":"no terminal \\"t99\\""},"id":1,"jsonrpc":"2.0"}',
  /** To the idle agent with `if: "idle"`, 5.2 s after it was sent: the fake agent does not go working on input. */
  sent: '{"id":1,"jsonrpc":"2.0","result":{"started":false,"status":"idle","turn":4}}',
  mismatch: '{"error":{"code":-32000,"data":{"hint":"nothing was typed","kind":"status_mismatch"},"message":"t1 is working, not idle"},"id":1,"jsonrpc":"2.0"}',
  blocked: '{"error":{"code":-32000,"data":{"hint":"typing would answer its dialog; read its screen first (hc read t1), or --force","kind":"blocked"},"message":"t1 is blocked (waiting)"},"id":1,"jsonrpc":"2.0"}',
  finished: '{"error":{"code":-32000,"data":{"hint":"hc read t1","kind":"finished"},"message":"t1 has finished"},"id":1,"jsonrpc":"2.0"}',
  /** `missed` carries its fresh snapshot itself; then the agent idle again, its exit, and its removal. */
  missed: [
    '{"jsonrpc":"2.0","method":"missed","params":{"seq":30040,"terminals":[{"address":"t1","argv":["/usr/local/bin/node","/work/hh/agent.mjs"],"cols":200,"created_ms":1700000000000,"cwd":"/work/hh","die_with_parent":false,"exit_code":null,"finished_ms":null,"foreground":{"argv":["/usr/local/bin/node","/work/hh/agent.mjs"],"cwd":"/work/hh","name":"node","pid":4242},"identity":"ghostty","keep":false,"labels":{"herdr.space":"s1"},"name":null,"notify":true,"parent":null,"pid":4242,"reason":null,"reported":true,"rm":false,"rows":120,"screen":"exact","signal":null,"state":"live","status":{"app":"claude-code","state":"idle"},"status_ms":1700000118744,"template":null,"title":"fake title","turn":10005}]}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{"records":{},"reported":true,"status":{"app":"claude-code","state":"idle"}},"seq":30041,"terminal":"t1","type":"status"}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{"records":{},"reported":true,"status":null},"seq":30042,"terminal":"t1","type":"status"}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{"exit_code":0,"finished_ms":1700000125430,"reason":"exited","signal":null},"seq":30043,"terminal":"t1","type":"finished"}}',
    '{"jsonrpc":"2.0","method":"event","params":{"data":{},"seq":30044,"terminal":"t1","type":"removed"}}',
  ],
  agent: 't1',
  worker: 't2',
}

/** A terminal as a spec names one; the fake writes it as hc writes a terminal (RECORDED). */
export interface FakeHcTerminal {
  address: string
  /** live */
  state?: 'live' | 'finished'
  /** { 'herdr.space': 's1' } */
  labels?: Record<string, string>
  /** { state: 'idle', app: 'claude-code' } */
  status?: { state: string; app?: string } | null
  /** null */
  name?: string | null
  /** '/work/hh' */
  cwd?: string
  /** Any other field of hc's terminal, written as given. */
  more?: Record<string, unknown>
}

/** What a method answers: a result, hc's error by its `data.kind`, bytes as they are (a RECORDED answer's id becomes
 *  the request's), nothing with the connection held open and nothing more on it (`hold`), or nothing with it ended
 *  (`close`). */
export type FakeHcAnswer = { result: unknown } | { error: string } | { raw: string } | 'hold' | 'close'

export interface FakeHcRequest {
  /** The server's connections count from 1. */
  connection: number
  /** The line as it arrived, parsed. */
  request: unknown
}

export interface FakeHc {
  /** <a fresh temp folder>/hc.sock */
  readonly path: string
  /** The terminals it holds: the snapshot, `terminal.get` and `terminal.send` answer from these. */
  terminals: FakeHcTerminal[]
  readonly requests: readonly FakeHcRequest[]
  /** The connections it took. */
  readonly connections: number
  /** The n-th request of that method, from 1, once it has arrived. */
  got(method: string, n: number): Promise<FakeHcRequest>
  /** Once that connection has closed. */
  ended(connection: number): Promise<void>
  /** What a method answers from now on; with no answer, hc's own again. */
  answer(method: string, answer?: FakeHcAnswer): void
  /** Changes a terminal it holds, or adds one, and tells each live subscription as hc does: the `event` lines hc
   *  writes for that change, in the recorded shape, each with the next `seq`. */
  change(address: string, to: Partial<FakeHcTerminal>): void
  /** hc's `removed`. */
  remove(address: string): void
  /** An `event` that changes no terminal the fake holds: a kind it does not follow (`doc`, `size`, `title`, `turn`,
   *  `keep`), or one Task 1 could not record (`lost`, `restarted`, F8). `body` is the event's params but its `seq` and
   *  `type` (`{ data, terminal }`); left out, the recorded one of that kind. */
  event(kind: string, body?: Record<string, unknown>): void
  heartbeat(): void
  /** `missed`, with a fresh snapshot of `terminals` in it, as recorded. */
  missed(): void
  /** Bytes to each live subscription. */
  send(raw: string | Uint8Array): void
  /** Ends every subscription. */
  drop(): void
  /** Closes every connection and the server, which removes its socket. */
  stop(): Promise<void>
  /** As `stop`, but the socket stays, with nothing listening: a core that died. */
  stale(): Promise<void>
  /** Listens again at the same path, in place of a stale socket. */
  start(): Promise<void>
}

type Fault = { code: number; data: { hint?: string; kind: string }; message: string }
/** What the fake answers on its own: a result, or a refusal written as hc writes it. */
type Own = { result: unknown } | { fault: Fault }

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parse = (text: string): unknown => {
  try { return JSON.parse(text) } catch { return undefined }
}

/** hc writes every object's keys sorted, at every depth (the recording). */
const ordered = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(ordered)
  if (!isObject(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])]))
}
const lineOf = (message: Record<string, unknown>) => `${JSON.stringify(ordered(message))}\n`

/** Where a RECORDED answer names its request: the first `"id":…,"jsonrpc"` of its line. */
const RECORDED_ID = /"id":(?:\d+|null),"jsonrpc":"2\.0"/

/** hc's times are the recording's, fixed: no spec reads a clock from them. */
const T = 1_700_000_000_000
const ARGV = ['/usr/local/bin/node', '/work/hh/agent.mjs']
const IDLE = { app: 'claude-code', state: 'idle' }

const refused = (kind: string, message: string, hint: string, code = -32000): Own =>
  ({ fault: { code, data: { hint, kind }, message } })
const notFound = (address: string) => refused('not_found', `no terminal "${address}"`, 'see `hc ls --all`')

/** The recorded line of an event of that kind, its params but `seq` and `type`. */
const recordedEvent = (kind: string): Record<string, unknown> => {
  for (const text of RECORDED.subscription) {
    const params = (parse(text) as { params?: Record<string, unknown> }).params
    if (params?.type === kind) {
      const { seq: _seq, type: _type, ...body } = params
      return body
    }
  }
  // `size` was not recorded: no plain request resizes a terminal (only a viewer's attach does). An assumption.
  return kind === 'size' ? { data: { cols: 200, rows: 120 }, terminal: RECORDED.agent } : { data: {} }
}

export async function fakeHc(): Promise<FakeHc> {
  const path = join(await mkdtemp(join(tmpdir(), 'hc-')), 'hc.sock')
  const requests: FakeHcRequest[] = []
  const answers = new Map<string, FakeHcAnswer>()
  const open = new Set<Socket>()
  // Each connection that asked `events.subscribe`, and the answered ones: the live subscriptions.
  const subscribing = new Set<Socket>()
  const live = new Set<Socket>()
  // Each connection with a request the fake holds: hc answers a connection's requests in order (F4), so nothing after it
  // is answered there.
  const holding = new Set<Socket>()
  const closed = new Set<number>()
  // What `got` and `ended` wait for, asked again on every request and every closed connection.
  const waits = new Set<() => boolean>()
  const settle = () => { for (const done of waits) if (done()) waits.delete(done) }
  // Each terminal's pid, and the terminals that ever reported a status: hc keeps both for a terminal's life.
  const pids = new Map<string, number>()
  const reported = new Set<string>()
  let server: Server | undefined
  let count = 0
  let seq = 0

  const of = (method: string) => requests.filter(({ request }) => isObject(request) && request.method === method)
  const held = (address: unknown) => fake.terminals.find((terminal) => terminal.address === address)

  /** A terminal as hc writes one (the recording's agent): a finished one has no foreground and no status. */
  const written = (terminal: FakeHcTerminal): Record<string, unknown> => {
    const running = (terminal.state ?? 'live') === 'live'
    const status = running ? (terminal.status === undefined ? IDLE : terminal.status) : null
    if (status) reported.add(terminal.address)
    if (!pids.has(terminal.address)) pids.set(terminal.address, 4242 + pids.size)
    const pid = pids.get(terminal.address)
    const cwd = terminal.cwd ?? '/work/hh'
    return {
      address: terminal.address, argv: ARGV, cols: 200, created_ms: T, cwd, die_with_parent: false,
      exit_code: running ? null : 0, finished_ms: running ? null : T,
      ...(running ? { foreground: { argv: ARGV, cwd, name: 'node', pid } } : {}),
      identity: 'ghostty', keep: false, labels: terminal.labels ?? { 'herdr.space': 's1' }, name: terminal.name ?? null,
      notify: true, parent: null, pid, reason: running ? null : 'exited', reported: reported.has(terminal.address),
      rm: false, rows: 120, screen: 'exact', signal: null, state: running ? 'live' : 'finished', status,
      status_ms: reported.has(terminal.address) ? T : null, template: null, title: '', turn: 0, ...terminal.more,
    }
  }
  const snapshot = () => fake.terminals.map(written)

  const tell = (message: Record<string, unknown>) => {
    const line = lineOf({ jsonrpc: '2.0', ...message })
    for (const socket of live) socket.write(line)
  }
  const told = (terminal: string | undefined, type: string, data: unknown) =>
    tell({ method: 'event', params: { data, seq: ++seq, ...(terminal ? { terminal } : {}), type } })

  const hcs = (method: string, params: Record<string, unknown>): Own => {
    const terminal = held(params.terminal)
    switch (method) {
      case 'hello': {
        const generation = params.generation ?? 1
        if (generation === 1) return { result: (parse(RECORDED.hello) as { result: unknown }).result }
        return refused('unsupported_generation', `protocol generation ${String(generation)} not supported`,
          'this core speaks generation 1')
      }
      case 'events.subscribe': return { result: { channel: null, seq, terminals: snapshot() } }
      case 'terminal.get': return terminal ? { result: written(terminal) } : notFound(String(params.terminal))
      case 'terminal.send': {
        if (!terminal) return notFound(String(params.terminal))
        const now = written(terminal)
        const state = (now.status as { state: string } | null)?.state
        const address = terminal.address
        if (now.state === 'finished') return refused('finished', `${address} has finished`, `hc read ${address}`)
        // Which of `blocked` and `status_mismatch` hc says to a blocked terminal sent `if` was not recorded: assumed.
        if (state === 'blocked' && params.force !== true) {
          return refused('blocked', `${address} is blocked (waiting)`,
            `typing would answer its dialog; read its screen first (hc read ${address}), or --force`)
        }
        if (typeof params.if === 'string' && state !== params.if) {
          return refused('status_mismatch', `${address} is ${state ?? 'silent'}, not ${params.if}`, 'nothing was typed')
        }
        return { result: { started: false, status: state ?? null, turn: now.turn } }
      }
      default: return refused('unknown_method', `unknown method "${method}"`, 'see `hc schema`', -32601)
    }
  }

  const write = (socket: Socket, id: unknown, answer: FakeHcAnswer | Own) => {
    if (typeof answer === 'string') return
    if ('raw' in answer) {
      return void socket.write(answer.raw.replace(RECORDED_ID, () => `"id":${JSON.stringify(id)},"jsonrpc":"2.0"`))
    }
    if ('result' in answer) return void socket.write(lineOf({ id, jsonrpc: '2.0', result: answer.result }))
    const error = 'fault' in answer
      ? answer.fault
      : { code: -32000, data: { kind: answer.error }, message: answer.error }
    socket.write(lineOf({ error, id, jsonrpc: '2.0' }))
  }

  const receive = (socket: Socket, connection: number, text: string) => {
    const request = parse(text)
    requests.push({ connection, request })
    settle()
    // hc's subscription connection carries notifications only. What it does with another request there was not
    // recorded: here it is not answered, an assumption. Nor is one behind a request held.
    if (subscribing.has(socket) || holding.has(socket)) return
    if (request === undefined) {
      return write(socket, null,
        refused('parse_error', 'key must be a string at line 1 column 2', 'see `hc schema`', -32700))
    }
    // A JSON line that is no request was not recorded: answered here as an unknown method, an assumption.
    const method = isObject(request) && typeof request.method === 'string' ? request.method : ''
    const id = isObject(request) ? request.id ?? null : null
    const params = isObject(request) && isObject(request.params) ? request.params : {}
    const answer = answers.get(method) ?? hcs(method, params)
    if (answer === 'close') return void socket.end()
    if (method === 'events.subscribe') subscribing.add(socket)
    if (answer === 'hold') holding.add(socket)
    write(socket, id, answer)
    const refusal = typeof answer === 'object' && ('error' in answer || 'fault' in answer)
    if (method !== 'events.subscribe' || answer === 'hold') return
    if (refusal) subscribing.delete(socket)
    else live.add(socket)
  }

  const accept = (socket: Socket) => {
    const connection = ++count
    open.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => {
      open.delete(socket)
      subscribing.delete(socket)
      live.delete(socket)
      holding.delete(socket)
      closed.add(connection)
      settle()
    })
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (let end = buffer.indexOf('\n'); end !== -1 && !socket.destroyed; end = buffer.indexOf('\n')) {
        const text = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        receive(socket, connection, text)
      }
    })
  }

  const listen = async () => {
    // hc starts in place of a socket nothing listens on.
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

  const same = (a: unknown, b: unknown) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b))

  const fake: FakeHc = {
    path,
    terminals: [],
    requests,
    get connections() { return count },
    got: (method, n) => until(() => of(method)[n - 1]),
    ended: async (connection) => { await until(() => closed.has(connection) || undefined) },
    answer: (method, answer) => {
      if (answer) answers.set(method, answer)
      else answers.delete(method)
    },
    change: (address, to) => {
      const terminal = held(address)
      if (!terminal) {
        const added = { ...to, address }
        fake.terminals.push(added)
        // hc tells a new terminal whole before its program has reported and before its foreground is known, then the
        // foreground, then the program's first status (the recording's t3, F5).
        const { foreground, ...created } = written(added)
        told(address, 'created', { ...created, reported: false, status: null, status_ms: null })
        if (foreground) told(address, 'foreground', foreground)
        if (created.status) told(address, 'status', { records: {}, reported: true, status: created.status })
        return
      }
      const before = written(terminal)
      // A program that ends takes its status with it (the recording).
      Object.assign(terminal, to, to.state === 'finished' ? { status: null } : {})
      const after = written(terminal)
      if (!same(before.labels, after.labels)) told(address, 'labels', { labels: after.labels })
      // hc writes a status line for each report, one that repeats its last word too (F5), and one for a status the
      // program's end clears.
      if (to.status !== undefined || !same(before.status, after.status)) {
        told(address, 'status', { records: {}, reported: after.reported, status: after.status })
        const word = (after.status as { state: string } | null)?.state
        // hc counts a turn each time a status leaves `working`, and says so after the status (the recording). Whether a
        // program that ends while working counts one was not recorded: here it does not, an assumption.
        if ((before.status as { state: string } | null)?.state === 'working' && word && word !== 'working') {
          terminal.more = { ...terminal.more, turn: Number(after.turn) + 1 }
          told(address, 'turn', { state: word, turn: Number(after.turn) + 1 })
        }
      }
      if (after.foreground && !same(before.foreground, after.foreground)) told(address, 'foreground', after.foreground)
      if (before.state === 'live' && after.state === 'finished') {
        const { exit_code, finished_ms, reason, signal } = after
        told(address, 'finished', { exit_code, finished_ms, reason, signal })
      }
      // A changed name tells nothing: hc sets a name once, at the start, and has no event for one.
    },
    remove: (address) => {
      fake.terminals = fake.terminals.filter((terminal) => terminal.address !== address)
      told(address, 'removed', {})
    },
    event: (kind, body) =>
      tell({ method: 'event', params: { ...(body ?? recordedEvent(kind)), seq: ++seq, type: kind } }),
    heartbeat: () => tell({ method: 'heartbeat', params: { seq } }),
    missed: () => tell({ method: 'missed', params: { seq, terminals: snapshot() } }),
    send: (raw) => { for (const socket of live) socket.write(raw) },
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
