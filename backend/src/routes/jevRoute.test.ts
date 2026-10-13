// POST /api/route/jev — ⌘B's Jev decisions on Harness's own key.
//
// Pinned here: that the route spends the key only on Jev (the model is ours, not the caller's), that
// it fails closed without a key, that one account cannot spend without bound, and that what comes back
// is only answers to the questions that were asked.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const authenticateAccessToken = vi.hoisted(() => vi.fn())
vi.mock('../lib/ssoAuth.js', async (importActual) => ({
  ...(await importActual<typeof import('../lib/ssoAuth.js')>()),
  authenticateAccessToken,
}))

import { jevAllowance, jevRouteRoutes, localJevCounter, parseJevAnswers, JEV_ROUTE_PATH, type JevBody, type JevCounter } from './jevRoute.js'
import { errorHandler } from '../middlewares/errorHandler.js'
import { registerAuthMiddleware, shouldSkipAuth } from '../middlewares/authMiddleware.js'
import { env } from '../config/env.js'
import { logger } from '../utils/logger.js'

const body = (over: Partial<JevBody> = {}): JevBody => ({
  state: { message: 'fix the login redirect' },
  questions: {
    target: { type: 'choice', instructions: 'Which session?', criteria: { s0: 'auth work', new: 'None of them' } },
    topic: { type: 'choice', instructions: 'Does it name a subject?', criteria: { yes: 'Yes', no: 'No' } },
  },
  ...over,
})

async function build(count?: JevCounter): Promise<FastifyInstance> {
  const app = Fastify()
  app.setErrorHandler(errorHandler)
  registerAuthMiddleware(app, authenticateAccessToken)
  await app.register(jevRouteRoutes, count ? { count } : {})
  await app.ready()
  return app
}

/** The largest decision the CLI's router builds (cli/src/lib/routeDecide.ts): 40 sessions and "new", 40
 *  projects, 40 agents, every label cut to 600 characters, a 16,000-character message and a previous session. */
function largest(message = 'x'.repeat(16_000)): JevBody {
  const options = (prefix: string) => Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`${prefix}${i}`, 'é'.repeat(599) + '…']))
  return {
    state: { message, previous_message_went_to: 'n'.repeat(300) },
    questions: {
      target: { type: 'choice', instructions: 'i'.repeat(760), criteria: { ...options('s'), new: 'None of them: no session does this kind of work' } },
      topic: { type: 'choice', instructions: 'i'.repeat(160), criteria: { yes: 'y'.repeat(100), no: 'n'.repeat(140) } },
      project: { type: 'choice', instructions: 'If this becomes new work, which project folder does it belong in?', criteria: options('p') },
      agent: { type: 'choice', instructions: 'Which agent is best suited to do this work?', criteria: options('a') },
    },
  }
}

const post = (app: FastifyInstance, payload: unknown, auth = true) =>
  app.inject({ method: 'POST', url: JEV_ROUTE_PATH, payload: payload as object, headers: auth ? { authorization: 'Bearer sso-token' } : {} })

const jevSays = (answer: unknown, status = 200) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(typeof answer === 'string' ? answer : JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } }))

const good = {
  answers: {
    target: { choice: 's0', probabilities: { s0: 0.9, new: 0.1 } },
    topic: { choice: 'yes', probabilities: { yes: 0.97, no: 0.03 } },
  },
  usage: { cost: 0.00017, input_tokens: 4000 },
}

