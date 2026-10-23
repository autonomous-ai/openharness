/**
 * The core's end of the services that run in their own processes (harnessd/services.ts starts them).
 *
 * A service reaches the core the way a window does — the local socket — under a service role: its
 * `machine_select` names the service and carries the token the master gave the core and the service
 * alike, so no other local process can stand in for one. The core then routes the requests the service
 * answers to it and relays each answer back to the client that asked; a request that finds the service
 * down, or not answering in time, is answered SERVICE_UNAVAILABLE with `retryable: true` — the core never
 * waits on a service in line. A service on demand is waited for as it starts, and the Store as it comes back
 * too, each request for a bounded time and none of them in line (`onDemand`, `waitsThroughRestart`). A routed request carries the connection it came over (`Asker.connection`),
 * and the core says when that connection closes (`closeConnection`). The core tells a service what it
 * needs to know with `notify`, and answers the few questions a service may ask it (`service_query`),
 * nothing more.
 */
import { performance } from 'node:perf_hooks'
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

export interface ServiceQueryAuthority {
  /** Checked inside a commit, after all asynchronous query dispatch: the exact routed owner request is still live. */
  ownsRequest(id: string, type: string, expected: Record<string, unknown>): boolean
}
export interface ServiceLinksOptions {
  /** The token the master started this core with; without one, no service may connect. */
  token: string | undefined
  /** The request types each out-of-process service answers. Only these services may connect. */
  owned: Readonly<Record<string, readonly string[]>>
  /** The core's answer to a service's question (`service_query`): `query` names it. */
  answer(service: string, query: string, payload: Record<string, unknown>, authority: ServiceQueryAuthority): Record<string, unknown> | Promise<Record<string, unknown>>
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
  /** The services whose process runs only once asked for: the experiments (core/api.ts `EXPERIMENTS`), the
   *  devices (core/devicesWake.ts), models (core/modelsWake.ts) and the viewers and the Store (core/viewersWake.ts). A request for one that has not connected yet
   *  asks for it (`want`) and waits for it to connect, for its own wait or `startWaitMs`, whichever is shorter,
   *  and then for its answer, for its own wait. One that has connected and is down again is answered as any
   *  service is, at once, unless it is in `waitsThroughRestart`; so is one that did not connect in time, until it does. */
  onDemand?: ReadonlySet<string>
  /** Of those, the ones whose requests also wait for them to come back after they connected and went (a crash, a
   *  kill, the master's restart for an update), as a first start is waited for: asked for again, within the same
   *  start wait and then the request's own, at most `RESTART_HELD_MAX` at a time for each. The Store's (core/main.ts). */
  waitsThroughRestart?: ReadonlySet<string>
  /** How long a request waits for its service on demand to connect (`ON_DEMAND_START_MS`). */
  startWaitMs?: number
  /** Ask the master for a process on demand (harnessd/coreLink.ts `want`). */
  want?(service: string): void
  log?: (line: string) => void
  now?: () => number
  newId?: () => string
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

interface Connected {
  sink: ServiceSink
  close: (code: number, reason: string) => void
}

interface Waiting {
  request: ServiceFrame
  connection?: Connected
  expiresAt: number
  service: string
  type: string
  reply: (result: Record<string, unknown>) => void
  timer: unknown
  /** How long it waits for its answer once it is sent. */
  wait: number
  /** Sent once its service connects: an experiment's request that woke it. */
  frame?: ServiceFrame
}

/** The most notifications held for one service while it is down. */
export const HELD_MAX = 1_000

/** How long a request waits for its service on demand to start and connect, at most. A process starts in a
 *  second or two even on a loaded machine; one that has not connected in this long is not starting (it ends as
 *  it starts, and its master parks it). Models' requests wait up to fifteen minutes for their answers (grid's
 *  set-up, a download), which a request for a models that cannot start must not wait on its connection. */
export const ON_DEMAND_START_MS = 20_000

/** The most requests held at once for one service to come back after it went (`waitsThroughRestart`); past it,
 *  a request is answered SERVICE_UNAVAILABLE at once, as before. A window asks the Store a few things at a time
 *  (its list, an install): this is many windows' worth, and all a service that does not come back can pile up. */
export const RESTART_HELD_MAX = 100

/** What a failed query threw, on one line of at most 200 characters: its name and message, or the value itself. */
const describe = (error: unknown): string =>
  (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).replace(/\s+/g, ' ').slice(0, 200)

/** Who asks when the core itself asks a service (`call`): this machine's owner, on this machine. */
const THE_CORE: Asker = { local: true, owner: true }

export function createServiceLinks(options: ServiceLinksOptions) {
  const now = options.now ?? (() => performance.now())
  const timeoutMs = options.timeoutMs ?? 30_000
  const startWaitMs = options.startWaitMs ?? ON_DEMAND_START_MS
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
   *  the whole wait again (⌘K's 25 s, found end to end with the devices crashing on every start), until it connects. */
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

  /** How many requests wait for `service`, which is down: all of them wait for it to connect, since what was sent to
   *  it was answered as it went (`closed`, and `accept` for a replaced connection). */
  const heldFor = (service: string): number => {
    let count = 0
    for (const entry of waiting.values()) if (entry.service === service) count++
    return count
  }

  /** How long an answer from `service` to `type` is waited for: its own wait when it has one. */
  const waitFor = (service: string, type: string): number => {
    const waits = options.waits?.[service]
    return waits && Object.hasOwn(waits, type) ? waits[type] : type === 'agent_handoff_prepare' ? Math.min(timeoutMs, 5_000) : timeoutMs
  }

  /** Send `type` to `service`, its answer to `reply`, whatever becomes of the service. An experiment that is
   *  not connected is asked for, and the request goes once it connects: off, it costs nothing until asked. */
  const ask = (service: string, type: string, payload: Record<string, unknown>, asker: Asker, reply: (result: Record<string, unknown>) => void, waitMs?: number): void => {
    const link = links.get(service)
    const awaited = !link && !!options.onDemand?.has(service) && !unstarted.has(service)
    // Coming back after it connected: the Store, while the master restarts the viewers' process (a crash, an update's
    // handover), answered the windows' Store list SERVICE_UNAVAILABLE at once (7 times on 2026-10-16, a day of six
    // updates). Held as a first start is, in time and in number: a process that does not come back holds at most
    // RESTART_HELD_MAX requests for one start wait, and none after it (`unstarted`). The other services are refused at
    // once while down, as their callers expect: a viewer's rendered frame, an engine worker's answer, ⌘K's route
    // (e2e/viewersProcess, engineQuestionControl and devicesProcess).
    const starting = awaited && (!seen.has(service)
      || (!!options.waitsThroughRestart?.has(service) && heldFor(service) < RESTART_HELD_MAX))
    if (!link && !starting) { reply(unavailable(service)); return }
    const id = newId()
    const frame: ServiceFrame = { type, payload: { ...payload, requestId: id }, asker }
    const wait = waitMs ?? waitFor(service, type)
    const entry: Waiting = { service, type, reply, timer: null, wait, request: frame, connection: link, expiresAt: now() + wait, ...(starting ? { frame } : {}) }
    // Cleared whenever the entry is settled, so it only ever fires for one still waiting.
    entry.timer = setTimer(() => {
      if (entry.frame) unstarted.add(service)
      settle(id, entry, unavailable(service))
    }, starting ? Math.min(wait, startWaitMs) : wait)
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
      const replaced = links.get(service)
      replaced?.close(4409, 'replaced by a newer connection')
      for (const [id, entry] of waiting) if (replaced && entry.connection === replaced) settle(id, entry, unavailable(service))
      const connected: Connected = { sink, close }
      links.set(service, connected)
      seen.add(service)
      // Back: the next time it goes, it is waited for again.
      unstarted.delete(service)
      log(`[services] ${service} connected`)
      // Found by QA on a quiet machine: a cold Share received its request before `connected`, so it
      // read agents without a core connection and answered HARNESS_NOT_FOUND. Welcome it first.
      accepted?.()
      const owed = held.get(service) ?? []
      held.delete(service)
      for (const frame of owed) sink.sendFrame(frame)
      // What the core tells it as it connects comes before the requests that woke it: the gateway answers
      // nothing until it is told what to start from (core/gatewayLink.ts `connected`).
      options.connected?.(service)
      // The requests that woke an experiment, in the order they came.
      for (const [id, entry] of waiting) {
        if (entry.service !== service || !entry.frame) continue
        const frame = entry.frame
        delete entry.frame
        entry.connection = connected; entry.expiresAt = now() + entry.wait
        if (!sink.sendFrame(frame)) { settle(id, entry, unavailable(service)); continue }
        // Sent: it waits for its answer for its own wait now, as a request to a service that was up does.
        clearTimer(entry.timer)
        entry.timer = setTimer(() => settle(id, entry, unavailable(service)), entry.wait)
      }
      const authority: ServiceQueryAuthority = { ownsRequest(id, type, expected) {
        const entry = waiting.get(id)
        return !!entry && entry.service === service && entry.type === type && entry.connection === connected
          && links.get(service) === connected && now() <= entry.expiresAt
          && (entry.request.asker as Asker).owner
          && Object.entries(expected).every(([key, value]) => entry.request.payload?.[key] === value)
      } }
      return {
        receive: (frame) => {
          if (links.get(service) !== connected) return
          const payload = frame.payload ?? {}
          if (frame.type === 'service_notice') { options.notice?.(service, payload); return }
          if (frame.type === 'service_query') {
            const requestId = payload.requestId
            const query = typeof payload.query === 'string' ? payload.query : ''
            void Promise.resolve()
              .then(() => links.get(service) === connected ? options.answer(service, query, payload, authority) : unavailable(service))
              .catch((error: unknown) => {
                // The service hears only QUERY_FAILED. What threw is said here, so a failure like the models list's on
                // 2026-10-23 (CLI e2e, 6 ms after models connected) names its cause in the core's log.
                log(`[services] ${service}'s query "${query.slice(0, 40)}" could not be answered: ${describe(error)}`)
                return { error: 'QUERY_FAILED' }
              })
              .then((result) => { sink.sendFrame({ type: 'service_query_result', payload: { ...result, requestId } }) })
            return
          }
          const id = typeof payload.requestId === 'string' ? payload.requestId : ''
          const entry = waiting.get(id)
          // Only the answer to a request routed to THIS service, under the type it was asked as.
          if (!entry || entry.service !== service || entry.connection !== connected || frame.type !== `${entry.type}_result`) return
          const { requestId: _routed, ...result } = payload
          settle(id, entry, result)
        },
        receiveBinary: (bytes) => { if (links.get(service) === connected) options.binary?.(service, bytes) },
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
        if ((entry.request.asker as Asker | undefined)?.connection === connection) settle(id, entry, unavailable(entry.service))
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
