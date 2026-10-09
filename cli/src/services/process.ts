/**
 * Services in a process of their own (`harness __service <a>,<b>`), started and watched by harnessd's
 * master (harnessd/services.ts): one service, or the several a host shares (the edge host).
 *
 * The process (`hostServices`) tells the master it is alive over the spawn channel, as the core does:
 * one heartbeat, and so one memory budget, for everything it runs. It exits when the master goes, so a
 * crash never leaves one behind, and stops what it runs first. Each service in it (`runServiceProcess`)
 * reaches the core on a link of its own, the way a window does (the core's local socket), under the
 * service role, its own name and the token the master gave the core and this process
 * (core/serviceLinks.ts). It reconnects with backoff whenever the core restarts, and the service keeps
 * its own state meanwhile. It answers the requests the core routes to it, hears what the core tells it,
 * and asks the core what it needs to know.
 */
import { existsSync } from 'node:fs'
import WebSocket from 'ws'
import type { Asker, ServiceRequests } from '../core/api.js'
import { heartbeatInterval, processLoopDelay, type LoopDelay, type MasterChannel } from '../harnessd/coreLink.js'

type Payload = Record<string, unknown>

/** The core, as a connected service reaches it. */
export interface CoreConnection {
  /** Ask the core something (`service_query`); rejects when the connection goes before it answers. */
  query(query: string, payload?: Payload): Promise<Payload>
  /** Tell the core something without asking (`service_notice`): the gateway's remote clients and what
   *  they sent. Dropped when the connection is going. */
  notice?(kind: string, payload?: Payload): void
  /** Bytes for the core (a remote client's terminal, from the gateway); false when the connection is going. */
  sendBinary?(bytes: Uint8Array): boolean
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
  /** Each time that connection ends: what was the core's to hear is gone with it. */
  onDisconnected?: () => void
  /** A binary frame from the core (a remote client's terminal, for the gateway). A throw is logged. */
  onBinary?: (bytes: Uint8Array) => void
  env?: NodeJS.ProcessEnv
  connect?: (url: string) => WebSocket
  log?: (line: string) => void
  /** The reconnect delay starts here and doubles to `maxBackoffMs`. */
  initialBackoffMs?: number
  maxBackoffMs?: number
  /** The delay after the core refused this service (`REFUSED`). */
  refusedBackoffMs?: number
}

/** How the core's local socket closes a service connection it does not take (localWsServer.ts). */
export const REFUSED = 4401

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

/** A service running in this process. Its stop may take a moment (the viewers stop their servers). */
export interface ServiceProcess {
  stop(): void | Promise<void>
}

export interface ServiceHostOptions {
  /** The process's name, as its master runs it (`HARNESSD_SERVICE`): `edge`, or its one service's. */
  name: string
  /** The services it runs. A crash or a leak a test asks of the process, or of any of them, is the process's. */
  services: readonly string[]
  /** The master's spawn channel; this process when absent. */
  channel?: MasterChannel
  env?: NodeJS.ProcessEnv
  exit?: (code: number) => void
  loopDelay?: LoopDelay
  /** How the master's stop (SIGTERM) reaches this process; this process's own signal when absent. */
  onSignal?: (signal: NodeJS.Signals, handler: () => void) => void
  /** How long its services get to stop before it exits all the same. */
  leaveGraceMs?: number
}

export interface ServiceHost {
  /** A service now running in this process: stopped before the process exits. */
  add(service: ServiceProcess): void
  /** Stop every service it runs, then exit with `code`. Only the first call counts. */
  leave(code: number): void
}

/** How long a process's services get to stop before it exits without them: the master's own grace for a
 *  SIGTERM is shorter, and a master that is gone waits for nothing. */
export const LEAVE_GRACE_MS = 5_000

