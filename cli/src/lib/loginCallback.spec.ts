import { createServer, type Server } from 'http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { awaitLoginCallback, callbackAttribution, extractCallbackParams, LOGIN_TIMEOUT_MESSAGE } from './loginCallback.js'

const REDIRECT = 'http://127.0.0.1:4321/callback'

const servers: Server[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})

/**
 * Whether the timer armed with `ms` was cleared. Counted by handle rather than `vi.getTimerCount()`:
 * `fetch` in the neighbouring tests leaves undici's keep-alive tick (its own 1s `setTimeout`) alive in
 * this worker, and it re-arms itself whenever the fake clock is advanced — a count would see that.
 */
function timerCleared(ms: number): boolean {
  const setSpy = vi.mocked(setTimeout)
  const clearSpy = vi.mocked(clearTimeout)
  const call = setSpy.mock.calls.findIndex((args) => args[1] === ms)
  if (call < 0) return false
  const handle = setSpy.mock.results[call].value
  return clearSpy.mock.calls.some((args) => args[0] === handle)
}

function spyTimers(): void {
  vi.useFakeTimers()
  vi.spyOn(globalThis, 'setTimeout')
  vi.spyOn(globalThis, 'clearTimeout')
}

async function listening(): Promise<{ server: Server; redirectUri: string }> {
  const server = createServer()
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return { server, redirectUri: `http://127.0.0.1:${address.port}/callback` }
}

