import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createServer, type AddressInfo } from 'node:net'
import { Redis } from 'ioredis'
import { redisWindowCounter } from './redisRateCounter.js'

// A real client: the shared setup's never connects (noRedis.test-support.ts).
vi.unmock('ioredis')

// Against a real Redis, so the script is what is tested: REDIS_TEST_URL when set (CI's Redis service), with keys of this run
// alone, removed afterwards; otherwise a redis-server of its own where one is installed. Skipped with neither.
const url = process.env.REDIS_TEST_URL
const hasRedis = !!url || (() => { try { execFileSync('redis-server', ['--version'], { stdio: 'pipe' }); return true } catch { return false } })()
const run = randomUUID()
const k = (name: string) => `rl:t:${run}:${name}`

describe.skipIf(!hasRedis)('Redis window counter', () => {
  let server: ChildProcess | undefined
  let redis: Redis

  beforeAll(async () => {
    if (url) {
      redis = new Redis(url, { lazyConnect: true })
      await redis.connect()
      return
    }
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address() as AddressInfo; probe.close(() => resolve(port)) })
    })
    server = spawn('redis-server', ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
    redis = new Redis({ port, host: '127.0.0.1', lazyConnect: true, retryStrategy: () => 50 })
    for (let i = 0; i < 100; i++) { try { await redis.connect(); break } catch { await new Promise((r) => setTimeout(r, 50)) } }
  })
  afterAll(async () => {
    const used = await redis?.keys(k('*')) ?? []
    if (url && used.length) await redis.del(...used)
    redis?.disconnect()
    server?.kill()
  })

  it('counts each key in one round trip and returns the counts after this hit', async () => {
    const count = redisWindowCounter(redis)

    const both = [{ key: k('a:1'), windowMs: 60_000 }, { key: k('b:1'), windowMs: 1_000 }]
    expect(await count(both)).toEqual([1, 1])
    expect(await count(both)).toEqual([2, 2])
    expect(await count([{ key: k('a:1'), windowMs: 60_000 }])).toEqual([3])
  })

  it('lets each key expire with its own window, so nothing is left behind', async () => {
    const count = redisWindowCounter(redis)
    await count([{ key: k('minute:1'), windowMs: 60_000 }, { key: k('second:1'), windowMs: 1_000 }])

    const [minute, second] = [await redis.pttl(k('minute:1')), await redis.pttl(k('second:1'))]

    expect(minute).toBeGreaterThan(59_000)
    expect(minute).toBeLessThanOrEqual(60_000)
    expect(second).toBeGreaterThan(0)
    expect(second).toBeLessThanOrEqual(1_000)
  })
})
