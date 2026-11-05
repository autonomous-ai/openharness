/**
 * Whether the owner's relay answers a Harness Team account, and why not, in words its owner can act on (task #3106).
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, onTestFinished } from 'vitest'
import { startSubscriptionRelay } from '../lib/subscriptionRelay.js'
import { TEAM_RELAY_GUEST } from '../team/relay.js'
import { probeRelay, RELAY_REASONS } from './relayHealth.js'

async function relay(owner: { read: () => Promise<unknown>; refresh: () => Promise<null> }) {
  const upstream = createServer((req, res) => { res.writeHead(req.url === '/v1/models' ? 200 : 404); res.end('{"data":[]}') })
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
    expect(await probeRelay(grant)).toEqual({ ok: false, reason: RELAY_REASONS.ownerSignIn })
    expect(RELAY_REASONS.ownerSignIn).toMatch(/allow/)
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
