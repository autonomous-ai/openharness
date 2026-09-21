import { describe, expect, it } from 'vitest'
import { createSsoProfileCache, type SharedProfileStore } from './ssoProfileCache.js'

const profile = { id: 'external-1', email: 'owner@example.com' }

/** An access token shaped like the real one: only the payload's `exp` (seconds) is ever read. */
function tokenExpiringAt(expMs: number, salt = 'a'): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000), salt })).toString('base64url')
  return `header.${payload}.signature`
}

/** A counting loader, so a test can say how many times the profile service was really asked. */
function loader(result: typeof profile | Error = profile) {
  const state = { calls: 0 }
  const load = async () => {
    state.calls++
    if (result instanceof Error) throw result
    return result
  }
  return { state, load }
}

/** What Redis is to the cache: a string store with a TTL, shared by every backend process. */
function memoryStore(now: () => number): SharedProfileStore & { keys: () => string[]; values: () => string[] } {
  const rows = new Map<string, { value: string; expiresAt: number }>()
  return {
    async get(key) {
      const row = rows.get(key)
      return row && row.expiresAt > now() ? row.value : null
    },
    async set(key, value, ttlMs) { rows.set(key, { value, expiresAt: now() + ttlMs }) },
    keys: () => [...rows.keys()],
    values: () => [...rows.values()].map((row) => row.value),
  }
}

