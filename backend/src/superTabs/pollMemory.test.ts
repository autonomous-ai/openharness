import { describe, expect, it } from 'vitest'
import { redisPollMemory } from './pollMemory.js'

/** The two Redis commands the memory uses, with Redis' own expiry (`PX` milliseconds), on a clock the test moves. */
function fakeRedis() {
  let now = 0
  const keys = new Map<string, { value: string; until: number }>()
  return {
    tick: (ms: number) => { now += ms },
    keys,
    async get(key: string) {
      const entry = keys.get(key)
      return entry && entry.until > now ? entry.value : null
    },
    async set(key: string, value: string, mode: 'PX', ms: number) {
      if (mode !== 'PX') throw new Error('expected an expiry')
      keys.set(key, { value, until: now + ms })
      return 'OK' as const
    },
  }
}

describe('the delivery poll memory every server shares', () => {
  it('answers with the time any server last remembered for a caller', async () => {
    const redis = fakeRedis()
    await redisPollMemory(redis).set('tab:agent:user', 1_234)
    expect(await redisPollMemory(redis).get('tab:agent:user')).toBe(1_234)
    expect(await redisPollMemory(redis).get('tab:agent:other')).toBeUndefined()
  })

  // A key per tab, agent and caller that never expired would grow Redis by one for every agent that ever polled.
  it('forgets each caller 30 seconds after it was remembered', async () => {
    const redis = fakeRedis()
    await redisPollMemory(redis).set('tab:agent:user', 1_234)
    redis.tick(29_999)
    expect(await redisPollMemory(redis).get('tab:agent:user')).toBe(1_234)
    redis.tick(1)
    expect(await redisPollMemory(redis).get('tab:agent:user')).toBeUndefined()
  })

  it('keeps its keys apart from the rest of Redis', async () => {
    const redis = fakeRedis()
    await redisPollMemory(redis).set('tab:agent:user', 1)
    expect([...redis.keys.keys()]).toEqual(['swarm:polled:tab:agent:user'])
  })

  it('reads a value it cannot use as never remembered', async () => {
    const redis = fakeRedis()
    await redis.set('swarm:polled:tab:agent:user', 'not a time', 'PX', 30_000)
    expect(await redisPollMemory(redis).get('tab:agent:user')).toBeUndefined()
  })
})
