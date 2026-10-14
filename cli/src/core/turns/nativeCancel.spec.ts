import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createNativeCancel, type NativeCancelDeps } from './nativeCancel.js'
import { createTerminalWriter } from '../terminals/writer.js'
import { nativeTurnTarget, nativeTurnTransition, parseNativeTurnIntent, type NativeTurnIntent } from '../../lib/nativeTurnIntent.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { NativeCancellationResult } from '../../hookServer.js'

const wait = <T = void>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
const row = (agentId = 'agent'): RegisteredSession => ({ agentId, schemaVersion: 2, registeredAt: 1, engine: 'cursor',
  sessionId: 'session', boundAt: 2, active: true, processIdentity: { pid: 42, executable: '<cursor>', startMarker: 'birth' },
  runtimes: [{ backend: 'tmux', paneId: '%1' }], primaryRuntimeKey: 'tmux:%1', tmuxPane: '%1', cwd: '/fixture/project',
  transcriptPath: null } as RegisteredSession)
let disposals: Array<() => void> = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => { for (const close of disposals) close(); disposals = []; vi.useRealTimers() })

function fixture(options: Partial<Pick<NativeCancelDeps, 'maxJobs' | 'maxRunning' | 'now'>> = {}) {
  const rows = new Map([['agent', row()]]), events: string[] = [], writer = createTerminalWriter()
  let version = 0
  const capture = vi.fn<NativeCancelDeps['capture']>(original => ({ owner: { agentId: original.agentId,
    sessionId: original.sessionId, processKey: 'original-process' }, frontier: { index: 3, digest: 'a'.repeat(64) } }))
  const registry = {
    byAgent: (id: string) => rows.get(id),
    commitNativeControl: vi.fn((original: RegisteredSession, intent: NativeTurnIntent, fence: () => void) => {
      expect(parseNativeTurnIntent(intent)).toEqual(intent)
      expect(nativeTurnTransition(original, intent)).toBe(true)
      fence(); events.push('saved'); version++
      const saved = { ...structuredClone(original), schemaVersion: 3 as const, nativeControl: structuredClone(intent) }
      rows.set(saved.agentId, saved)
      return saved
    }),
    readNativeControl: vi.fn((original: RegisteredSession) => {
      const retained = version
      return { intent: original.nativeControl, verify: () => { if (retained !== version) throw Error('disk changed') } }
    }),
  }
  const nativeProof = vi.fn(() => {})
  const result = (): NativeCancellationResult => ({ recorded: true, targets: ['generation'], source: {
    owner: capture(row())!.owner, facts: [], verify: nativeProof,
  }, dispatch: async effect => { events.push('claim'); nativeProof(); return effect(nativeProof) } })
  const journal = vi.fn<NativeCancelDeps['journal']>(async () => { events.push('journal'); return result() })
  const held = vi.fn(), revokeRearm = vi.fn(), revoke = vi.fn(() => { events.push('revoke') })
  const interrupt = vi.fn<NativeCancelDeps['interrupt']>(async (_id, allowed, write) => write.dispatch(async () => {
    if (!allowed()) throw Error('revoked before physical dispatch')
    events.push('C-c'); return { state: 'succeeded', dispatch: 'executed' }
  }))
  const controller = createNativeCancel({ registry, capture, journal, held, revoke, revokeRearm, writer, interrupt, ...options })
  disposals.push(controller.close)
  return { rows, registry, capture, nativeProof, result, journal, held, revokeRearm, revoke, writer, interrupt, controller, events,
    changeDisk: () => { version++ } }
}

it('saves the immutable original cancellation before a single fresh physical interrupt', async () => {
  const f = fixture(), original = row(), epoch = f.writer.ticket('agent')
  const answer = f.controller.cancel(original)
  expect(epoch.allowed()).toBe(false)
  original.sessionId = 'mutated'; original.processIdentity!.pid = 7
  await expect(answer).resolves.toBe(true)
  expect(f.events).toEqual(['revoke', 'saved', 'journal', 'claim', 'C-c'])
  const intent = f.rows.get('agent')!.nativeControl!
  expect(intent.cancel.target).toBe(nativeTurnTarget(row()))
  expect(f.journal.mock.calls[0]).toEqual([{ agentId: 'agent', sessionId: 'session', processKey: 'original-process' }, intent.cancel.request])
  expect(f.held).toHaveBeenLastCalledWith('agent', expect.stringContaining('interruption was confirmed'))
  f.controller.close()
  await expect(f.controller.cancel(row())).resolves.toBe(false)
})

