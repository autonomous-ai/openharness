import { describe, expect, it, vi } from 'vitest'
import { GuestHelperError, guestUserFor, type GuestAccounts, type SharedFolder } from '../lib/guestAccounts.js'
import type { GuestHelperState } from '../lib/guestHelperInstall.js'
import type { SubscriptionRelay } from '../lib/subscriptionRelay.js'
import { createGuestLaunches } from './guestLaunches.js'

const KIM = guestUserFor('kim@acme.io')
const LEE = guestUserFor('lee@acme.io')
const OLD = guestUserFor('old@acme.io')

// Never a real OS account, helper or relay: each is a fake the test controls.
function setup(over: {
  state?: GuestHelperState; ensure?: GuestAccounts['ensureGuest']; relay?: () => Promise<SubscriptionRelay>
  folders?: SharedFolder[]; share?: GuestAccounts['shareFolders']; guests?: string[]
} = {}) {
  const revoked: string[] = []
  let n = 0
  const relay: SubscriptionRelay = {
    port: 41234, url: 'http://127.0.0.1:41234',
    mintToken: vi.fn((guest: string) => `token-${guest}-${++n}`),
    revoke: vi.fn((guest: string) => { revoked.push(guest) }),
    close: vi.fn(async () => {}),
  }
  const accounts = {
    ensureGuest: over.ensure ?? vi.fn(async () => ({ user: KIM, home: `/g/${KIM}`, workspace: `/g/${KIM}/work` })),
    installGuestEngine: vi.fn(), removeGuest: vi.fn(), runCommand: vi.fn(),
    shareFolders: vi.fn(over.share ?? (async () => {})),
    guests: vi.fn(() => over.guests ?? []),
  }
  const startRelay = vi.fn(over.relay ?? (async () => relay))
  const lines: string[] = []
  const helperState = vi.fn(async () => over.state ?? 'ready')
  const launches = createGuestLaunches({ accounts: accounts as GuestAccounts, helperState, startRelay, lang: 'en_GB.UTF-8',
    helperPath: '/opt/helper', folders: () => over.folders ?? [], log: (line) => { lines.push(line) } })
  return { launches, relay, accounts, startRelay, revoked, lines, helperState }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const input = { email: 'kim@acme.io', engine: 'claude', bypassPermission: true }

describe('a guest\'s harness, as shared machines builds it', () => {
  it('runs as the guest\'s own account, in its workspace, on a token of its own; one relay for every harness', async () => {
    const { launches, accounts, startRelay, lines } = setup()
    const first = await launches.launch({ ...input, email: ' Kim@Acme.io ' })
    expect(accounts.ensureGuest).toHaveBeenCalledWith('kim@acme.io')
    expect(first).toEqual({ ok: true, workspace: `/g/${KIM}/work`, argv: expect.arrayContaining(['/opt/helper', KIM, 'claude']),
      env: expect.objectContaining({ ANTHROPIC_AUTH_TOKEN: 'token-kim@acme.io-1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:41234/claude', LANG: 'en_GB.UTF-8' }) })
    const second = await launches.launch({ ...input, engine: 'codex', bypassPermission: true, permissionFlags: ['--approve-for-me'], prompt: 'Fix the tests' })
    expect(second.ok && second.argv.slice(-2)).toEqual(['--approve-for-me', 'Fix the tests'])
    expect(second.ok && second.argv.at(-1)).toBe('Fix the tests')
    expect(second.ok && second.env.HARNESS_RELAY_TOKEN).toBe('token-kim@acme.io-2')
    expect(startRelay).toHaveBeenCalledTimes(1)
    expect(lines).toEqual([`launch · claude · ${KIM}`, `launch · codex · ${KIM}`])
  })

  it('works with the defaults: no log, the machine\'s helper and LANG, no folders', async () => {
    const relay = { port: 1, url: 'http://127.0.0.1:1', mintToken: () => 't', revoke: () => {}, close: async () => {} }
    const shareFolders = vi.fn(async () => {})
    const launches = createGuestLaunches({ accounts: { ensureGuest: async () => ({ user: KIM, home: '/g', workspace: '/g/work' }), shareFolders, guests: () => [KIM] } as unknown as GuestAccounts,
      helperState: async () => 'ready', startRelay: async () => relay })
    const launched = await launches.launch({ ...input, bypassPermission: false })
    expect(launched.ok && launched.argv[4]).toBe('/usr/local/libexec/harness/guest-helper')
    expect(launched.ok && launched.env.LANG).toBe('en_US.UTF-8')
    expect(shareFolders).toHaveBeenCalledWith(KIM, [])
    await launches.sync(() => false, [])
    await launches.stop()
  })

  it('starts nothing for a session whose guest it cannot name, or an engine whose subscription it cannot spend', async () => {
    const { launches, accounts } = setup()
    expect(await launches.launch({ ...input, email: ' ' })).toEqual({ ok: false, error: 'NOT_YOUR_HARNESS', detail: expect.any(String) })
    expect(await launches.launch({ ...input, engine: 'opencode' })).toEqual({ ok: false, error: 'GUEST_ENGINE_UNSUPPORTED', detail: expect.stringMatching(/Claude Code or Codex/) })
    expect(accounts.ensureGuest).not.toHaveBeenCalled()
  })

  it('asks the owner to turn guest access on, in words, until the helper is ready', async () => {
    for (const [state, words] of [['missing', /finished turning on sharing/], ['outdated', /after an update/], ['not-authorized', /sharing back on\./]] as const) {
      const { launches } = setup({ state })
      expect(await launches.launch(input)).toEqual({ ok: false, error: 'GUEST_HELPER_REQUIRED', detail: expect.stringMatching(words) })
    }
  })

  it('says what the helper said when the account could not be made', async () => {
    const { launches } = setup({ ensure: async () => { throw new GuestHelperError('GUEST_INVALID', 'not an email') } })
    expect(await launches.launch(input)).toEqual({ ok: false, error: 'GUEST_INVALID', detail: 'not an email' })
    const odd = setup({ ensure: async () => { throw new Error('boom') } })
    expect(await odd.launches.launch(input)).toEqual({ ok: false, error: 'GUEST_HELPER_FAILED', detail: 'The guest helper failed.' })
  })

  it('starts the relay again for the next harness when it could not start', async () => {
    let fails = true
    const relay = { port: 1, url: 'http://127.0.0.1:1', mintToken: () => 't', revoke: () => {}, close: async () => {} }
    const { launches, startRelay } = setup({ relay: async () => { if (fails) throw new Error('EADDRINUSE'); return relay } })
    expect(await launches.launch(input)).toEqual({ ok: false, error: 'GUEST_RELAY_FAILED', detail: expect.any(String) })
    await flush()
    fails = false
    expect((await launches.launch(input)).ok).toBe(true)
    expect(startRelay).toHaveBeenCalledTimes(2)
  })

  describe('the owner\'s shared folders', () => {
    const folders = [{ path: '/Users/dee/code/app', write: true }, { path: '/Users/dee/docs/', write: false }]

    it('are the guest\'s on every harness, which starts in one when the guest asks, and in its workspace otherwise', async () => {
      const { launches, accounts } = setup({ folders })
      const inApp = await launches.launch({ ...input, cwd: '/Users/dee/code/app/src/../src' })
      expect(accounts.shareFolders).toHaveBeenCalledWith(KIM, folders)
      expect(inApp).toMatchObject({ ok: true, workspace: '/Users/dee/code/app/src', argv: expect.arrayContaining(['--cwd', '/Users/dee/code/app/src']) })
      expect(await launches.launch({ ...input, cwd: '/Users/dee/docs' })).toMatchObject({ ok: true, workspace: '/Users/dee/docs' })
      // Not shared, a neighbour that only starts the same, relative, or absent: its workspace.
      for (const cwd of ['/Users/dee/secret', '/Users/dee/code/application', 'code/app', undefined]) {
        expect(await launches.launch({ ...input, ...(cwd ? { cwd } : {}) }), String(cwd)).toMatchObject({ ok: true, workspace: `/g/${KIM}/work` })
      }
    })

    it('a share that failed stops a harness meant for that folder, and no other', async () => {
      const { launches, lines } = setup({ folders, share: async () => { throw new GuestHelperError('GUEST_INVALID', 'no such folder: /Users/dee/docs') } })
      expect(await launches.launch({ ...input, cwd: '/Users/dee/docs' })).toEqual({ ok: false, error: 'GUEST_FOLDER_UNAVAILABLE',
        detail: 'That folder could not be shared with you: no such folder: /Users/dee/docs' })
      expect(await launches.launch(input)).toMatchObject({ ok: true, workspace: `/g/${KIM}/work` })
      expect(lines.filter((l) => l.startsWith('could not share'))).toHaveLength(2)
      const odd = setup({ folders, share: async () => { throw 'helper gone' } })
      expect(await odd.launches.launch({ ...input, cwd: '/Users/dee/docs' })).toMatchObject({ detail: 'That folder could not be shared with you: helper gone' })
    })

    it('are shared one at a time: two shares never read the helper\'s record at once', async () => {
      const order: string[] = []
      let release: () => void = () => {}
      const { launches } = setup({ folders, guests: [KIM, LEE], share: async (user) => {
        order.push(`start ${user}`)
        if (order.length === 1) await new Promise<void>((resolve) => { release = resolve })
        order.push(`end ${user}`)
      } })
      const launched = launches.launch(input)
      await flush()
      const synced = launches.sync(() => true, ['kim@acme.io', 'lee@acme.io'])
      await flush()
      expect(order).toEqual([`start ${KIM}`])
      release()
      await Promise.all([launched, synced])
      expect(order).toEqual([`start ${KIM}`, `end ${KIM}`, `start ${KIM}`, `end ${KIM}`, `start ${LEE}`, `end ${LEE}`])
    })
  })

  describe('sharing kept true', () => {
    it('revokes the tokens of whoever sharing no longer names, once', async () => {
      const { launches, revoked, lines } = setup()
      await launches.sync(() => false, []) // nothing minted, no relay: nothing to do
      await launches.launch(input)
      await launches.launch({ ...input, email: 'lee@acme.io' })
      await launches.sync((email) => email === 'lee@acme.io', [])
      await launches.sync((email) => email === 'lee@acme.io', [])
      await flush()
      expect(revoked).toEqual(['kim@acme.io'])
      expect(lines.at(-1)).toBe('revoked · kim@acme.io')
    })

    it('gives every guest still named the owner\'s folders, and takes them from every other account', async () => {
      const folders = [{ path: '/Users/dee/docs', write: false }]
      const { launches, accounts, lines } = setup({ folders, guests: [KIM, LEE, OLD] })
      await launches.sync((email) => email !== 'lee@acme.io', ['kim@acme.io', 'lee@acme.io'])
      expect(accounts.shareFolders.mock.calls).toEqual([[KIM, folders], [LEE, []], [OLD, []]])
      // One that fails is said, and the rest go on.
      accounts.shareFolders.mockRejectedValueOnce(new Error('EPERM')).mockRejectedValueOnce('gone')
      await launches.sync(() => true, ['kim@acme.io'])
      expect(lines.filter((l) => l.startsWith('could not share'))).toEqual([`could not share folders with ${KIM}: EPERM`, `could not share folders with ${LEE}: gone`])
    })

    it('asks nothing of the helper while there are no guests, or guest access is off', async () => {
      const none = setup({ folders: [{ path: '/x', write: false }] })
      await none.launches.sync(() => true, ['kim@acme.io'])
      expect(none.helperState).not.toHaveBeenCalled()
      const off = setup({ state: 'missing', guests: [KIM] })
      await off.launches.sync(() => true, ['kim@acme.io'])
      expect(off.accounts.shareFolders).not.toHaveBeenCalled()
    })
  })

  it('closes the relay when it stops; one that never started, or fails as it stops, has nothing to close', async () => {
    const { launches, relay } = setup()
    await launches.launch(input)
    await launches.stop()
    expect(relay.close).toHaveBeenCalledTimes(1)
    await launches.stop()
    const never = setup({ relay: async () => { throw new Error('no') } })
    await never.launches.launch(input)
    await never.launches.sync(() => false, [])
    await never.launches.stop()
    let fail: (error: Error) => void = () => {}
    const stopping = setup({ relay: () => new Promise((_resolve, reject) => { fail = reject }) })
    const launched = stopping.launches.launch(input)
    await flush()
    const stopped = stopping.launches.stop()
    fail(new Error('stopped'))
    await stopped
    expect((await launched).ok).toBe(false)
  })
})