/** The process the services run in: alive to the master, and gone with it. */
export function hostServices(options: ServiceHostOptions): ServiceHost {
  const channel: MasterChannel = options.channel ?? (process as unknown as MasterChannel)
  const env = options.env ?? process.env
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const faults = [options.name, ...options.services].map((name) => serviceFaults(env, name))
  const services: ServiceProcess[] = []
  let leaving = false

  // Alive, to the master: the same beat the core sends, so the same watchdog and budgets apply, to the
  // process as a whole. A host's services share its heap: one leaking costs every one of them a restart.
  const loopDelay = options.loopDelay ?? processLoopDelay()
  const beat = (): void => {
    const memory = channel.memoryUsage()
    channel.send?.({ type: 'harnessd:heartbeat', rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, loopDelayMs: loopDelay.take() })
  }
  const beating = channel.send ? setInterval(beat, heartbeatInterval(env)) : null
  if (channel.send) beat()
  const leaked: Buffer[] = []
  const leaking = faults.some((fault) => fault.leak)
    ? setInterval(() => { leaked.push(Buffer.alloc(8 * 1024 * 1024, 1)); leaked.push(Buffer.from(new Array(200_000).fill('x').join(''))) }, 100)
    : null

  const leave = (code: number): void => {
    if (leaving) return
    leaving = true
    if (beating) clearInterval(beating)
    if (leaking) clearInterval(leaking)
    loopDelay.stop()
    // Its services stop first, however this process ends (the master's SIGTERM, the master going, a test
    // fault): the viewers' servers run in process groups of their own, and would otherwise outlive it
    // holding their ports until the next viewers process reaped them. Bounded, so one that never finishes
    // stopping cannot keep an orphan alive once its master is gone.
    const late = setTimeout(() => exit(code), options.leaveGraceMs ?? LEAVE_GRACE_MS)
    void Promise.allSettled(services.map((service) => Promise.resolve().then(() => service.stop())))
      .then(() => { clearTimeout(late); exit(code) })
  }
  if (faults.some((fault) => fault.crash)) setTimeout(() => leave(1), 200)
  // The master is gone: so is this process, rather than an orphan holding what it holds.
  channel.once('disconnect', () => leave(0))
  ;(options.onSignal ?? ((signal, handler) => { process.once(signal, handler) }))('SIGTERM', () => leave(0))
  return { add: (service) => { services.push(service) }, leave }
}

/**
 * `HARNESSD_TEST_HOLD_CONNECT=<service>:<file>`, for the end-to-end suite: the file this service waits on before it
 * goes to the core, for as long as it exists. A service that is running and not there yet, held exactly as long as
 * a test needs (e2e/serviceProcesses.e2e.ts, models at boot); unset, nothing waits.
 */
export function heldOffFile(env: NodeJS.ProcessEnv, name: string): string | null {
  const [service, file] = (env.HARNESSD_TEST_HOLD_CONNECT ?? '').split(/:(.*)/s)
  return service === name && file ? file : null
}

/** How often a held-off service looks again (`heldOffFile`). */
const HELD_OFF_POLL_MS = 200

