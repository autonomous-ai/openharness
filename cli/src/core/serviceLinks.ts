/**
 * The core's end of the services that run in their own processes (harnessd/services.ts starts them).
 *
 * A service reaches the core the way a window does — the local socket — under a service role: its
 * `machine_select` names the service and carries the token the master gave the core and the service
 * alike, so no other local process can stand in for one. The core then routes the requests the service
 * answers to it and relays each answer back to the client that asked; a request that finds the service
 * down, or not answering in time, is answered SERVICE_UNAVAILABLE with `retryable: true` — the core never
 * waits on a service in line. A routed request carries the connection it came over (`Asker.connection`),
 * and the core says when that connection closes (`closeConnection`). The core tells a service what it
 * needs to know with `notify`, and answers the few questions a service may ask it (`service_query`),
 * nothing more.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { Asker } from './api.js'

export interface ServiceFrame {
  type: string
  payload?: Record<string, unknown>
  [key: string]: unknown
}

/** Where frames to one service's connection go. */
export interface ServiceSink {
  sendFrame(frame: ServiceFrame): boolean
  /** Bytes, for a service that carries terminals (the gateway); false when the socket refused them. */
  sendBinary?(bytes: Uint8Array): boolean
  /** How many bytes are waiting on the socket to the service: a hung one stops reading, and what the core
   *  keeps sending it would pile up in the core's memory. */
  buffered?(): number
}

/** What the local socket hands back for a service connection: its frames in, its end. */
export interface ServiceLink {
  receive(frame: ServiceFrame): void
  /** A binary frame from the service. */
  receiveBinary(bytes: Uint8Array): void
  closed(): void
}

export interface ServiceLinksOptions {
  /** The token the master started this core with; without one, no service may connect. */
  token: string | undefined
  /** The request types each out-of-process service answers. Only these services may connect. */
  owned: Readonly<Record<string, readonly string[]>>
  /** The core's answer to a service's question (`service_query`): `query` names it. */
  answer(service: string, query: string, payload: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>>
  /** What a service tells the core without asking (`service_notice`), and its binary frames: the gateway's
   *  remote clients and what they sent. Only the services that send them are given these. */
  notice?(service: string, payload: Record<string, unknown>): void
  binary?(service: string, bytes: Uint8Array): void
  /** A service connected (each time, a restarted one too), or its connection ended. */
  connected?(service: string): void
  disconnected?(service: string): void
  /** How long a routed request may wait for its service before it is answered SERVICE_UNAVAILABLE. */
  timeoutMs?: number
  /** Longer waits for the answers that take longer, by service and then by type (core/api.ts
   *  `LONG_ANSWERS`): a grid command, grid's set-up, a harness's install. */
  waits?: Readonly<Record<string, Readonly<Record<string, number>>>>
  /** The services whose process runs only once asked for: the experiments (core/api.ts `EXPERIMENTS`) and the
   *  devices (core/devicesWake.ts). A request for one that has not connected yet asks for it (`want`) and waits
   *  for it to connect, within the same time. One that has connected and is down again is answered as any
   *  service is, at once; so is one that did not connect within a request's wait, until it does. */
  onDemand?: ReadonlySet<string>
  /** Ask the master for a process on demand (harnessd/coreLink.ts `want`). */
  want?(service: string): void
  log?: (line: string) => void
  newId?: () => string
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

interface Connected {
  sink: ServiceSink
  close: (code: number, reason: string) => void
}

interface Waiting {
  service: string
  type: string
  reply: (result: Record<string, unknown>) => void
  timer: unknown
  /** Sent once its service connects: an experiment's request that woke it. */
  frame?: ServiceFrame
}

/** The most notifications held for one service while it is down. */
export const HELD_MAX = 1_000

/** Who asks when the core itself asks a service (`call`): this machine's owner, on this machine. */
const THE_CORE: Asker = { local: true, owner: true }

export function createServiceLinks(options: ServiceLinksOptions) {
  const timeoutMs = options.timeoutMs ?? 30_000
  const log = options.log ?? ((line: string) => console.warn(line))
  const newId = options.newId ?? randomUUID
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms))
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const ownerOf = new Map<string, string>()
  for (const [service, types] of Object.entries(options.owned)) for (const type of types) ownerOf.set(type, service)
  const links = new Map<string, Connected>()
  /** The services that have connected in this core's life: an experiment among them is on, not off. */
  const seen = new Set<string>()
  /** Asked for and not connected within a request's wait: the master could not start it (it ends as it starts,
   *  and is parked). Its requests are answered at once, as a service that is down is, instead of each waiting
   *  the whole wait again (⌘K's 25 s, found end to end with the devices crashing on every start). */
  const unstarted = new Set<string>()
  const waiting = new Map<string, Waiting>()
  /** What a service must hear even if it is down when it is said (a purge's forgetting), delivered on
   *  its next connection; bounded, the oldest dropped first. */
  const held = new Map<string, ServiceFrame[]>()
  const unavailable = (service: string) => ({ error: 'SERVICE_UNAVAILABLE', service, retryable: true })

