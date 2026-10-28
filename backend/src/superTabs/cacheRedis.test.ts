import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { redisStamps, STAMP_TTL_MS, type StampScope } from './cache.js'

// A real Redis: REDIS_TEST_URL, e.g. redis://127.0.0.1:6379/15 (CI has none, so this file is skipped there). Only keys of
// this run are touched, and they are removed afterwards.
const url = process.env.REDIS_TEST_URL

describe.skipIf(!url)('redisStamps', () => {
  let redis: Redis
  const tab = () => `stamp-test-${randomUUID()}`
  const used: string[] = []
  const published: Array<{ tabId: string; scopes: readonly StampScope[] }> = []
  const bus = { publish: async (tabId: string, scopes: readonly StampScope[]) => { published.push({ tabId, scopes }) }, subscribe: () => () => {} }

  beforeAll(async () => {
    redis = new Redis(url!, { maxRetriesPerRequest: 1, enableOfflineQueue: false })
    await new Promise(resolve => redis.once('ready', resolve))
  })
  afterAll(async () => {
    if (used.length) await redis.del(...used.map(id => `swarm:stamp:${id}`))
    await redis.quit()
  })

  it('reads 0 for a Swarm never bumped', async () => {
    const id = tab()
    expect(await redisStamps(redis, bus).read([id])).toEqual(new Map([[id, { main: 0, machine: 0 }]]))
  })

  it('starts a Swarm from the time, so a Redis that lost its keys never hands out an old stamp again', async () => {
    const stamps = redisStamps(redis, bus), id = tab()
    used.push(id)
    const before = Date.now()
    await stamps.bump(id, ['main'])
    const first = (await stamps.read([id])).get(id)!
    expect(first.main).toBeGreaterThan(before - 60_000)
    expect(first.machine).toBe(first.main - 1)
    await stamps.bump(id, ['main']); await stamps.bump(id, ['main'])
    const old = (await stamps.read([id])).get(id)!.main
    await redis.del(`swarm:stamp:${id}`)
    await stamps.bump(id, ['main'])
    expect((await stamps.read([id])).get(id)!.main).toBeGreaterThan(old)
  })

  it('moves only the scopes named, by one each', async () => {
    const stamps = redisStamps(redis, bus), id = tab()
    used.push(id)
    await stamps.bump(id, ['main'])
    const start = (await stamps.read([id])).get(id)!
    await stamps.bump(id, ['machine'])
    expect((await stamps.read([id])).get(id)).toEqual({ main: start.main, machine: start.machine + 1 })
    await stamps.bump(id, ['main', 'machine'])
    expect((await stamps.read([id])).get(id)).toEqual({ main: start.main + 1, machine: start.machine + 2 })
  })

  it('reads several Swarms in one call, and lets a quiet Swarm\'s stamp expire', async () => {
    const stamps = redisStamps(redis, bus), a = tab(), b = tab()
    used.push(a, b)
    await stamps.bump(a, ['main'])
    const read = await stamps.read([a, b])
    expect(read.get(a)!.main).toBeGreaterThan(0)
    expect(read.get(b)).toEqual({ main: 0, machine: 0 })
    const ttl = await redis.pttl(`swarm:stamp:${a}`)
    expect(ttl).toBeGreaterThan(STAMP_TTL_MS - 60_000)
    expect(ttl).toBeLessThanOrEqual(STAMP_TTL_MS)
  })

  it('tells the other processes which Swarm moved, and which stamps', async () => {
    const stamps = redisStamps(redis, bus), id = tab()
    used.push(id)
    await stamps.bump(id, ['machine'])
    expect(published.at(-1)).toEqual({ tabId: id, scopes: ['machine'] })
  })
})
