import { expect, it, vi } from 'vitest'
import { createNativeHookReadFence } from './nativeHookReadFence.js'

class RouteChanged extends Error {}
const changed = (error: unknown) => error instanceof RouteChanged

it('rechecks full authority around synchronous nested reads without sharing another root', () => {
  const full = vi.fn(), identity = vi.fn(), route = vi.fn(), otherFull = vi.fn()
  const fence = createNativeHookReadFence(full, identity, () => route, changed)
  const other = createNativeHookReadFence(otherFull, vi.fn(), () => vi.fn(), changed)
  expect(fence.run(() => {
    fence.verify()
    return fence.run(() => { fence.verify(); other.verify(); return 'observed' })
  })).toBe('observed')
  expect(full).toHaveBeenCalledTimes(2)
  expect(identity).toHaveBeenCalledTimes(3)
  expect(route).toHaveBeenCalledOnce()
  expect(otherFull).toHaveBeenCalledOnce()
  fence.verify()
  expect(full).toHaveBeenCalledTimes(3)
})

it('discards a changed route and its result with one retry budget for all nesting', () => {
  let attempts = 0
  const after = vi.fn(), full = vi.fn()
  const fence = createNativeHookReadFence(full, vi.fn(), () => () => {
    if (attempts < 3) throw new RouteChanged()
  }, changed)
  expect(fence.run(() => fence.run(() => ++attempts, after))).toBe(3)
  expect(attempts).toBe(3)
  expect(after).toHaveBeenCalledOnce()
  expect(full).toHaveBeenCalledTimes(4)
  const unstable = createNativeHookReadFence(vi.fn(), vi.fn(), () => () => { throw new RouteChanged() }, changed)
  const read = vi.fn(() => unstable.run(() => undefined))
  expect(() => unstable.run(read)).toThrow(RouteChanged)
  expect(read).toHaveBeenCalledTimes(3)
})

it('never retries a failed leaf and restores full checks after either kind of failure', () => {
  const full = vi.fn(), read = vi.fn(() => { throw Error('leaf replaced') })
  const fence = createNativeHookReadFence(full, vi.fn(), () => vi.fn(), changed)
  expect(() => fence.run(read)).toThrow('leaf replaced')
  expect(read).toHaveBeenCalledOnce()
  fence.verify()
  expect(full).toHaveBeenCalledTimes(2)
  const unstable = createNativeHookReadFence(full, vi.fn(), () => () => { throw new RouteChanged() }, changed)
  expect(() => unstable.run(() => undefined)).toThrow(RouteChanged)
  const prior = full.mock.calls.length
  unstable.verify()
  expect(full).toHaveBeenCalledTimes(prior + 1)
})

it('rejects async callbacks and does not extend the cheap scope past an await', async () => {
  const full = vi.fn(), identity = vi.fn()
  const fence = createNativeHookReadFence(full, identity, () => vi.fn(), changed)
  const continued = vi.fn()
  expect(() => fence.run(async () => {
    fence.verify()
    await Promise.resolve()
    fence.verify(); continued()
  })).toThrow('synchronous callbacks')
  await Promise.resolve()
  expect(continued).toHaveBeenCalledOnce()
  expect(full).toHaveBeenCalledTimes(2)
  expect(identity).toHaveBeenCalledOnce()
  expect(() => fence.run(() => ({ then: () => undefined }))).toThrow('synchronous callbacks')
})

it('checks nested owners after the outer exit proof can revoke them or exhaust their deadline', () => {
  let valid = true, checks = 0
  const fence = createNativeHookReadFence(() => { if (++checks === 2) valid = false }, vi.fn(), () => vi.fn(), changed)
  const owner = () => { if (!valid) throw Error('owner expired') }
  expect(() => fence.run(() => fence.run(owner, owner))).toThrow('owner expired')
  expect(checks).toBe(2)
})

it('does not publish a result or run final checks when the exit authority fails', () => {
  let checks = 0
  const after = vi.fn()
  const fence = createNativeHookReadFence(() => { if (++checks === 2) throw Error('root replaced') }, vi.fn(), () => vi.fn(), changed)
  expect(() => fence.run(() => 'untrusted result', after)).toThrow('root replaced')
  expect(after).not.toHaveBeenCalled()
  fence.verify()
  expect(checks).toBe(3)
})
