import { createHash } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { countShared, windowKey } from '../lib/rateLimit.js'
import { createWindowLimiter } from '../lib/windowLimiter.js'

/**
 * A ceiling on every signed-in request, per route and minute (Stability 3.2): one person's looping client, or one
 * machine's, must not take the server from everyone else.
 *
 * A route is its method and pattern, so changing an id does not buy a new budget. Each request counts once for its
 * person and, when the route names a machine (`:machineId`), once for that machine, both through the shared counter in
 * one call, so every pod spends one budget (lib/rateLimit.ts). The limits are far above any client that works as
 * designed and are set by the environment; 0 turns one off. Requests nobody signed in for are not counted here.
 * Clients already back off on 429; Retry-After says when the window ends.
 *
 * Two hooks around the sign-in gate. Counting needs the person, so it runs after sign-in (`afterSignIn`); but signing in
 * reads the account, and a loop that is already refused should not cost that on every call. A count only grows within
 * its window, so a refusal holds until the window ends: this pod remembers it by the sign-in token's digest, and
 * `beforeSignIn` answers that token's next calls on the same route (and machine) at once.
 *
 * Each refusal is held `refusalDelayMs` before it is sent. A client that honours Retry-After never sees it; one that
 * ignores it and keeps N calls in flight is slowed to N calls a second, where a refusal sent at once would let it loop
 * as fast as the event loop can answer, at everyone else's expense. The hold is a timer, not work.
 */
export interface RouteRateLimits {
  perPerson: number
  perMachine: number
  windowMs?: number
  refusalDelayMs?: number
  now?: () => number
}

type Hook = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>

const REMEMBERED_REFUSALS_MAX = 50_000

export function createRouteRateLimit({ perPerson, perMachine, windowMs = 60_000, refusalDelayMs = 1_000, now = Date.now }: RouteRateLimits): { beforeSignIn: Hook; afterSignIn: Hook } {
  if (perPerson <= 0 && perMachine <= 0) return { beforeSignIn: async () => {}, afterSignIn: async () => {} }
  const localPerson = createWindowLimiter(windowMs, perPerson)
  const localMachine = createWindowLimiter(windowMs, perMachine)
  const refusedUntil = new Map<string, number>()

  const routeOf = (request: FastifyRequest): string | undefined =>
    request.routeOptions.url ? `${request.method} ${request.routeOptions.url}` : undefined
  const machineOf = (request: FastifyRequest): string | undefined => {
    const machineId = (request.params as { machineId?: unknown } | undefined)?.machineId
    return typeof machineId === 'string' && machineId ? machineId : undefined
  }
  const refusalKey = (request: FastifyRequest, route: string): string | undefined => {
    const token = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')?.[1]
    if (!token) return undefined
    return `${route}\n${createHash('sha256').update(token).digest('hex')}\n${machineOf(request) ?? ''}`
  }
  const refuse = async (reply: FastifyReply, until: number, at: number) => {
    if (refusalDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, refusalDelayMs))
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
      const key = route && refusalKey(request, route)
      if (!key) return
      const until = refusedUntil.get(key)
      if (until === undefined) return
      const at = now()
      if (until > at) return refuse(reply, until, at)
      refusedUntil.delete(key)
    },

    async afterSignIn(request, reply) {
      const person = request.user?.sub
      const route = routeOf(request)
      if (!person || !route) return
      const machineId = machineOf(request)
      const at = now()

      const checks: Array<{ name: string; key: string; max: number; local: ReturnType<typeof createWindowLimiter> }> = []
      if (perPerson > 0) checks.push({ name: 'route-person', key: `${route}:${person}`, max: perPerson, local: localPerson })
      if (perMachine > 0 && machineId) checks.push({ name: 'route-machine', key: `${route}:${machineId}`, max: perMachine, local: localMachine })
      if (!checks.length) return

      const counts = await countShared(checks.map((c) => windowKey(c.name, c.key, windowMs, at)), windowMs)
      const over = counts
        ? checks.some((c, i) => counts[i] > c.max)
        : checks.map((c) => c.local.allows(c.key, at)).includes(false)
      if (!over) return
      const until = (Math.floor(at / windowMs) + 1) * windowMs
      const key = refusalKey(request, route)
      if (key) remember(key, until, at)
      return refuse(reply, until, at)
    },
  }
}
