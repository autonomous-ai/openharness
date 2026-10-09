import { afterEach, expect, it, vi } from 'vitest'
import { loadEngine } from '../../engines/inProcess.js'
import { createReaderLoads } from './readerLoads.js'

vi.mock('../../engines/inProcess.js', () => ({ loadEngine: vi.fn() }))
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers() })

function deferred() {
  let finish!: (module: any) => void
  const promise = new Promise<any>(resolve => { finish = resolve })
  return { promise, finish }
}

it('returns available or missing code without a delayed retry', async () => {
  vi.useFakeTimers()
  const readers = createReaderLoads(), retry = vi.fn(async () => {})
  vi.mocked(loadEngine).mockResolvedValueOnce({ marker: 'loaded' } as never).mockResolvedValueOnce(null)
  expect(await readers.read('cursor', 'c', 'c1', () => true, retry)).toEqual({ marker: 'loaded' })
  expect(await readers.read('grok', 'g', 'g1', () => true, retry)).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
  expect(retry).not.toHaveBeenCalled()
})

it('bounds a stalled import and coalesces repeated attempts to one current retry per session', async () => {
  vi.useFakeTimers()
  const readers = createReaderLoads(20), code = deferred(), obsolete = vi.fn(async () => {}), retry = vi.fn(async () => {}), other = vi.fn(async () => {})
  vi.mocked(loadEngine).mockReturnValueOnce(code.promise).mockReturnValueOnce(new Promise(() => {}))
  const first = readers.read('cursor', 'c', 'c1', () => true, obsolete)
  await vi.advanceTimersByTimeAsync(20); expect(await first).toBeNull()
  const second = readers.read('cursor', 'c', 'c1', () => true, retry)
  const third = readers.read('grok', 'g', 'g1', () => true, other)
  await vi.advanceTimersByTimeAsync(20); await Promise.all([second, third])
  readers.supersede('c', 'c1') // Same authority retains the latest retry.
  code.finish({})
  await vi.advanceTimersByTimeAsync(0)
  expect(obsolete).not.toHaveBeenCalled()
  expect(retry).toHaveBeenCalledOnce()
  expect(other).not.toHaveBeenCalled()
  expect(loadEngine).toHaveBeenCalledTimes(2)
})

it.each(['forget', 'supersede', 'revoked before deadline', 'missing import'] as const)('does not retry after %s', async outcome => {
  vi.useFakeTimers()
  const readers = createReaderLoads(20), code = deferred(), retry = vi.fn(async () => {})
  vi.mocked(loadEngine).mockReturnValueOnce(code.promise)
  const reading = readers.read('cursor', 'c', 'c1', () => outcome !== 'revoked before deadline', retry)
  await vi.advanceTimersByTimeAsync(20); await reading
  if (outcome === 'forget') readers.forget('c')
  if (outcome === 'supersede') readers.supersede('c', 'c2')
  code.finish(outcome === 'missing import' ? null : {})
  await vi.advanceTimersByTimeAsync(0)
  expect(retry).not.toHaveBeenCalled()
})
