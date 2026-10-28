import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createServer, type AddressInfo } from 'node:net'
import { Redis } from 'ioredis'
import { redisWindowCounter } from './redisRateCounter.js'

// Against a real redis-server, so the script is what is tested. Skipped where none is installed (CI's Linux runners).
const hasRedis = (() => { try { execFileSync('redis-server', ['--version'], { stdio: 'pipe' }); return true } catch { return false } })()

describe.skipIf(!hasRedis)('Redis window counter', () => {
  let server: ChildProcess
  let redis: Redis

  beforeAll(async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address() as AddressInfo; probe.close(() => resolve(port)) })
    })
    server = spawn('redis-server', ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
    redis = new Redis({ port, host: '127.0.0.1', lazyConnect: true, retryStrategy: () => 50 })
    for (let i = 0; i < 100; i++) { try { await redis.connect(); break } catch { await new Promise((r) => setTimeout(r, 50)) } }
  })
  afterAll(() => { redis?.disconnect(); server?.kill() })

  it('counts each key in one round trip and returns the counts after this hit', async () => {
    const count = redisWindowCounter(redis)

    expect(await count(['rl:t:a:1', 'rl:t:b:1'], 60_000)).toEqual([1, 1])
    expect(await count(['rl:t:a:1', 'rl:t:b:1'], 60_000)).toEqual([2, 2])
    expect(await count(['rl:t:a:1'], 60_000)).toEqual([3])
  })

  it('lets each key expire with its window, so nothing is left behind', async () => {
    const count = redisWindowCounter(redis)
    await count(['rl:t:expiring:1'], 60_000)

    const ttl = await redis.pttl('rl:t:expiring:1')

    expect(ttl).toBeGreaterThan(59_000)
    expect(ttl).toBeLessThanOrEqual(60_000)
  })
})