  const tokenMatches = (offered: string): boolean => {
    if (!options.token) return false
    const expected = Buffer.from(options.token)
    const given = Buffer.from(offered)
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  const settle = (id: string, entry: Waiting, result: Record<string, unknown>): void => {
    waiting.delete(id)
    clearTimer(entry.timer)
    entry.reply(result)
  }

  /** How long an answer from `service` to `type` is waited for: its own wait when it has one. */
  const waitFor = (service: string, type: string): number => {
    const waits = options.waits?.[service]
    return waits && Object.hasOwn(waits, type) ? waits[type] : timeoutMs
  }

  /** Send `type` to `service`, its answer to `reply`, whatever becomes of the service. An experiment that is
   *  not connected is asked for, and the request goes once it connects: off, it costs nothing until asked. */
  const ask = (service: string, type: string, payload: Record<string, unknown>, asker: Asker, reply: (result: Record<string, unknown>) => void, waitMs?: number): void => {
    const link = links.get(service)
    const starting = !link && !!options.onDemand?.has(service) && !seen.has(service) && !unstarted.has(service)
    if (!link && !starting) { reply(unavailable(service)); return }
    const id = newId()
    const frame: ServiceFrame = { type, payload: { ...payload, requestId: id }, asker }
    const entry: Waiting = { service, type, reply, timer: null, ...(starting ? { frame } : {}) }
    // Cleared whenever the entry is settled, so it only ever fires for one still waiting.
    entry.timer = setTimer(() => {
      if (entry.frame) unstarted.add(service)
      settle(id, entry, unavailable(service))
    }, waitMs ?? waitFor(service, type))
    waiting.set(id, entry)
    if (starting) { options.want?.(service); return }
    if (!link!.sink.sendFrame(frame)) settle(id, entry, unavailable(service))
  }

  return {
    /** A service connecting. Null — and the socket closes it — unless the master started it.
     *  `accepted` acknowledges the authenticated connection before its queued traffic is delivered. */
    accept(service: string, token: string, sink: ServiceSink, close: (code: number, reason: string) => void, accepted?: () => void): ServiceLink | null {
      if (!Object.hasOwn(options.owned, service) || !tokenMatches(token)) {
        log(`[services] a connection as service "${service.slice(0, 40)}" was refused`)
        return null
      }
      // A service reconnecting (the core restarted, its socket dropped) replaces its old connection.
      links.get(service)?.close(4409, 'replaced by a newer connection')
      const connected: Connected = { sink, close }
      links.set(service, connected)
      seen.add(service)
      log(`[services] ${service} connected`)
      // Found by QA on a quiet machine: a cold Share received its request before `connected`, so it
      // read agents without a core connection and answered HARNESS_NOT_FOUND. Welcome it first.
      accepted?.()
      const owed = held.get(service) ?? []
      held.delete(service)
      for (const frame of owed) sink.sendFrame(frame)
      // The requests that woke an experiment, in the order they came.
      for (const [id, entry] of waiting) {
        if (entry.service !== service || !entry.frame) continue
        const frame = entry.frame
        delete entry.frame
        if (!sink.sendFrame(frame)) settle(id, entry, unavailable(service))
      }
      options.connected?.(service)
      return {
        receive: (frame) => {
          const payload = frame.payload ?? {}
          if (frame.type === 'service_notice') { options.notice?.(service, payload); return }
          if (frame.type === 'service_query') {
            const requestId = payload.requestId
            const query = typeof payload.query === 'string' ? payload.query : ''
            void Promise.resolve()
              .then(() => options.answer(service, query, payload))
              .catch(() => ({ error: 'QUERY_FAILED' }))
              .then((result) => { sink.sendFrame({ type: 'service_query_result', payload: { ...result, requestId } }) })
            return
          }
          const id = typeof payload.requestId === 'string' ? payload.requestId : ''
          const entry = waiting.get(id)
          // Only the answer to a request routed to THIS service, under the type it was asked as.
          if (!entry || entry.service !== service || frame.type !== `${entry.type}_result`) return
          const { requestId: _routed, ...result } = payload
          settle(id, entry, result)
        },
        receiveBinary: (bytes) => { options.binary?.(service, bytes) },
        closed: () => {
          if (links.get(service) !== connected) return
          links.delete(service)
          log(`[services] ${service} disconnected`)
          for (const [id, entry] of waiting) if (entry.service === service) settle(id, entry, unavailable(service))
          options.disconnected?.(service)
        },
      }
    },

    /** Route a request a service owns: false when no service owns `type`, and the core answers it itself.
     *  The asker goes beside the payload, never in it, so nothing a client writes can stand for it. */
    route(type: string, payload: Record<string, unknown>, asker: Asker, reply: (result: Record<string, unknown>) => void): boolean {
      const service = ownerOf.get(type)
      if (!service) return false
      ask(service, type, payload, asker, reply)
      return true
    },

    /** Ask a service what the core itself needs (a port's call, core/monitorLink.ts): answered by its
     *  handler for `type` in its process, or SERVICE_UNAVAILABLE as a routed request is, while it is down
     *  or slow. Never rejects. The types it asks are no client's to route: only the core sends them. */
    call(service: string, type: string, payload: Record<string, unknown>, waitMs?: number): Promise<Record<string, unknown>> {
      return new Promise((resolve) => { ask(service, type, payload, THE_CORE, resolve, waitMs) })
    },

    /** A connection closed: every service connected is told (`service_connection_closed`), and aborts what
     *  that connection asked it that it is still answering (services/process.ts). Not held for a service
     *  that is down: what it was answering went with it. What it asked of an experiment still starting is
     *  never sent: nobody is left to read the answer, and the work would run for no one. */
    closeConnection(connection: string): void {
      for (const [id, entry] of waiting) {
        if (entry.frame && (entry.frame.asker as Asker | undefined)?.connection === connection) settle(id, entry, unavailable(entry.service))
      }
      for (const link of links.values()) link.sink.sendFrame({ type: 'service_connection_closed', payload: { connection } })
    },

    /** Bytes for a service that carries terminals; false when it is not connected or would not take them. */
    notifyBinary(service: string, bytes: Uint8Array): boolean {
      return links.get(service)?.sink.sendBinary?.(bytes) ?? false
    },

    /** How many bytes wait on the socket to a service; 0 when it is not connected. */
    buffered(service: string): number {
      return links.get(service)?.sink.buffered?.() ?? 0
    },

    /** Tell a service something it needs to know; false when it is not connected to hear it. With
     *  `untilDelivered`, what it misses is said again when it next connects. */
    notify(service: string, frame: ServiceFrame, opts: { untilDelivered?: boolean } = {}): boolean {
      if (links.get(service)?.sink.sendFrame(frame)) return true
      if (opts.untilDelivered && Object.hasOwn(options.owned, service)) {
        const owed = held.get(service) ?? []
        owed.push(frame)
        if (owed.length > HELD_MAX) owed.shift()
        held.set(service, owed)
      }
      return false
    },

    connected(service: string): boolean {
      return links.has(service)
    },
  }
}

export type ServiceLinks = ReturnType<typeof createServiceLinks>
