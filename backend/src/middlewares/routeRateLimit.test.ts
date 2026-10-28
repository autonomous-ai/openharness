import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import type { AuthUser } from '../lib/ssoAuth.js'
import { useSharedRateCounter } from '../lib/rateLimit.js'
import { createRouteRateLimit } from './routeRateLimit.js'

const user = (sub: string, extra: Partial<AuthUser> = {}): AuthUser => ({ sub, email: `${sub}@example.com`, role: 'user', autonomousEnv: 'prod', ...extra })

let app: FastifyInstance | undefined
afterEach(async () => {
  await app?.close()
  app = undefined
  useSharedRateCounter(null)
})

let signIns = 0

/** An app whose requests sign in with `Bearer <user>` (none: anonymous), between the limit's two hooks, as in server.ts. */
async function appWith(limits: { perPersonPerMinute: number; perCallerPerSecond: number; refusalDelayMs?: number }, now?: () => number) {
  app = Fastify()
  signIns = 0
  const limit = createRouteRateLimit({ refusalDelayMs: 0, ...limits, ...(now ? { now } : {}) })
  app.addHook('onRequest', limit.beforeSignIn)
  app.addHook('onRequest', async (request) => {
    const sub = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1]
    if (sub) { signIns++; request.user = user(sub) }
  })
  app.addHook('onRequest', limit.afterSignIn)
  app.get('/api/things', async () => ({ ok: true }))
  app.get('/api/other', async () => ({ ok: true }))
  app.get('/api/tabs/:tabId/changes', async () => ({ ok: true }))
  app.get('/api/hosts/:machineId/changes', async () => ({ ok: true }))
  app.get('/api/tabs/:tabId/agents/:agentId/deliveries', async () => ({ ok: true }))
  app.get('/api/public', async () => ({ ok: true }))
  await app.ready()
  return (url: string, sub?: string) => app!.inject({ method: 'GET', url, headers: sub ? { authorization: `Bearer ${sub}` } : {} })
}