it('copies the previously confirmed PID view before revocation and never renews it on retry', async () => {
  const f = fixture(), known = { owner: { agentId: 'agent', sessionId: 'session',
    processKey: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa\0cursor\0' + '42\0' + '12345' },
    frontier: { index: -1, digest: null }, namespace: 'linux:4:5' }
  f.capture.mockReturnValue(known)
  f.revoke.mockImplementation(() => { known.namespace = 'linux:4:6' })
  await expect(f.controller.cancel(row())).resolves.toBe(true)
  const saved = f.rows.get('agent')!
  expect(saved.nativeControl!.cancel.namespace).toBe('linux:4:5')
  f.journal.mockResolvedValue({ recorded: false, source: f.result().source })
  await expect(f.controller.cancel(saved)).resolves.toBe(false)
  expect(f.rows.get('agent')!.nativeControl).toEqual(saved.nativeControl)
})

it.each(['legacy', 'unknown'])('never fills missing %s Cancel scope from a later capture', async kind => {
  const f = fixture()
  if (kind === 'unknown') f.capture.mockReturnValue(undefined)
  await f.controller.cancel(row())
  const saved = f.rows.get('agent')!, previous = structuredClone(saved.nativeControl)
  f.capture.mockReturnValue({ owner: { agentId: 'agent', sessionId: 'session',
    processKey: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa\0cursor\0' + '42\0' + '12345' },
    frontier: { index: -1, digest: null }, namespace: 'linux:4:5' })
  f.journal.mockResolvedValue({ recorded: false, source: f.result().source })
  await f.controller.cancel(saved)
  expect(f.rows.get('agent')!.nativeControl).toEqual(previous)
  expect(Object.hasOwn(f.rows.get('agent')!.nativeControl!.cancel, 'namespace')).toBe(false)
})

it.each(['missing', 'mismatch', 'session', 'throws', 'unbound'] as const)('saves %s ownership as permanently unknown without interrupting', async kind => {
  const f = fixture(), original = row()
  if (kind === 'throws') f.capture.mockImplementation(() => { throw Error('unavailable') })
  else if (kind === 'mismatch') f.capture.mockReturnValue({ owner: { agentId: 'other', sessionId: 'session', processKey: 'other' }, frontier: { index: -1, digest: null } })
  else if (kind === 'session') f.capture.mockReturnValue({ owner: { agentId: 'agent', sessionId: 'other', processKey: 'other' }, frontier: { index: -1, digest: null } })
  else f.capture.mockReturnValue(undefined)
  if (kind === 'unbound') { original.sessionId = ''; original.boundAt = null; f.rows.set('agent', original) }
  const answer = f.controller.cancel(original)
  expect(f.journal).not.toHaveBeenCalled()
  await expect(answer).resolves.toBe(false)
  const saved = f.rows.get('agent')!
  expect(saved.nativeControl!.cancel.processKey).toBeNull()
  expect(saved.nativeControl!.cancel.request.frontier).toEqual({ index: -1, digest: null })
  f.capture.mockReturnValue({ owner: { agentId: 'agent', sessionId: 'session', processKey: 'discovered-later' }, frontier: { index: -1, digest: null } })
  await expect(f.controller.cancel(saved)).resolves.toBe(false)
  expect(f.rows.get('agent')!.nativeControl).toEqual(saved.nativeControl)
  expect(f.journal).not.toHaveBeenCalled(); expect(f.interrupt).not.toHaveBeenCalled()
})

it('keeps the exact request through storage failure and coalesces retries', async () => {
  const f = fixture(), commit = f.registry.commitNativeControl.getMockImplementation()!
  f.registry.commitNativeControl.mockImplementationOnce(() => { throw Error('disk busy') })
  const first = f.controller.cancel(row()), duplicate = f.controller.cancel(row())
  expect(duplicate).toBe(first)
  const frozen = structuredClone(f.registry.commitNativeControl.mock.calls[0][1])
  expect(f.journal).not.toHaveBeenCalled()
  f.registry.commitNativeControl.mockImplementation(commit)
  await vi.advanceTimersByTimeAsync(1000)
  await expect(first).resolves.toBe(true)
  expect(f.registry.commitNativeControl.mock.calls[1][1]).toEqual(frozen)
  expect(f.interrupt).toHaveBeenCalledOnce()
})

it('retains the original journal request after an unavailable read without renewing its deadline', async () => {
  const f = fixture()
  f.journal.mockRejectedValueOnce('journal unavailable')
  const answer = f.controller.cancel(row())
  await flush()
  expect(f.held).toHaveBeenLastCalledWith('agent', expect.stringContaining('journal unavailable'))
  await vi.advanceTimersByTimeAsync(1000)
  await expect(answer).resolves.toBe(true)
  expect(f.journal.mock.calls[1]).toEqual(f.journal.mock.calls[0])
  expect(f.registry.commitNativeControl).toHaveBeenCalledOnce()
})

it('does not replay an earlier or recovered journal interrupt', async () => {
  const f = fixture(), prior = f.result()
  // Even a stale function left on the object is no permission without recorded.
  f.journal.mockResolvedValue({ ...prior, recorded: false })
  await expect(f.controller.cancel(row())).resolves.toBe(false)
  expect(f.interrupt).not.toHaveBeenCalled()
  expect(f.held).toHaveBeenLastCalledWith('agent', expect.stringContaining('earlier interrupt outcome'))
})

it('freshly confirms its exact visible publication before proceeding after a failed final read', async () => {
  const f = fixture(), commit = f.registry.commitNativeControl.getMockImplementation()!
  f.registry.commitNativeControl.mockImplementationOnce((...args) => { commit(...args); throw Error('final read failed') })
  f.registry.readNativeControl.mockImplementationOnce(() => { throw Error('still cannot confirm') })
  const answer = f.controller.cancel(row())
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.journal).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1000)
  await expect(answer).resolves.toBe(true)
  expect(f.registry.commitNativeControl).toHaveBeenCalledOnce()
})

