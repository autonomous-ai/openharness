import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPendingAdmissions, type AdmissionDecision, type PendingAdmission } from './pendingAdmission.js'

afterEach(() => vi.useRealTimers())
function request(overrides: Partial<PendingAdmission<string>> = {}): PendingAdmission<string> {
  return { current: () => true, inspect: vi.fn(async () => ({ kind: 'accept' as const, value: 'home' })),
    accept: vi.fn(), reject: vi.fn(), held: vi.fn(), ...overrides }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

describe('pending hook admission', () => {
  it('isolates a failed notification without repeating publication or losing a held retry', async () => {
    vi.useFakeTimers()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const queue = createPendingAdmissions({ retryMs: 20 })
    const failure = () => { throw new Error('notification failed') }
    const accept = vi.fn(failure)
    queue.submit('accepted', request({ accept })); await flush()
    const inspect = vi.fn<PendingAdmission<string>['inspect']>()
      .mockResolvedValueOnce({ kind: 'hold', reason: 'unavailable' })
      .mockResolvedValueOnce({ kind: 'accept', value: 'recovered' })
    const held = request({ inspect, held: failure })
    queue.submit('held', held); await flush()
    await vi.advanceTimersByTimeAsync(20)
    expect(held.accept).toHaveBeenCalledExactlyOnceWith('recovered')
    expect(accept).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    queue.close(); warning.mockRestore()
  })

  it('holds without publishing, logs a reason once, and automatically admits after recovery', async () => {
    vi.useFakeTimers()
    const queue = createPendingAdmissions()
    const inspect = vi.fn<PendingAdmission<string>['inspect']>()
      .mockResolvedValueOnce({ kind: 'hold', reason: 'store unavailable' })
      .mockResolvedValueOnce({ kind: 'hold', reason: 'store unavailable' })
      .mockResolvedValueOnce({ kind: 'hold', reason: 'waiting for its row' })
      .mockResolvedValueOnce({ kind: 'accept', value: 'own home' })
    const r = request({ inspect })
    queue.submit('agent', r); await flush()
    expect(r.accept).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(r.held).toHaveBeenCalledTimes(2)
    expect(r.accept).toHaveBeenCalledExactlyOnceWith('own home')
    expect(r.reject).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    queue.close()
  })

  it('rejects a verified child and keeps unexpected read failures pending', async () => {
    vi.useFakeTimers()
    const queue = createPendingAdmissions({ retryMs: 20 })
    const inspect = vi.fn<PendingAdmission<string>['inspect']>()
      .mockRejectedValueOnce(new Error('broken reader'))
      .mockResolvedValueOnce({ kind: 'reject', reason: 'delegated' })
    const r = request({ inspect })
    queue.submit('agent', r); await flush()
    expect(r.held).toHaveBeenCalledWith('The session source could not be read.')
    await vi.advanceTimersByTimeAsync(20)
    expect(r.reject).toHaveBeenCalledExactlyOnceWith('delegated')
    expect(r.accept).not.toHaveBeenCalled()
    queue.close()
  })

  it('fences an old hook, a changed binding, and shutdown during the read', async () => {
    vi.useFakeTimers()
    for (const change of ['replace', 'binding', 'close'] as const) {
      const queue = createPendingAdmissions()
      let finish!: (value: AdmissionDecision<string>) => void
      let current = true
      const old = request({ current: () => current, inspect: () => new Promise(resolve => { finish = resolve }) })
      queue.submit('agent', old)
      const newer = request()
      if (change === 'replace') queue.submit('agent', newer)
      if (change === 'binding') current = false
      if (change === 'close') queue.close()
      finish({ kind: 'accept', value: 'stale' }); await flush()
      expect(old.accept).not.toHaveBeenCalled()
      expect(old.held).not.toHaveBeenCalled()
      if (change === 'replace') expect(newer.accept).toHaveBeenCalledOnce()
      queue.close()
    }
  })

  it('drops stale work before lookup and clears replaced or closed retry timers', async () => {
    vi.useFakeTimers()
    const queue = createPendingAdmissions()
    const stale = request({ current: () => false })
    queue.submit('stale', stale)
    expect(stale.inspect).not.toHaveBeenCalled()
    let active = true
    const held = request({ current: () => active, inspect: async () => ({ kind: 'hold', reason: 'unreadable' }) })
    queue.submit('first', held); await flush()
    queue.submit('first', request()); await flush()
    expect(vi.getTimerCount()).toBe(0)
    queue.submit('first', held); await flush()
    active = false
    await vi.advanceTimersByTimeAsync(1_000)
    expect(vi.getTimerCount()).toBe(0)
    active = true
    queue.submit('first', held); await flush()
    queue.close()
    expect(vi.getTimerCount()).toBe(0)
    const after = request()
    queue.submit('after', after)
    expect(after.inspect).not.toHaveBeenCalled()
  })
})
