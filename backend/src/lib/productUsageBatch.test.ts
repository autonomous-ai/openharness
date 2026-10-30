import { afterEach, expect, it, vi } from 'vitest'
import { createUsageBatch } from './productUsageBatch.js'

afterEach(() => vi.useRealTimers())
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

it('commits one batch at a time, and what arrives meanwhile together in the next', async () => {
  const gate = deferred(), batches: number[][] = []
  const write = createUsageBatch<number, string>(async items => {
    batches.push(items)
    if (batches.length === 1) await gate.promise
    return items.map(item => `ok ${item}`)
  })
  const first = write(1)
  await tick()
  const rest = [2, 3, 4].map(item => write(item))
  await tick()
  expect(batches).toEqual([[1]])
  gate.resolve()
  expect(await first).toBe('ok 1')
  expect(await Promise.all(rest)).toEqual(['ok 2', 'ok 3', 'ok 4'])
  expect(batches).toEqual([[1], [2, 3, 4]])
})

it('a failed batch refuses only its own reports; the next batch still commits', async () => {
  const gate = deferred(), batches: number[][] = []
  const write = createUsageBatch<number, number>(async items => {
    batches.push(items)
    if (batches.length === 1) { await gate.promise; throw Object.assign(new Error('conflict'), { code: 'P2034' }) }
    return items
  })
  const first = write(1)
  const failed = expect(first).rejects.toMatchObject({ code: 'P2034' })
  await tick()
  const second = write(2)
  gate.resolve()
  await failed
  expect(await second).toBe(2)
  expect(batches).toEqual([[1], [2]])
})

it('splits a long queue into batches of at most the bound', async () => {
  const gate = deferred(), batches: number[][] = []
  const write = createUsageBatch<number, number>(async items => {
    batches.push(items)
    if (batches.length === 1) await gate.promise
    return items
  }, { maxBatch: 2 })
  const all = [write(0)]
  await tick()
  all.push(...[1, 2, 3, 4, 5].map(item => write(item)))
  gate.resolve()
  expect(await Promise.all(all)).toEqual([0, 1, 2, 3, 4, 5])
  expect(batches).toEqual([[0], [1, 2], [3, 4], [5]])
})

it('a full queue answers busy at once, and a report that waited too long is refused, not written', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const gate = deferred(), batches: number[][] = []
  const write = createUsageBatch<number, number>(async items => {
    batches.push(items)
    if (batches.length === 1) await gate.promise
    return items
  }, { maxQueued: 2, waitMs: 2000 })
  const first = write(0)
  await tick()
  const waited = write(1)
  vi.advanceTimersByTime(1500)
  const recent = write(2)
  await expect(write(3)).rejects.toMatchObject({ code: 'USAGE_BUSY' })
  vi.advanceTimersByTime(600)
  gate.resolve()
  expect(await first).toBe(0)
  await expect(waited).rejects.toMatchObject({ code: 'USAGE_BUSY' })
  expect(await recent).toBe(2)
  expect(batches).toEqual([[0], [2]])
})
