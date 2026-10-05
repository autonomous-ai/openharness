/**
 * The core's end of the services that run in their own processes (harnessd/services.ts starts them).
 *
 * A service reaches the core the way a window does — the local socket — under a service role: its
 * `machine_select` names the service and carries the token the master gave the core and the service
 * alike, so no other local process can stand in for one. The core then routes the requests the service
 * answers to it and relays each answer back to the client that asked; a request that finds the service
 * down, or not answering in time, is answered SERVICE_UNAVAILABLE with `retryable: true` — the core never
 * waits on a service in line. The core tells a service what it needs to know with `notify`, and answers
 * the few questions a service may ask it (`service_query`), nothing more.
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
}

/** What the local socket hands back for a service connection: its frames in, its end. */
export interface ServiceLink {
  receive(frame: ServiceFrame): void
  closed(): void
}

export interface ServiceLinksOptions {
  /** The token the master started this core with; without one, no service may connect. */
  token: string | undefined
  /** The request types each out-of-process service answers. Only these services may connect. */
  owned: Readonly<Record<string, readonly string[]>>
  /** The core's answer to a service's question (`service_query`): `query` names it. */
  answer(service: string, query: string, payload: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>>
  /** How long a routed request may wait for its service before it is answered SERVICE_UNAVAILABLE. */
  timeoutMs?: number
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
}

/** The most notifications held for one service while it is down. */
export const HELD_MAX = 1_000

export function createServiceLinks(options: ServiceLinksOptions) {
  const timeoutMs = options.timeoutMs ?? 30_000
  const log = options.log ?? ((line: string) => console.warn(line))
  const newId = options.newId ?? randomUUID
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms))
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const ownerOf = new Map<string, string>()
  for (const [service, types] of Object.entries(options.owned)) for (const type of types) ownerOf.set(type, service)
  const links = new Map<string, Connected>()
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

  return {
    /** A service connecting. Null — and the socket closes it — unless the master started it. */
    accept(service: string, token: string, sink: ServiceSink, close: (code: number, reason: string) => void): ServiceLink | null {
      if (!Object.hasOwn(options.owned, service) || !tokenMatches(token)) {
        log(`[services] a connection as service "${service.slice(0, 40)}" was refused`)
        return null
      }
      // A service reconnecting (the core restarted, its socket dropped) replaces its old connection.
      links.get(service)?.close(4409, 'replaced by a newer connection')
      const connected: Connected = { sink, close }
      links.set(service, connected)
      log(`[services] ${service} connected`)
      const owed = held.get(service) ?? []
      held.delete(service)
      for (const frame of owed) sink.sendFrame(frame)
      return {
        receive: (frame) => {
          const payload = frame.payload ?? {}
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
        closed: () => {
          if (links.get(service) !== connected) return
          links.delete(service)
          log(`[services] ${service} disconnected`)
          for (const [id, entry] of waiting) if (entry.service === service) settle(id, entry, unavailable(service))
        },
      }
    },

    /** Route a request a service owns: false when no service owns `type`, and the core answers it itself.
     *  The asker goes beside the payload, never in it, so nothing a client writes can stand for it. */
    route(type: string, payload: Record<string, unknown>, asker: Asker, reply: (result: Record<string, unknown>) => void): boolean {
      const service = ownerOf.get(type)
      if (!service) return false
      const link = links.get(service)
      if (!link) { reply(unavailable(service)); return true }
      const id = newId()
      const entry: Waiting = { service, type, reply, timer: null }
      // Cleared whenever the entry is settled, so it only ever fires for one still waiting.
      entry.timer = setTimer(() => settle(id, entry, unavailable(service)), timeoutMs)
      waiting.set(id, entry)
      if (!link.sink.sendFrame({ type, payload: { ...payload, requestId: id }, asker })) settle(id, entry, unavailable(service))
      return true
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
