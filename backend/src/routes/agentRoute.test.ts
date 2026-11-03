// POST /api/route/agents — the agent router's backend half.
//
// What is pinned here is the part that is easy to break quietly: that a model's answer is filtered
// against the ids we actually offered, that the caller's clock wins over this endpoint's, and that an
// agent with no questions on record is described honestly in the prompt rather than being given
// somebody else's text.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify'

const authenticateAccessToken = vi.hoisted(() => vi.fn())
// Only the SSO network call is faked. bearerToken, resolveSsoAuth and the middleware's own 401 mapping
// stay REAL, so this route's gating is genuinely exercised rather than assumed.
vi.mock('../lib/ssoAuth.js', async (importActual) => ({
  ...(await importActual<typeof import('../lib/ssoAuth.js')>()),
  authenticateAccessToken,
}))

import {
  agentRouteRoutes,
  buildRankPrompt,
  parseRanking,
  resolveBudgetMs,
  resetRouteRateLimits,
  AGENT_ROUTE_PATH,
  type RouteBody,
} from './agentRoute.js'
import { errorHandler } from '../middlewares/errorHandler.js'
import { registerAuthMiddleware, shouldSkipAuth } from '../middlewares/authMiddleware.js'
import { SsoAuthError } from '../lib/ssoAuth.js'
import { env } from '../config/env.js'
import { logger } from '../utils/logger.js'
import { useSharedRateCounter, windowKey } from '../lib/rateLimit.js'

const body = (over: Partial<RouteBody> = {}): RouteBody => ({
  task: 'so sanh iphone vs samsung',
  agents: [
    { id: 'a1', name: 'Phones', prompts: ['iphone 17 gia bao nhieu'] },
    { id: 'a2', name: 'Frontend', prompts: [] },
  ],
  ...over,
})

/** The app as the server builds it: the global SSO gate in front, then the route. */
async function build(): Promise<FastifyInstance> {
  const app = Fastify()
  app.setErrorHandler(errorHandler)
  registerAuthMiddleware(app, authenticateAccessToken)
  await app.register(agentRouteRoutes)
  await app.ready()
  return app
}

function post(app: FastifyInstance, payload: unknown, opts: { noAuth?: boolean; user?: string } = {}) {
  const options: InjectOptions = {
    method: 'POST',
    url: AGENT_ROUTE_PATH,
    payload: payload as InjectOptions['payload'],
    headers: opts.noAuth ? {} : { authorization: `Bearer ${opts.user ?? 'sso-token'}` },
  }
  return app.inject(options)
}

/** One OpenAI-compatible reply, as `fetch` would hand it back. */
const llmSays = (content: string) =>
  vi.fn(async () => new Response(JSON.stringify({ model: 'test-model', choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))

describe('POST /api/route/agents', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetRouteRateLimits()
    authenticateAccessToken.mockReset()
    authenticateAccessToken.mockResolvedValue({ sub: 'u1', email: 'a@b.c', role: 'user', autonomousEnv: 'prod' })
    env.CURSOR_LLM_BASE_URL = 'https://llm.example/v1'
    env.CURSOR_LLM_API_KEY = 'llm-key'
  })

  it('is gated by the ordinary SSO middleware — the daemon signs in as a person', () => {
    // NOT in the skip-list, unlike /api/analytics/report. The `harness` daemon holds an SSO access
    // token and no machine api key, so a machine-key gate would refuse every real caller.
    expect(shouldSkipAuth(AGENT_ROUTE_PATH)).toBe(false)
  })

  it('refuses without a token', async () => {
    const app = await build()
    expect((await post(app, body(), { noAuth: true })).statusCode).toBe(401)
  })

  it('refuses a token the SSO service rejects', async () => {
    authenticateAccessToken.mockRejectedValue(new SsoAuthError('nope', 'INVALID_TOKEN'))
    const app = await build()
    expect((await post(app, body())).statusCode).toBe(401)
  })

  it('answers the single-agent case without spending a call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const app = await build()
    const res = await post(app, body({ agents: [{ id: 'only', name: 'One', prompts: [] }] }))
    expect(res.statusCode).toBe(200)
    expect(res.json().data.ranking).toEqual([{ agentId: 'only', score: 1, reason: 'only conversation' }])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('ranks from the model', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      llmSays('{"ranking":[{"agentId":"a1","score":0.9,"reason":"phones"},{"agentId":"a2","score":0.1,"reason":"no"}]}') as never,
    )
    const app = await build()
    const res = await post(app, body())
    expect(res.statusCode).toBe(200)
    const ranking = res.json().data.ranking
    expect(ranking[0]).toMatchObject({ agentId: 'a1', score: 0.9 })
    expect(ranking).toHaveLength(2)
  })

  it('passes the caller\'s budget to the model call, not its own', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      llmSays('{"ranking":[{"agentId":"a1","score":0.9}]}') as never,
    )
    const app = await build()
    await post(app, body({ budgetMs: 12_000 }))
    const init = spy.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('is a 502 when the model names nothing we offered', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      llmSays('{"ranking":[{"agentId":"invented","score":0.9}]}') as never,
    )
    const app = await build()
    expect((await post(app, body())).statusCode).toBe(502)
  })

  it('is a 502 when the call itself fails — no scored fallback here', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('upstream down') as never)
    const app = await build()
    expect((await post(app, body())).statusCode).toBe(502)
  })

  it('refuses when no model is configured, rather than answering another way', async () => {
    env.CURSOR_LLM_API_KEY = undefined
    const app = await build()
    expect((await post(app, body())).statusCode).toBe(503)
  })

  it('rejects a body with no agents', async () => {
    const app = await build()
    expect((await post(app, { task: 'hi', agents: [] })).statusCode).toBe(400)
  })

  it('rejects more than fifteen agents rather than silently weighing some', async () => {
    const many = Array.from({ length: 16 }, (_, i) => ({ id: `a${i}`, name: `n${i}`, prompts: [] }))
    const app = await build()
    expect((await post(app, { task: 'hi', agents: many })).statusCode).toBe(400)
  })
})