describe('SSO profile cache', () => {
  it('asks the profile service once for a token it has just validated', async () => {
    const cache = createSsoProfileCache({ ttlMs: 60_000 })
    const { state, load } = loader()

    await expect(cache.resolve('opaque-token', 'prod', load)).resolves.toEqual(profile)
    await expect(cache.resolve('opaque-token', 'prod', load)).resolves.toEqual(profile)

    expect(state.calls).toBe(1)
  })

  it('asks again once the entry is older than the TTL', async () => {
    let now = 1_000_000
    const cache = createSsoProfileCache({ ttlMs: 60_000, now: () => now })
    const { state, load } = loader()

    await cache.resolve('opaque-token', 'prod', load)
    now += 60_001
    await cache.resolve('opaque-token', 'prod', load)

    expect(state.calls).toBe(2)
  })

  it('never keeps a token past its own expiry', async () => {
    let now = 1_000_000
    const cache = createSsoProfileCache({ ttlMs: 60_000, now: () => now })
    const token = tokenExpiringAt(now + 10_000)
    const { state, load } = loader()

    await cache.resolve(token, 'prod', load)
    now += 9_000
    await cache.resolve(token, 'prod', load)
    expect(state.calls).toBe(1)

    now += 2_000
    await cache.resolve(token, 'prod', load)
    expect(state.calls).toBe(2)
  })

  it('does not remember a token the profile service rejected', async () => {
    const cache = createSsoProfileCache({ ttlMs: 60_000 })
    const rejected = loader(new Error('Invalid or expired SSO access token'))
    const accepted = loader()

    await expect(cache.resolve('opaque-token', 'prod', rejected.load)).rejects.toThrow('Invalid or expired')
    await expect(cache.resolve('opaque-token', 'prod', accepted.load)).resolves.toEqual(profile)

    expect(accepted.state.calls).toBe(1)
  })

  it('shares one in-flight validation between requests that arrive together', async () => {
    const cache = createSsoProfileCache({ ttlMs: 60_000 })
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const load = async () => { calls++; await gate; return profile }

    const both = Promise.all([
      cache.resolve('opaque-token', 'prod', load),
      cache.resolve('opaque-token', 'prod', load),
    ])
    release()

    await expect(both).resolves.toEqual([profile, profile])
    expect(calls).toBe(1)
  })

  it('keeps the two account planes apart for the same token', async () => {
    const cache = createSsoProfileCache({ ttlMs: 60_000 })
    const prod = loader()
    const stag = loader({ id: 'stag-1', email: 'owner@example.com' })

    await cache.resolve('opaque-token', 'prod', prod.load)
    await expect(cache.resolve('opaque-token', 'stag', stag.load)).resolves.toEqual({ id: 'stag-1', email: 'owner@example.com' })

    expect(stag.state.calls).toBe(1)
  })

  it('reuses a validation another backend process already made', async () => {
    const now = () => 1_000_000
    const shared = memoryStore(now)
    const first = createSsoProfileCache({ ttlMs: 60_000, now, shared: () => shared })
    const second = createSsoProfileCache({ ttlMs: 60_000, now, shared: () => shared })
    const { state, load } = loader()

    await first.resolve('opaque-token', 'prod', load)
    await expect(second.resolve('opaque-token', 'prod', load)).resolves.toEqual(profile)

    expect(state.calls).toBe(1)
  })

  it('trusts a borrowed validation no longer than the process that made it', async () => {
    let now = 1_000_000
    const shared = memoryStore(() => now)
    const first = createSsoProfileCache({ ttlMs: 60_000, now: () => now, shared: () => shared })
    const second = createSsoProfileCache({ ttlMs: 60_000, now: () => now, shared: () => shared })
    const { state, load } = loader()

    await first.resolve('opaque-token', 'prod', load)
    now += 59_000
    await second.resolve('opaque-token', 'prod', load)
    expect(state.calls).toBe(1)

    now += 2_000
    await second.resolve('opaque-token', 'prod', load)
    expect(state.calls).toBe(2)
  })

  it('never hands the shared store the token itself', async () => {
    const now = () => 1_000_000
    const shared = memoryStore(now)
    const cache = createSsoProfileCache({ ttlMs: 60_000, now, shared: () => shared })

    await cache.resolve('very-secret-access-token', 'prod', loader().load)

    expect(shared.keys()).toHaveLength(1)
    expect([...shared.keys(), ...shared.values()].join(' ')).not.toContain('very-secret-access-token')
  })

  it('still authenticates when the shared store is down', async () => {
    const broken: SharedProfileStore = {
      get: async () => { throw new Error('redis unreachable') },
      set: async () => { throw new Error('redis unreachable') },
    }
    const cache = createSsoProfileCache({ ttlMs: 60_000, shared: () => broken })
    const { state, load } = loader()

    await expect(cache.resolve('opaque-token', 'prod', load)).resolves.toEqual(profile)
    await expect(cache.resolve('opaque-token', 'prod', load)).resolves.toEqual(profile)

    expect(state.calls).toBe(1)
  })

  it('does not wait for the shared store to save what it just validated', async () => {
    const stalled: SharedProfileStore = { get: async () => null, set: () => new Promise<void>(() => {}) }
    const cache = createSsoProfileCache({ ttlMs: 60_000, shared: () => stalled })

    await expect(cache.resolve('opaque-token', 'prod', loader().load)).resolves.toEqual(profile)
  })

  it('treats a shared store that does not answer promptly as a miss', async () => {
    const hung: SharedProfileStore = { get: () => new Promise<string | null>(() => {}), set: async () => {} }
    const cache = createSsoProfileCache({ ttlMs: 60_000, shared: () => hung, sharedReadTimeoutMs: 10 })
    const { state, load } = loader()

    await expect(cache.resolve('opaque-token', 'prod', load)).resolves.toEqual(profile)
    expect(state.calls).toBe(1)
  })

  it('ignores a shared entry that is not a profile', async () => {
    const now = () => 1_000_000
    const shared = memoryStore(now)
    const writer = createSsoProfileCache({ ttlMs: 60_000, now, shared: () => shared })
    await writer.resolve('opaque-token', 'prod', loader().load)
    await shared.set(shared.keys()[0], '{"id":42}', 60_000)

    const reader = createSsoProfileCache({ ttlMs: 60_000, now, shared: () => shared })
    const { state, load } = loader()
    await expect(reader.resolve('opaque-token', 'prod', load)).resolves.toEqual(profile)

    expect(state.calls).toBe(1)
  })

  it('validates every time when the TTL is zero', async () => {
    const cache = createSsoProfileCache({ ttlMs: 0 })
    const { state, load } = loader()

    await cache.resolve('opaque-token', 'prod', load)
    await cache.resolve('opaque-token', 'prod', load)

    expect(state.calls).toBe(2)
  })

  it('forgets the oldest token when it is full', async () => {
    const cache = createSsoProfileCache({ ttlMs: 60_000, maxEntries: 2 })
    const first = loader()

    await cache.resolve('token-1', 'prod', first.load)
    await cache.resolve('token-2', 'prod', loader().load)
    await cache.resolve('token-3', 'prod', loader().load)
    await cache.resolve('token-1', 'prod', first.load)

    expect(first.state.calls).toBe(2)
  })

  it('forgets everything on clear', async () => {
    const cache = createSsoProfileCache({ ttlMs: 60_000 })
    const { state, load } = loader()

    await cache.resolve('opaque-token', 'prod', load)
    cache.clear()
    await cache.resolve('opaque-token', 'prod', load)

    expect(state.calls).toBe(2)
  })
})
