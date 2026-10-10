import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentCreationReceipts, creationFingerprint } from '../../lib/agentCreationReceipt.js'
import { createPendingLaunches, type IntentReceipts, type PreparedCreation } from './pendingLaunches.js'

const roots: string[] = []
const stops: Array<() => void> = []
const held = { service: 'models', detail: 'Waiting for the model.' }
const request = { kind: 'fixture' }
const fingerprint = creationFingerprint(request)
const id = (n: number) => `fixture-creation-${n}`
const created = { state: 'created' as const, agentId: 'fixture-agent' }
afterEach(() => {
  stops.splice(0).forEach(stop => stop())
  vi.useRealTimers()
  vi.restoreAllMocks()
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }))
})
function setup(prepare = vi.fn<Parameters<typeof createPendingLaunches>[0]['prepare']>(), receipts?: IntentReceipts) {
  const root = mkdtempSync(join(tmpdir(), 'pending-launches-')); roots.push(root)
  const store = new AgentCreationReceipts(join(root, 'receipts'))
  const pending = createPendingLaunches({ receipts: receipts ?? store, prepare })
  stops.push(pending.stop)
  return { pending, store, prepare }
}

it('opens recovery after readiness, preserves pending intent and completes it once', async () => {
  const effect = vi.fn(async () => created)
  const prepare = vi.fn(async () => effect)
  const { pending, store } = setup(prepare)
  await store.runIntent(id(0), fingerprint, request, held, async () => null)
  await pending.recover()
  expect(prepare).not.toHaveBeenCalled()
  pending.open()
  pending.open()
  expect(pending.recover()).toBe(pending.recover())
  await pending.recover()
  await vi.waitFor(() => expect(store.status(id(0))).toEqual(created))
  await pending.recover()
  expect(effect).toHaveBeenCalledOnce()
  pending.stop()
  await pending.recover()
  pending.open()
  expect(effect).toHaveBeenCalledOnce()
})

it('bounds stalled preparations and retains their slots instead of accumulating promises', async () => {
  vi.useFakeTimers()
  const finish: Array<(value: PreparedCreation) => void> = []
  const prepare = vi.fn(() => new Promise<PreparedCreation>(resolve => finish.push(resolve)))
  const { pending, store } = setup(prepare)
  const jobs = Array.from({ length: 8 }, (_, n) => pending.start(id(n), fingerprint, request, held))
  await vi.advanceTimersByTimeAsync(5_000)
  expect(await Promise.all(jobs)).toEqual(Array.from({ length: 8 }, () => ({ state: 'pending', held })))
  expect(prepare).toHaveBeenCalledTimes(4)
  expect(await pending.start(id(8), fingerprint, request, held)).toEqual({ state: 'pending', held })
  expect(prepare).toHaveBeenCalledTimes(4)
  const effect = vi.fn(async () => created)
  finish.splice(0).forEach(resolve => resolve(effect))
  await vi.advanceTimersByTimeAsync(0)
  expect(effect).toHaveBeenCalledTimes(4)
  prepare.mockResolvedValue(effect)
  expect(await pending.start(id(0), fingerprint, request, held)).toEqual(created)
  expect(store.status(id(1))).toEqual(created)
})

it('retries rejected dependencies on its timer and stops old preflight completions', async () => {
  vi.useFakeTimers()
  const prepare = vi.fn().mockRejectedValueOnce(new Error('service disconnected'))
  const { pending, store } = setup(prepare)
  expect(await pending.start(id(0), fingerprint, request, held)).toEqual({ state: 'pending', held })
  pending.open()
  // Recovery starts after opendir; the explicit pass joins it.
  await pending.recover()
  let finish!: (value: PreparedCreation) => void
  prepare.mockImplementationOnce(() => new Promise<PreparedCreation>(resolve => { finish = resolve }))
  const running = pending.start(id(1), fingerprint, request, held)
  await vi.advanceTimersByTimeAsync(0)
  pending.stop()
  const effect = vi.fn(async () => created)
  finish(effect)
  expect(await running).toEqual({ state: 'pending', held })
  expect(effect).not.toHaveBeenCalled()
  expect(store.status(id(1))).toEqual({ state: 'pending', held })
  expect(await pending.start(id(2), fingerprint, request, held)).toEqual({ state: 'pending', held })
  await vi.advanceTimersByTimeAsync(2_000)
})

