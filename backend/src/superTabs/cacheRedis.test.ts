import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { redisStamps, STAMP_TTL_MS, type StampScope } from './cache.js'

// A real Redis: REDIS_TEST_URL, e.g. redis://127.0.0.1:6379/15 (CI's Redis service; skipped without one, which CI's
// redis-tests-ran step refuses). Only keys of this run are touched, and they are removed afterwards.
const url = process.env.REDIS_TEST_URL
// A real client: the shared setup's never connects (noRedis.test-support.ts).
vi.unmock('ioredis')

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
    // Redis's clock in microseconds.
    expect(first.main).toBeGreaterThan((before - 60_000) * 1000)
    expect(first.main).toBeLessThan((Date.now() + 60_000) * 1000)
    expect(first.machine).toBe(first.main - 1)
    await stamps.bump(id, ['main']); await stamps.bump(id, ['main'])
    const old = (await stamps.read([id])).get(id)!.main
    await redis.del(`swarm:stamp:${id}`)
    await stamps.bump(id, ['main'])
    expect((await stamps.read([id])).get(id)!.main).toBeGreaterThan(old)
  })

  // Review of #2456: a stamp the old Redis handed out must never come back for other data, or a process serves what it holds
  // (cache.ts) and a delivery poll skips its revocation check (store.ts deliveries). Each bump is at least Redis's clock.
  it('moves forward even after Redis comes back with an older value, as from a snapshot or a lagging replica', async () => {
    const stamps = redisStamps(redis, bus), id = tab()
    used.push(id)
    await stamps.bump(id, ['main', 'machine'])
    const older = (await stamps.read([id])).get(id)!
    for (let i = 0; i < 5; i++) await stamps.bump(id, ['main', 'machine'])
    const newest = (await stamps.read([id])).get(id)!
    await redis.hset(`swarm:stamp:${id}`, 'main', older.main, 'machine', older.machine)
    await stamps.bump(id, ['main', 'machine'])
    const after = (await stamps.read([id])).get(id)!
    expect(after.main).toBeGreaterThan(newest.main)
    expect(after.machine).toBeGreaterThan(newest.machine)
  })

  it('moves each stamp strictly forward on every bump, many in one millisecond', async () => {
    const stamps = redisStamps(redis, bus), id = tab()
    used.push(id)
    const seen: number[] = []
    for (let i = 0; i < 50; i++) {
      await stamps.bump(id, ['main'])
      seen.push((await stamps.read([id])).get(id)!.main)
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]!)
  })

  it('moves a stamp ahead of the clock by exactly one, never back to the clock', async () => {
    const stamps = redisStamps(redis, bus), id = tab()
    used.push(id)
    await stamps.bump(id, ['main', 'machine'])
    // As a burst or a faster clock could leave it: 10 s above Redis's clock, in microseconds.
    const ahead = (Date.now() + 10_000) * 1000
    await redis.hset(`swarm:stamp:${id}`, 'main', ahead, 'machine', ahead)
    await stamps.bump(id, ['main'])
    expect((await stamps.read([id])).get(id)).toEqual({ main: ahead + 1, machine: ahead })
  })

  it('moves only the scopes named', async () => {
    const stamps = redisStamps(redis, bus), id = tab()
    used.push(id)
    await stamps.bump(id, ['main'])
    const start = (await stamps.read([id])).get(id)!
    await stamps.bump(id, ['machine'])
    const machine = (await stamps.read([id])).get(id)!
    expect(machine.main).toBe(start.main)
    expect(machine.machine).toBeGreaterThan(start.machine)
    await stamps.bump(id, ['main', 'machine'])
    const both = (await stamps.read([id])).get(id)!
    expect(both.main).toBeGreaterThan(machine.main)
    expect(both.machine).toBeGreaterThan(machine.machine)
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
