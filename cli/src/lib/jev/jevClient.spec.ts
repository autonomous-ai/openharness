// Jev through OpenRouter, as the router asks it: where the person's key is found, the one request it makes
// (an injected fetch here, never the network), how each refusal is named, and what of an answer is kept.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveOpenRouterKey } from '../openrouter.js'
import { createJevDecide, JevUnavailable, resolveJevKey, type AccountBackend, type JevChoice } from './jevClient.js'

// The env key and `ori login`'s file are openrouter.ts's to read, and its spec's to test: here they are none,
// unless a test says otherwise.
vi.mock('../openrouter.js', () => ({ resolveOpenRouterKey: vi.fn(async () => null) }))

let root: string
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'jev-client-')) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })
beforeEach(() => { vi.mocked(resolveOpenRouterKey).mockResolvedValue(null) })
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/** A credentials file with [text] in it. */
function credentials(text: string): string {
  const path = join(root, `credentials-${Math.random().toString(36).slice(2)}`)
  writeFileSync(path, text)
  return path
}

describe('the person\'s OpenRouter key', () => {
  it('is the one OpenRouter\'s own lookup finds (OPENROUTER_API_KEY, `ori login`), before any file of Jev\'s', async () => {
    vi.mocked(resolveOpenRouterKey).mockResolvedValue('sk-or-known')
    expect(await resolveJevKey({ TYPESAFE_CREDENTIALS: credentials('OPENROUTER_API_KEY=sk-or-file\n') })).toBe('sk-or-known')
  })

  it('is read from the credentials file the Store\'s Jev tools keep, in the shell forms they write', async () => {
    const read = (text: string) => resolveJevKey({ TYPESAFE_CREDENTIALS: credentials(text) })
    expect(await read('OPENROUTER_API_KEY=sk-or-bare\n')).toBe('sk-or-bare')
    expect(await read('# Jev\nOTHER=1\n  export OPENROUTER_API_KEY = "sk-or-double"  \n')).toBe('sk-or-double')
    expect(await read("export OPENROUTER_API_KEY='sk-or-single'")).toBe('sk-or-single')
    // An empty value is passed over for one further down; quotes that do not match are the key's own.
    expect(await read('OPENROUTER_API_KEY=\nOPENROUTER_API_KEY=""\nOPENROUTER_API_KEY=sk-or-later\n')).toBe('sk-or-later')
    expect(await read('OPENROUTER_API_KEY="sk-or-odd\'')).toBe('"sk-or-odd\'')
  })

  it('is none when the file has no key, or there is no file', async () => {
    expect(await resolveJevKey({ TYPESAFE_CREDENTIALS: credentials('ANTHROPIC_API_KEY=sk-ant\n# OPENROUTER_API_KEY=commented\n') })).toBeNull()
    expect(await resolveJevKey({ TYPESAFE_CREDENTIALS: join(root, 'missing') })).toBeNull()
  })

  it('reads $TYPESAFE_CREDENTIALS from this process by default', async () => {
    vi.stubEnv('TYPESAFE_CREDENTIALS', credentials('OPENROUTER_API_KEY=sk-or-from-env-path'))
    expect(await resolveJevKey()).toBe('sk-or-from-env-path')
  })

  it('looks in ~/.config/typesafe/credentials when nothing names another file', async () => {
    const home = mkdtempSync(join(root, 'home-'))
    vi.stubEnv('HOME', home)
    expect(await resolveJevKey({})).toBeNull()
    mkdirSync(join(home, '.config', 'typesafe'), { recursive: true })
    writeFileSync(join(home, '.config', 'typesafe', 'credentials'), 'OPENROUTER_API_KEY=sk-or-home\n')
    expect(await resolveJevKey({ TYPESAFE_CREDENTIALS: '' })).toBe('sk-or-home')
  })
})