it('runs a streaming recovery four at a time and isolates a failed journal or request', async () => {
  const callbacks: Array<() => void> = []
  const prepare = vi.fn(() => new Promise<PreparedCreation>(resolve => callbacks.push(() => resolve(async () => created))))
  const { pending, store } = setup(prepare)
  for (let n = 0; n < 6; n++) await store.runIntent(id(n), fingerprint, request, held, async () => null)
  pending.open()
  await vi.waitFor(() => expect(callbacks).toHaveLength(4))
  expect(prepare).toHaveBeenCalledTimes(4)
  callbacks.splice(0).forEach(done => done())
  await vi.waitFor(() => expect(callbacks).toHaveLength(2), { timeout: 4_000 })
  callbacks.splice(0).forEach(done => done())
  await pending.recover()
  expect(prepare).toHaveBeenCalledTimes(6)
  await vi.waitFor(() => expect(store.status(id(5))).toEqual(created))

  const refused = vi.fn(() => { throw new Error('disk failed') })
  const damaged = setup(vi.fn(), { runIntent: refused, cancelIntent: vi.fn(), pendingIntent: vi.fn(() => ({ id: id(9), fingerprint, request, held })),
    pendingIntents: async function* () { yield { id: id(9), fingerprint, request, held }; throw new Error('directory unavailable') } })
  damaged.pending.open()
  await damaged.pending.recover()
  await vi.waitFor(() => expect(refused).toHaveBeenCalledOnce())
  damaged.pending.stop()
})

it('does not claim work yielded after shutdown or execute work stopped just after preparation', async () => {
  let yielded!: () => void
  const waiting = new Promise<void>(resolve => { yielded = resolve })
  const receipts: IntentReceipts = { runIntent: vi.fn(), cancelIntent: vi.fn(), pendingIntent: vi.fn(() => ({ id: id(9), fingerprint, request, held })), pendingIntents: async function* () {
    await waiting
    yield { id: id(0), fingerprint, request, held }
  } }
  const first = setup(vi.fn(), receipts)
  first.pending.open()
  first.pending.stop()
  yielded()
  await first.pending.recover()
  await vi.waitFor(() => expect(receipts.runIntent).not.toHaveBeenCalled())

  const effect = vi.fn(async () => created)
  const second = setup(vi.fn(async () => effect), { ...receipts, runIntent: async (_id, _fingerprint, request, _held, prepare) => {
    const ready = await prepare(request)
    second.pending.stop()
    return ready!()
  } })
  expect(await second.pending.start(id(1), fingerprint, request, held)).toEqual({ state: 'unconfirmed' })
  expect(effect).not.toHaveBeenCalled()
})

it('keeps one preparation per ID even after the service deadline, then retries after settlement', async () => {
  vi.useFakeTimers()
  let finish!: (value: PreparedCreation) => void
  const prepare = vi.fn(() => new Promise<PreparedCreation>(resolve => { finish = resolve }))
  const { pending } = setup(prepare)
  const first = pending.start(id(0), fingerprint, request, held)
  await vi.advanceTimersByTimeAsync(185_000)
  expect(await first).toEqual({ state: 'pending', held })
  expect(await pending.start(id(0), fingerprint, request, held)).toEqual({ state: 'pending', held })
  expect(prepare).toHaveBeenCalledOnce()
  const effect = vi.fn(async () => created)
  finish(effect)
  await vi.advanceTimersByTimeAsync(0)
  expect(effect).not.toHaveBeenCalled()
  prepare.mockResolvedValue(effect)
  expect(await pending.start(id(0), fingerprint, request, held)).toEqual(created)
  expect(effect).toHaveBeenCalledOnce()
})

