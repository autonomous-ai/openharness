/**
 * The local door's routes that a service answers (core/api.ts `SERVICE_HTTP_ROUTES`). Once the door has let a request
 * in (hookServer.ts: the private socket or loopback, the credential, Host and Origin), it goes to the service its route
 * names, as the request that route is, wherever that service runs, and the service's answer is written as it gave it.
 * Generic: what the core holds of a route is where it goes, which methods it takes and which of them write, how long it
 * waits, the headers its answers carry, and what it answers while its service is down or does not answer in time, at
 * once, never a hang. What the route does, and every check of what it carries, is the service's.
 */
import type { Asker, HttpAnswer, ServiceHttpRoute } from './api.js'

/** An HTTP request as its route's service is asked it: the method, the target as the client sent it (its query too),
 *  and the body as text, for a method that carries one. */
export interface ServiceHttpRequest { method: string; target: string; body?: string }

/** A request as the door has it: its body is read only once a route takes it and lets it in, and only up to that
 *  route's bound (the door's own when it has none); a body past it reads as empty, as the door's reads always were. */
export interface DoorRequest { method: string; target: string; readBody(maxBytes?: number): Promise<string> }

/** Where a request a service owns is answered. False when no service there owns `type`. */
export interface ServiceRouter {
  route(type: string, payload: Record<string, unknown>, asker: Asker, reply: (result: Record<string, unknown>) => void, waitMs?: number): boolean
}

export interface ServiceRoutesDeps {
  routes: readonly ServiceHttpRoute[]
  /** The services in their own processes (core/serviceLinks.ts), which bound the wait themselves: the route's, from when
   *  the request is sent, after the start of a service on demand that was not running. */
  linked: ServiceRouter
  /** The services in this process (core/serviceHost.ts), whose handlers nothing else bounds: the route's wait is kept here. */
  hosted: ServiceRouter
  log?: (line: string) => void
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

/** Who asks through the door: this computer's owner, as the door's checks established. */
const OWNER_HERE: Asker = { local: true, owner: true }

/** The door's answer to a write without the local header, as it always was. */
const FORBIDDEN: HttpAnswer = { status: 403, body: { error: 'FORBIDDEN' } }

/** A header value a service may give: one short line of printable characters. */
const HEADER_VALUE = /^[\x20-\x7e]{1,128}$/

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export function createServiceRoutes(deps: ServiceRoutesDeps) {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms))
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))

  /** The service's answer, or null when none came in the route's time. A timer of its own here would run from the
   *  request's arrival, and cut short a request that first waits for its service's process to start. */
  const ask = (route: ServiceHttpRoute, request: ServiceHttpRequest): Promise<Record<string, unknown> | null> => new Promise((resolve) => {
    if (deps.linked.route(route.type, { ...request }, OWNER_HERE, resolve, route.waitMs)) return
    const timer = setTimer(() => resolve(null), route.waitMs)
    const reply = (result: Record<string, unknown>): void => { clearTimer(timer); resolve(result) }
    if (!deps.hosted.route(route.type, { ...request }, OWNER_HERE, reply)) reply({ error: 'SERVICE_UNAVAILABLE' })
  })

  /** [answer] with the headers its route declares: those its service may set, as it gave them, then the route's own. */
  const headed = (route: ServiceHttpRoute, answer: HttpAnswer, given?: unknown): HttpAnswer => {
    const headers: Record<string, string> = {}
    for (const name of route.answerHeaders ?? []) {
      const value = isRecord(given) ? given[name] : undefined
      if (typeof value === 'string' && HEADER_VALUE.test(value)) headers[name] = value
    }
    Object.assign(headers, route.headers)
    return Object.keys(headers).length ? { ...answer, headers } : answer
  }

  return {
    /** The answer to [request] on [path] (its query left out), or null when no service answers that path and method.
     *  [localOk]: the request carries the local header, which a route's write needs. Its body is read after both. */
    answer(path: string, request: DoorRequest, localOk = false): Promise<HttpAnswer> | null {
      const { method, target } = request
      const route = deps.routes.find((each) => each.path.test(path) && (!each.methods || each.methods.includes(method)))
      if (!route) return null
      if (route.writes?.includes(method) && !localOk) return Promise.resolve(headed(route, FORBIDDEN))
      const asked = (body?: string) => ask(route, { method, target, ...(body === undefined ? {} : { body }) })
      return (method === 'GET' ? asked() : request.readBody(route.maxBodyBytes).then(asked)).then((answer) => {
        if (answer && Number.isInteger(answer.status) && (answer.status as number) >= 200 && (answer.status as number) <= 599 && isRecord(answer.body)) {
          return headed(route, { status: answer.status as number, body: answer.body }, answer.headers)
        }
        // Down, slow or failing is said where it is seen (core/serviceLinks.ts, core/serviceHost.ts); an answer that is
        // none is a service's mistake, said here.
        if (answer && typeof answer.error !== 'string') log(`[services] ${route.type} was answered with no HTTP answer: answered ${route.unanswered.status} instead`)
        return headed(route, route.unanswered)
      })
    },
  }
}