// What one account may spend on Harness's model through this route. Before these bounds, each question
// was unbounded (only the 1 MiB default body limit held), and an account could relay ~1 MB a call, 60
// calls a minute, every day, out of the budget that also pays for ⌘B routing and Hub translation.
describe('POST /api/route/agents: what one account may spend', () => {
  const ranked = JSON.stringify({ ranking: [{ agentId: 'a1', score: 0.9, reason: 'phones' }, { agentId: 'a2', score: 0.1, reason: 'no' }] })
  /** Each bearer token signs in as the account it names: `Bearer u7` is user u7. */
  const asUser = () => authenticateAccessToken.mockImplementation(async (token: string) =>
    ({ sub: token, email: `${token}@b.c`, role: 'user', autonomousEnv: 'prod' }))

  beforeEach(() => {
    vi.restoreAllMocks()
    resetRouteRateLimits()
    authenticateAccessToken.mockReset()
    asUser()
    env.CURSOR_LLM_BASE_URL = 'https://llm.example/v1'
    env.CURSOR_LLM_API_KEY = 'llm-key'
  })
  afterEach(() => { vi.useRealTimers() })

  it('refuses a question over 4,000 characters and never calls the model', async () => {
    const fetchMock = llmSays(ranked)
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock)
    const app = await build()
    const res = await post(app, body({
      agents: [
        { id: 'a1', name: 'Phones', prompts: ['x'.repeat(4_001)] },
        { id: 'a2', name: 'Frontend', prompts: [] },
      ],
    }), { user: 'u1' })
    expect(res.statusCode).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still takes a question of exactly 4,000 characters', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(llmSays(ranked))
    const app = await build()
    const res = await post(app, body({
      agents: [
        { id: 'a1', name: 'Phones', prompts: ['x'.repeat(4_000)] },
        { id: 'a2', name: 'Frontend', prompts: [] },
      ],
    }), { user: 'u1' })
    expect(res.statusCode).toBe(200)
  })

  it('refuses a body over the route limit with 413 before it is parsed', async () => {
    // Every field inside its own bound, so only the body limit can refuse it: 15 agents with three
    // 4,000-character questions in a three-byte script is ~540 KB of JSON.
    const fetchMock = llmSays(ranked)
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock)
    const app = await build()
    const agents = Array.from({ length: 15 }, (_, i) => ({ id: `a${i}`, name: 'n', prompts: Array(3).fill('ệ'.repeat(4_000)) }))
    const payload = JSON.stringify({ task: 'route this', agents })
    expect(Buffer.byteLength(payload)).toBeGreaterThan(300 * 1024)
    const res = await app.inject({
      method: 'POST', url: AGENT_ROUTE_PATH, payload,
      headers: { authorization: 'Bearer u1', 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(413)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  /**
   * The shared count every pod uses (Redis in production), in memory: lets a test start an account or the
   * whole day near its real limit instead of making a thousand calls.
   */
  const DAY_MS = 24 * 60 * 60_000
  function sharedCounts(): Map<string, number> {
    const counts = new Map<string, number>()
    useSharedRateCounter(async (entries) => entries.map(({ key }) => {
      const next = (counts.get(key) ?? 0) + 1
      counts.set(key, next)
      return next
    }))
    return counts
  }
  const accountDay = (user: string) => windowKey('agent-route-day', user, DAY_MS, Date.now())
  const everyoneDay = () => windowKey('agent-route-all', 'all', DAY_MS, Date.now())
  afterEach(() => { useSharedRateCounter(null) })

  it('refuses an account past 1,000 routes a day with 429, in plain words, and counts each account on its own', async () => {
    const counts = sharedCounts()
    const fetchMock = llmSays(ranked)
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock)
    const app = await build()
    counts.set(accountDay('u1'), 999)
    expect((await post(app, body(), { user: 'u1' })).statusCode).toBe(200) // the 1,000th
    const refused = await post(app, body(), { user: 'u1' })
    expect(refused.statusCode).toBe(429)
    expect(refused.json().error.message).toMatch(/today/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((await post(app, body(), { user: 'u2' })).statusCode).toBe(200)
  })

  it('gives an account its daily count back the next UTC day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-03T23:59:00Z'))
    const counts = sharedCounts()
    vi.spyOn(globalThis, 'fetch').mockImplementation(llmSays(ranked))
    const app = await build()
    counts.set(accountDay('u1'), 1_000)
    expect((await post(app, body(), { user: 'u1' })).statusCode).toBe(429)
    vi.setSystemTime(new Date('2026-11-04T00:01:00Z'))
    expect((await post(app, body(), { user: 'u1' })).statusCode).toBe(200)
  })

  it('holds the all-accounts ceiling of 100,000 a day, and an account refused on its own count does not spend it', async () => {
    const counts = sharedCounts()
    const fetchMock = llmSays(ranked)
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock)
    const app = await build()
    counts.set(everyoneDay(), 99_999)
    counts.set(accountDay('u9'), 1_000)
    expect((await post(app, body(), { user: 'u9' })).statusCode).toBe(429) // its own count
    expect(counts.get(everyoneDay())).toBe(99_999)
    expect((await post(app, body(), { user: 'u1' })).statusCode).toBe(200) // the 100,000th
    const over = await post(app, body(), { user: 'u2' })
    expect(over.statusCode).toBe(503)
    expect(over.json().error.message).toMatch(/today/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not count the single-agent answer, which spends no call', async () => {
    const counts = sharedCounts()
    const app = await build()
    counts.set(accountDay('u1'), 1_000)
    const one = body({ agents: [{ id: 'a1', name: 'Phones', prompts: [] }] })
    expect((await post(app, one, { user: 'u1' })).statusCode).toBe(200)
    expect(counts.get(accountDay('u1'))).toBe(1_000)
  })

  it('logs the length of the prompt it sent, not only the task', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(llmSays(ranked))
    const info = vi.spyOn(logger, 'info')
    const app = await build()
    const sent = body({ agents: [{ id: 'a1', name: 'Phones', prompts: ['p'.repeat(3_000)] }, { id: 'a2', name: 'Frontend', prompts: [] }] })
    expect((await post(app, sent, { user: 'u1' })).statusCode).toBe(200)
    const line = info.mock.calls.find(([message]) => message === 'agent-route')
    expect(line?.[1]).toMatchObject({ promptChars: buildRankPrompt(sent).length })
  })
})