describe('asking Jev', () => {
  const QUESTIONS: Record<string, JevChoice> = { target: { type: 'choice', instructions: 'Which?', criteria: { s0: 'billing', new: 'none' } } }
  const STATE = { message: 'why was the card charged twice' }
  const ANSWER = { answers: { target: { choice: 's0', probabilities: { s0: 0.9, new: 0.1 } } } }

  /** A fetch answering [reply] (a Response, or a body for a 200) and recording what it was asked. */
  function fetching(reply: Response | string = JSON.stringify(ANSWER)) {
    return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => (typeof reply === 'string' ? new Response(reply) : reply))
  }

  it('posts the state and the questions to the Decisions API with the person\'s key, and reads the answers', async () => {
    const fetch = fetching()
    const decide = createJevDecide({ key: async () => 'sk-or-fixture', fetch })
    expect(await decide(STATE, QUESTIONS)).toEqual(ANSWER.answers)
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions')
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer sk-or-fixture', 'Content-Type': 'application/json',
        'HTTP-Referer': 'https://harness.autonomous.ai', 'X-Title': 'Harness router',
      },
    })
    expect(JSON.parse(init!.body as string)).toEqual({ model: 'typesafe/jev-1.13', state: STATE, questions: QUESTIONS })
    // Bounded by its own timeout when the caller gives no signal.
    expect(init!.signal).toBeInstanceOf(AbortSignal)
    expect(init!.signal!.aborted).toBe(false)
  })

  it('gives up when the caller does', async () => {
    const fetch = fetching()
    const caller = new AbortController()
    await createJevDecide({ key: async () => 'sk-or-fixture', fetch })(STATE, QUESTIONS, caller.signal)
    const signal = fetch.mock.calls[0]![1]!.signal!
    expect(signal.aborted).toBe(false)
    caller.abort()
    expect(signal.aborted).toBe(true)
  })

  it('tells what each answer cost, as OpenRouter reports it, and nothing when it does not say', async () => {
    const costs: Array<[number, number]> = []
    const onCost = (usd: number, tokens: number) => { costs.push([usd, tokens]) }
    const priced = JSON.stringify({ answers: {}, usage: { cost: 0.000167, input_tokens: 3986 } })
    await createJevDecide({ key: async () => 'sk-or-fixture', fetch: fetching(priced), onCost })(STATE, QUESTIONS)
    const noTokens = JSON.stringify({ answers: {}, usage: { cost: 0.0001 } })
    await createJevDecide({ key: async () => 'sk-or-fixture', fetch: fetching(noTokens), onCost })(STATE, QUESTIONS)
    await createJevDecide({ key: async () => 'sk-or-fixture', fetch: fetching(JSON.stringify({ answers: {} })), onCost })(STATE, QUESTIONS)
    expect(costs).toEqual([[0.000167, 3986], [0.0001, 0]])
  })

  it('asks nothing without a key or a backend to ask', async () => {
    const fetch = fetching()
    const failure = await createJevDecide({ key: async () => null, fetch })(STATE, QUESTIONS).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(JevUnavailable)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({ code: 'NO_KEY', message: 'no OpenRouter key on this computer' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('finds the key and calls fetch itself by default', async () => {
    vi.mocked(resolveOpenRouterKey).mockResolvedValue('sk-or-default')
    const fetch = fetching()
    vi.stubGlobal('fetch', fetch)
    expect(await createJevDecide()(STATE, QUESTIONS)).toEqual(ANSWER.answers)
    expect((fetch.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-default')
    // And with no key anywhere, says so.
    vi.mocked(resolveOpenRouterKey).mockResolvedValue(null)
    vi.stubEnv('TYPESAFE_CREDENTIALS', join(root, 'missing'))
    await expect(createJevDecide()(STATE, QUESTIONS)).rejects.toMatchObject({ code: 'NO_KEY' })
  })

  it("prefers the person's own key over Harness's", async () => {
    const fetch = fetching()
    const backend = vi.fn<AccountBackend>(async () => ({ status: 200, body: {} }))
    await createJevDecide({ key: async () => 'sk-or-fixture', backend, fetch })(STATE, QUESTIONS)
    expect(backend).not.toHaveBeenCalled()
    expect(fetch.mock.calls[0]![0]).toBe('https://openrouter.ai/api/alpha/decisions')
  })

  it.each([
    [401, 'AUTH', 'OpenRouter refused the key'],
    [403, 'AUTH', 'OpenRouter refused the key'],
    [402, 'CREDITS', 'the OpenRouter account is out of credit'],
    [429, 'BUSY', 'OpenRouter is busy'],
    [500, 'UNAVAILABLE', 'OpenRouter answered 500'],
    [503, 'UNAVAILABLE', 'OpenRouter answered 503'],
  ])('names a %i as %s, and lets the body go', async (status, code, message) => {
    let cancelled = false
    const body = new ReadableStream({ cancel: () => { cancelled = true } })
    const decide = createJevDecide({ key: async () => 'sk-or-fixture', fetch: fetching(new Response(body, { status })) })
    await expect(decide(STATE, QUESTIONS)).rejects.toMatchObject({ code, message })
    expect(cancelled).toBe(true)
  })

  it('names a refusal with no body too', async () => {
    const decide = createJevDecide({ key: async () => 'sk-or-fixture', fetch: fetching(new Response(null, { status: 429 })) })
    await expect(decide(STATE, QUESTIONS)).rejects.toMatchObject({ code: 'BUSY' })
  })

  it('refuses an answer that is too long, not JSON, or has no answers', async () => {
    const ask = (body: string) => createJevDecide({ key: async () => 'sk-or-fixture', fetch: fetching(body) })(STATE, QUESTIONS)
    await expect(ask('x'.repeat(128_001))).rejects.toMatchObject({ code: 'INVALID', message: 'Jev answered too much' })
    // At the bound itself it is read.
    const padded = JSON.stringify({ ...ANSWER, pad: '' })
    expect(await ask(padded.replace('"pad":""', `"pad":"${'x'.repeat(128_000 - padded.length)}"`))).toEqual(ANSWER.answers)
    await expect(ask('{not json')).rejects.toMatchObject({ code: 'INVALID', message: 'Jev answered something that is not JSON' })
    for (const body of ['null', '{}', '{"answers":null}', '{"answers":"yes"}', '[]']) {
      await expect(ask(body), body).rejects.toMatchObject({ code: 'INVALID', message: 'Jev gave no answers' })
    }
  })

  it('keeps each answer that is a choice with probabilities, and drops the rest', async () => {
    const body = JSON.stringify({
      answers: {
        target: { choice: 's0', probabilities: { s0: 0.9, new: 0.1 } },
        empty: null,
        number: { choice: 3, probabilities: { s0: 1 } },
        bare: { choice: 's0' },
        flat: { choice: 's0', probabilities: 0.9 },
      },
    })
    const decide = createJevDecide({ key: async () => 'sk-or-fixture', fetch: fetching(body) })
    expect(await decide(STATE, QUESTIONS)).toEqual({ target: { choice: 's0', probabilities: { s0: 0.9, new: 0.1 } } })
    expect(await createJevDecide({ key: async () => 'sk-or-fixture', fetch: fetching('{"answers":{}}') })(STATE, QUESTIONS)).toEqual({})
  })
})

describe("asking Jev on Harness's key", () => {
  const QUESTIONS: Record<string, JevChoice> = { target: { type: 'choice', instructions: 'Which?', criteria: { s0: 'billing', new: 'none' } } }
  const STATE = { message: 'why was the card charged twice' }
  const ANSWERS = { target: { choice: 's0', probabilities: { s0: 0.9, new: 0.1 } } }
  const answering = (status: number, body: Record<string, unknown>) => vi.fn<AccountBackend>(async () => ({ status, body }))
  const decide = (backend: AccountBackend, onCost?: (usd: number, tokens: number) => void) =>
    createJevDecide({ key: async () => null, backend, onCost })

  it('posts the state and the questions to the backend the core signs, and reads the answers', async () => {
    const backend = answering(200, { success: true, data: { answers: ANSWERS } })
    const onCost = vi.fn()
    expect(await decide(backend, onCost)(STATE, QUESTIONS)).toEqual(ANSWERS)
    // No model and no key from here: the backend fixes both.
    expect(backend).toHaveBeenCalledWith('POST', '/api/route/jev', { state: STATE, questions: QUESTIONS })
    // Harness pays, so nothing is charged to the person.
    expect(onCost).not.toHaveBeenCalled()
  })

  it.each([
    [401, { success: false, error: { code: 'NOT_SIGNED_IN' } }, 'NO_KEY', 'sign in to Harness to use ⌘B'],
    [401, { success: false, error: { code: 'UNAUTHORIZED' } }, 'AUTH', 'Harness could not confirm your sign-in'],
    [403, {}, 'AUTH', 'Harness could not confirm your sign-in'],
    [502, { success: false, error: { code: 'AUTH_UNAVAILABLE' } }, 'UNAVAILABLE', 'Harness could not refresh your sign-in'],
    [429, { success: false, error: { code: 'RATE_LIMITED' } }, 'BUSY', 'too many ⌘B decisions, try again in a minute'],
    [503, { success: false, error: { code: 'JEV_CREDITS' } }, 'CREDITS', "Harness's Jev budget has run out"],
    [503, { success: false, error: { code: 'JEV_BUSY' } }, 'BUSY', 'Jev is busy'],
    [504, { success: false, error: { code: 'BACKEND_TIMEOUT' } }, 'UNAVAILABLE', "Harness's server did not answer in time"],
    [502, { success: false, error: { code: 'BACKEND_UNREACHABLE' } }, 'UNAVAILABLE', "Harness's server cannot be reached"],
    [503, { error: 'SERVICE_UNAVAILABLE' }, 'UNAVAILABLE', "Harness's server cannot be reached"],
    [503, { error: 'GATEWAY_UNAVAILABLE' }, 'UNAVAILABLE', "Harness's server cannot be reached"],
    [404, {}, 'UNAVAILABLE', "Harness's server cannot decide yet"],
    [503, { success: false, error: { code: 'JEV_NOT_CONFIGURED' } }, 'UNAVAILABLE', "Harness's server answered 503"],
    [502, { error: 7 }, 'UNAVAILABLE', "Harness's server answered 502"],
  ])('names a %i (%j) as %s', async (status, body, code, message) => {
    await expect(decide(answering(status, body))(STATE, QUESTIONS)).rejects.toMatchObject({ code, message })
  })

  it('refuses a reply with no answers', async () => {
    await expect(decide(answering(200, { success: true, data: {} }))(STATE, QUESTIONS)).rejects.toMatchObject({ code: 'INVALID' })
    await expect(decide(answering(200, {}))(STATE, QUESTIONS)).rejects.toMatchObject({ code: 'INVALID' })
  })

  it('stops waiting when the caller does: its slot is not held by a slow backend', async () => {
    const never = vi.fn<AccountBackend>(() => new Promise(() => {}))
    const caller = new AbortController()
    const asked = decide(never)(STATE, QUESTIONS, caller.signal)
    caller.abort(new Error('the window closed'))
    await expect(asked).rejects.toThrow('the window closed')
    // Already gone before it asked: nothing is asked, so nothing is paid for.
    const unasked = vi.fn<AccountBackend>(() => new Promise(() => {}))
    await expect(decide(unasked)(STATE, QUESTIONS, caller.signal)).rejects.toThrow('the window closed')
    expect(unasked).not.toHaveBeenCalled()
  })
})
