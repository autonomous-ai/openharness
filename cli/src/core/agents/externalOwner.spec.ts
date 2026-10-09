import { afterEach, expect, it, vi } from 'vitest'
import { stopExternalOwner } from './externalOwner.js'
import { externalProcessGeneration } from '../../lib/externalProcessGeneration.js'
import { processExists } from '../../lib/processLiveness.js'
import { verifiedForegroundJob } from '../../lib/externalOwnerControl.js'
vi.mock('../../lib/externalProcessGeneration.js', () => ({ externalProcessGeneration: vi.fn(() => 'ps:1') }))
vi.mock('../../lib/processLiveness.js', () => ({ processExists: vi.fn(() => true) }))
vi.mock('../../lib/externalOwnerControl.js', () => ({ verifiedForegroundJob: vi.fn(async () => null) }))
const owner = { process: { pid: 7, engine: 'claude' as const, tty: '/dev/fixture-terminal', record: '/fixture/record' }, generation: 'ps:1' }
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers() })
function setup() {
  let alive = true, valid = true, marker = 'ps:1'
  const deps = { current: () => valid, same: vi.fn(async () => true), generation: () => marker, exists: () => alive,
    job: vi.fn(async (): Promise<number | null | 'unknown'> => 7), kill: vi.fn(() => { alive = false }), sleep: vi.fn(async () => {}) }
  return { deps, gone: () => { alive = false }, cancel: () => { valid = false }, replace: () => { marker = 'ps:2' } }
}
it('rechecks conversation after foreground lookup, journals at the signal and stops only its verified group', async () => {
  const test = setup(), order: string[] = []
  test.deps.job.mockImplementation(async () => { order.push('job'); return 7 })
  test.deps.same.mockImplementation(async () => { order.push('same'); return true })
  const result = await stopExternalOwner(owner, { ...test.deps,
    beforeSignal: () => order.push('intent'), afterSignal: () => order.push('sent') })
  expect(result).toBe(true)
  expect(order).toEqual(['job', 'same', 'intent', 'sent'])
  expect(test.deps.kill).toHaveBeenCalledWith(-7, 'SIGTERM')
})
it('holds unknown foreground evidence and changed or cancelled ownership without signalling', async () => {
  for (const mode of ['unknown', 'throws', 'moved', 'cancelled', 'replaced', 'cancel-after-read'] as const) {
    const test = setup()
    if (mode === 'unknown') test.deps.job.mockResolvedValue('unknown')
    if (mode === 'throws') test.deps.job.mockRejectedValue(new Error('ps failed'))
    if (mode === 'moved') test.deps.same.mockResolvedValue(false)
    if (mode === 'cancelled') test.cancel()
    if (mode === 'replaced') test.replace()
    if (mode === 'cancel-after-read') test.deps.same.mockImplementation(async () => { test.cancel(); return true })
    expect(await stopExternalOwner(owner, test.deps)).toBe(false)
    expect(test.deps.kill).not.toHaveBeenCalled()
  }
})
it('does not signal an exited owner, and checks the incarnation after a durable signal intent', async () => {
  const gone = setup(); gone.gone()
  expect(await stopExternalOwner(owner, gone.deps)).toBe(true)
  expect(gone.deps.kill).not.toHaveBeenCalled()
  for (const change of ['cancel', 'replace'] as const) {
    const test = setup()
    expect(await stopExternalOwner(owner, { ...test.deps, beforeSignal: test[change] })).toBe(false)
    expect(test.deps.kill).not.toHaveBeenCalled()
  }
})
it('rechecks the group and consent before KILL and never kills a replacement or cancelled process', async () => {
  const test = setup()
  test.deps.kill.mockImplementation((_pid?: number, signal?: NodeJS.Signals) => { if (signal === 'SIGKILL') test.gone() })
  expect(await stopExternalOwner(owner, test.deps)).toBe(true)
  expect(test.deps.job).toHaveBeenCalledTimes(2)
  expect(test.deps.same).toHaveBeenCalledTimes(2)
  for (const reason of ['cancel', 'replace', 'moved'] as const) {
    const test = setup(); test.deps.kill.mockImplementation(() => {})
    if (reason === 'moved') test.deps.same.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    else test.deps.sleep.mockImplementation(async () => { test[reason]() })
    expect(await stopExternalOwner(owner, test.deps)).toBe(false)
    expect(test.deps.kill).toHaveBeenCalledTimes(1)
  }
})
it('reports a stubborn owner or signal failure as unconfirmed, but recognizes exit during a signal race', async () => {
  const stubborn = setup(); stubborn.deps.kill.mockImplementation(() => {})
  expect(await stopExternalOwner(owner, stubborn.deps)).toBe(false)
  for (const gone of [true, false]) {
    const test = setup(); test.deps.job.mockResolvedValue(null)
    test.deps.kill.mockImplementation(() => { if (gone) test.gone(); throw new Error('signal refused') })
    expect(await stopExternalOwner(owner, test.deps)).toBe(gone)
    expect(test.deps.kill).toHaveBeenCalledWith(7, 'SIGTERM')
  }
})
it('uses the core OS controls by default, with a bounded wait and no terminal writes after exit', async () => {
  vi.useFakeTimers()
  vi.mocked(processExists).mockReturnValue(true)
  vi.mocked(externalProcessGeneration).mockReturnValue('ps:1')
  vi.mocked(verifiedForegroundJob).mockResolvedValue(null)
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
  const done = stopExternalOwner(owner, { current: () => true, same: async () => true })
  await vi.advanceTimersByTimeAsync(100)
  vi.mocked(processExists).mockReturnValue(false)
  await vi.advanceTimersByTimeAsync(100)
  expect(await done).toBe(true)
  expect(kill).toHaveBeenCalledWith(7, 'SIGTERM')
})
