import { afterEach, describe, expect, it, vi } from 'vitest'
import { CALLBACK_FOR_MS, CALLBACKS_PER_PEER, CALLBACKS_MAX, BROWSER_URL_MAX, BROWSER_SOURCES_MAX, CALLBACK_WAIT_MS, createBrowser, type BrowserDeps } from './browser.js'
import { createAgentLife } from '../core/agentLife.js'
import type { RegisteredSession } from '../lib/registry.js'

afterEach(() => vi.useRealTimers())

/** A page opened from a harness's pane goes to the phone that typed there last; the sign-in it returns from
 *  is replayed to the program waiting on this computer, and nothing else is. */
const CLAUDE = 'https://claude.com/cai/oauth/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A35391%2Fcallback&state=s1'

function setup(over: Partial<BrowserDeps> = {}) {
  let now = 1_000
  const deps: BrowserDeps = {
    agentOfPane: vi.fn((pane: string) => (pane === '%7' ? 'a1' : undefined)),
    sendTo: vi.fn(() => true),
    isLocal: vi.fn((connId: string) => connId.startsWith('local:')),
    // A phone's key: `phone-1` reconnects as `phone-1b`.
    who: (connId: string) => connId.replace(/b$/, ''),
    replay: vi.fn(async () => ({ status: 200, location: null })),
    now: () => now,
    log: vi.fn(),
    ...over,
  }
  const browser = createBrowser(deps)
  return { deps, browser, later: (ms: number) => { now += ms } }
}

