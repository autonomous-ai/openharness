import { describe, expect, it, vi } from 'vitest'

const fakes = vi.hoisted(() => {
  const writes: Array<{ key: string; value: string; ttl: number }> = []
  let fail = false
  return {
    writes,
    setFail: (v: boolean) => { fail = v },
    pub: { set: vi.fn(async (key: string, value: string, _ex: string, ttl: number) => {
      if (fail) throw new Error('redis down')
      writes.push({ key, value, ttl }); return 'OK'
    }) },
  }
})
vi.mock('./bus.js', () => ({ pub: fakes.pub }))

import { AUTH_CACHE_TTL_MS, AUTH_EPOCH_TTL_SEC, authEpochKey, createAuthCache, signInsChanged } from './harnessAuthCache.js'

const user = { sub: 'u1', email: 'dee@example.com', role: 'user', autonomousEnv: 'prod' as const, harnessSessionId: 's1', harnessSessionKind: 'viewer' as const }
const entry = { sessionId: 's1', userId: 'u1', epoch: null, user }

describe('the per-pod sign-in cache', () => {
  it('keeps a sign-in for 30 seconds, then forgets it', () => {
    let now = 1_000
    const cache = createAuthCache({ now: () => now })
    cache.set('h1', entry)
    now += AUTH_CACHE_TTL_MS - 1
    expect(cache.get('h1')).toMatchObject({ sessionId: 's1', userId: 'u1' })
    now += 1
    expect(cache.get('h1')).toBeUndefined()
    expect(AUTH_CACHE_TTL_MS).toBe(30_000)
  })

  it('holds at most its bound, dropping the oldest first', () => {
    const cache = createAuthCache({ max: 2, now: () => 0 })
    cache.set('a', entry); cache.set('b', entry); cache.set('c', entry)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBeDefined()
    expect(cache.get('c')).toBeDefined()
    expect(cache.size()).toBe(2)
  })
})

describe('a change to a person\'s sign-ins', () => {
  it('writes a fresh epoch for each person, never one an earlier epoch could equal, outliving every cached sign-in', async () => {
    fakes.writes.length = 0
    await signInsChanged('u1', 'u2', 'u1')
    await signInsChanged('u1')
    expect(fakes.writes.map(w => w.key)).toEqual([authEpochKey('u1'), authEpochKey('u2'), authEpochKey('u1')])
    expect(new Set(fakes.writes.map(w => w.value)).size).toBe(3)
    for (const w of fakes.writes) expect(w.ttl).toBe(AUTH_EPOCH_TTL_SEC)
    expect(AUTH_EPOCH_TTL_SEC * 1000).toBeGreaterThan(AUTH_CACHE_TTL_MS * 10)
  })

  it('throws when the epoch cannot be written, so the caller cannot report a sign-out that other pods may still serve', async () => {
    fakes.setFail(true)
    await expect(signInsChanged('u1')).rejects.toThrow('redis down')
    fakes.setFail(false)
  })
})