it('retries a failed identical Cancel commit without treating a previously saved value as new confirmation', async () => {
  const f = fixture()
  f.capture.mockReturnValue(undefined)
  await f.controller.cancel(row())
  f.registry.commitNativeControl.mockImplementationOnce(() => { throw Error('sync failure') })
  const answer = f.controller.cancel(f.rows.get('agent')!)
  await vi.advanceTimersByTimeAsync(1000)
  await expect(answer).resolves.toBe(false)
  expect(f.registry.commitNativeControl).toHaveBeenCalledTimes(3)
})

it.each(['failed', 'unknown'] as const)('keeps %s physical outcomes unconfirmed without retrying', async state => {
  const f = fixture()
  f.interrupt.mockResolvedValue(state === 'failed' ? { state, dispatch: 'not_started', reason: 'unavailable' }
    : { state, dispatch: 'possibly_executed', reason: 'unavailable' })
  await expect(f.controller.cancel(row())).resolves.toBe(false)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(f.interrupt).toHaveBeenCalledOnce(); expect(f.journal).toHaveBeenCalledOnce()
})

it('never borrows a changed owner while cancellation storage is unavailable', async () => {
  const f = fixture()
  f.registry.commitNativeControl.mockImplementation(() => { throw Error('disk busy') })
  const answer = f.controller.cancel(row())
  f.rows.set('agent', { ...row(), sessionId: 'replacement' })
  await vi.advanceTimersByTimeAsync(1000)
  await expect(answer).resolves.toBe(false)
  expect(f.registry.commitNativeControl).toHaveBeenCalledOnce()
  expect(f.journal).not.toHaveBeenCalled()
})