describe('awaitLoginCallback', () => {
  it('leaves no timer armed once the pasted URL wins the race (issue #112)', async () => {
    // Over SSH the browser cannot reach this loopback, so the user pastes the URL instead. The
    // five-minute timeout used to be cleared only by the loopback request handler — on this path it
    // stayed armed and ref'd, and `harness login` sat there after "✓ Signed in" until Ctrl+C.
    spyTimers()
    const server = createServer()
    const won = await awaitLoginCallback({
      server, redirectUri: REDIRECT, manual: Promise.resolve({ code: 'c', state: 's' }), timeoutMs: 5 * 60_000,
    })
    expect(won).toEqual({ code: 'c', state: 's' })
    expect(timerCleared(5 * 60_000)).toBe(true)
  })

  it('resolves from the loopback redirect, answers the browser, and clears the timer', async () => {
    const { server, redirectUri } = await listening()
    const pending = awaitLoginCallback({ server, redirectUri, manual: null, timeoutMs: 60_000 })
    const response = await fetch(`${redirectUri}?code=code_1&state=state_1`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<')
    await expect(pending).resolves.toEqual({ code: 'code_1', state: 'state_1' })
    // The race is over: the handler leaves with it, so a late redirect cannot reach a settled login.
    expect(server.listenerCount('request')).toBe(0)
  })

  it('sends a person back to whichever surface asked for the sign-in', async () => {
    // "return to the terminal" is a direction to a window the DESKTOP app never
    // opened — a person reads it and goes looking for something that is not
    // there (owner, 2026-09-23). The page is the last thing a sign-in says, and
    // it is the only place the caller can be named.
    const fromApp = await listening()
    const appPending = awaitLoginCallback({
      server: fromApp.server, redirectUri: fromApp.redirectUri,
      manual: null, timeoutMs: 60_000, entryPoint: 'desktop',
    })
    const appPage = await (await fetch(`${fromApp.redirectUri}?code=c&state=s`)).text()
    await appPending
    expect(appPage).toContain('Harness is signed in')
    expect(appPage).not.toContain('terminal')

    const fromCli = await listening()
    const cliPending = awaitLoginCallback({
      server: fromCli.server, redirectUri: fromCli.redirectUri,
      manual: null, timeoutMs: 60_000,
    })
    const cliPage = await (await fetch(`${fromCli.redirectUri}?code=c&state=s`)).text()
    await cliPending
    expect(cliPage).toContain('return to the terminal')
  })

  it('brings back where the sign-in came from, as auth.autonomous.ai appended it to the redirect', async () => {
    // The desktop app signs in through this loopback. Before, only code/state were read, so a person who
    // downloaded the app from a tagged autonomous.ai/harness-app link was never attributed (prod E2E, 2026-10-06).
    const { server, redirectUri } = await listening()
    const pending = awaitLoginCallback({ server, redirectUri, manual: null, timeoutMs: 60_000 })
    await fetch(`${redirectUri}?code=c&iss=https%3A%2F%2Fauth.autonomous.ai&rid=r1&state=s&utm_campaign=launch&utm_content=&utm_source=app&utm_term=`)
    await expect(pending).resolves.toEqual({
      code: 'c',
      state: 's',
      attribution: { rid: 'r1', utm_campaign: 'launch', utm_source: 'app' },
    })
  })

  it('carries no attribution for an untagged sign-in', async () => {
    const { server, redirectUri } = await listening()
    const pending = awaitLoginCallback({ server, redirectUri, manual: null, timeoutMs: 60_000 })
    await fetch(`${redirectUri}?code=c&state=s`)
    expect(await pending).not.toHaveProperty('attribution')
  })

  it('rejects on an error redirect, with a 400 for the browser', async () => {
    const { server, redirectUri } = await listening()
    // The rejection lands before the browser's response is read, so the expectation is attached first.
    const rejected = expect(awaitLoginCallback({ server, redirectUri, manual: null, timeoutMs: 60_000 }))
      .rejects.toThrow('SSO login failed: access_denied')
    const response = await fetch(`${redirectUri}?error=access_denied`)
    expect(response.status).toBe(400)
    await rejected
  })

  it('rejects with the TIMEOUT message when nobody answers, and the timer never keeps the loop alive', async () => {
    spyTimers()
    const server = createServer()
    const rejected = expect(awaitLoginCallback({ server, redirectUri: REDIRECT, manual: null, timeoutMs: 1_000 }))
      .rejects.toThrow(LOGIN_TIMEOUT_MESSAGE)
    expect(timerCleared(1_000)).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    await rejected
    expect(timerCleared(1_000)).toBe(true)
  })
})

describe('extractCallbackParams', () => {
  it('reads the full URL, a bare query string, and a code=…&state=… pair alike', () => {
    expect(extractCallbackParams(`${REDIRECT}?code=a&state=b`, REDIRECT)).toEqual({ code: 'a', state: 'b', error: null })
    expect(extractCallbackParams('?code=a&state=b', REDIRECT)).toEqual({ code: 'a', state: 'b', error: null })
    expect(extractCallbackParams('code=a&state=b', REDIRECT)).toEqual({ code: 'a', state: 'b', error: null })
    expect(extractCallbackParams(`${REDIRECT}?error=denied`, REDIRECT)).toEqual({ code: null, state: null, error: 'denied' })
    expect(extractCallbackParams('hello', REDIRECT)).toEqual({ code: null, state: null, error: null })
  })

  it('survives a paste that is not a URL at all instead of throwing out of the prompt', () => {
    expect(extractCallbackParams('http://', REDIRECT)).toEqual({ code: null, state: null, error: null })
    // The raw query-string fallback reads what it can; without a `code` the prompt just asks again.
    expect(extractCallbackParams('http://ex ample/?code=a&state=b', REDIRECT)).toMatchObject({ code: null })
  })

  it('reads the tags from a pasted URL or query string too', () => {
    // Over SSH the person pastes the URL the browser landed on; it carries the same tags.
    expect(extractCallbackParams(`${REDIRECT}?code=a&state=b&rid=r1&utm_medium=email`, REDIRECT))
      .toEqual({ code: 'a', state: 'b', error: null, attribution: { rid: 'r1', utm_medium: 'email' } })
    expect(extractCallbackParams('code=a&state=b&utm_source=app', REDIRECT))
      .toEqual({ code: 'a', state: 'b', error: null, attribution: { utm_source: 'app' } })
  })
})

describe('callbackAttribution', () => {
  it('keeps only the utm keys and rid, trimmed', () => {
    expect(callbackAttribution(new URLSearchParams('utm_source=%20app%20&role=admin&iss=x&rid=r1')))
      .toEqual({ utm_source: 'app', rid: 'r1' })
  })

  it('is absent rather than empty when nothing usable was sent', () => {
    expect(callbackAttribution(new URLSearchParams('code=a&state=b'))).toBeUndefined()
    expect(callbackAttribution(new URLSearchParams('utm_term=&utm_content=%20%20'))).toBeUndefined()
  })
})
