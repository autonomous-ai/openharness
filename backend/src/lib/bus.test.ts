import { beforeEach, describe, expect, it, vi } from 'vitest'

// One fake ioredis per `new Redis(...)`; the bus creates four (pub, sub, terminalSub, appSub).
const state = vi.hoisted(() => {
  const instances: unknown[] = []
  // Which HEXPIRE calls should error, consumed in order (true = error → fallback expire for that key).
  let hexpireErrors: boolean[] = []
  return {
    instances,
    setHexpireErrors: (e: boolean[]) => { hexpireErrors = [...e] },
    nextHexpireError: (): Error | null => (hexpireErrors.shift() ? new Error('ERR unknown command HEXPIRE') : null),
  }
})

vi.mock('ioredis', () => {
  class FakePipeline {
    calls: Array<{ cmd: string; args: unknown[] }> = []
    results: Array<[Error | null, unknown]> = []
    hdel(...args: unknown[]) { this.calls.push({ cmd: 'hdel', args }); this.results.push([null, 1]); return this }
    hset(...args: unknown[]) { this.calls.push({ cmd: 'hset', args }); this.results.push([null, 1]); return this }
    expire(...args: unknown[]) { this.calls.push({ cmd: 'expire', args }); this.results.push([null, 1]); return this }
    hgetall(...args: unknown[]) { this.calls.push({ cmd: 'hgetall', args }); this.results.push([null, {}]); return this }
    get(...args: unknown[]) { this.calls.push({ cmd: 'get', args }); this.results.push([null, null]); return this }
    call(cmd: string, ...args: unknown[]) {
      this.calls.push({ cmd, args })
      // Simulate Redis < 7.4: HEXPIRE errors. state.hexpireErrors decides per-call.
      this.results.push([state.nextHexpireError(), null])
      return this
    }
    exec = vi.fn(async () => this.results)
  }
  class FakeRedis {
    publish = vi.fn(async () => 1)
    subscribe = vi.fn(async () => 1)
    unsubscribe = vi.fn(async () => 1)
    quit = vi.fn(async () => 'OK')
    on = vi.fn()
    eval = vi.fn(async () => 0)
    get = vi.fn(async (_key: string): Promise<string | null> => null)
    pipelines: FakePipeline[] = []
    pipeline() { const p = new FakePipeline(); this.pipelines.push(p); return p }
    opts: unknown
    constructor(_url: string, opts: unknown) { this.opts = opts; state.instances.push(this) }
  }
  return { Redis: FakeRedis }
})
vi.mock('../config/env.js', () => ({ env: {
  REDIS_URL: 'redis://test',
  HARNESS_NEW_MACHINE_PER_HOUR: 5, HARNESS_NEW_MACHINE_PER_DAY: 20,
  HARNESS_NEW_DEVICE_PER_HOUR: 5, HARNESS_NEW_DEVICE_PER_DAY: 20,
} }))
vi.mock('../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

const bus = await import('./bus.js')
type MockFn = ReturnType<typeof vi.fn>
const pub = state.instances[0] as unknown as {
  publish: MockFn; subscribe: MockFn; opts: unknown
  eval: MockFn; get: MockFn
  pipelines: Array<{ calls: Array<{ cmd: string; args: unknown[] }> }>
}

describe('bus redis options', () => {
  it('fails publishes fast instead of queuing them while Redis is down, and keeps subscribers retrying', () => {
    const pubOpts = pub.opts as { enableOfflineQueue?: boolean; maxRetriesPerRequest?: number | null }
    expect(pubOpts.enableOfflineQueue).toBe(false)
    expect(pubOpts.maxRetriesPerRequest).toBe(1)
    for (const sub of state.instances.slice(1) as Array<{ opts: { maxRetriesPerRequest?: number | null } }>) {
      expect(sub.opts.maxRetriesPerRequest).toBeNull()
    }
    expect(state.instances).toHaveLength(4)
  })
})

describe('publishUp', () => {
  beforeEach(() => { pub.publish.mockClear() })

  it('mirrors node_status onto the status channel as the bare frame', async () => {
    const frame = { type: 'node_status', payload: { online: true } }
    await bus.publishUp('m1', { webEligible: true, commanderEligible: true, frame })
    const channels = pub.publish.mock.calls.map((c: unknown[]) => c[0])
    expect(channels).toContain('up:m1')
    expect(channels).toContain('status:m1')
    const statusCall = pub.publish.mock.calls.find((c: unknown[]) => c[0] === 'status:m1')!
    expect(JSON.parse(statusCall[1] as string)).toEqual(frame)
  })

  it('does not mirror ordinary frames', async () => {
    await bus.publishUp('m1', { webEligible: true, commanderEligible: false, frame: { type: 'text_delta', payload: { content: 'x' } } })
    expect(pub.publish.mock.calls.map((c: unknown[]) => c[0])).toEqual(['up:m1'])
  })

  it('returns 0 and does not throw when Redis rejects', async () => {
    pub.publish.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(bus.publishDown('m1', { connId: 'c', frame: { type: 'message' } })).resolves.toBe(0)
  })
})

describe('subscribeAppUp', () => {
  it('rides its own subscriber connection, not the main one', async () => {
    const [, mainSub, , appSub] = state.instances as Array<{ subscribe: MockFn }>
    await bus.subscribeAppUp('s1', () => undefined)
    expect(appSub.subscribe).toHaveBeenCalledWith('appup:s1')
    expect(mainSub.subscribe).not.toHaveBeenCalledWith('appup:s1')
  })
})


describe('setAgentClientCountsBatch HEXPIRE fallback', () => {
  const pipelinesOf = () => (pub as unknown as { pipelines: Array<{ calls: Array<{ cmd: string; args: unknown[] }> }> }).pipelines

  it('only re-expires the keys whose own HEXPIRE errored', async () => {
    // Two rows with counts (each → hset + HEXPIRE); make only the SECOND HEXPIRE fail.
    const before = pipelinesOf().length
    state.setHexpireErrors([false, true])
    await bus.setAgentClientCountsBatch('inst-1', [
      { machineId: 'm1', ui: 1, commander: 0, commanderActive: 0 },
      { machineId: 'm2', ui: 0, commander: 2, commanderActive: 1 },
    ])
    const created = pipelinesOf().slice(before)
    const expireCalls = created.flatMap((p) => p.calls).filter((c) => c.cmd === 'expire')
    expect(expireCalls).toHaveLength(1)
    expect(expireCalls[0].args[0]).toContain('m2')
  })

  it('issues no fallback when every HEXPIRE succeeds', async () => {
    const before = pipelinesOf().length
    state.setHexpireErrors([false])
    await bus.setAgentClientCountsBatch('inst-1', [{ machineId: 'm3', ui: 1, commander: 0, commanderActive: 0 }])
    const created = pipelinesOf().slice(before)
    const expireCalls = created.flatMap((p) => p.calls).filter((c) => c.cmd === 'expire')
    expect(expireCalls).toHaveLength(0)
  })
})

describe('clearDevicePresence', () => {
  beforeEach(() => { pub.eval.mockClear(); pub.get.mockClear(); pub.eval.mockResolvedValue(0) })

  it('reports `cleared` when the key is gone afterwards, and only deletes on a token match', async () => {
    pub.get.mockResolvedValue(null)
    expect(await bus.clearDevicePresence('dev-1', 'tok-1')).toBe('cleared')
    const [script, keyCount, key, token] = pub.eval.mock.calls[0]
    expect(script).toContain("redis.call('del', KEYS[1])")
    expect(script).toContain('== ARGV[1]')
    expect(keyCount).toBe(1)
    expect(key).toContain('dev-1')
    expect(token).toBe('tok-1')
  })

  it('reports `superseded` when a newer connection still holds the key', async () => {
    pub.get.mockResolvedValue('tok-2')
    expect(await bus.clearDevicePresence('dev-1', 'tok-1')).toBe('superseded')
  })

  it('reports `unknown` — never `superseded` — when Redis is unreachable', async () => {
    pub.eval.mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await bus.clearDevicePresence('dev-1', 'tok-1')).toBe('unknown')
    pub.eval.mockResolvedValue(0)
    pub.get.mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await bus.clearDevicePresence('dev-1', 'tok-1')).toBe('unknown')
  })
})