it.each(['process', 'control', 'removed', 'close'] as const)('revokes after a journal wait when %s changes', async change => {
  const f = fixture(), gate = wait<NativeCancellationResult>()
  f.journal.mockReturnValue(gate.promise)
  const answer = f.controller.cancel(row())
  if (change === 'process') f.rows.set('agent', { ...f.rows.get('agent')!, processIdentity: null })
  if (change === 'control') f.rows.get('agent')!.nativeControl = undefined
  if (change === 'removed') f.rows.delete('agent')
  if (change === 'close') f.controller.close()
  gate.resolve(f.result()); await expect(answer).resolves.toBe(false)
  expect(f.interrupt).not.toHaveBeenCalled()
})

it('revokes a prepared rearm while preserving its original uncertain allocation', async () => {
  const f = fixture()
  f.capture.mockReturnValue(undefined)
  await f.controller.cancel(row())
  const cancelled = f.rows.get('agent')!
  const rearm = { requestId: 'prepared-rearm-request', agentId: 'agent', operation: 'restart' as const,
    target: nativeTurnTarget(cancelled), launchToken: 'original-launch-token' }
  f.rows.set('agent', { ...cancelled, nativeControl: { ...cancelled.nativeControl!, rearm } })
  f.revokeRearm.mockImplementationOnce(() => { throw Error('receipt busy') })
  const next = f.controller.cancel(f.rows.get('agent')!)
  await vi.advanceTimersByTimeAsync(1000)
  await expect(next).resolves.toBe(false)
  const saved = f.rows.get('agent')!.nativeControl!
  expect(saved.cancel.request.requestId).not.toBe(cancelled.nativeControl!.cancel.request.requestId)
  expect(saved.rearm).toEqual({ ...rearm, revoked: true })
  expect(f.revokeRearm).toHaveBeenLastCalledWith(rearm.requestId)
  expect(f.capture).toHaveBeenCalledOnce()
  expect(f.interrupt).not.toHaveBeenCalled()
})

it('cancels only an explicitly confirmed replacement with a new request', async () => {
  const f = fixture()
  await f.controller.cancel(row())
  const previous = f.rows.get('agent')!.nativeControl!
  f.rows.set('agent', { ...f.rows.get('agent')!, nativeControl: { ...previous, rearm: {
    requestId: 'explicit-rearm-request', agentId: 'agent', operation: 'restart', target: nativeTurnTarget(row()),
    launchToken: 'original-launch-token', replacement: { processKey: 'replacement-process', sessionId: 'session' },
  } } })
  f.capture.mockReturnValue({ owner: { agentId: 'agent', sessionId: 'session', processKey: 'replacement-process' }, frontier: { index: -1, digest: null } })
  await expect(f.controller.cancel(f.rows.get('agent')!)).resolves.toBe(true)
  expect(f.journal.mock.calls[1][0].processKey).toBe('replacement-process')
  expect(f.journal.mock.calls[1][1].requestId).not.toBe(previous.cancel.request.requestId)
})

it('a new Cancel supersedes a pending request whose row changed', async () => {
  const f = fixture(), gate = wait<NativeCancellationResult>()
  f.journal.mockReturnValueOnce(gate.promise)
  const old = f.controller.cancel(row())
  const next = { ...row(), sessionId: 'next' }; f.rows.set('agent', next)
  await expect(f.controller.cancel(next)).resolves.toBe(true)
  await expect(old).resolves.toBe(false)
  const visible = f.held.mock.calls.slice()
  gate.resolve(f.result()); await flush()
  expect(f.held.mock.calls).toEqual(visible)
  expect(f.interrupt).toHaveBeenCalledOnce()
})