describe('browser_open', () => {
  it.each(['stopped', 'purged', 'taken'] as const)('revokes a routing source and its pending callback when %s', async kind => {
    const life = createAgentLife({ live: () => [], notify: () => true, hears: {} })
    const { browser, deps } = setup({ follow: life.follow })
    life.input({ agentId: 'a1' } as RegisteredSession, { connId: 'phone-1', kind: 'phone' })
    await browser.open({ pane: '%7', url: CLAUDE })
    if (kind === 'stopped') life.stopped('a1')
    if (kind === 'purged') life.purged('a1', [])
    if (kind === 'taken') life.taken('a1', { agentId: 'replacement' } as RegisteredSession)
    expect(await browser.callback({ url: 'http://localhost:35391/callback' }, 'phone-1')).toEqual({ error: 'NOT_EXPECTED' })
    expect(await browser.open({ pane: '%7', url: CLAUDE })).toEqual({ handled: false })
    expect(deps.replay).not.toHaveBeenCalled()
    browser.stop()
  })

  it('refuses oversized source facts and encoded URLs, and releases failed delivery reservations', async () => {
    const { browser, deps } = setup()
    browser.typed('a'.repeat(129), { connId: 'phone-1', kind: 'phone' })
    browser.typed('a1', { connId: 'p'.repeat(257), kind: 'phone' })
    expect(await browser.open({ pane: '%7', url: CLAUDE })).toEqual({ handled: false })
    browser.typed('a1', { connId: 'phone-1', kind: 'phone' })
    expect(await browser.open({ pane: '%7', url: 'https://x.test/' + '界'.repeat(2_000) })).toEqual({ handled: false })
    expect(await browser.callback({ url: 'http://localhost:35391/' + '界'.repeat(2_000) }, 'phone-1')).toEqual({ error: 'BAD_URL' })
    vi.mocked(deps.sendTo).mockReturnValue(false)
    for (let n = 0; n < CALLBACKS_PER_PEER + 1; n++) expect(await browser.open({ pane: '%7', url: CLAUDE })).toEqual({ handled: false })
    expect(await browser.open({ pane: '%7', url: 'https://x.test/' })).toEqual({ handled: false })
    vi.mocked(deps.sendTo).mockReturnValue(true)
    expect(await browser.open({ pane: '%7', url: CLAUDE })).toEqual({ handled: true })
    browser.stop()
    browser.typed('a1', { connId: 'phone-1', kind: 'phone' })
  })

  it('uses shared terminal facts, ignores composer-only facts, and revokes callbacks when the agent ends', async () => {
    const life = createAgentLife({ live: () => [], notify: () => true, hears: {} })
    const { browser, deps } = setup({ follow: life.follow })
    const agent = { agentId: 'a1' } as RegisteredSession
    life.running(agent)
    life.input(agent, { connId: 'phone-1', kind: 'phone' })
    life.input(agent)
    const asker = { local: true, owner: true }
    expect(await browser.request({ frame: 'browser_open', payload: { pane: '%7', url: CLAUDE } }, asker)).toEqual({ handled: true })
    life.ended('a1')
    expect(await browser.callback({ url: 'http://localhost:35391/callback?code=x' }, 'phone-1')).toEqual({ error: 'NOT_EXPECTED' })
    expect(deps.replay).not.toHaveBeenCalled()
    browser.stop()
    life.input(agent, { connId: 'phone-1', kind: 'phone' })
    expect(await browser.open({ pane: '%7', url: CLAUDE })).toEqual({ handled: false })
  })

  it('keeps local/owner provenance outside payloads and preserves callback refusals', async () => {
    const { browser, deps } = setup()
    expect(await browser.request({ frame: 'browser_open', payload: { local: true, pane: '%7', url: CLAUDE } }, { local: false, owner: true })).toEqual({ error: 'LOCAL_ONLY' })
    for (const asker of [{ local: false, owner: false }, { local: false, owner: true, guest: 'guest' }]) {
      expect(await browser.request({ frame: 'browser_callback', payload: { owner: true } }, asker)).toEqual({ error: 'OWNER_REQUIRED' })
    }
    expect(await browser.request({ frame: 'browser_callback' }, { local: true, owner: true })).toEqual({ error: 'BAD_URL' })
    expect(await browser.request({ frame: 'unknown', payload: [] }, { local: true, owner: true })).toEqual({ error: 'UNKNOWN_REQUEST' })
    expect(deps.agentOfPane).not.toHaveBeenCalled()
  })

  it('rejects oversized inputs and unavailable pane/peer facts without sending a page', async () => {
    const { browser, deps } = setup({ who: () => null })
    browser.typed('a1', { connId: 'phone-1', kind: 'phone' })
    expect(await browser.open({ pane: '%7', url: 'https://x.test/' + 'x'.repeat(BROWSER_URL_MAX) })).toEqual({ handled: false })
    expect(await browser.open({ pane: 'p'.repeat(257), url: CLAUDE })).toEqual({ handled: false })
    expect(await browser.open({ pane: '%7', url: CLAUDE })).toEqual({ handled: false })
    vi.mocked(deps.agentOfPane).mockRejectedValueOnce(new Error('private lookup error'))
    expect(await browser.open({ pane: '%7', url: CLAUDE })).toEqual({ handled: false })
    expect(await browser.callback({ url: 'x'.repeat(BROWSER_URL_MAX + 1) }, 'phone-1')).toEqual({ error: 'BAD_URL' })
    expect(deps.sendTo).not.toHaveBeenCalled()
    expect(JSON.stringify(vi.mocked(deps.log).mock.calls)).not.toContain('private lookup error')
  })

  it('bounds routing sources and all pending callbacks, then admits again after expiry or agent end', async () => {
    const { browser, deps, later } = setup({ agentOfPane: pane => pane })
    for (let n = 0; n < BROWSER_SOURCES_MAX; n++) browser.typed(`a${n}`, { connId: `p${n}`, kind: 'phone' })
    browser.typed('over', { connId: 'phone', kind: 'phone' })
    expect(await browser.open({ pane: 'over', url: CLAUDE })).toEqual({ handled: false })
    for (let n = 0; n < CALLBACKS_MAX; n++) expect(await browser.open({ pane: `a${n}`, url: CLAUDE })).toEqual({ handled: true })
    expect(await browser.open({ pane: 'a300', url: CLAUDE })).toEqual({ handled: false })
    later(CALLBACK_FOR_MS + 1)
    expect(await browser.open({ pane: 'a300', url: CLAUDE })).toEqual({ handled: true })
    browser.ended('a0')
    browser.typed('over', { connId: 'phone', kind: 'phone' })
    expect(await browser.open({ pane: 'over', url: CLAUDE })).toEqual({ handled: true })
    expect(deps.sendTo).toHaveBeenCalledTimes(CALLBACKS_MAX + 2)
  })

  it('bounds active callbacks and cancels requests at their deadline', async () => {
    vi.useFakeTimers()
    const replay = vi.fn((_url: string, signal: AbortSignal) => new Promise<{ status: number; location: string | null }>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('private aborted address')), { once: true })
    }))
    const { browser, deps } = setup({ replay })
    browser.typed('a1', { connId: 'phone-1', kind: 'phone' })
    for (let n = 0; n < 5; n++) await browser.open({ pane: '%7', url: CLAUDE })
    const calls = Array.from({ length: 4 }, () => browser.callback({ url: 'http://localhost:35391/callback?code=x' }, 'phone-1'))
    expect(await browser.callback({ url: 'http://localhost:35391/callback?code=x' }, 'phone-1')).toEqual({ error: 'NOT_DELIVERED' })
    await vi.advanceTimersByTimeAsync(CALLBACK_WAIT_MS)
    expect(await Promise.all(calls)).toEqual(calls.map(() => ({ error: 'NOT_DELIVERED' })))
    expect(replay).toHaveBeenCalledTimes(4)
    expect(JSON.stringify(vi.mocked(deps.log).mock.calls)).not.toContain('private aborted address')
  })

  it('falls back locally before sending a page whose callback cannot be retained', async () => {
    const { browser, deps } = setup()
    browser.typed('a1', { connId: 'phone-1', kind: 'phone' })
    // The bound is part of admission, before a remote page is sent.
    for (let n = 0; n < 8; n++) expect(await browser.open({ pane: '%7', url: CLAUDE })).toEqual({ handled: true })
    expect(await browser.open({ pane: '%7', url: CLAUDE })).toEqual({ handled: false })
    expect(deps.sendTo).toHaveBeenCalledTimes(8)
    expect(CALLBACKS_PER_PEER).toBe(8)
  })

  it('does not send a page after the controlling source changes during its pane lookup', async () => {
    let answer!: (agent: string) => void
    const { browser, deps } = setup({ agentOfPane: () => new Promise(resolve => { answer = resolve }) })
    browser.typed('a1', { connId: 'phone-1', kind: 'phone' })
    const opening = browser.open({ pane: '%7', url: CLAUDE })
    browser.typed('a1', { connId: 'desktop', kind: 'desktop' })
    answer('a1')
    expect(await opening).toEqual({ handled: false })
    expect(deps.sendTo).not.toHaveBeenCalled()
  })

  it('stops later callback effects after the gateway or request ends and logs no callback content', async () => {
    const { browser, deps } = setup({ replay: vi.fn().mockRejectedValue(new Error('synthetic-private-code')) })
    browser.typed('a1', { connId: 'phone-1', kind: 'phone' })
    await browser.open({ pane: '%7', url: CLAUDE })
    expect(await browser.callback({ url: 'http://localhost:35391/callback?code=synthetic-private-code' }, 'phone-1'))
      .toEqual({ error: 'NOT_DELIVERED' })
    expect(JSON.stringify(vi.mocked(deps.log).mock.calls)).not.toContain('synthetic-private-code')
    await browser.open({ pane: '%7', url: CLAUDE })
    browser.stop()
    expect(await browser.callback({ url: 'http://localhost:35391/callback?code=x' }, 'phone-1')).toEqual({ error: 'NOT_EXPECTED' })
    expect(await browser.open({ pane: '%7', url: CLAUDE })).toEqual({ handled: false })
  })
  it('goes to the phone that typed last, sealed to it', async () => {
    const { deps, browser } = setup()
    browser.typed('a1', { connId: 'phone-1', kind: 'phone' })
    expect(await browser.open({ pane: '%7', url: CLAUDE })).toEqual({ handled: true })
    expect(deps.sendTo).toHaveBeenCalledWith('phone-1', 'browser_open', { agentId: 'a1', url: CLAUDE })
  })

  it('stays on this computer when the person typed here, from a desktop, or nobody typed yet', async () => {
    const { deps, browser } = setup()
    expect(await browser.open({ pane: '%7', url: CLAUDE })).toEqual({ handled: false })
    browser.typed('a1', { connId: 'local:w', kind: 'phone' })
    expect(await browser.open({ pane: '%7', url: CLAUDE })).toEqual({ handled: false })
    browser.typed('a1', { connId: 'remote-desk', kind: 'desktop' })
    expect(await browser.open({ pane: '%7', url: CLAUDE })).toEqual({ handled: false })
    browser.typed('a1', { connId: 'remote-old', kind: null })
    expect(await browser.open({ pane: '%7', url: CLAUDE })).toEqual({ handled: false })
    expect(deps.sendTo).not.toHaveBeenCalled()
  })

  it('stays here for a pane no harness owns, a page that is not one, or a phone gone', async () => {
    const { browser } = setup({ sendTo: vi.fn(() => false) })
    browser.typed('a1', { connId: 'phone-1', kind: 'phone' })
    expect(await browser.open({ pane: '%9', url: CLAUDE })).toEqual({ handled: false })
    expect(await browser.open({ url: CLAUDE })).toEqual({ handled: false })
    expect(await browser.open({ pane: '%7', url: 'not a url' })).toEqual({ handled: false })
    expect(await browser.open({ pane: '%7' })).toEqual({ handled: false })
    expect(await browser.open({ pane: '%7', url: 'file:///etc/passwd' })).toEqual({ handled: false })
    expect(await browser.open({ pane: '%7', url: CLAUDE })).toEqual({ handled: false })
  })
})