describe('resolveBudgetMs', () => {
  // The caller owns the clock: the CLI gives a spoken task 12s, and an endpoint that waits longer
  // produces answers nobody is still listening for.
  it('takes the caller\'s budget', () => expect(resolveBudgetMs(12_000)).toBe(12_000))
  it('clamps an absurdly long one', () => expect(resolveBudgetMs(600_000)).toBe(20_000))
  it('clamps an impossibly short one', () => expect(resolveBudgetMs(1)).toBe(3_000))
  it('falls back when not asked', () => expect(resolveBudgetMs(undefined)).toBe(10_000))
  it('falls back on a non-number', () => expect(resolveBudgetMs(NaN)).toBe(10_000))
})

describe('parseRanking', () => {
  const offered = new Set(['a1', 'a2', 'a3'])

  it('reads a bare object', () => {
    expect(parseRanking('{"ranking":[{"agentId":"a1","score":0.7,"reason":"r"}]}', offered))
      .toEqual([{ agentId: 'a1', score: 0.7, reason: 'r' }])
  })

  it('survives a code fence and a sentence of preamble', () => {
    const raw = 'Sure, here you go:\n```json\n{"ranking":[{"agentId":"a2","score":0.5}]}\n```'
    expect(parseRanking(raw, offered)).toEqual([{ agentId: 'a2', score: 0.5, reason: '' }])
  })

  it('drops an id that was never offered instead of correcting it', () => {
    const raw = '{"ranking":[{"agentId":"ghost","score":0.9},{"agentId":"a1","score":0.4}]}'
    expect(parseRanking(raw, offered)).toEqual([{ agentId: 'a1', score: 0.4, reason: '' }])
  })

  it('drops a repeat', () => {
    const raw = '{"ranking":[{"agentId":"a1","score":0.9},{"agentId":"a1","score":0.2}]}'
    expect(parseRanking(raw, offered)).toHaveLength(1)
  })

  it('drops a row whose score is not a number', () => {
    const raw = '{"ranking":[{"agentId":"a1","score":"high"},{"agentId":"a2","score":0.3}]}'
    expect(parseRanking(raw, offered)).toEqual([{ agentId: 'a2', score: 0.3, reason: '' }])
  })

  it('clamps a score outside 0..1', () => {
    expect(parseRanking('{"ranking":[{"agentId":"a1","score":4}]}', offered)?.[0].score).toBe(1)
    expect(parseRanking('{"ranking":[{"agentId":"a1","score":-2}]}', offered)?.[0].score).toBe(0)
  })

  it('caps at five rows', () => {
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']
    const wide = new Set(ids)
    const raw = `{"ranking":[${ids.map((id) => `{"agentId":"${id}","score":0.5}`).join(',')}]}`
    expect(parseRanking(raw, wide)).toHaveLength(5)
  })

  it('is null on unparseable text — a failed call, not an empty ranking', () => {
    expect(parseRanking('I could not decide.', offered)).toBeNull()
    expect(parseRanking('{"ranking":', offered)).toBeNull()
    expect(parseRanking('{"winner":"a1"}', offered)).toBeNull()
  })

  it('is null when every row was dropped — answering in shape but naming nobody is a failure', () => {
    expect(parseRanking('{"ranking":[{"agentId":"ghost","score":1}]}', offered)).toBeNull()
  })
})