/** One service in its process: its own link to the core, answering what the core routes to it. */
export function runServiceProcess(options: ServiceProcessOptions): ServiceProcess {
  const env = options.env ?? process.env
  const faults = serviceFaults(env, options.name)
  // As a service whose start throws: it is not run, and, alone in its process, the process ends and the
  // master decides whether to try again.
  if (faults.start) throw new Error(`injected fault: ${options.name}`)
  const connect = options.connect ?? ((url: string) => new WebSocket(url))
  const log = options.log ?? ((line: string) => console.log(line))
  const initialBackoffMs = options.initialBackoffMs ?? 250
  const maxBackoffMs = options.maxBackoffMs ?? 5_000
  const refusedBackoffMs = options.refusedBackoffMs ?? 60_000
  let stopped = false
  let backoff = initialBackoffMs
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let queries = 0
  /** The core took this connection (`connected`): only then does its end mean the service was cut off. */
  let opened = false
  const pending = new Map<string, { resolve: (payload: Payload) => void; reject: (error: Error) => void }>()
  /** The requests being answered, each with the connection that asked (`Asker.connection`): what that
   *  connection closing aborts, and what the core going aborts all of, since nobody is left to answer. */
  const answering = new Map<AbortController, string | undefined>()

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
    notice: (kind, payload = {}) => send({ type: 'service_notice', payload: { ...payload, kind } }),
    sendBinary: (bytes) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false
      try { socket.send(bytes, { binary: true }); return true } catch { return false }
    },
  }

  const onFrame = (raw: WebSocket.RawData, isBinary = false): void => {
    if (isBinary) {
      try { options.onBinary?.(raw instanceof Buffer ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(Buffer.concat(raw as Buffer[]))) }
      catch (error) { log(`[service ${options.name}] binary frame failed · ${describe(error)}`) }
      return
    }
    let frame: { type?: unknown; payload?: Payload; asker?: { local?: unknown; owner?: unknown; connection?: unknown; requestId?: unknown } }
    try { frame = JSON.parse(raw.toString()) as typeof frame } catch { return }
    const payload = frame.payload ?? {}
    if (frame.type === 'connected') {
      backoff = initialBackoffMs
      opened = true
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
    if (frame.type === 'service_connection_closed') {
      for (const [closed, asked] of answering) if (asked === payload.connection) closed.abort()
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
    // Who asked, as the core established it; read as the least it could be if it is missing. The connection
    // and its own request id, when the core gave them, are what work belonging to one connection is keyed by.
    const asker: Asker = {
      local: frame.asker?.local === true,
      owner: frame.asker?.owner === true,
      ...(typeof frame.asker?.connection === 'string' ? { connection: frame.asker.connection } : {}),
      ...(typeof frame.asker?.requestId === 'string' ? { requestId: frame.asker.requestId } : {}),
    }
    // Aborted when that connection closes (`service_connection_closed`), or when the core goes.
    const closed = new AbortController()
    answering.set(closed, asker.connection)
    // A request that fails here is answered as failed, never left for the core's timeout, and in the
    // words the core's host uses: what went wrong goes to the log, not to whoever asked.
    void Promise.resolve()
      .then(() => {
        if (faults.calls.has(type)) throw new Error(`injected fault: ${options.name}.${type}`)
        return handle(payload, asker, closed.signal)
      })
      .catch((error: unknown) => {
        log(`[service ${options.name}] ${type} failed · ${describe(error)}`)
        return { error: 'SERVICE_FAILED', service: options.name }
      })
      .then((result) => {
        answering.delete(closed)
        send({ type: `${type}_result`, payload: { ...result, requestId } })
      })
  }

  const heldOff = heldOffFile(env, options.name)
  // Only ever run at start and from the reconnect timer, which `stop` clears.
  const dial = (): void => {
    if (heldOff && existsSync(heldOff)) {
      reconnectTimer = setTimeout(() => { reconnectTimer = null; dial() }, HELD_OFF_POLL_MS)
      return
    }
    const ws = connect(`ws+unix://${options.socketPath}:/api/local-ws`)
    socket = ws
    ws.on('open', () => {
      // Through `send`, which a socket failing as it opens cannot turn into a crash: `close` follows.
      send({ type: 'machine_select', payload: {
        machineId: options.machineId, localProtocolVersion: 1, role: 'service', service: options.name, token: options.token,
      } })
    })
    ws.on('message', (raw, isBinary) => onFrame(raw, isBinary))
    ws.on('error', () => { /* `close` follows, and reconnects */ })
    ws.on('close', (code: number) => {
      // A new socket is dialled only after this one closes, so this is always the current one.
      const wasOpen = socket === ws && opened
      socket = null
      opened = false
      for (const [id, waiting] of pending) { pending.delete(id); waiting.reject(new Error('the core went away')) }
      // The core that asked is gone, and every connection it routed with it: nobody can read these answers.
      for (const closed of answering.keys()) closed.abort()
      if (wasOpen) {
        try { options.onDisconnected?.() } catch (error) { log(`[service ${options.name}] disconnect failed · ${describe(error)}`) }
      }
      if (stopped) return
      // Refused: this core does not run the service out of its process, as a core from before it did under
      // a newer master, for as long as the two differ. Asked again every few seconds, it only filled both
      // logs; once a minute still finds a core that takes it.
      const delay = code === REFUSED ? Math.max(backoff, refusedBackoffMs) : backoff
      backoff = Math.min(backoff * 2, maxBackoffMs)
      reconnectTimer = setTimeout(() => { reconnectTimer = null; dial() }, delay)
    })
  }

  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    try { socket?.close() } catch { /* already closed */ }
  }

  dial()
  return { stop }
}
