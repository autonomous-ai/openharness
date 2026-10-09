import { afterEach, expect, it, vi } from 'vitest'
import { externalUnavailable, type ExternalSessionAnswer } from '../../lib/externalSessionWire.js'
import { createExternalInspector } from './externalInspect.js'
const request = { sessionId: 'conversation', engine: 'claude' as const }
const free: ExternalSessionAnswer = { ok: true, request, session: null, owner: null, generation: null, busy: false }
afterEach(() => vi.useRealTimers())

it('validates exact replies, isolates throws, and fences a response from an old worker generation', async () => {
  let epoch = 1
  let reply!: (value: ExternalSessionAnswer) => void
  const call = vi.fn<() => Promise<ExternalSessionAnswer>>(async () => free)
  const inspect = createExternalInspector({ call, generation: () => epoch })
  expect(await inspect(request)).toEqual(free)
  call.mockRejectedValueOnce(new Error('reader unavailable'))
  expect(await inspect(request)).toEqual(externalUnavailable())
  call.mockImplementationOnce(() => new Promise(resolve => { reply = resolve }))
  const reading = inspect(request)
  await Promise.resolve()
  epoch++
  reply(free)
  expect(await reading).toEqual(externalUnavailable())
  expect(await inspect(request)).toEqual(free)
})

it('holds after a deadline without releasing hung work slots; a replacement worker gets fresh slots', async () => {
  vi.useFakeTimers()
  let epoch = 1
  const replies: Array<(value: ExternalSessionAnswer) => void> = []
  const call = vi.fn(() => new Promise<ExternalSessionAnswer>(resolve => replies.push(resolve)))
  const inspect = createExternalInspector({ call, generation: () => epoch, timeoutMs: 50 })
  const waiting = Array.from({ length: 4 }, () => inspect(request))
  await vi.advanceTimersByTimeAsync(51)
  expect(await Promise.all(waiting)).toEqual(Array(4).fill(externalUnavailable()))
  expect((await inspect(request)).ok).toBe(false)
  expect(call).toHaveBeenCalledTimes(4)
  epoch++
  const fresh = inspect(request)
  await Promise.resolve()
  replies[4](free)
  expect(await fresh).toEqual(free)
  for (const reply of replies.slice(0, 4)) reply(free)
  await Promise.resolve()
  call.mockResolvedValue(free)
  expect(await inspect(request)).toEqual(free)
})