it('a same-binding rearm is not hidden by an older pending Cancel job', async () => {
  const f = fixture(), gate = wait<NativeCancellationResult>()
  f.journal.mockReturnValueOnce(gate.promise)
  const old = f.controller.cancel(row()), cancelled = f.rows.get('agent')!
  f.rows.set('agent', { ...cancelled, nativeControl: { ...cancelled.nativeControl!, rearm: {
    requestId: 'prepared-rearm-request', agentId: 'agent', operation: 'restart', target: nativeTurnTarget(cancelled), launchToken: 'original-launch-token',
  } } })
  await expect(f.controller.cancel(f.rows.get('agent')!)).resolves.toBe(false)
  await expect(old).resolves.toBe(false)
  expect(f.rows.get('agent')!.nativeControl!.rearm!.revoked).toBe(true)
  gate.resolve(f.result()); await flush()
  expect(f.interrupt).not.toHaveBeenCalled()
})

it('holds invalid capture and a full queue after immediate input revocation', async () => {
  const f = fixture({ maxJobs: 1 }), gate = wait<NativeCancellationResult>()
  f.journal.mockReturnValue(gate.promise)
  const first = f.controller.cancel(row())
  const other = row('other'); f.rows.set('other', other)
  await expect(f.controller.cancel(other)).resolves.toBe(false)
  expect(f.revoke).toHaveBeenLastCalledWith(other)
  expect(f.held).toHaveBeenLastCalledWith('other', expect.stringContaining('queue is full'))
  f.controller.close(); await expect(first).resolves.toBe(false)
  gate.resolve(f.result()); await flush()
  const invalid = fixture()
  invalid.capture.mockReturnValue({ owner: { agentId: 'agent', sessionId: 'session', processKey: '' }, frontier: { index: -1, digest: null } })
  await expect(invalid.controller.cancel(row())).resolves.toBe(false)
  expect(invalid.revoke).toHaveBeenCalledOnce()
  expect(invalid.registry.commitNativeControl).not.toHaveBeenCalled()
})

it('retains actual journal occupancy after the caller deadline', async () => {
  const f = fixture({ maxRunning: 1 }), gate = wait<NativeCancellationResult>()
  f.journal.mockReturnValueOnce(gate.promise)
  const first = f.controller.cancel(row()), other = row('other'); f.rows.set('other', other)
  const second = f.controller.cancel(other)
  await vi.advanceTimersByTimeAsync(5000)
  await expect(first).resolves.toBe(false); await expect(second).resolves.toBe(false)
  expect(f.journal).toHaveBeenCalledOnce()
  gate.resolve(f.result()); await flush()
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.journal).toHaveBeenCalledTimes(2)
  expect(f.interrupt).not.toHaveBeenCalled()
})

it('does not start another read for a job already occupying its slot', async () => {
  const f = fixture({ maxRunning: 2 }), gate = wait<NativeCancellationResult>()
  f.journal.mockReturnValue(gate.promise)
  const first = f.controller.cancel(row()), other = row('other'); f.rows.set('other', other)
  const second = f.controller.cancel(other)
  expect(f.journal).toHaveBeenCalledTimes(2)
  f.controller.close(); gate.resolve(f.result())
  await expect(first).resolves.toBe(false); await expect(second).resolves.toBe(false)
})

it('gives an unrelated queued cancellation a slot before retrying a persistently unavailable journal', async () => {
  const f = fixture({ maxRunning: 1 }), journal = f.journal.getMockImplementation()!
  f.journal.mockImplementation(async (owner, request) => {
    if (owner.agentId === 'agent') { await Promise.resolve(); throw Error('unavailable') }
    return journal(owner, request)
  })
  const first = f.controller.cancel(row()), other = row('other'); f.rows.set('other', other)
  const second = f.controller.cancel(other)
  await vi.advanceTimersByTimeAsync(1000)
  await expect(second).resolves.toBe(true)
  expect(f.interrupt).toHaveBeenCalledOnce()
  f.controller.close(); await expect(first).resolves.toBe(false)
})

it('does not retry synchronous persistence failures on every new Cancel request', async () => {
  const f = fixture({ maxRunning: 1 })
  f.registry.commitNativeControl.mockImplementation(() => { throw Error('unavailable') })
  const first = f.controller.cancel(row())
  for (const id of ['second', 'third']) { const next = row(id); f.rows.set(id, next); void f.controller.cancel(next) }
  expect(f.registry.commitNativeControl.mock.calls.filter(([original]) => original.agentId === 'agent')).toHaveLength(1)
  f.controller.close(); await expect(first).resolves.toBe(false)
})

