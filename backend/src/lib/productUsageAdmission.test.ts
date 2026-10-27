import { afterEach, expect, it, vi } from 'vitest'
import { createUsageAdmission } from './productUsageAdmission.js'

afterEach(() => vi.useRealTimers())
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }

it('runs four writes at once and admits the fifth when one finishes', async () => {
  const write = createUsageAdmission(), gates = [deferred(), deferred(), deferred(), deferred()], seen: number[] = []
  const running = gates.map((gate, i) => write(async () => { seen.push(i + 1); await gate.promise; return i + 1 }))
  const fifth = write(async () => { seen.push(5); return 5 })
  await Promise.resolve()
  expect(seen).toEqual([1, 2, 3, 4])
  gates[2].resolve()
  expect(await running[2]).toBe(3)
  await Promise.resolve()
  expect(seen).toEqual([1, 2, 3, 4, 5])
  expect(await fifth).toBe(5)
  for (const gate of gates) gate.resolve()
  expect(await Promise.all(running)).toEqual([1, 2, 3, 4])
})

it('with one slot, serializes concurrent transactions in arrival order and releases after an error', async () => {
  const write = createUsageAdmission(32, 2000, 1), gate = deferred(), seen: number[] = []
  const first = write(async () => { seen.push(1); await gate.promise; throw new Error('fixture failure') })
  const failure = expect(first).rejects.toThrow('fixture failure')
  const second = write(async () => { seen.push(2); return 'second' })
  const third = write(async () => { seen.push(3); return 'third' })
  await Promise.resolve()
  expect(seen).toEqual([1])
  gate.resolve()
  await failure
  expect(await Promise.all([second, third])).toEqual(['second', 'third'])
  expect(seen).toEqual([1, 2, 3])
})

it('bounds waiting work behind every running slot and rejects overflow without executing it', async () => {
  const write = createUsageAdmission(1, 2000, 2), gate = deferred(), skipped = vi.fn()
  const running = [write(() => gate.promise), write(() => gate.promise)], queued = write(async () => 'accepted')
  await expect(write(skipped)).rejects.toMatchObject({ code: 'USAGE_BUSY' })
  expect(skipped).not.toHaveBeenCalled()
  gate.resolve()
  expect(await queued).toBe('accepted'); await Promise.all(running)
})

it('removes expired waiters; no late write, timer, or stuck admission remains', async () => {
  vi.useFakeTimers()
  const write = createUsageAdmission(2, 1000, 2), gate = deferred(), skipped = vi.fn()
  const first = Promise.all([write(() => gate.promise), write(() => gate.promise)])
  const expired = expect(write(skipped)).rejects.toMatchObject({ code: 'USAGE_BUSY' })
  await vi.advanceTimersByTimeAsync(1000)
  await expired
  const next = write(async () => 'next')
  gate.resolve(); await first
  expect(await next).toBe('next')
  expect(skipped).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  expect(await write(async () => 'idle')).toBe('idle')
})
