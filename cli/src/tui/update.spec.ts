import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { updateTui } from './install.js'
import { startTuiUpdater } from './update.js'

vi.mock('./install.js', () => ({ updateTui: vi.fn() }))
const options = { currentVersion: '0.3.28', isInstalledCopy: true, disabled: false, intervalMs: 60_000, slotSecond: 45 }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-30T01:00:00Z'))
  vi.mocked(updateTui).mockReset().mockResolvedValue(false)
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('hn automatic update schedule', () => {
  it('checks immediately and keeps checking when the CLI version has not changed', async () => {
    const updater = startTuiUpdater(options)
    expect(updateTui).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(44_999)
    expect(updateTui).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(updateTui).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(updateTui).toHaveBeenCalledTimes(3)
    updater.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(updateTui).toHaveBeenCalledTimes(3)
  })

  it.each([
    { disabled: true },
    { isInstalledCopy: false },
    { currentVersion: '0.3.28-dev.local' },
    { currentVersion: '0.0.0-dev' },
  ])('does not start for a disabled or development installation: %j', async (override) => {
    const updater = startTuiUpdater({ ...options, ...override })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(updateTui).not.toHaveBeenCalled()
    updater.stop()
  })

  it('retries after failure without overlapping a slow download', async () => {
    const log = vi.fn()
    let finish!: () => void
    vi.mocked(updateTui).mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(true) }))
    const updater = startTuiUpdater({ ...options, log })
    await vi.advanceTimersByTimeAsync(45_000)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('offline'))
    expect(updateTui).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(updateTui).toHaveBeenCalledTimes(2)
    finish()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(updateTui).toHaveBeenCalledTimes(3)
    updater.stop()
  })

  it('aborts a pending download during shutdown without logging a failure', async () => {
    const log = vi.fn()
    let signal!: AbortSignal
    vi.mocked(updateTui).mockImplementation((_log, pendingSignal) => new Promise((_resolve, reject) => {
      signal = pendingSignal!
      signal.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const updater = startTuiUpdater({ ...options, log })
    updater.stop()
    expect(signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(updateTui).toHaveBeenCalledTimes(1)
    expect(log).not.toHaveBeenCalled()
  })
})