it('does not publish an expired Cancel over a replacement while its read is still hung', async () => {
  const f = fixture(), gate = wait<NativeCancellationResult>()
  f.journal.mockReturnValue(gate.promise)
  const answer = f.controller.cancel(row())
  f.rows.set('agent', { ...row(), sessionId: 'replacement' })
  await vi.advanceTimersByTimeAsync(5000)
  await expect(answer).resolves.toBe(false)
  expect(f.held).not.toHaveBeenCalled()
  gate.resolve(f.result()); await flush()
})

it('still saves a held cancellation after its physical deadline without sending late C-c', async () => {
  const f = fixture(), commit = f.registry.commitNativeControl.getMockImplementation()!
  f.registry.commitNativeControl.mockImplementation(() => { throw Error('disk busy') })
  const answer = f.controller.cancel(row())
  await vi.advanceTimersByTimeAsync(5000); await expect(answer).resolves.toBe(false)
  expect(f.held).toHaveBeenCalledWith('agent', expect.stringContaining('retained locally, awaiting a confirmed save'))
  f.registry.commitNativeControl.mockImplementation(commit)
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.rows.get('agent')!.nativeControl).toBeDefined()
  expect(f.journal).toHaveBeenCalledOnce(); expect(f.interrupt).not.toHaveBeenCalled()
})

it('starts the absolute interrupt deadline before capturing its native owner', async () => {
  let clock = 0
  const f = fixture({ now: () => clock }), capture = f.capture.getMockImplementation()!
  f.capture.mockImplementation(original => { clock = 5000; return capture(original) })
  await expect(f.controller.cancel(row())).resolves.toBe(false)
  expect(f.rows.get('agent')!.nativeControl).toBeDefined()
  expect(f.interrupt).not.toHaveBeenCalled()
})

it('does not report confirmation after its absolute deadline before the timer callback runs', async () => {
  let clock = 0
  const f = fixture({ now: () => clock })
  f.interrupt.mockImplementation(async (_id, allowed, write) => write.dispatch(async () => {
    expect(allowed()).toBe(true)
    clock = 5000
    return { state: 'succeeded', dispatch: 'executed' }
  }))
  await expect(f.controller.cancel(row())).resolves.toBe(false)
  expect(f.held).toHaveBeenLastCalledWith('agent', expect.stringContaining('deadline expired before confirmation'))
})

it.each(['disk', 'native', 'owner', 'deadline', 'writer'] as const)('checks %s at the final physical dispatch boundary', async failure => {
  let clock = 0
  let admitted: boolean | undefined
  const f = fixture({ now: () => clock })
  const effect = vi.fn(async () => ({ state: 'succeeded' as const, dispatch: 'executed' as const }))
  f.interrupt.mockImplementation(async (_id, allowed, write) => {
    if (failure === 'disk') f.changeDisk()
    if (failure === 'native') f.nativeProof.mockImplementation(() => { throw Error('native changed') })
    if (failure === 'owner') f.rows.get('agent')!.sessionId = 'other'
    if (failure === 'deadline') clock = 5000
    if (failure === 'writer') f.writer.revoke('agent')
    admitted = allowed()
    if (!admitted) return { state: 'failed', dispatch: 'not_started', reason: 'held' }
    return write.dispatch(effect)
  })
  await expect(f.controller.cancel(row())).resolves.toBe(false)
  expect(admitted).toBe(false)
  expect(effect).not.toHaveBeenCalled()
})

it('rechecks its original proof after draining an earlier physical write', async () => {
  const f = fixture(), gate = wait(), effect = f.writer.run('agent', f.writer.ticket('agent'), write => write.dispatch(() => gate.promise))
  const revoked = expect(effect).rejects.toThrow('cancelled')
  const answer = f.controller.cancel(row()); await revoked; await flush()
  f.changeDisk(); gate.resolve()
  await flush()
  expect(f.interrupt).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.journal).toHaveBeenCalledOnce()
  await expect(answer).resolves.toBe(false)
})
