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
    await redisPollMemory(redis).set('tab:agent:user', { at: 1_234 })
    expect(await redisPollMemory(redis).get('tab:agent:user')).toEqual({ at: 1_234 })
    expect(await redisPollMemory(redis).get('tab:agent:other')).toBeUndefined()
  })

  // A key per tab, agent and caller that never expired would grow Redis by one for every agent that ever polled.
  it('forgets each caller 30 seconds after it was remembered', async () => {
    const redis = fakeRedis()
    await redisPollMemory(redis).set('tab:agent:user', { at: 1_234 })
    redis.tick(29_999)
    expect(await redisPollMemory(redis).get('tab:agent:user')).toEqual({ at: 1_234 })
    redis.tick(1)
    expect(await redisPollMemory(redis).get('tab:agent:user')).toBeUndefined()
  })

  it('keeps its keys apart from the rest of Redis', async () => {
    const redis = fakeRedis()
    await redisPollMemory(redis).set('tab:agent:user', { at: 1 })
    expect([...redis.keys.keys()]).toEqual(['swarm:polled:tab:agent:user'])
  })

  // A held delivery is answered from what the last full poll found open (store.ts deliveries), on whichever server polls next.
  it('gives back the open deliveries a full poll found, and the stamp it found them at', async () => {
    const redis = fakeRedis()
    const found = { at: 1_234, open: { stamp: 7, seen: ['d1', 'd2'], allowed: ['d2'] } }
    await redisPollMemory(redis).set('tab:agent:user', found)
    expect(await redisPollMemory(redis).get('tab:agent:user')).toEqual(found)
  })

  // During a deploy an older server still writes the bare time: its full poll counts, with nothing open remembered.
  it('reads the bare time an older server wrote', async () => {
    const redis = fakeRedis()
    await redis.set('swarm:polled:tab:agent:user', '1234', 'PX', 30_000)
    expect(await redisPollMemory(redis).get('tab:agent:user')).toEqual({ at: 1_234 })
  })

  it('reads a remembered poll whose open deliveries are malformed as never remembered', async () => {
    const redis = fakeRedis()
    await redis.set('swarm:polled:tab:agent:user', JSON.stringify({ at: 1, open: { stamp: 'x', seen: [], allowed: [] } }), 'PX', 30_000)
    expect(await redisPollMemory(redis).get('tab:agent:user')).toBeUndefined()
  })

  it('reads a value it cannot use as never remembered', async () => {
    const redis = fakeRedis()
    await redis.set('swarm:polled:tab:agent:user', 'not a time', 'PX', 30_000)
    expect(await redisPollMemory(redis).get('tab:agent:user')).toBeUndefined()
  })
})