describe('consumeNewIdQuota', () => {
  beforeEach(() => { pub.eval.mockReset() })

  it('counts an hour and a day window per kind and user, in one atomic call', async () => {
    pub.eval.mockResolvedValue([1, 1])
    expect(await bus.consumeNewIdQuota('device', 'u1')).toBe(true)
    const [script, keyCount, ...rest] = pub.eval.mock.calls[0]
    expect(script).toContain("redis.call('incr', key)")
    expect(keyCount).toBe(2)
    expect(rest.slice(0, 2)).toEqual(['newid:device:u1:h', 'newid:device:u1:d'])
    expect(rest.slice(2)).toEqual([3_600_000, 86_400_000])
  })

  it('allows up to the limit and refuses past it, in either window', async () => {
    pub.eval.mockResolvedValue([5, 5])
    expect(await bus.consumeNewIdQuota('machine', 'u1')).toBe(true)
    pub.eval.mockResolvedValue([6, 6])
    expect(await bus.consumeNewIdQuota('machine', 'u1')).toBe(false)
    pub.eval.mockResolvedValue([1, 21])
    expect(await bus.consumeNewIdQuota('machine', 'u1')).toBe(false)
  })

  it('fails open when Redis is unreachable', async () => {
    pub.eval.mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await bus.consumeNewIdQuota('device', 'u1')).toBe(true)
  })
})
