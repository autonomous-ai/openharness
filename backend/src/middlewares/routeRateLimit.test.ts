import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
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
async function appWith(limits: { perPersonPerMinute: number; perCallerPerSecond: number; perPersonPerSecond?: number; refusalDelayMs?: number; maxHeldRefusals?: number }, now?: () => number) {
  app = Fastify({ forceCloseConnections: true })
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

  it('caps a person per route and second however many agent ids they name, so made-up ids cannot burst the minute\'s budget', async () => {
    const get = await appWith({ perPersonPerMinute: 12_000, perCallerPerSecond: 50, perPersonPerSecond: 5 }, () => 0)
    for (let agent = 0; agent < 5; agent++) expect((await get(`/api/tabs/t1/agents/made-up-${agent}/deliveries`, 'loop')).statusCode).toBe(200)

    const refused = await get('/api/tabs/t1/agents/made-up-5/deliveries', 'loop')
    expect(refused.statusCode).toBe(429)
    expect(refused.headers['retry-after']).toBe('1')
    expect((await get('/api/hosts/m1/changes', 'loop')).statusCode).toBe(200)
    expect((await get('/api/tabs/t1/agents/a0/deliveries', 'someone-else')).statusCode).toBe(200)
  })

  it.each([
    ['across pods, through the shared counter', true],
    ['in one process, while the shared counter is unavailable', false],
  ])('never refuses 200 agents of one person each polling once a second, late polls and minute boundaries included, at the server\'s default limits (%s)', async (_, shared) => {
    if (shared) {
      const counts = new Map<string, number>()
      useSharedRateCounter(async (entries) => entries.map(({ key }) => { counts.set(key, (counts.get(key) ?? 0) + 1); return counts.get(key)! }))
    }
    let at = 0
    const get = await appWith({
      perPersonPerMinute: env.ROUTE_RATE_LIMIT_PER_PERSON_MINUTE,
      perCallerPerSecond: env.ROUTE_RATE_LIMIT_PER_CALLER_SECOND,
      perPersonPerSecond: env.ROUTE_RATE_LIMIT_PER_PERSON_SECOND,
    }, () => at)
    // Each agent polls on its own phase, for a little over three minutes. Odd rounds arrive 299 ms late, so one second's
    // window can see an agent twice. The rounds just before the minute boundaries are late (59: 299 ms, 179: 999 ms) and
    // round 119 is on time, so the second and fourth minutes see some agents 61 times.
    const lateMs = (round: number) => (round === 179 ? 999 : round === 119 ? 0 : round % 2 ? 299 : 0)
    const polls: Array<{ at: number; agent: number }> = []
    for (let agent = 0; agent < 200; agent++) {
      for (let round = 0; round < 190; round++) polls.push({ at: (agent * 5) % 1_000 + round * 1_000 + lateMs(round), agent })
    }
    polls.sort((a, b) => a.at - b.at)

    const refused: Array<{ at: number; agent: number }> = []
    for (const poll of polls) {
      at = poll.at
      if ((await get(`/api/tabs/t1/agents/a${poll.agent}/deliveries`, 'owner')).statusCode !== 200) refused.push(poll)
    }
    expect(refused.slice(0, 3)).toEqual([])
  }, 30_000) // 38,000 calls through Fastify: about a second on an idle machine

  it.each([
    ['per second', { perPersonPerMinute: 1_000, perCallerPerSecond: 50, perPersonPerSecond: 5 }, 1_000],
    ['per minute', { perPersonPerMinute: 5, perCallerPerSecond: 50, perPersonPerSecond: 500 }, 60_000],
  ])('once a person is over a route\'s ceiling %s, new agent ids are refused before sign-in and before the shared counter', async (_, limits, resetAt) => {
    let counted = 0
    const counts = new Map<string, number>()
    useSharedRateCounter(async (entries) => {
      counted++
      return entries.map(({ key }) => { counts.set(key, (counts.get(key) ?? 0) + 1); return counts.get(key)! })
    })
    let at = 0
    const get = await appWith(limits, () => at)
    for (let agent = 0; agent < 5; agent++) expect((await get(`/api/tabs/t1/agents/made-up-${agent}/deliveries`, 'loop')).statusCode).toBe(200)
    expect((await get('/api/tabs/t1/agents/made-up-5/deliveries', 'loop')).statusCode).toBe(429)
    const [signedIn, countedSoFar] = [signIns, counted]

    for (let agent = 6; agent < 100; agent++) expect((await get(`/api/tabs/t1/agents/made-up-${agent}/deliveries`, 'loop')).statusCode).toBe(429)
    expect([signIns, counted]).toEqual([signedIn, countedSoFar])
    expect((await get('/api/tabs/t1/agents/a0/deliveries', 'someone-else')).statusCode).toBe(200)

    at = resetAt
    expect((await get('/api/tabs/t1/agents/made-up-100/deliveries', 'loop')).statusCode).toBe(200)
  })

  it('holds at most so many refusals at once; past that each is answered at once', async () => {
    const get = await appWith({ perPersonPerMinute: 100, perCallerPerSecond: 1, refusalDelayMs: 200, maxHeldRefusals: 2 }, () => 0)
    expect((await get('/api/things', 'loop')).statusCode).toBe(200)

    const started = Date.now()
    const answeredAfter = await Promise.all(Array.from({ length: 5 }, async () => {
      expect((await get('/api/things', 'loop')).statusCode).toBe(429)
      return Date.now() - started
    }))
    answeredAfter.sort((a, b) => a - b)
    expect(answeredAfter.slice(0, 3).every((ms) => ms < 150)).toBe(true)
    expect(answeredAfter.slice(3).every((ms) => ms >= 190)).toBe(true)
  })

  it('over real connections, keeps at most the bound open on held refusals and answers someone else at once', async () => {
    await appWith({ perPersonPerMinute: 100_000, perCallerPerSecond: 1, refusalDelayMs: 1_000, maxHeldRefusals: 40 }, () => 0)
    const address = await app!.listen({ port: 0, host: '127.0.0.1' })
    const call = async (sub: string) => (await fetch(`${address}/api/things`, { headers: { authorization: `Bearer ${sub}` } })).status
    expect(await call('loop')).toBe(200)

    const started = Date.now()
    let answered = 0
    const loop = Array.from({ length: 100 }, () => call('loop').then((status) => { answered++; return status }))
    expect(await call('someone-else')).toBe(200)
    expect(Date.now() - started).toBeLessThan(900)
    // The 60 past the bound are answered before the first held one is due, a second after they started.
    await vi.waitFor(() => expect(answered).toBe(60), { timeout: 900, interval: 10 })
    expect(answered).toBe(60)

    expect(await Promise.all(loop)).toEqual(Array(100).fill(429))
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000)
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
