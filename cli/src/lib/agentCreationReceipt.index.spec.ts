import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentCreationReceipts, creationFingerprint, type AgentCreationOutcome } from './agentCreationReceipt.js'

const roots: string[] = []
const id = 'indexed-creation-0001'
const held = { service: 'models', detail: 'Waiting for the selected model.' }
const request = { kind: 'fixture', text: 'original' }
const fingerprint = creationFingerprint(request)
const created = { state: 'created' as const, agentId: 'fixture-agent' }
function fixture(ensure: (id: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'creation-index-admission-')); roots.push(root)
  const directory = join(root, 'receipts')
  return { root, directory, receipts: new AgentCreationReceipts(directory, ensure), legacy: new AgentCreationReceipts(directory) }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('pins a new request before marker admission, coalesces duplicates and publishes only after it', async () => {
  const marker = deferred<void>(), ensure = vi.fn(() => marker.promise)
  const { receipts } = fixture(ensure), mutable = structuredClone(request), mutableHold = { ...held }
  const prepare = vi.fn(async (saved: Record<string, unknown>) => { expect(saved).toEqual(request); return async () => created })
  const first = receipts.runIntent(id, fingerprint, mutable, mutableHold, prepare)
  const duplicate = receipts.runIntent(id, fingerprint, mutable, mutableHold, prepare)
  expect(duplicate).toBe(first)
  mutable.text = 'changed'; mutableHold.detail = 'changed'
  await vi.waitFor(() => expect(ensure).toHaveBeenCalledExactlyOnceWith(id))
  expect(receipts.status(id)).toEqual({ state: 'missing' })
  expect(prepare).not.toHaveBeenCalled()
  marker.resolve()
  expect(await first).toEqual(created)
  expect(prepare).toHaveBeenCalledOnce()
})

it.each(['created', 'failed', 'cancelled', 'unconfirmed'] as const)('replays %s independently of unavailable marker storage', async state => {
  const ensure = vi.fn(async () => { throw new Error('index unavailable') })
  const { receipts, legacy } = fixture(ensure)
  if (state === 'cancelled') legacy.cancelIntent(id)
  else await legacy.runIntent(id, fingerprint, request, held, async () => async () => state === 'created' ? created
    : state === 'failed' ? { state, error: 'fixture-refusal' } : { state })
  const prepare = vi.fn(async () => async () => created)
  expect((await receipts.runIntent(id, fingerprint, request, held, prepare)).state).toBe(state)
  expect(ensure).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled()
})

it('keeps an admitted slow preparation owned after its reply deadline and ignores index availability for a duplicate', async () => {
  vi.useFakeTimers()
  const ensure = vi.fn(async () => {}), ready = deferred<(() => Promise<AgentCreationOutcome>) | null>()
  const { receipts } = fixture(ensure)
  const prepare = vi.fn(() => ready.promise), effect = vi.fn(async () => created)
  const first = receipts.runIntent(id, fingerprint, request, held, prepare)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(await first).toEqual({ state: 'pending', held })
  ensure.mockRejectedValue(new Error('later index loss'))
  expect(await receipts.runIntent(id, fingerprint, request, held, prepare)).toEqual({ state: 'pending', held })
  expect(ensure).toHaveBeenCalledOnce(); expect(prepare).toHaveBeenCalledOnce()
  ready.resolve(effect)
  await vi.advanceTimersByTimeAsync(0)
  expect(receipts.status(id)).toEqual(created); expect(effect).toHaveBeenCalledOnce()
})

it('does not publish or prepare after a failed marker and preserves the typed refusal', async () => {
  const { receipts } = fixture(async () => { throw new Error('index failed') })
  const prepare = vi.fn(async () => async () => created)
  await expect(receipts.runIntent(id, fingerprint, request, held, prepare)).rejects.toMatchObject({ code: 'CREATION_STORAGE_FAILED' })
  expect(receipts.status(id)).toEqual({ state: 'missing' }); expect(prepare).not.toHaveBeenCalled()
})

