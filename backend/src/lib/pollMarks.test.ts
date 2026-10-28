import { describe, expect, it, vi } from 'vitest'
import { redisPollMarks } from './pollMarks.js'

vi.mock('./bus.js', () => ({ pub: {} }))

/** Redis's EXISTS and SET … PX, on a clock the test moves. */
function fakeRedis() {
  let now = 0
  const keys = new Map<string, number>()
  return {
    wait: (ms: number) => { now += ms },
    keys,
    client: {
      exists: async (key: string) => (keys.get(key) ?? -1) > now ? 1 : 0,
      set: async (key: string, _value: string, _mode: 'PX', ms: number) => { keys.set(key, now + ms); return 'OK' as const },
    },
  }
}
const down = { exists: async () => { throw new Error('Connection is closed.') }, set: async () => { throw new Error('Connection is closed.') } }

describe('the quiet delivery poll\'s memory, shared by every server through Redis', () => {
  it('remembers a full poll for 30 s, for that key alone', async () => {
    const redis = fakeRedis(), marks = redisPollMarks(redis.client as never)
    expect(await marks.recent('tab:agent:caller')).toBe(false)
    await marks.mark('tab:agent:caller')
    redis.wait(29_999)
    expect(await marks.recent('tab:agent:caller')).toBe(true)
    expect(await marks.recent('tab:agent:other')).toBe(false)
    redis.wait(1)
    expect(await marks.recent('tab:agent:caller')).toBe(false)
  })

  it('keeps its keys apart from everything else in Redis', async () => {
    const redis = fakeRedis()
    await redisPollMarks(redis.client as never).mark('tab:agent:caller')
    expect([...redis.keys.keys()]).toEqual(['superTabs:polled:tab:agent:caller'])
  })

  // A Redis outage must cost CPU, never authority: with no memory every poll runs the full checks.
  it('with Redis down, remembers nothing and never fails the poll, and says so once', async () => {
    const warn = vi.fn()
    const marks = redisPollMarks(down as never, warn)
    await expect(marks.mark('tab:agent:caller')).resolves.toBeUndefined()
    expect(await marks.recent('tab:agent:caller')).toBe(false)
    expect(await marks.recent('tab:agent:caller')).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('says so again after Redis came back and failed once more', async () => {
    const warn = vi.fn(), redis = fakeRedis()
    let failing = true
    const flaky = { exists: (key: string) => failing ? down.exists() : redis.client.exists(key),
      set: (key: string, value: string, mode: 'PX', ms: number) => failing ? down.set() : redis.client.set(key, value, mode, ms) }
    const marks = redisPollMarks(flaky as never, warn)
    await marks.recent('k')
    failing = false
    await marks.mark('k')
    expect(await marks.recent('k')).toBe(true)
    failing = true
    await marks.recent('k')
    expect(warn).toHaveBeenCalledTimes(2)
  })
})
