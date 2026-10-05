/**
 * A service in its own process (`harness __service <name>`), started and watched by harnessd's master
 * (harnessd/services.ts).
 *
 * It tells the master it is alive over the spawn channel, as the core does, and exits when the master
 * goes, so a crash never leaves one behind. It reaches the core the way a window does — the core's local
 * socket — under the service role, with the token the master gave both (core/serviceLinks.ts), and
 * reconnects with backoff whenever the core restarts; the service keeps its own state meanwhile. It
 * answers the requests the core routes to it, hears what the core tells it, and asks the core what it
 * needs to know.
 */
import WebSocket from 'ws'
import type { ServiceRequests } from '../core/api.js'
import { heartbeatInterval, processLoopDelay, type LoopDelay, type MasterChannel } from '../harnessd/coreLink.js'

type Payload = Record<string, unknown>

/** The core, as a connected service reaches it. */
export interface CoreConnection {
  /** Ask the core something (`service_query`); rejects when the connection goes before it answers. */
  query(query: string, payload?: Payload): Promise<Payload>
}

export interface ServiceProcessOptions {
  name: string
  /** The core's local socket. */
  socketPath: string
  /** This machine, as the core's `machine_select` expects it. */
  machineId: string
  token: string
  /** The requests the core routes here, by type: each answered under `<type>_result`. */
  requests: ServiceRequests
  /** What the core tells this service (`service_event`). A throw, or a rejection of what it returns, is logged. */
  onEvent?: (payload: Payload) => void | Promise<unknown>
  /** Each time it is connected to a core: the first time, and after every core restart. */
  onConnected?: (core: CoreConnection) => void
  /** The master's spawn channel; this process when absent. */
  channel?: MasterChannel
  env?: NodeJS.ProcessEnv
  connect?: (url: string) => WebSocket
  exit?: (code: number) => void
  loopDelay?: LoopDelay
  log?: (line: string) => void
  /** The reconnect delay starts here and doubles to `maxBackoffMs`. */
  initialBackoffMs?: number
  maxBackoffMs?: number
}

/** What a test asked this service's process to do wrong. */
export interface ServiceFaults {
  start: boolean
  crash: boolean
  leak: boolean
  /** The requests and events that fail on every call. */
  calls: ReadonlySet<string>
}

/**
 * `HARNESSD_TEST_FAULTS` for a service's own process, as the end-to-end suite uses them. The names the
 * core's host takes mean the same here (core/serviceHost.ts), so one test proves a guarantee whichever
 * process the service runs in: `<name>` fails its start, `<name>.<request or event>` fails that request
 * or event on every call. Two only a process has: `<name>.crash` exits soon after start, `<name>.leak`
 * keeps allocating memory it never lets go. Each is what the master, or the core, must survive. (A hang
 * needs no fault: a stopped process — SIGSTOP — beats no more than a hung one.)
 */
