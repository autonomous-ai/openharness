import { describe, expect, it, vi } from 'vitest'
import type { AuthUser } from '../lib/ssoAuth.js'
import { AUTO_JOIN_EVERY_MS, AUTO_JOIN_LIMIT, autoJoin, localAutoJoinMemory, redisAutoJoinMemory, type AutoJoinDeps } from './autoJoin.js'

const x: AuthUser = { sub: 'x', email: 'X@Acme.com', autonomousEnv: 'prod', role: 'user' }
const deps = (over: Partial<AutoJoinDeps> = {}): AutoJoinDeps => ({
  memory: { claim: vi.fn(async () => true) },
  find: vi.fn(async () => ['a', 'b']),
  join: vi.fn(async () => 'joined' as const),
  ...over,
})

describe('autoJoin', () => {
  it('finds the Swarms of the person\'s own domain, ten at most, and joins each as the person', async () => {
    const d = deps()
    expect(await autoJoin(d, x)).toEqual(['a', 'b'])
    expect(d.find).toHaveBeenCalledWith(x, 'acme.com', AUTO_JOIN_LIMIT)
    expect(AUTO_JOIN_LIMIT).toBe(10)
    expect(d.join).toHaveBeenCalledWith(x, 'a')
    expect(d.memory.claim).toHaveBeenCalledWith('prod:x')
  })

  it('reads nothing when the person was tried in the last two minutes', async () => {
    const d = deps({ memory: { claim: async () => false } })
    expect(await autoJoin(d, x)).toEqual([])
    expect(d.find).not.toHaveBeenCalled()
  })

  it('still tries when the memory is down', async () => {
    const d = deps({ memory: { claim: async () => { throw new Error('redis down') } } })
    expect(await autoJoin(d, x)).toEqual(['a', 'b'])
  })

  it('skips a public domain, an address with no domain and a team session before any read', async () => {
    for (const user of [{ ...x, email: 'x@gmail.com' }, { ...x, email: 'y@privaterelay.appleid.com' }, { ...x, email: 'nobody' },
      { ...x, harnessSessionKind: 'team' as const }]) {
      const d = deps()
      expect(await autoJoin(d, user)).toEqual([])
      expect(d.memory.claim).not.toHaveBeenCalled()
      expect(d.find).not.toHaveBeenCalled()
    }
  })

  it('answers with the Swarms that did join when one join fails or is skipped', async () => {
    const d = deps({ find: async () => ['a', 'b', 'c', 'd'], join: vi.fn(async (_user: AuthUser, tab: string) => {
      if (tab === 'b') throw new Error('conflict')
      return tab === 'c' ? 'skipped' as const : tab === 'd' ? 'declined' as const : 'joined' as const
    }) })
    expect(await autoJoin(d, x)).toEqual(['a'])
    expect(d.join).toHaveBeenCalledTimes(4)
  })

  it('never throws when the read fails', async () => {
    expect(await autoJoin(deps({ find: async () => { throw new Error('mongo down') } }), x)).toEqual([])
  })
})

describe('auto-join memories', () => {
  it('claims a person once per two minutes in one server', async () => {
    let now = 1_000
    const memory = localAutoJoinMemory(() => now)
    expect(await memory.claim('k')).toBe(true)
    expect(await memory.claim('k')).toBe(false)
    now += AUTO_JOIN_EVERY_MS
    expect(await memory.claim('k')).toBe(true)
    expect(AUTO_JOIN_EVERY_MS).toBe(120_000)
  })

  it('claims with one SET NX PX in Redis, shared by every server', async () => {
    const set = vi.fn(async () => 'OK' as string | null)
    const memory = redisAutoJoinMemory({ set })
    expect(await memory.claim('prod:x')).toBe(true)
    expect(set).toHaveBeenCalledWith('swarm:auto-join:prod:x', '1', 'PX', 120_000, 'NX')
    set.mockResolvedValueOnce(null)
    expect(await memory.claim('prod:x')).toBe(false)
  })
})
