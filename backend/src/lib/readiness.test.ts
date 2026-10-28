import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { backendReadinessChecks, createDrain, createReadiness, drainBeforeClosing } from './readiness.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const never = (): Promise<never> => new Promise(() => {})

it('is ready when every dependency answers', async () => {
  const readiness = createReadiness({ mongo: async () => 1, redis: async () => 'PONG' })
  expect(await readiness.probe()).toEqual({ ready: true, draining: false, checks: { mongo: 'ok', redis: 'ok' } })
})

it('is not ready when one dependency fails, and names which', async () => {
  const readiness = createReadiness({
    mongo: async () => 1,
    redis: async () => { throw new Error('connect ECONNREFUSED redis://:hunter2@10.0.0.9') },
  })
  expect(await readiness.probe()).toEqual({ ready: false, draining: false, checks: { mongo: 'ok', redis: 'failed' } })
})

it('counts a check that throws before returning a promise as failed', async () => {
  const readiness = createReadiness({ mongo: () => { throw new Error('client closed') }, redis: async () => 'PONG' })
  expect(await readiness.probe()).toEqual({ ready: false, draining: false, checks: { mongo: 'failed', redis: 'ok' } })
})

it('gives up on a dependency that does not answer within 1 s', async () => {
  const readiness = createReadiness({ mongo: never, redis: async () => 'PONG' })
  const report = readiness.probe()
  await vi.advanceTimersByTimeAsync(999)
  let settled = false
  void report.then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(await report).toEqual({ ready: false, draining: false, checks: { mongo: 'timeout', redis: 'ok' } })
})

it('reuses one answer for 1 s, then asks the dependencies again', async () => {
  const mongo = vi.fn(async () => 1)
  const readiness = createReadiness({ mongo })
  await readiness.probe()
  await vi.advanceTimersByTimeAsync(999)
  await readiness.probe()
  expect(mongo).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  await readiness.probe()
  expect(mongo).toHaveBeenCalledTimes(2)
})

it('shares one ping among probes that arrive while it is still running', async () => {
  let answer!: () => void
  const mongo = vi.fn(() => new Promise<void>((resolve) => { answer = resolve }))
  const readiness = createReadiness({ mongo })
  const first = readiness.probe(), second = readiness.probe()
  answer()
  expect(await first).toEqual({ ready: true, draining: false, checks: { mongo: 'ok' } })
  expect(await second).toEqual({ ready: true, draining: false, checks: { mongo: 'ok' } })
  expect(mongo).toHaveBeenCalledTimes(1)
})

it('keeps a slow ping shared until it settles, even past the cache window', async () => {
  const mongo = vi.fn(never)
  const readiness = createReadiness({ mongo }, { timeoutMs: 1000, cacheMs: 500 })
  const first = readiness.probe()
  await vi.advanceTimersByTimeAsync(600)
  const second = readiness.probe()
  expect(mongo).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(400)
  expect(await first).toEqual(await second)
})

it('answers not ready without pinging anything once draining starts', async () => {
  const mongo = vi.fn(async () => 1)
  const drain = createDrain()
  const readiness = createReadiness({ mongo }, { drain })
  expect((await readiness.probe()).ready).toBe(true)
  drain.start()
  // The cached "ready" from a moment ago must not outlive the drain.
  expect(await readiness.probe()).toEqual({ ready: false, draining: true, checks: {} })
  await vi.advanceTimersByTimeAsync(5_000)
  expect(await readiness.probe()).toEqual({ ready: false, draining: true, checks: {} })
  expect(mongo).toHaveBeenCalledTimes(1)
})

it('answers draining even for a probe whose ping started before the drain', async () => {
  let answer!: () => void
  const drain = createDrain()
  const readiness = createReadiness({ mongo: () => new Promise<void>((resolve) => { answer = resolve }) }, { drain })
  const report = readiness.probe()
  drain.start()
  answer()
  expect(await report).toEqual({ ready: false, draining: true, checks: {} })
})

it('follows this process\' drain unless given another', async () => {
  // A fresh copy of the module, so this process' drain starts undrained and the other tests never see it drained.
  vi.resetModules()
  const fresh = await import('./readiness.js')
  const readiness = fresh.createReadiness({ mongo: async () => 1 })
  expect(fresh.processDrain.draining).toBe(false)
  expect((await readiness.probe()).draining).toBe(false)
  fresh.processDrain.start()
  expect(fresh.processDrain.draining).toBe(true)
  expect((await readiness.probe()).draining).toBe(true)
})

it('marks draining at once, then keeps serving for the delay before closing may begin', async () => {
  const drain = createDrain()
  let finished = false
  void drainBeforeClosing(drain, 3_000).then(() => { finished = true })
  expect(drain.draining).toBe(true)
  await vi.advanceTimersByTimeAsync(2_999)
  expect(finished).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(finished).toBe(true)
})

it('closes at once after marking draining when no delay is set', async () => {
  const drain = createDrain()
  await drainBeforeClosing(drain, 0)
  expect(drain.draining).toBe(true)
})

it('checks Redis only where it is configured, and Mongo always', async () => {
  const deps = { mongo: async () => 1, redis: async () => 'PONG' }
  expect(Object.keys(backendReadinessChecks({ REDIS_URL: 'redis://redis:6379' }, deps))).toEqual(['mongo', 'redis'])
  expect(Object.keys(backendReadinessChecks({}, deps))).toEqual(['mongo'])
  expect(Object.keys(backendReadinessChecks({ REDIS_URL: '' }, deps))).toEqual(['mongo'])
})