export function serviceFaults(env: NodeJS.ProcessEnv, name: string): ServiceFaults {
  const faults = { start: false, crash: false, leak: false, calls: new Set<string>() }
  for (const entry of (env.HARNESSD_TEST_FAULTS ?? '').split(',')) {
    const [service, fault] = entry.trim().split('.')
    if (service !== name) continue
    if (fault === undefined) faults.start = true
    else if (fault === 'crash' || fault === 'leak') faults[fault] = true
    else faults.calls.add(fault)
  }
  return faults
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export interface ServiceProcess {
  stop(): void
}


export function runServiceProcess(options: ServiceProcessOptions): ServiceProcess {
  const channel: MasterChannel = options.channel ?? (process as unknown as MasterChannel)
  const env = options.env ?? process.env
  const faults = serviceFaults(env, options.name)
  // As a service whose start throws: this process ends, and the master decides whether to try again.
  if (faults.start) throw new Error(`injected fault: ${options.name}`)
  const connect = options.connect ?? ((url: string) => new WebSocket(url))
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const log = options.log ?? ((line: string) => console.log(line))
  const initialBackoffMs = options.initialBackoffMs ?? 250
  const maxBackoffMs = options.maxBackoffMs ?? 5_000
  let stopped = false
  let backoff = initialBackoffMs
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let queries = 0
  const pending = new Map<string, { resolve: (payload: Payload) => void; reject: (error: Error) => void }>()

  // Alive, to the master: the same beat the core sends, so the same watchdog and budgets apply.
  const loopDelay = options.loopDelay ?? processLoopDelay()
  const beat = (): void => {
    const memory = channel.memoryUsage()
    channel.send?.({ type: 'harnessd:heartbeat', rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, loopDelayMs: loopDelay.take() })
  }
  const beating = channel.send ? setInterval(beat, heartbeatInterval(env)) : null
  if (channel.send) beat()
  const leaked: Buffer[] = []
  if (faults.crash) setTimeout(() => exit(1), 200)
  const leaking = faults.leak ? setInterval(() => { leaked.push(Buffer.alloc(8 * 1024 * 1024, 1)); leaked.push(Buffer.from(new Array(200_000).fill('x').join(''))) }, 100) : null
  // The master is gone: so is this service, rather than an orphan holding what it holds.
  channel.once('disconnect', () => { stop(); exit(0) })

  const send = (frame: { type: string; payload: Payload }): void => {
    try { socket?.send(JSON.stringify(frame)) } catch { /* the socket is going; the core answers for us */ }
  }

  const core: CoreConnection = {
    query: (query, payload = {}) => new Promise<Payload>((resolve, reject) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) { reject(new Error('not connected to the core')); return }
      const requestId = `${options.name}-${++queries}`
      pending.set(requestId, { resolve, reject })
      send({ type: 'service_query', payload: { ...payload, query, requestId } })
    }),
  }

  const onFrame = (raw: WebSocket.RawData): void => {
    let frame: { type?: unknown; payload?: Payload; asker?: { local?: unknown; owner?: unknown } }
    try { frame = JSON.parse(raw.toString()) as typeof frame } catch { return }
    const payload = frame.payload ?? {}
    if (frame.type === 'connected') {
      backoff = initialBackoffMs
      log(`[service ${options.name}] connected to the core`)
      options.onConnected?.(core)
      return
    }
    if (frame.type === 'service_event') {
      // An event that fails is this service's alone: logged, and the next one handled as usual. Thrown
      // out of the socket's listener it ended the process, and every request in flight with it.
      const kind = typeof payload.kind === 'string' ? payload.kind : 'event'
      const failed = (error: unknown): void => log(`[service ${options.name}] ${kind} failed · ${describe(error)}`)
      try {
        if (faults.calls.has(kind)) throw new Error(`injected fault: ${options.name}.${kind}`)
        void Promise.resolve(options.onEvent?.(payload)).catch(failed)
      } catch (error) { failed(error) }
      return
    }
    if (frame.type === 'service_query_result') {
      const waiting = pending.get(String(payload.requestId))
      if (!waiting) return
      pending.delete(String(payload.requestId))
      const { requestId: _id, ...answer } = payload
      waiting.resolve(answer)
      return
    }
    const type = typeof frame.type === 'string' ? frame.type : ''
    const handle = Object.hasOwn(options.requests, type) ? options.requests[type] : undefined
    if (!handle) return
    const requestId = payload.requestId
    // Who asked, as the core established it; read as the least it could be if it is missing.
    const asker = { local: frame.asker?.local === true, owner: frame.asker?.owner === true }
    // A request that fails here is answered as failed, never left for the core's timeout, and in the
    // words the core's host uses: what went wrong goes to the log, not to whoever asked.
    void Promise.resolve()
      .then(() => {
        if (faults.calls.has(type)) throw new Error(`injected fault: ${options.name}.${type}`)
        return handle(payload, asker)
      })
      .catch((error: unknown) => {
        log(`[service ${options.name}] ${type} failed · ${describe(error)}`)
        return { error: 'SERVICE_FAILED', service: options.name }
      })
      .then((result) => send({ type: `${type}_result`, payload: { ...result, requestId } }))
  }

  // Only ever run at start and from the reconnect timer, which `stop` clears.
  const dial = (): void => {
    const ws = connect(`ws+unix://${options.socketPath}:/api/local-ws`)
    socket = ws
    ws.on('open', () => {
      // Through `send`, which a socket failing as it opens cannot turn into a crash: `close` follows.
      send({ type: 'machine_select', payload: {
        machineId: options.machineId, localProtocolVersion: 1, role: 'service', service: options.name, token: options.token,
      } })
    })
    ws.on('message', onFrame)
    ws.on('error', () => { /* `close` follows, and reconnects */ })
    ws.on('close', () => {
      // A new socket is dialled only after this one closes, so this is always the current one.
      socket = null
      for (const [id, waiting] of pending) { pending.delete(id); waiting.reject(new Error('the core went away')) }
      if (stopped) return
      const delay = backoff
      backoff = Math.min(backoff * 2, maxBackoffMs)
      reconnectTimer = setTimeout(() => { reconnectTimer = null; dial() }, delay)
    })
  }

  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (beating) clearInterval(beating)
    if (leaking) clearInterval(leaking)
    loopDelay.stop()
    if (reconnectTimer) clearTimeout(reconnectTimer)
    try { socket?.close() } catch { /* already closed */ }
  }

  dial()
  return { stop }
}
