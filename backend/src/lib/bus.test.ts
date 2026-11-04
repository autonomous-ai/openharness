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
    // The bus guards its command connection at ioredis' single send point (lib/redisGuard.ts).
    sendCommand = vi.fn()
    publish = vi.fn(async () => 1)
    subscribe = vi.fn(async () => 1)
    unsubscribe = vi.fn(async () => 1)
    quit = vi.fn(async () => 'OK')
    on = vi.fn()
    eval = vi.fn(async () => 0)
    get = vi.fn(async (_key: string): Promise<string | null> => null)
    set = vi.fn(async (..._args: unknown[]): Promise<string | null> => 'OK')
    exists = vi.fn(async (_key: string): Promise<number> => 0)
    pipelines: FakePipeline[] = []
    pipeline() { const p = new FakePipeline(); this.pipelines.push(p); return p }
    multiCalls: Array<{ cmd: string; args: unknown[] }> = []
    multiResult: unknown = [[null, 'OK'], [null, 1]]
    multi() {
      const calls = this.multiCalls, result = () => this.multiResult
      const m = {
        set: (...args: unknown[]) => { calls.push({ cmd: 'set', args }); return m },
        incr: (...args: unknown[]) => { calls.push({ cmd: 'incr', args }); return m },
        exec: async () => result(),
      }
      return m
    }
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
  eval: MockFn; get: MockFn; set: MockFn; exists: MockFn
  multiCalls: Array<{ cmd: string; args: unknown[] }>; multiResult: unknown
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

const NOT_WRITABLE = "Stream isn't writeable and enableOfflineQueue options is false"
type Listener = (...args: unknown[]) => void
/** What the subscriber connection hands the bus when Redis delivers `payload` on `channel`. */
function deliverFromRedis(instance: number, event: 'message' | 'messageBuffer', channel: string | Buffer, payload: string | Buffer) {
  const conn = state.instances[instance] as { on: MockFn }
  for (const [name, listener] of conn.on.mock.calls as Array<[string, Listener]>) if (name === event) listener(channel, payload)
}

describe('single-pod mode: Redis cannot take a publish', () => {
  beforeEach(() => { pub.publish.mockReset(); pub.publish.mockResolvedValue(1) })

  it('still delivers to this pod\'s own subscribers, once', async () => {
    const got: unknown[] = []
    await bus.subscribeShareChanged('share-1', () => got.push('changed'))
    pub.publish.mockRejectedValueOnce(new Error(NOT_WRITABLE))

    await expect(bus.publishShareChanged('share-1')).resolves.toBe(1)
    await vi.waitFor(() => expect(got).toEqual(['changed']))
  })

  it('delivers a frame for a machine whose socket is on this pod', async () => {
    const got: unknown[] = []
    await bus.subscribeDown('m-local', (msg) => got.push(msg))
    pub.publish.mockRejectedValueOnce(new Error(NOT_WRITABLE))

    await bus.publishDown('m-local', { connId: 'c1', frame: { type: 'message', payload: { text: 'hi' } } })

    await vi.waitFor(() => expect(got).toEqual([{ connId: 'c1', frame: { type: 'message', payload: { text: 'hi' } } }]))
  })

  it('delivers terminal bytes locally too', async () => {
    const got: Buffer[] = []
    await bus.subscribeTerminalUp('m-term', (payload) => got.push(payload))
    pub.publish.mockRejectedValueOnce(new Error(NOT_WRITABLE))

    await bus.publishTerminalUp('m-term', new Uint8Array([1, 2, 3]))

    await vi.waitFor(() => expect(got.map((b) => [...b])).toEqual([[1, 2, 3]]))
  })

  it('does not deliver a publish that timed out, which Redis may still deliver itself', async () => {
    const got: unknown[] = []
    await bus.subscribeShareChanged('share-2', () => got.push('changed'))
    pub.publish.mockRejectedValueOnce(new Error('Command timed out'))

    await expect(bus.publishShareChanged('share-2')).resolves.toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(got).toEqual([])
  })

  it('says 0 when nobody on this pod listens, as Redis would', async () => {
    pub.publish.mockRejectedValueOnce(new Error(NOT_WRITABLE))
    await expect(bus.publishShareChanged('nobody')).resolves.toBe(0)
  })

  it('warns once on entering it and says once when it is over', async () => {
    const { logger } = await import('../utils/logger.js')
    const warn = vi.mocked(logger.warn), info = vi.mocked(logger.info)
    await bus.publishShareChanged('settle') // out of single-pod mode, whatever an earlier test left
    warn.mockClear(); info.mockClear()
    pub.publish.mockRejectedValue(new Error(NOT_WRITABLE))
    await bus.publishShareChanged('a'); await bus.publishShareChanged('b')
    pub.publish.mockResolvedValue(1)
    await bus.publishShareChanged('c'); await bus.publishShareChanged('d')

    expect(warn.mock.calls.filter(([m]) => String(m).includes('single-pod mode'))).toHaveLength(1)
    expect(info.mock.calls.filter(([m]) => String(m).includes('single-pod mode'))).toHaveLength(1)
  })
})