describe('POST /api/route/jev', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    authenticateAccessToken.mockReset()
    authenticateAccessToken.mockResolvedValue({ sub: 'u1', email: 'a@b.c', role: 'user', autonomousEnv: 'prod' })
    env.JEV_OPENROUTER_API_KEY = 'or-key'
  })

  it('is gated by the ordinary SSO middleware', async () => {
    expect(shouldSkipAuth(JEV_ROUTE_PATH)).toBe(false)
    const app = await build()
    expect((await post(app, body(), false)).statusCode).toBe(401)
  })

  it("asks Jev with Harness's key and returns only the answers", async () => {
    const spy = jevSays(good)
    const app = await build()
    const res = await post(app, body())
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ answers: good.answers })
    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer or-key')
    expect(headers['X-Title']).toBe('Harness router')
    const sent = JSON.parse(init.body as string)
    expect(sent).toEqual({ model: 'typesafe/jev-1.13', ...body() })
  })

  it('never lets a caller pick the model', async () => {
    const spy = jevSays(good)
    const app = await build()
    expect((await post(app, { ...body(), model: 'openai/gpt-5-pro' })).statusCode).toBe(200)
    expect(JSON.parse((spy.mock.calls[0] as [string, RequestInit])[1].body as string).model).toBe('typesafe/jev-1.13')
  })

  it('fails closed with no key', async () => {
    env.JEV_OPENROUTER_API_KEY = undefined
    const spy = jevSays(good)
    const app = await build()
    const res = await post(app, body())
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('JEV_NOT_CONFIGURED')
    expect(spy).not.toHaveBeenCalled()
  })

  it('names running out of credit apart from other failures', async () => {
    const app = await build()
    jevSays({ error: 'no credit' }, 402)
    expect((await post(app, body())).json().error.code).toBe('JEV_CREDITS')
    vi.restoreAllMocks()
    jevSays({ error: 'busy' }, 429)
    expect((await post(app, body())).json().error.code).toBe('JEV_BUSY')
    vi.restoreAllMocks()
    jevSays({ error: 'boom' }, 500)
    expect((await post(app, body())).statusCode).toBe(502)
    vi.restoreAllMocks()
    jevSays('not json')
    expect((await post(app, body())).statusCode).toBe(502)
    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down') as never)
    expect((await post(app, body())).json().error.code).toBe('JEV_UNAVAILABLE')
  })

  it('takes every decision the router can build: none, one session, the largest, a long paste', async () => {
    const app = await build()
    // A desk with no sessions offers only "new". The first ⌘B of a new user is exactly this.
    jevSays({ answers: { target: { choice: 'new', probabilities: { new: 1 } } } })
    const first = body({ questions: { target: { type: 'choice', instructions: 'Which session?', criteria: { new: 'None of them' } } } })
    expect((await post(app, first)).json().data.answers.target.choice).toBe('new')
    vi.restoreAllMocks()
    const spy = jevSays(good)
    expect((await post(app, largest())).statusCode).toBe(200)
    // 16,000 characters of pasted JSON: 21k once JSON escapes it, and still one message.
    const paste = '{"a":"b\n","c":[1,"\t"]}\n'.repeat(Math.floor(16_000 / 26))
    expect(paste.length).toBeLessThanOrEqual(16_000)
    expect(JSON.stringify(paste).length).toBeGreaterThan(17_000)
    expect((await post(app, largest(paste))).statusCode).toBe(200)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('refuses decisions bigger than the router builds', async () => {
    const spy = jevSays(good)
    const app = await build()
    const big = largest()
    expect((await post(app, { ...big, state: { message: 'x'.repeat(16_701), previous_message_went_to: 'n'.repeat(300) } })).statusCode).toBe(400)
    expect((await post(app, { ...big, state: { a: '1', b: '2', c: '3', d: '4', e: '5' } })).statusCode).toBe(400)
    const many = Object.fromEntries(Array.from({ length: 49 }, (_, i) => [`s${i}`, 'option']))
    expect((await post(app, body({ questions: { target: { type: 'choice', instructions: 'Which?', criteria: many } } }))).statusCode).toBe(400)
    expect((await post(app, body({ questions: { target: { type: 'choice', instructions: 'Which?', criteria: { s0: 'x'.repeat(641) } } } }))).statusCode).toBe(400)
    expect((await post(app, body({ questions: { target: { type: 'choice', instructions: 'x'.repeat(1_501), criteria: { s0: 'a' } } } }))).statusCode).toBe(400)
    expect((await post(app, body({ questions: { ...big.questions, extra: big.questions.topic } }))).statusCode).toBe(400)
    expect((await post(app, body({ questions: { target: { type: 'choice', instructions: 'Which?', criteria: {} } } }))).statusCode).toBe(400)
    expect((await post(app, { state: { message: 'hi' }, questions: {} })).statusCode).toBe(400)
    expect(spy).not.toHaveBeenCalled()
  })

  it('caps each account per minute, counted where it is told to count', async () => {
    jevSays(good)
    const count = vi.fn(localJevCounter())
    const app = await build(count)
    for (let i = 0; i < 30; i++) expect((await post(app, body())).statusCode).toBe(200)
    expect((await post(app, body())).statusCode).toBe(429)
    expect(count.mock.calls[0]![0]).toMatch(/^jev:m:u1:\d+$/)
  })

  it('stops everyone at the daily ceiling, as out of credit', async () => {
    const spy = jevSays(good)
    const app = await build(async (key) => (key.startsWith('jev:all:') ? 200_001 : 1))
    const res = await post(app, body())
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('JEV_CREDITS')
    expect(spy).not.toHaveBeenCalled()
  })

  it('still caps when the shared count fails, in this process', async () => {
    jevSays(good)
    vi.spyOn(logger, 'error').mockImplementation(() => logger)
    const app = await build(async () => { throw new Error('redis down') })
    for (let i = 0; i < 30; i++) expect((await post(app, body())).statusCode).toBe(200)
    expect((await post(app, body())).statusCode).toBe(429)
  })

  it('does not wait on a stalled shared count, and leaves it alone for a while after', async () => {
    jevSays(good)
    const error = vi.spyOn(logger, 'error').mockImplementation(() => logger)
    const stalled = vi.fn<JevCounter>(() => new Promise(() => {}))
    const app = await build(stalled)
    const started = Date.now()
    expect((await post(app, body())).statusCode).toBe(200)
    // One stalled count, then this process's own: well inside the CLI's 8 s.
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(stalled).toHaveBeenCalledTimes(1)
    expect((await post(app, body())).statusCode).toBe(200)
    expect(stalled).toHaveBeenCalledTimes(1)
    expect(error.mock.calls.filter(([line]) => String(line).includes('shared count failed'))).toHaveLength(1)
  })

  it('never logs the words', async () => {
    const lines: unknown[] = []
    for (const level of ['info', 'error', 'warn', 'debug'] as const) {
      vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => { lines.push(args); return logger })
    }
    const app = await build()
    const secret = { state: { message: 'the payroll export for ACME' }, questions: { target: { type: 'choice' as const, instructions: 'Which?', criteria: { s0: 'the ACME migration', new: 'none' } } } }
    jevSays(good)
    await post(app, secret)
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('down'))
    await post(app, secret)
    jevSays('not json')
    await post(app, secret)
    expect(lines.length).toBeGreaterThan(0)
    expect(JSON.stringify(lines)).not.toMatch(/ACME|payroll/)
  })
})