describe('buildRankPrompt', () => {
  it('lists a person\'s questions as theirs, numbered and newest first', () => {
    const prompt = buildRankPrompt(body({
      agents: [{ id: 'a1', name: 'Phones', prompts: ['newest one', 'older one'] }, { id: 'a2', name: 'X', prompts: [] }],
    }))
    expect(prompt).toContain('asked, newest first:')
    expect(prompt.indexOf('1. "newest one"')).toBeLessThan(prompt.indexOf('2. "older one"'))
    expect(prompt).toContain("THE PERSON'S OWN QUESTIONS")
  })

  it('says an agent has nothing on record rather than filling it with the machine\'s replies', () => {
    // The fault this whole endpoint was written to fix: the old prompt announced "recently asked" over
    // text that was a summary of what the AGENT said back.
    const prompt = buildRankPrompt(body({ agents: [{ id: 'a1', name: 'Fresh', prompts: [] }, { id: 'a2', name: 'B', prompts: ['x'] }] }))
    expect(prompt).toContain('(no questions on record)')
  })

  it('names how many rows it wants, and says a low score is still an answer', () => {
    // A model asked for "the five best" when nothing fits answers with ONE row and thinks itself
    // honest — and the picker then draws a single number over a list of eight.
    const prompt = buildRankPrompt(body({
      agents: Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, name: `n${i}`, prompts: [] })),
    }))
    expect(prompt).toContain('ALWAYS return 5 rows')
    expect(prompt).toContain('A low score is an answer')
    expect(prompt).toContain('The array has 5 entries')
  })

  it('asks for one row per conversation when there are fewer than five', () => {
    const prompt = buildRankPrompt(body({
      agents: [{ id: 'a1', name: 'A', prompts: [] }, { id: 'a2', name: 'B', prompts: [] }],
    }))
    expect(prompt).toContain('The array has 2 entries')
  })

  it('scores on an absolute scale, not against each other', () => {
    const prompt = buildRankPrompt(body())
    expect(prompt).toContain('NOT relative to the others')
  })

  it('carries the task verbatim and forbids translating it', () => {
    const prompt = buildRankPrompt(body({ task: 'so sánh iphone với samsung' }))
    expect(prompt).toContain('so sánh iphone với samsung')
    expect(prompt).toContain('do NOT translate')
  })

  it('states continuity as a fact with its age, and omits it entirely when absent', () => {
    const withCarry = buildRankPrompt(body({ continuity: { agentId: 'a2', agoMs: 30_000 } }))
    expect(withCarry).toContain('previous task to id=a2, 30s ago')
    expect(buildRankPrompt(body())).not.toContain('previous task')
  })

  it('does not mention a machine — the old prompt printed one and never explained it', () => {
    expect(buildRankPrompt(body())).not.toContain('machine=')
  })
})