describe('browser_callback', () => {
  it('keeps one deadline across redirects and returns the original callback status', async () => {
    vi.useFakeTimers()
    const replay = vi.fn((_url: string, signal: AbortSignal) => new Promise<{ status: number; location: string | null }>((resolve, reject) => {
      const timer = setTimeout(() => resolve({ status: 302, location: '/next' }), CALLBACK_WAIT_MS - 1)
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
    }))
    const { browser, deps } = setup({ replay })
    browser.typed('a1', { connId: 'phone-1', kind: 'phone' })
    await browser.open({ pane: '%7', url: CLAUDE })
    const call = browser.callback({ url: 'http://localhost:35391/callback' }, 'phone-1')
    await vi.advanceTimersByTimeAsync(CALLBACK_WAIT_MS - 1)
    expect(replay).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(await call).toEqual({ ok: true, status: 302 })
    expect(deps.log).toHaveBeenCalledWith('[browser] CALLBACK_PAGE_NOT_DELIVERED')
  })

  it('does not follow a redirect whose encoded URL exceeds the request bound', async () => {
    const { browser, deps } = setup({ replay: vi.fn().mockResolvedValue({ status: 302, location: '/' + '界'.repeat(2_000) }) })
    browser.typed('a1', { connId: 'phone-1', kind: 'phone' })
    await browser.open({ pane: '%7', url: CLAUDE })
    expect(await browser.callback({ url: 'http://localhost:35391/callback' }, 'phone-1')).toEqual({ ok: true, status: 302 })
    expect(deps.replay).toHaveBeenCalledOnce()
    expect(deps.log).toHaveBeenCalledWith('[browser] CALLBACK_PAGE_NOT_DELIVERED')
  })

  it.each(['request', 'agent', 'gateway', 'peer'] as const)('revokes later effects after the %s ends or changes', async cause => {
    let complete!: (answer: { status: number; location: string }) => void
    let identity = 'phone-1'
    const replay = vi.fn((_url: string, _signal: AbortSignal) => new Promise<{ status: number; location: string }>(resolve => { complete = resolve }))
    const { browser } = setup({ replay, who: () => identity })
    const closed = new AbortController()
    browser.typed('a1', { connId: 'phone-1', kind: 'phone' })
    await browser.open({ pane: '%7', url: CLAUDE })
    const call = browser.callback({ url: 'http://localhost:35391/callback' }, 'phone-1', closed.signal)
    browser.ended('unrelated-agent')
    expect(replay.mock.calls[0][1].aborted).toBe(false)
    if (cause === 'request') closed.abort()
    if (cause === 'agent') browser.ended('a1')
    if (cause === 'gateway') browser.stop()
    if (cause === 'peer') identity = 'another-peer'
    complete({ status: 302, location: '/success' })
    expect(await call).toEqual({ ok: true, status: 302 })
    expect(replay).toHaveBeenCalledOnce()
    expect(replay.mock.calls[0][1].aborted).toBe(cause !== 'peer')
  })

  it('replays the caught redirect to the waiting program, once', async () => {
    const { deps, browser } = setup()
    browser.typed('a1', { connId: 'phone-1', kind: 'phone' })
    await browser.open({ pane: '%7', url: CLAUDE })
    const caught = 'http://localhost:35391/callback?code=c1&state=s1'
    // Back from the browser the phone is on a new connection: it is the same phone.
    expect(await browser.callback({ url: caught }, 'phone-1b')).toEqual({ ok: true, status: 200 })
    expect(deps.replay).toHaveBeenCalledWith('http://127.0.0.1:35391/callback?code=c1&state=s1', expect.any(AbortSignal))
    expect(await browser.callback({ url: caught }, 'phone-1')).toEqual({ error: 'NOT_EXPECTED' })
  })

  // Codex answers its callback with a 302 to its own `/success`, and its sign-in stayed open until a browser came (the MSI,
  // 2026-11-06).
  it('follows the program to its own next page on that port, as the phone\'s browser would, and nowhere else', async () => {
    const CODEX = 'https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&state=s'
    const pages: Record<string, { status: number; location: string | null }> = {
      'http://127.0.0.1:1455/auth/callback?code=c': { status: 302, location: '/success?id=1' },
      'http://127.0.0.1:1455/success?id=1': { status: 200, location: null },
    }
    const { deps, browser } = setup({ replay: vi.fn(async (url: string) => pages[url] ?? { status: 404, location: null }) })
    browser.typed('a1', { connId: 'phone-1', kind: 'phone' })
    await browser.open({ pane: '%7', url: CODEX })
    expect(await browser.callback({ url: 'http://127.0.0.1:1455/auth/callback?code=c' }, 'phone-1')).toEqual({ ok: true, status: 302 })
    expect(vi.mocked(deps.replay).mock.calls.map(([url]) => url))
      .toEqual(['http://127.0.0.1:1455/auth/callback?code=c', 'http://127.0.0.1:1455/success?id=1'])
    expect(deps.log).toHaveBeenCalledWith('[browser] CALLBACK_PAGE_DELIVERED')
    // Another port, another host, https, a page that fails: none opened, and the sign-in still said handed over.
    for (const location of ['http://127.0.0.1:22/x', 'https://example.com/done', 'https://127.0.0.1:1455/success']) {
      const replay = vi.fn(async () => ({ status: 302, location }))
      const other = setup({ replay })
      other.browser.typed('a1', { connId: 'phone-1', kind: 'phone' })
      await other.browser.open({ pane: '%7', url: CODEX })
      expect(await other.browser.callback({ url: 'http://127.0.0.1:1455/auth/callback?code=c' }, 'phone-1')).toEqual({ ok: true, status: 302 })
      expect(replay).toHaveBeenCalledOnce()
    }
    const failing = setup({ replay: vi.fn().mockResolvedValueOnce({ status: 302, location: '/success' }).mockRejectedValueOnce(new Error('ECONNRESET')) })
    failing.browser.typed('a1', { connId: 'phone-1', kind: 'phone' })
    await failing.browser.open({ pane: '%7', url: CODEX })
    expect(await failing.browser.callback({ url: 'http://127.0.0.1:1455/auth/callback?code=c' }, 'phone-1')).toEqual({ ok: true, status: 302 })
    expect(failing.deps.log).toHaveBeenCalledWith('[browser] CALLBACK_PAGE_NOT_DELIVERED')
    // A rejection that is not an Error is said the same way.
    const plain = setup({ replay: vi.fn().mockResolvedValueOnce({ status: 302, location: '/success' }).mockRejectedValueOnce('socket closed') })
    plain.browser.typed('a1', { connId: 'phone-1', kind: 'phone' })
    await plain.browser.open({ pane: '%7', url: CODEX })
    expect(await plain.browser.callback({ url: 'http://127.0.0.1:1455/auth/callback?code=c' }, 'phone-1')).toEqual({ ok: true, status: 302 })
    expect(plain.deps.log).toHaveBeenCalledWith('[browser] CALLBACK_PAGE_NOT_DELIVERED')
    // A program that keeps sending the browser on is followed a few pages, never for ever.
    const loop = setup({ replay: vi.fn(async () => ({ status: 302, location: '/again' })) })
    loop.browser.typed('a1', { connId: 'phone-1', kind: 'phone' })
    await loop.browser.open({ pane: '%7', url: CODEX })
    await loop.browser.callback({ url: 'http://127.0.0.1:1455/auth/callback?code=c' }, 'phone-1')
    expect(loop.deps.replay).toHaveBeenCalledTimes(4)
  })

  it('says when the program refused it or could not be reached', async () => {
    const { browser, deps } = setup({ replay: vi.fn().mockResolvedValueOnce({ status: 400, location: null }).mockRejectedValueOnce(new Error('ECONNREFUSED')).mockRejectedValueOnce('gone') })
    browser.typed('a1', { connId: 'phone-1', kind: 'phone' })
    await browser.open({ pane: '%7', url: CLAUDE })
    await browser.open({ pane: '%7', url: CLAUDE })
    expect(await browser.callback({ url: 'http://127.0.0.1:35391/callback?code=x' }, 'phone-1')).toEqual({ ok: false, status: 400 })
    expect(await browser.callback({ url: 'http://127.0.0.1:35391/callback?code=x' }, 'phone-1')).toEqual({ error: 'NOT_DELIVERED' })
    await browser.open({ pane: '%7', url: CLAUDE })
    expect(await browser.callback({ url: 'http://127.0.0.1:35391/callback?code=x' }, 'phone-1')).toEqual({ error: 'NOT_DELIVERED' })
    // The log says what happened and where, never the code.
    expect(deps.log).toHaveBeenCalledWith('[browser] CALLBACK_NOT_DELIVERED')
    expect(deps.log).toHaveBeenCalledWith('[browser] CALLBACK_NOT_DELIVERED')
    expect(JSON.stringify(vi.mocked(deps.log).mock.calls)).not.toContain('code=')
    expect(await browser.callback({ url: 'http://localhost/callback?code=x' }, 'phone-1')).toEqual({ error: 'NOT_EXPECTED' })
    expect(deps.log).toHaveBeenLastCalledWith('[browser] CALLBACK_NOT_EXPECTED')
  })

  it('refuses any other port, path, scheme, host or phone, and a redirect left too long', async () => {
    const { deps, browser, later } = setup()
    browser.typed('a1', { connId: 'phone-1', kind: 'phone' })
    await browser.open({ pane: '%7', url: CLAUDE })
    // A page that returns nowhere on this computer leaves nothing to replay.
    await browser.open({ pane: '%7', url: 'https://github.com/login/device' })
    await browser.open({ pane: '%7', url: 'https://x.test/a?redirect_uri=https%3A%2F%2Fx.test%2Fcb' })
    await browser.open({ pane: '%7', url: 'https://x.test/a?redirect_uri=http%3A%2F%2Flocalhost%2Fcb' })
    await browser.open({ pane: '%7', url: 'https://x.test/a?redirect_uri=%25' })
    for (const url of [
      'http://localhost:22/callback?code=c',
      'http://localhost:35391/admin?code=c',
      'https://localhost:35391/callback?code=c',
      'http://example.com:35391/callback?code=c',
      'nonsense',
    ]) expect(await browser.callback({ url }, 'phone-1')).toEqual(url === 'nonsense' ? { error: 'BAD_URL' } : { error: 'NOT_EXPECTED' })
    expect(await browser.callback({}, 'phone-1')).toEqual({ error: 'BAD_URL' })
    expect(await browser.callback({ url: 'http://localhost:35391/callback?code=c' }, 'phone-2')).toEqual({ error: 'NOT_EXPECTED' })
    later(CALLBACK_FOR_MS + 1)
    expect(await browser.callback({ url: 'http://localhost:35391/callback?code=c' }, 'phone-1')).toEqual({ error: 'NOT_EXPECTED' })
    expect(deps.replay).not.toHaveBeenCalled()
  })
})