it.each(['checksum', 'missing', 'directory'] as const)('refuses an existing pending %s replacement during marker admission', async changed => {
  const marker = deferred<void>(), ensure = vi.fn(() => marker.promise)
  const { directory, receipts, legacy } = fixture(ensure)
  await legacy.runIntent(id, fingerprint, request, held, async () => null)
  const prepare = vi.fn(async () => async () => created)
  const answer = receipts.runIntent(id, fingerprint, request, held, prepare)
  await vi.waitFor(() => expect(ensure).toHaveBeenCalledOnce())
  const file = join(directory, `${id}.json`), old = JSON.parse(readFileSync(file, 'utf8'))
  if (changed === 'missing') rmSync(file)
  else if (changed === 'directory') {
    renameSync(directory, `${directory}-prior`); mkdirSync(directory, { mode: 0o700 })
    writeFileSync(file, JSON.stringify(old), { mode: 0o600 })
  } else {
    const value = { ...old, request: { ...request, text: 'replacement' } }
    value.checksum = creationFingerprint({ fingerprint, request: value.request, held: value.held })
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 })
  }
  marker.resolve()
  await expect(answer).rejects.toMatchObject({ code: 'CREATION_STORAGE_FAILED' })
  expect(prepare).not.toHaveBeenCalled()
})

it('honors cancellation during marker admission without dispatching', async () => {
  const marker = deferred<void>(), ensure = vi.fn(() => marker.promise)
  const { receipts, legacy } = fixture(ensure), prepare = vi.fn(async () => async () => created)
  const answer = receipts.runIntent(id, fingerprint, request, held, prepare)
  await vi.waitFor(() => expect(ensure).toHaveBeenCalledOnce())
  legacy.cancelIntent(id)
  marker.resolve()
  expect(await answer).toEqual({ state: 'cancelled' }); expect(prepare).not.toHaveBeenCalled()
})

it('bounds marker admissions in its existing map and frees refused admissions for later requests', async () => {
  const marker = deferred<void>(), ensure = vi.fn(() => marker.promise)
  const { receipts } = fixture(ensure), prepare = vi.fn(async () => null)
  const answers = Array.from({ length: 64 }, (_, n) => receipts.runIntent(`${id}-${n}`, fingerprint, request, held, prepare))
  const settled = Promise.allSettled(answers)
  expect(() => receipts.runIntent(`${id}-overflow`, fingerprint, request, held, prepare)).toThrow('CREATION_STORAGE_FAILED')
  await vi.waitFor(() => expect(ensure).toHaveBeenCalledTimes(64))
  marker.reject(new Error('fixture marker unavailable')); await settled
  ensure.mockResolvedValue()
  expect(await receipts.runIntent(`${id}-overflow`, fingerprint, request, held, prepare)).toEqual({ state: 'pending', held })
  expect(prepare).toHaveBeenCalledOnce()
})

it('allows exactly one dispatch when independent writers finish marker admission together', async () => {
  const marker = deferred<void>(), { directory, receipts } = fixture(() => marker.promise)
  const other = new AgentCreationReceipts(directory, () => marker.promise), effect = vi.fn(async () => created)
  const first = receipts.runIntent(id, fingerprint, request, held, async () => effect)
  const second = other.runIntent(id, fingerprint, request, held, async () => effect)
  marker.resolve()
  const outcomes = await Promise.all([first, second])
  expect(outcomes.some(result => result.state === 'created')).toBe(true)
  expect(effect).toHaveBeenCalledOnce()
})

it('honors terminal completion or fingerprint conflict while marker admission waits', async () => {
  for (const conflict of [false, true]) {
    const marker = deferred<void>(), ensure = vi.fn(() => marker.promise)
    const { receipts, legacy } = fixture(ensure), prepare = vi.fn(async () => async () => created)
    const answer = receipts.runIntent(id, fingerprint, request, held, prepare)
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledOnce())
    await legacy.runIntent(id, conflict ? creationFingerprint({ changed: true }) : fingerprint, request, held, async () => async () => created)
    marker.resolve()
    if (conflict) await expect(answer).rejects.toMatchObject({ code: 'CREATION_CONFLICT' })
    else expect(await answer).toEqual(created)
    expect(prepare).not.toHaveBeenCalled()
  }
})