describe('jevAllowance', () => {
  it('allows 30 a minute and 1,000 a day per account, under the shared ceiling', async () => {
    let now = 0
    const count = localJevCounter(() => now)
    let allowed = 0
    // Thirty a minute for an hour is 1,800 asks; the day stops it at 1,000.
    for (let minute = 0; minute < 60; minute++, now += 60_000) {
      for (let i = 0; i < 31; i++) if (await jevAllowance(count, 'u1', now, 10_000) === null) allowed++
    }
    expect(allowed).toBe(1_000)
    expect(await jevAllowance(count, 'u2', now, 10_000)).toBeNull()
    expect(await jevAllowance(count, 'u1', now + 24 * 60 * 60_000, 10_000)).toBeNull()
  })

  it("never spends the shared ceiling on an account's refused asks", async () => {
    const count = localJevCounter(() => 0)
    for (let i = 0; i < 100; i++) await jevAllowance(count, 'loop', 0, 40)
    expect(await jevAllowance(count, 'u2', 0, 40)).toBeNull()
    for (let i = 0; i < 9; i++) await jevAllowance(count, `u${i + 3}`, 0, 40)
    expect(await jevAllowance(count, 'last', 0, 40)).toBe('everyone')
  })
})

describe('parseJevAnswers', () => {
  const { questions } = body()

  it('keeps only answers to questions asked, with options offered', () => {
    expect(parseJevAnswers({
      answers: {
        target: { choice: 's0', probabilities: { s0: 0.8, new: 0.2, s9: 0.5 } },
        topic: { choice: 'maybe', probabilities: { maybe: 1 } },
        extra: { choice: 'x', probabilities: { x: 1 } },
      },
    }, questions)).toEqual({ target: { choice: 's0', probabilities: { s0: 0.8, new: 0.2 } } })
  })

  it('is null when nothing usable came back', () => {
    expect(parseJevAnswers(null, questions)).toBeNull()
    expect(parseJevAnswers({ answers: 'no' }, questions)).toBeNull()
    expect(parseJevAnswers({ answers: { target: { choice: 's0' } } }, questions)).toBeNull()
  })
})
