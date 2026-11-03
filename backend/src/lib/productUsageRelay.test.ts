import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRelayTotals } from './productUsageRelay.js'
import type { UsageIncrement } from './productUsageWrite.js'

const day = new Date('2026-10-29T00:00:00Z')
const nextDay = new Date('2026-10-30T00:00:00Z')
type Write = (id: string, increments: UsageIncrement[]) => Promise<void>
const setup = (write: Write, options: Partial<Parameters<typeof createRelayTotals>[0]> = {}) => {
  let n = 0
  return createRelayTotals({ write, newId: () => `batch-${++n}`, warn: () => {}, ...options })
}
const sorted = (increments: UsageIncrement[]) =>
  increments.map(i => [i.dayUtc.toISOString().slice(0, 10), i.metric, i.value]).sort()

describe('relay totals', () => {
  it('many connects in a minute are one increment per day and metric, equal to their sum', async () => {
    const write = vi.fn<Write>(async () => {})
    const totals = setup(write)
    for (let i = 0; i < 300; i++) totals.add(day, 'relay_tui_opens')
    for (let i = 0; i < 40; i++) totals.add(day, 'relay_machine_connections')
    for (let i = 0; i < 7; i++) totals.add(nextDay, 'relay_tui_opens')
    expect(write).not.toHaveBeenCalled()
    await totals.flush()
    expect(write).toHaveBeenCalledOnce()
    expect(write.mock.calls[0][0]).toBe('batch-1')
    expect(sorted(write.mock.calls[0][1])).toEqual([
      ['2026-10-29', 'relay_machine_connections', 40], ['2026-10-29', 'relay_tui_opens', 300], ['2026-10-30', 'relay_tui_opens', 7]])
  })

  it('writes nothing when nothing was counted', async () => {
    const write = vi.fn<Write>(async () => {})
    await setup(write).flush()
    expect(write).not.toHaveBeenCalled()
  })

  it('counts connects that arrive during a flush in the next one, never twice', async () => {
    let release!: () => void
    const write = vi.fn<Write>(() => new Promise<void>(resolve => { release = resolve }))
    const totals = setup(write)
    totals.add(day, 'm')
    const first = totals.flush()
    totals.add(day, 'm')
    totals.add(day, 'm')
    release()
    await first
    write.mockImplementation(async () => {})
    await totals.flush()
    expect(write.mock.calls.map(([, increments]) => sorted(increments))).toEqual([[['2026-10-29', 'm', 1]], [['2026-10-29', 'm', 2]]])
  })

  it('does not start a second flush while one is writing', async () => {
    let release!: () => void
    const write = vi.fn<Write>(() => new Promise<void>(resolve => { release = resolve }))
    const totals = setup(write)
    totals.add(day, 'm')
    const first = totals.flush()
    const second = totals.flush()
    release()
    await Promise.all([first, second])
    expect(write).toHaveBeenCalledOnce()
  })

  it('retries a failed batch under the same id, so a write that did commit is not counted twice', async () => {
    const write = vi.fn<Write>().mockRejectedValueOnce(new Error('connection reset')).mockResolvedValue(undefined)
    const totals = setup(write)
    totals.add(day, 'm')
    await totals.flush()
    totals.add(day, 'm')
    await totals.flush()
    expect(write).toHaveBeenCalledTimes(3)
    expect(write.mock.calls.map(([id]) => id)).toEqual(['batch-1', 'batch-1', 'batch-2'])
    expect(write.mock.calls[1][1]).toEqual(write.mock.calls[0][1])
    expect(sorted(write.mock.calls[2][1])).toEqual([['2026-10-29', 'm', 1]])
  })

  it('gives up on a batch that keeps failing and warns without an identity', async () => {
    const warn = vi.fn()
    const write = vi.fn<Write>().mockRejectedValue(new Error('PRIVATE_DATABASE_CANARY'))
    const totals = setup(write, { retries: 3, warn })
    totals.add(day, 'm')
    for (let i = 0; i < 5; i++) await totals.flush()
    expect(write).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalled()
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_')
  })

  it('flushes at once when too many different totals are waiting', async () => {
    const write = vi.fn<Write>(async () => {})
    const totals = setup(write, { maxKeys: 3 })
    for (const metric of ['a', 'b']) totals.add(day, metric)
    expect(write).not.toHaveBeenCalled()
    totals.add(day, 'c')
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
  })

  it('drops new totals instead of growing without bound while the database is down', async () => {
    const warn = vi.fn()
    const write = vi.fn<Write>().mockRejectedValue(new Error('down'))
    const totals = setup(write, { maxKeys: 2, retries: 100, warn })
    totals.add(day, 'a'); totals.add(day, 'b')
    await totals.flush()
    for (const metric of ['c', 'd', 'e', 'f', 'g']) totals.add(day, metric)
    write.mockImplementation(async () => {})
    await totals.flush()
    await totals.flush()
    const written = write.mock.calls.flatMap(([, increments]) => increments.map(i => i.metric))
    expect(written.filter(m => m === 'g')).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  describe('timer', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it('flushes once a minute and once more on stop, so a clean shutdown loses nothing', async () => {
      const write = vi.fn<Write>(async () => {})
      const totals = setup(write, { firstDelayMs: 60_000 })
      const stop = totals.start()
      totals.add(day, 'm')
      await vi.advanceTimersByTimeAsync(59_000)
      expect(write).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(write).toHaveBeenCalledOnce()
      totals.add(day, 'm')
      await stop()
      expect(write).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(write).toHaveBeenCalledTimes(2)
    })

    it('starts its minute at a different moment in each process', async () => {
      const write = vi.fn<Write>(async () => {})
      const totals = setup(write, { firstDelayMs: 80_000 })
      const stop = totals.start()
      totals.add(day, 'm')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(write).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(write).toHaveBeenCalledOnce()
      await stop()
    })
  })
})
