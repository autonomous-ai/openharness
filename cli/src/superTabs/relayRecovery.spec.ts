/**
 * A Harness Team agent stranded on a relay grant its owner's daemon no longer answers (task #3106). On daniel-pc, 2026-11-05,
 * the CLI 0.5.43 update restarted the owner's daemon at 11:33, its relay came back at a new address and token, and every
 * Team agent already running failed each model request until someone restarted it. Agents started after 11:33 worked.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { startSubscriptionRelay } from '../lib/subscriptionRelay.js'
import type { TeamConfig } from '../team/config.js'
import { TEAM_RELAY_GUEST, teamRelayLaunch, type TeamRelayGrant } from '../team/relay.js'
import { RECOVER_AFTER_MS, RELAY_RESTORED, RelayRecovery, relayAnswers, type RelayRecoveryDeps } from './relayRecovery.js'

const OLD: TeamRelayGrant = { url: 'http://127.0.0.1:50001', token: 'old-token-aaaaaaaaaaaaaaaaaaaa' }
const NEW: TeamRelayGrant = { url: 'http://127.0.0.1:50002', token: 'new-token-bbbbbbbbbbbbbbbbbbbb' }

function setup(over: Partial<RelayRecoveryDeps> = {}) {
  let clock = 1_000_000
  let grant: TeamRelayGrant | null = NEW
  const deps = {
    grant: vi.fn(() => grant),
    answers: vi.fn(async (_g: TeamRelayGrant) => true),
    restart: vi.fn(async (_h: string) => ({ ok: true as const })),
    input: vi.fn(async (_h: string, _t: string) => ({ ok: true as const })),
    now: () => clock,
    log: vi.fn(),
    ...over,
  }
  const recovery = new RelayRecovery(deps)
  const failingFor = (ms: number) => ({ failingSince: clock - ms, waiting: false })
  const clear = { failingSince: null, waiting: false }
  return { deps, recovery, failingFor, clear, wait: (ms: number) => { clock += ms }, publish: (next: TeamRelayGrant | null) => { grant = next } }
}

describe('a Team agent whose model keeps failing on its owner\'s relay', () => {
  it('is restarted onto the current grant once its model has failed for a minute, and told to carry on once it is back', async () => {
    const t = setup()
    await t.recovery.seen('h1', 'claude', t.failingFor(RECOVER_AFTER_MS - 1))
    expect(t.deps.restart).not.toHaveBeenCalled()
    await t.recovery.seen('h1', 'claude', t.failingFor(RECOVER_AFTER_MS))
    expect(t.deps.answers).toHaveBeenCalledWith(NEW)
    expect(t.deps.restart).toHaveBeenCalledExactlyOnceWith('h1')
    // The relaunch is still coming up: nothing is typed on the read right after it.
    await t.recovery.seen('h1', 'claude', t.clear)
    expect(t.deps.input).not.toHaveBeenCalled()
    t.wait(15_000)
    await t.recovery.seen('h1', 'claude', t.clear)
    expect(t.deps.input).toHaveBeenCalledExactlyOnceWith('h1', RELAY_RESTORED)
    t.wait(15_000)
    await t.recovery.seen('h1', 'claude', t.clear)
    expect(t.deps.input).toHaveBeenCalledOnce()
  })

  it('is restarted at most once per grant: still failing on the same grant, it is left for its model alert', async () => {
    const t = setup()
    await t.recovery.seen('h1', 'claude', t.failingFor(RECOVER_AFTER_MS))
    for (let i = 0; i < 10; i++) { t.wait(15_000); await t.recovery.seen('h1', 'claude', t.failingFor(RECOVER_AFTER_MS + i * 15_000)) }
    expect(t.deps.restart).toHaveBeenCalledOnce()
    // Never told to carry on while its model still fails.
    expect(t.deps.input).not.toHaveBeenCalled()
    // A grant published since (the owner's daemon restarted again) is worth one more.
    t.publish(OLD)
    await t.recovery.seen('h1', 'claude', t.failingFor(RECOVER_AFTER_MS * 20))
    expect(t.deps.restart).toHaveBeenCalledTimes(2)
  })

  it('is not restarted when the current grant does not answer either: a relaunch would fail the same way', async () => {
    const t = setup({ answers: vi.fn(async () => false) })
    await t.recovery.seen('h1', 'claude', t.failingFor(RECOVER_AFTER_MS))
    expect(t.deps.restart).not.toHaveBeenCalled()
    // Asked again on a later read, once the relay may answer.
    t.wait(15_000)
    vi.mocked(t.deps.answers).mockResolvedValue(true)
    await t.recovery.seen('h1', 'claude', t.failingFor(RECOVER_AFTER_MS + 15_000))
    expect(t.deps.restart).toHaveBeenCalledOnce()
  })

  it('does nothing without a published grant (any daemon but a Team account\'s), or for an engine the relay does not serve', async () => {
    const t = setup()
    t.publish(null)
    await t.recovery.seen('h1', 'claude', t.failingFor(RECOVER_AFTER_MS))
    t.publish(NEW)
    await t.recovery.seen('h2', 'opencode', t.failingFor(RECOVER_AFTER_MS))
    await t.recovery.seen('h3', undefined, t.failingFor(RECOVER_AFTER_MS))
    expect(t.deps.answers).not.toHaveBeenCalled()
    expect(t.deps.restart).not.toHaveBeenCalled()
  })

  it('never types its continue into an open prompt: it waits for the prompt to go', async () => {
    const t = setup()
    await t.recovery.seen('h1', 'codex', t.failingFor(RECOVER_AFTER_MS))
    t.wait(15_000)
    await t.recovery.seen('h1', 'codex', { failingSince: null, waiting: true })
    expect(t.deps.input).not.toHaveBeenCalled()
    t.wait(15_000)
    await t.recovery.seen('h1', 'codex', t.clear)
    expect(t.deps.input).toHaveBeenCalledExactlyOnceWith('h1', RELAY_RESTORED)
  })

  it('tries a failed restart again only with a new grant, and says why it failed without the token', async () => {
    const t = setup({ restart: vi.fn(async () => ({ ok: false as const, error: 'RESTART_FAILED' })) })
    await t.recovery.seen('h1', 'claude', t.failingFor(RECOVER_AFTER_MS))
    t.wait(15_000)
    await t.recovery.seen('h1', 'claude', t.failingFor(RECOVER_AFTER_MS + 15_000))
    expect(t.deps.restart).toHaveBeenCalledOnce()
    expect(t.deps.input).not.toHaveBeenCalled()
    const logged = vi.mocked(t.deps.log).mock.calls.map(c => String(c[0])).join('\n')
    expect(logged).toContain('RESTART_FAILED')
    expect(logged).not.toContain(NEW.token)
  })

  it('forgets agents that are no longer here', async () => {
    const t = setup()
    await t.recovery.seen('h1', 'claude', t.failingFor(RECOVER_AFTER_MS))
    t.recovery.keep(new Set())
    t.wait(15_000)
    await t.recovery.seen('h1', 'claude', t.failingFor(RECOVER_AFTER_MS))
    expect(t.deps.restart).toHaveBeenCalledTimes(2)
  })
})

describe('the owner\'s real relay across a restart that moved it', () => {
  const config = { user: 'harnessteam', owner: 'owner', ownerHome: '/Users/owner' } as TeamConfig
  const owner = { read: async () => ({ provider: 'claude' as const, accessToken: 'owner-fixture', expiresAt: null, accountId: null }), refresh: async () => null }

  it('refuses the stranded grant, answers the current one, and a relaunch reads the current one', async () => {
    const upstream = createServer((req, res) => { res.writeHead(req.url === '/v1/models' ? 200 : 404); res.end('{"data":[]}') })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    onTestFinished(() => { upstream.closeAllConnections(); upstream.close() })
    const claude = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`

    // Before the update: the agent launched with this grant.
    const before = await startSubscriptionRelay({ owner, upstream: { claude } })
    const stranded = { url: before.url, token: before.mintToken(TEAM_RELAY_GUEST) }
    expect(await relayAnswers(stranded)).toBe(true)
    await before.close()
    // After it: a new address and a new token (its kept port was not free in time).
    const after = await startSubscriptionRelay({ owner, upstream: { claude } })
    onTestFinished(() => after.close())
    const current = { url: after.url, token: after.mintToken(TEAM_RELAY_GUEST) }
    expect(current.url).not.toBe(stranded.url)
    expect(await relayAnswers(stranded)).toBe(false)
    // The old token at the new address is refused too.
    expect(await relayAnswers({ url: current.url, token: stranded.token })).toBe(false)
    expect(await relayAnswers(current)).toBe(true)

    // The restart relaunches through the same path as a first launch: it reads the grant published now.
    const relaunch = await teamRelayLaunch('claude', { team: () => true, config: () => config, signedIn: async () => false,
      read: () => current, onboarded: () => {}, codexHome: async () => null })
    expect(relaunch).toEqual({ env: { ANTHROPIC_BASE_URL: `${current.url}/claude`, ANTHROPIC_AUTH_TOKEN: current.token }, args: [] })
  })
})
