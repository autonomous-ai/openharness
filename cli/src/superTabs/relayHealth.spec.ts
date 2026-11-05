/**
 * Whether the owner's relay answers a Harness Team account, and why not, in words its owner can act on (task #3106).
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, onTestFinished } from 'vitest'
import { startSubscriptionRelay } from '../lib/subscriptionRelay.js'
import { TEAM_RELAY_GUEST } from '../team/relay.js'
import { probeRelay, RELAY_REASONS } from './relayHealth.js'

/** Anthropic's own error body for [status] (https://docs.anthropic.com/en/api/errors). */
const vendorError = (status: number) => JSON.stringify({ type: 'error', error: { type: ({ 401: 'authentication_error', 403: 'permission_error', 429: 'rate_limit_error', 529: 'overloaded_error' } as Record<number, string>)[status] ?? 'api_error', message: 'fixture' } })
async function relay(owner: { read: () => Promise<unknown>; refresh: () => Promise<null> }, status = 200) {
  const upstream = createServer((req, res) => { res.writeHead(req.url === '/v1/models' ? status : 404); res.end(status === 200 ? '{"data":[]}' : vendorError(status)) })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  onTestFinished(() => { upstream.closeAllConnections(); upstream.close() })
  const started = await startSubscriptionRelay({ owner: owner as never, upstream: { claude: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` } })
  onTestFinished(() => started.close())
  return { url: started.url, token: started.mintToken(TEAM_RELAY_GUEST) }
}
const signedIn = { read: async () => ({ provider: 'claude', accessToken: 'owner-fixture', expiresAt: null, accountId: null }), refresh: async () => null }

describe('asking the owner\'s relay whether it answers', () => {
  it('answers with the owner signed in', async () => {
    expect(await probeRelay(await relay(signedIn))).toEqual({ ok: true })
  })

  it('says the owner\'s sign-in cannot be read, and what the owner does, when the relay finds none (Kay\'s Mac)', async () => {
    const grant = await relay({ read: async () => null, refresh: async () => null })
    // Claude's alone: the relay may still serve the owner's Codex.
    expect(await probeRelay(grant)).toEqual({ ok: false, reason: RELAY_REASONS.ownerSignIn, claudeOnly: true })
    expect(RELAY_REASONS.ownerSignIn).toMatch(/allow/)
  })

  it('reads Anthropic busy or failing as the relay answering, never as the owner\'s sign-in (security reviews of #3098)', async () => {
    for (const status of [503, 529, 429, 500]) expect(await probeRelay(await relay(signedIn, status)), String(status)).toEqual({ ok: true })
  })

  // Review 1 of #3098, second read: the relay answers its own 502 for anything that throws in it, such as an owner sign-in
  // it refreshed and could not save back to the Keychain: every Team request then fails while the reading said ready.
  it('reads the relay\'s own 502 as not answering, for both engines', async () => {
    const throwing = { read: async () => { throw new Error('keychain write refused') }, refresh: async () => null }
    expect(await probeRelay(await relay(throwing))).toEqual({ ok: false, reason: RELAY_REASONS.vendor })
  })

  it('reads at most a few kilobytes of an error body, however much a port\'s holder sends', async () => {
    const endless = createServer((_req, res) => {
      res.writeHead(500)
      const chunk = 'x'.repeat(64 * 1024)
      const pump = () => { while (res.write(chunk)) { /* fill */ } }
      res.on('drain', pump); pump()
    })
    await new Promise<void>(resolve => endless.listen(0, '127.0.0.1', resolve))
    onTestFinished(() => { endless.closeAllConnections(); endless.close() })
    const started = Date.now()
    expect(await probeRelay({ url: `http://127.0.0.1:${(endless.address() as AddressInfo).port}`, token: 'any-token-aaaaaaaaaaaaaaaa' })).toEqual({ ok: false, reason: RELAY_REASONS.down })
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  // Review 2 of #3098, second read: once the owner's Harness has gone, whatever else listens on its port must not read ready.
  it('reads anything but a 2xx or Anthropic\'s own error as not answering: a redirect, a 404, an empty body', async () => {
    for (const [status, body] of [[302, ''], [404, ''], [500, 'oops'], [401, ''], [503, '{"type":"error"}']] as const) {
      const other = createServer((_req, res) => { res.writeHead(status, status === 302 ? { location: 'http://example.com/' } : {}); res.end(body) })
      await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve))
      onTestFinished(() => { other.closeAllConnections(); other.close() })
      expect(await probeRelay({ url: `http://127.0.0.1:${(other.address() as AddressInfo).port}`, token: 'any-token-aaaaaaaaaaaaaaaa' }), String(status))
        .toEqual({ ok: false, reason: RELAY_REASONS.down })
    }
  })

  it('says Anthropic refused the owner\'s Claude sign-in, as Claude\'s alone, apart from the relay refusing this account', async () => {
    expect(await probeRelay(await relay(signedIn, 401))).toEqual({ ok: false, reason: RELAY_REASONS.claudeRefused, claudeOnly: true })
  })

  it('says the token was refused, and that nothing listens, without the token in either', async () => {
    const grant = await relay(signedIn)
    const refused = await probeRelay({ url: grant.url, token: 'not-the-token-aaaaaaaaaaaa' })
    expect(refused).toEqual({ ok: false, reason: RELAY_REASONS.refused })
    const free = createServer()
    await new Promise<void>(resolve => free.listen(0, '127.0.0.1', resolve))
    const port = (free.address() as AddressInfo).port
    await new Promise<void>(resolve => free.close(() => resolve()))
    expect(await probeRelay({ url: `http://127.0.0.1:${port}`, token: grant.token })).toEqual({ ok: false, reason: RELAY_REASONS.down })
    for (const reason of Object.values(RELAY_REASONS)) expect(reason).not.toContain(grant.token)
  })
})
