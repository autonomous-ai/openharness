import { createHash } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { countShared, windowKey } from '../lib/rateLimit.js'
import { createWindowLimiter } from '../lib/windowLimiter.js'

/**
 * Ceilings on every signed-in request, per route (Stability 3.2): one person's looping client, or one machine's or
 * agent's, must not take the server from everyone else.
 *
 * A route is its method and pattern, so changing an id does not buy a new budget. Each request counts three times, in one
 * call to the shared counter, so every pod spends one budget (lib/rateLimit.ts):
 *  - for its caller, per second: the agent the route names (`:agentId`), else the machine it names (`:machineId`), each
 *    counted together with the person, else the person alone. With the person in the key, naming someone else's
 *    machine spends only your own budget; per agent, a person's agents polling in the same second do not crowd out one
 *    another. A second is short enough that a loop cannot spend a minute's worth at once.
 *  - for the person, per second and per minute, whatever agent or machine ids the calls name: so new ids, real or made
 *    up, buy nothing past either. Without the per-second one, each made-up id's fresh per-second budget would let a loop
 *    spend the whole minute's in a second.
 * The limits are far above any client that works as designed, late polls included, and are set by the environment; 0
 * turns one off.
 * Requests nobody signed in for are not counted here. Clients already back off on 429; Retry-After says when the
 * window that refused ends.
 *
 * Two hooks around the sign-in gate. Counting needs the person, so it runs after sign-in (`afterSignIn`); but signing in
 * reads the account, and a loop that is already refused should not cost that on every call. A count only grows within
 * its window, so a refusal holds until that window ends: this pod remembers it by the sign-in token's digest, and
 * `beforeSignIn` answers that token's next calls at once. A person's ceiling refuses the token on the whole route, so new
 * agent or machine ids do not get past it to the sign-in and the counter; the caller's ceiling only that agent or machine.
 *
 * Each refusal is held `refusalDelayMs` before it is sent. A client that honours Retry-After never sees it; one that
 * ignores it and keeps N calls in flight is slowed to N calls a second, where a refusal sent at once would let it loop
 * as fast as the event loop can answer, at everyone else's expense. The hold is a timer, not work, and at most
 * `maxHeldRefusals` are held at once in a process: past that a refusal is sent at once, so held refusals never keep more
 * than that many connections open.
 */
export interface RouteRateLimits {
  perPersonPerMinute: number
  perCallerPerSecond: number
  perPersonPerSecond?: number
  refusalDelayMs?: number
  maxHeldRefusals?: number
  now?: () => number
}

type Hook = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>

const MINUTE_MS = 60_000
const SECOND_MS = 1_000
const REMEMBERED_REFUSALS_MAX = 50_000

export function createRouteRateLimit({ perPersonPerMinute, perCallerPerSecond, perPersonPerSecond = 0, refusalDelayMs = 1_000, maxHeldRefusals = 1_000, now = Date.now }: RouteRateLimits): { beforeSignIn: Hook; afterSignIn: Hook } {
  if (perPersonPerMinute <= 0 && perCallerPerSecond <= 0 && perPersonPerSecond <= 0) return { beforeSignIn: async () => {}, afterSignIn: async () => {} }
  const localPerson = createWindowLimiter(MINUTE_MS, perPersonPerMinute)
  const localPersonSecond = createWindowLimiter(SECOND_MS, perPersonPerSecond)
  const localCaller = createWindowLimiter(SECOND_MS, perCallerPerSecond)
  const refusedUntil = new Map<string, number>()
  let held = 0

  const routeOf = (request: FastifyRequest): string | undefined =>
    request.routeOptions.url ? `${request.method} ${request.routeOptions.url}` : undefined
  /** The agent or machine the route names, as a key suffix; '' when it names neither. */
  const namedCaller = (request: FastifyRequest): string => {
    const params = request.params as { agentId?: unknown; machineId?: unknown } | undefined
    if (typeof params?.agentId === 'string' && params.agentId) return `a:${params.agentId}`
    if (typeof params?.machineId === 'string' && params.machineId) return `m:${params.machineId}`
    return ''
  }
  /** The remembered-refusal keys of this call: its token on the route, and on the agent or machine the route names. */
  const refusalKeys = (request: FastifyRequest, route: string): { person: string; caller: string } | undefined => {
    const token = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')?.[1]
    if (!token) return undefined
    const person = `${route}\n${createHash('sha256').update(token).digest('hex')}\n`
    return { person, caller: person + namedCaller(request) }
  }
  const refuse = async (reply: FastifyReply, until: number, at: number) => {
    if (refusalDelayMs > 0 && held < maxHeldRefusals) {
      held++
      try { await new Promise((resolve) => setTimeout(resolve, refusalDelayMs)) } finally { held-- }
    }
    return reply.code(429).header('Retry-After', String(Math.max(1, Math.ceil((until - at) / 1000)))).send({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again in a minute.' },
    })
  }
  const remember = (key: string, until: number, at: number): void => {
    if (refusedUntil.size >= REMEMBERED_REFUSALS_MAX) {
      for (const [k, end] of refusedUntil) if (end <= at) refusedUntil.delete(k)
      if (refusedUntil.size >= REMEMBERED_REFUSALS_MAX) refusedUntil.clear()
    }
    refusedUntil.set(key, until)
  }

  return {
    async beforeSignIn(request, reply) {
      if (refusedUntil.size === 0) return
      const route = routeOf(request)
      const keys = route && refusalKeys(request, route)
      if (!keys) return
      const at = now()
      for (const key of new Set([keys.person, keys.caller])) {
        const until = refusedUntil.get(key)
        if (until === undefined) continue
        if (until > at) return refuse(reply, until, at)
        refusedUntil.delete(key)
      }
    },

    async afterSignIn(request, reply) {
      const person = request.user?.sub
      const route = routeOf(request)
      if (!person || !route) return
      const named = namedCaller(request)
      const at = now()

      const checks: Array<{ name: string; key: string; windowMs: number; max: number; local: ReturnType<typeof createWindowLimiter>; personWide: boolean }> = []
      if (perPersonPerMinute > 0) checks.push({ name: 'route-person', key: `${route}:${person}`, windowMs: MINUTE_MS, max: perPersonPerMinute, local: localPerson, personWide: true })
      if (perPersonPerSecond > 0) checks.push({ name: 'route-person-second', key: `${route}:${person}`, windowMs: SECOND_MS, max: perPersonPerSecond, local: localPersonSecond, personWide: true })
      if (perCallerPerSecond > 0) {
        checks.push({ name: 'route-caller', key: `${route}:${person}${named ? `:${named}` : ''}`, windowMs: SECOND_MS, max: perCallerPerSecond, local: localCaller, personWide: !named })
      }

      const counts = await countShared(checks.map((c) => ({ key: windowKey(c.name, c.key, c.windowMs, at), windowMs: c.windowMs })))
      const over = checks.filter((c, i) => (counts ? counts[i] > c.max : !c.local.allows(c.key, at)))
      if (!over.length) return
      const untilOf = (cs: typeof over) => Math.max(...cs.map((c) => (Math.floor(at / c.windowMs) + 1) * c.windowMs))
      const keys = refusalKeys(request, route)
      const personWide = over.filter((c) => c.personWide)
      if (keys && personWide.length) remember(keys.person, untilOf(personWide), at)
      if (keys && personWide.length < over.length) remember(keys.caller, untilOf(over.filter((c) => !c.personWide)), at)
      return refuse(reply, untilOf(over), at)
    },
  }
}