describe('per-route rate limit', () => {
  it('refuses a person past a route\'s per-second budget with 429 and when to come back, and only on that route', async () => {
    const get = await appWith({ perPersonPerMinute: 100, perCallerPerSecond: 3 }, () => 15_400)
    for (let i = 0; i < 3; i++) expect((await get('/api/things', 'loop')).statusCode).toBe(200)

    const refused = await get('/api/things', 'loop')

    expect(refused.statusCode).toBe(429)
    expect(refused.headers['retry-after']).toBe('1')
    expect(refused.json()).toMatchObject({ success: false, error: { code: 'RATE_LIMITED' } })
    expect((await get('/api/other', 'loop')).statusCode).toBe(200)
    expect((await get('/api/things', 'someone-else')).statusCode).toBe(200)
  })

  it('counts a route by its pattern, so changing an id does not buy a new budget', async () => {
    const get = await appWith({ perPersonPerMinute: 100, perCallerPerSecond: 2 }, () => 0)
    expect((await get('/api/tabs/t1/changes', 'loop')).statusCode).toBe(200)
    expect((await get('/api/tabs/t2/changes', 'loop')).statusCode).toBe(200)

    expect((await get('/api/tabs/t3/changes', 'loop')).statusCode).toBe(429)
  })

  it('someone else naming my machine does not spend my machine\'s budget', async () => {
    const get = await appWith({ perPersonPerMinute: 100, perCallerPerSecond: 2 }, () => 0)
    for (let i = 0; i < 5; i++) await get('/api/hosts/m1/changes', 'intruder')
    expect((await get('/api/hosts/m1/changes', 'intruder')).statusCode).toBe(429)

    expect((await get('/api/hosts/m1/changes', 'owner')).statusCode).toBe(200)
    expect((await get('/api/hosts/m1/changes', 'owner')).statusCode).toBe(200)
  })

  it('holds one machine to its own budget without spending its owner\'s other machines', async () => {
    const get = await appWith({ perPersonPerMinute: 100, perCallerPerSecond: 2 }, () => 0)
    await get('/api/hosts/m1/changes', 'owner'); await get('/api/hosts/m1/changes', 'owner')

    expect((await get('/api/hosts/m1/changes', 'owner')).statusCode).toBe(429)
    expect((await get('/api/hosts/m2/changes', 'owner')).statusCode).toBe(200)
  })

  it('gives each agent the route names its own budget, so a person\'s agents polling in the same second all get through', async () => {
    const get = await appWith({ perPersonPerMinute: 100, perCallerPerSecond: 2 }, () => 0)
    const statuses: number[] = []
    for (let agent = 0; agent < 10; agent++) {
      for (let poll = 0; poll < 2; poll++) statuses.push((await get(`/api/tabs/t1/agents/a${agent}/deliveries`, 'owner')).statusCode)
    }

    expect(statuses).toEqual(Array(20).fill(200))
    expect((await get('/api/tabs/t1/agents/a0/deliveries', 'owner')).statusCode).toBe(429)
  })

  it('still counts every call toward the person\'s per-minute ceiling, so new agent or machine ids buy nothing past it', async () => {
    let at = 0
    const get = await appWith({ perPersonPerMinute: 5, perCallerPerSecond: 100 }, () => at)
    for (let agent = 0; agent < 5; agent++) expect((await get(`/api/tabs/t1/agents/a${agent}/deliveries`, 'owner')).statusCode).toBe(200)

    const refused = await get('/api/tabs/t1/agents/a5/deliveries', 'owner')
    expect(refused.statusCode).toBe(429)
    expect(refused.headers['retry-after']).toBe('60')
    expect((await get('/api/hosts/m9/changes', 'owner')).statusCode).toBe(200)

    at = 60_000
    expect((await get('/api/tabs/t1/agents/a5/deliveries', 'owner')).statusCode).toBe(200)
  })

  it('does not count requests nobody signed in for', async () => {
    const get = await appWith({ perPersonPerMinute: 1, perCallerPerSecond: 1 })
    for (let i = 0; i < 5; i++) expect((await get('/api/public')).statusCode).toBe(200)
  })

  it('a limit of 0 is off', async () => {
    const get = await appWith({ perPersonPerMinute: 0, perCallerPerSecond: 0 })
    for (let i = 0; i < 5; i++) expect((await get('/api/hosts/m1/changes', 'owner')).statusCode).toBe(200)
  })

  it('counts every pod together through the shared counter, in one call per request, each count in its own window', async () => {
    const calls: Array<Array<{ key: string; windowMs: number }>> = []
    const counts = new Map<string, number>()
    useSharedRateCounter(async (entries) => {
      calls.push(entries)
      return entries.map(({ key }) => { counts.set(key, (counts.get(key) ?? 0) + 1); return counts.get(key)! })
    })
    const get = await appWith({ perPersonPerMinute: 100, perCallerPerSecond: 2 }, () => 0)
    await get('/api/hosts/m1/changes', 'owner')
    counts.set('rl:route-caller:GET /api/hosts/:machineId/changes:owner:m:m1:0', 2) // another pod spent the rest

    expect((await get('/api/hosts/m1/changes', 'owner')).statusCode).toBe(429)
    expect(calls[0]).toEqual([
      { key: 'rl:route-person:GET /api/hosts/:machineId/changes:owner:0', windowMs: 60_000 },
      { key: 'rl:route-caller:GET /api/hosts/:machineId/changes:owner:m:m1:0', windowMs: 1_000 },
    ])
  })

  it('refuses a token it has already refused in this window before signing it in, so a loop costs no sign-in', async () => {
    let at = 0
    const get = await appWith({ perPersonPerMinute: 100, perCallerPerSecond: 2 }, () => at)
    await get('/api/things', 'loop'); await get('/api/things', 'loop'); await get('/api/things', 'loop')
    const signedIn = signIns

    for (let i = 0; i < 5; i++) expect((await get('/api/things', 'loop')).statusCode).toBe(429)
    expect(signIns).toBe(signedIn)
    expect((await get('/api/other', 'loop')).statusCode).toBe(200)

    at = 1_000
    expect((await get('/api/things', 'loop')).statusCode).toBe(200)
  })

  it('remembers a machine\'s refusal for that machine only', async () => {
    const get = await appWith({ perPersonPerMinute: 100, perCallerPerSecond: 1 }, () => 0)
    await get('/api/hosts/m1/changes', 'owner'); await get('/api/hosts/m1/changes', 'owner')

    expect((await get('/api/hosts/m1/changes', 'owner')).statusCode).toBe(429)
    expect((await get('/api/hosts/m2/changes', 'owner')).statusCode).toBe(200)
  })

  it('holds each refusal a moment, so a client that ignores it cannot loop faster than that', async () => {
    const get = await appWith({ perPersonPerMinute: 100, perCallerPerSecond: 1, refusalDelayMs: 60 })
    let started = Date.now()
    expect((await get('/api/things', 'loop')).statusCode).toBe(200)
    expect(Date.now() - started).toBeLessThan(50)

    for (const remembered of [false, true]) {
      started = Date.now()
      expect((await get('/api/things', 'loop')).statusCode, `remembered: ${remembered}`).toBe(429)
      expect(Date.now() - started).toBeGreaterThanOrEqual(55)
    }
  })
})