it('bounds a large history per event-loop turn and does not keep retrying completed IDs', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(0)
  let examined = 0
  const intent = { id: id(0), fingerprint, request, held }
  const receipts: IntentReceipts = {
    runIntent: vi.fn().mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValue({ state: 'pending', held }),
    cancelIntent: vi.fn(), pendingIntent: vi.fn(() => intent),
    pendingIntents: async function* () {
      for (let n = 0; n < 130; n++) { examined++; yield null }
      yield intent
    },
  }
  const { pending } = setup(vi.fn(), receipts)
  pending.open()
  await pending.recover()
  expect(examined).toBe(64)
  await vi.waitFor(() => expect(receipts.runIntent).toHaveBeenCalledOnce())
  expect(examined).toBe(130)
  vi.mocked(receipts.pendingIntent).mockReturnValue(null)
  // A later cancellation/completion is read from disk, then removed from the
  // retry set rather than retained as an ever-growing outcome cache.
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_000)
  await pending.recover(); await pending.recover()
  expect(receipts.runIntent).toHaveBeenCalledOnce()
})

it('contains a directory-close error on shutdown', async () => {
  const scan = (async function* () { for (;;) yield null })()
  vi.spyOn(scan, 'return').mockRejectedValueOnce(new Error('directory closed'))
  const receipts: IntentReceipts = { runIntent: vi.fn(), cancelIntent: vi.fn(), pendingIntent: vi.fn(), pendingIntents: () => scan }
  const { pending } = setup(vi.fn(), receipts)
  pending.open()
  await pending.recover()
  pending.stop()
  await Promise.resolve()
  expect(scan.return).toHaveBeenCalledOnce()
  expect(receipts.runIntent).not.toHaveBeenCalled()
})

it('bounds the retry window and visits the backlog beyond permanently held or damaged early IDs', async () => {
  vi.useFakeTimers()
  vi.spyOn(performance, 'now').mockReturnValue(0)
  const attempted = new Set<string>()
  let scanned = 0
  let largestBacklog = 0
  const receipts: IntentReceipts = {
    runIntent: vi.fn(async () => ({ state: 'pending' as const, held })), cancelIntent: vi.fn(),
    pendingIntent: vi.fn(key => {
      attempted.add(key)
      if (key === id(32)) throw new Error('damaged intent')
      return { id: key, fingerprint, request, held }
    }),
    pendingIntents: async function* () {
      for (let n = 0; n < 260; n++) {
        scanned++
        largestBacklog = Math.max(largestBacklog, scanned - attempted.size)
        yield { id: id(n), fingerprint, request, held }
      }
    },
  }
  const { pending } = setup(vi.fn(), receipts)
  pending.open()
  await vi.advanceTimersByTimeAsync(20_000)
  expect(largestBacklog).toBeLessThanOrEqual(128)
  expect(attempted.size).toBe(260)
  // An explicit new request while the window is full still receives its saved
  // hold; the window size never becomes a reason to reject durable admission.
  for (let n = 300; n < 450; n++) expect(await pending.start(id(n), fingerprint, request, held)).toEqual({ state: 'pending', held })
})

it('includes synchronous retry reads in the event-loop work budget', async () => {
  let work = 0
  vi.spyOn(performance, 'now').mockImplementation(() => work)
  const receipts: IntentReceipts = {
    runIntent: vi.fn(async () => ({ state: 'pending' as const, held })), cancelIntent: vi.fn(),
    pendingIntent: vi.fn(key => { work += 21; return { id: key, fingerprint, request, held } }),
    pendingIntents: async function* () { for (let n = 0; n < 5; n++) yield { id: id(n), fingerprint, request, held } },
  }
  const { pending } = setup(vi.fn(), receipts)
  pending.open(); await pending.recover()
  await pending.recover()
  expect(receipts.pendingIntent).toHaveBeenCalledOnce()
})