describe('subscribing while Redis is away', () => {
  it('does not hold the caller until Redis comes back, and the subscription still works when it does', async () => {
    const mainSub = state.instances[1] as { subscribe: MockFn }
    let subscribed!: () => void
    mainSub.subscribe.mockImplementationOnce(() => new Promise<void>((resolve) => { subscribed = resolve }))
    const got: unknown[] = []

    const started = Date.now()
    await bus.subscribeShareChanged('share-away', () => got.push('changed'))
    expect(Date.now() - started).toBeLessThan(2_000)

    subscribed()
    deliverFromRedis(1, 'message', 'harness-share:share-away', '{}')
    expect(got).toEqual(['changed'])
  })

  it('does not hold a terminal subscriber either', async () => {
    const terminalSub = state.instances[2] as { subscribe: MockFn }
    terminalSub.subscribe.mockImplementationOnce(() => new Promise<void>(() => {}))
    const started = Date.now()

    await bus.subscribeTerminalDown('m-away', () => undefined)

    expect(Date.now() - started).toBeLessThan(2_000)
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

describe('redisCount', () => {
  beforeEach(() => { pub.multiCalls.length = 0; pub.multiResult = [[null, 'OK'], [null, 1]] })

  it('starts a window once, with its expiry, and counts in it', async () => {
    pub.multiResult = [[null, null], [null, 7]]
    expect(await bus.redisCount('jev:m:u1:42', 60_000)).toBe(7)
    expect(pub.multiCalls).toEqual([
      { cmd: 'set', args: ['jev:m:u1:42', '0', 'PX', 60_000, 'NX'] },
      { cmd: 'incr', args: ['jev:m:u1:42'] },
    ])
  })

  it('throws when the count did not happen, so the caller counts elsewhere', async () => {
    pub.multiResult = [[null, 'OK'], [new Error('READONLY'), null]]
    await expect(bus.redisCount('k', 1_000)).rejects.toThrow('READONLY')
    pub.multiResult = null
    await expect(bus.redisCount('k', 1_000)).rejects.toThrow('redis count failed')
  })
})

describe('Swarm stamps', () => {
  beforeEach(() => { pub.publish.mockClear() })

  it('broadcasts which Swarm moved and which stamps, and drops the broadcast while Redis is down', async () => {
    await bus.publishSwarmStamp('tab-1', ['main', 'machine'])
    expect(pub.publish.mock.calls).toEqual([['swarm-stamp', JSON.stringify({ tabId: 'tab-1', scopes: ['main', 'machine'] })]])
    pub.publish.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(bus.publishSwarmStamp('tab-1', ['main'])).resolves.toBe(0)
  })

  it('hands each broadcast to the listener, and ignores one that is not a stamp', async () => {
    const sub = state.instances[1] as unknown as { on: MockFn; subscribe: MockFn }
    const heard: unknown[] = []
    await bus.subscribeSwarmStamps((tabId, scopes) => heard.push([tabId, scopes]))
    expect(sub.subscribe).toHaveBeenCalledWith('swarm-stamp')
    const deliver = sub.on.mock.calls.find((c: unknown[]) => c[0] === 'message')![1] as (channel: string, payload: string) => void
    deliver('swarm-stamp', JSON.stringify({ tabId: 'tab-2', scopes: ['machine'] }))
    deliver('swarm-stamp', JSON.stringify({ tabId: 7 }))
    deliver('swarm-stamp', JSON.stringify({ tabId: 'tab-3', scopes: ['everything'] }))
    expect(heard).toEqual([['tab-2', ['machine']]])
  })
})

// Change 5 of docs/plans/2026-10-31-live-events-relay-design.md: a terminal app open on the account, told to its daemons.
describe('terminal app presence', () => {
  beforeEach(() => { pub.publish.mockClear(); pub.set.mockReset(); pub.set.mockResolvedValue('OK'); pub.exists.mockReset() })

  it('refreshes the account\'s key for 150 s on every open and ping, and tells the daemons at once on an open', async () => {
    await bus.noteTuiPresence('kim', 'open')
    expect(pub.set).toHaveBeenCalledWith('tui_open:kim', '1', 'EX', 150)
    expect(pub.publish.mock.calls.map((c: unknown[]) => c[0])).toEqual(['tui:kim'])
    expect(bus.TUI_OPEN_FOR_MS).toBe(180_000)
  })

  it('tells the daemons on a ping at most once a minute', async () => {
    pub.set.mockImplementation(async (...args: unknown[]) => (args[0] === 'tui_open_said:kim' ? 'OK' : 'OK'))
    await bus.noteTuiPresence('kim', 'ping')
    expect(pub.set).toHaveBeenCalledWith('tui_open_said:kim', '1', 'EX', 60, 'NX')
    expect(pub.publish).toHaveBeenCalledTimes(1)
    pub.set.mockImplementation(async (...args: unknown[]) => (args[0] === 'tui_open_said:kim' ? null : 'OK'))
    await bus.noteTuiPresence('kim', 'ping')
    expect(pub.publish).toHaveBeenCalledTimes(1)
  })

  it('reads whether one is open now, and cannot say (null) when Redis fails', async () => {
    pub.exists.mockResolvedValueOnce(1)
    await expect(bus.tuiOpenNow('kim')).resolves.toBe(true)
    pub.exists.mockResolvedValueOnce(0)
    await expect(bus.tuiOpenNow('kim')).resolves.toBe(false)
    pub.exists.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(bus.tuiOpenNow('kim')).resolves.toBeNull()
  })

  // Final review: without Redis (single-pod mode, bus.ts) the daemons on this pod must still hear a terminal app opened.
  it('still tells the daemons when Redis refuses its keys', async () => {
    pub.set.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(bus.noteTuiPresence('kim', 'open')).resolves.toBeUndefined()
    await expect(bus.noteTuiPresence('kim', 'ping')).resolves.toBeUndefined()
    expect(pub.publish.mock.calls.map((c: unknown[]) => c[0])).toEqual(['tui:kim', 'tui:kim'])
  })
})
