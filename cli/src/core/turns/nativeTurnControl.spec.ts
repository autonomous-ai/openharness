import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { contentFixture, contentOwner as owner } from '../../testing/nativeGenerationContentFixture.js'
import { createNativeTurnControl, type NativeTurnControlDeps } from './nativeTurnControl.js'
import type { NativeGenerationOwner, NativeGenerationSource } from './nativeGenerations.js'

const controls: Array<ReturnType<typeof createNativeTurnControl>> = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => { controls.forEach(control => control.close()); controls.length = 0; vi.useRealTimers() })
function setup(inputs: Array<Record<string, unknown>> = [{}], overrides: Partial<NativeTurnControlDeps> = {}) {
  let source = contentFixture(inputs).source, alive = true, proof = true
  const verify = vi.fn(() => { if (!proof) throw Error('fixture native evidence expired') })
  source = { ...source, verify }
  const read = vi.fn(async (_owner: NativeGenerationOwner) => source), publish = vi.fn(), revoke = vi.fn(), held = vi.fn()
  const control = createNativeTurnControl({ owner, recoveredFactIds: source.facts.map(fact => fact.id),
    current: () => alive, read, publish, revoke, held, ...overrides })
  controls.push(control)
  const observe = (pending = false) => control.observe(source, pending)
  const update = (inputs: Array<Record<string, unknown>>) => { source = { ...contentFixture(inputs).source, verify } }
  return { control, read, publish, revoke, held, observe, update, verify, source: () => source,
    expire: () => { proof = false }, repair: () => { proof = true }, gone: () => { alive = false } }
}

it('publishes late Task observations only in their retired generation without changing a successor task', async () => {
  const inputs = [{ hookEvent: 'stop', status: 'completed' },
    { generationId: 'generation-two', hookEvent: 'preToolUse', toolUseId: 'same-tool', toolName: 'Task', input: { prompt: 'Second task' } }]
  const t = setup(inputs)
  t.observe(); await t.control.refresh()
  const before = t.publish.mock.calls.at(-1)![0], second = before.turns[1]
  expect(before.selection).toBe('one')
  expect(second.tasks.tasks[0]).toMatchObject({ state: 'observed', result: 'unconfirmed' })
  t.update([...inputs, { hookEvent: 'preToolUse', toolUseId: 'same-tool', toolName: 'Task', input: { prompt: 'First task' } }])
  t.observe(); await t.control.refresh()
  const after = t.publish.mock.calls.at(-1)![0]
  expect(after.selection).toBe('one')
  expect(after.turns[0].tasks.tasks[0]).toMatchObject({ state: 'retired', result: 'unconfirmed' })
  expect(after.turns[0].tasks.tasks[0].id).not.toBe(second.tasks.tasks[0].id)
  expect(after.turns[1]).toEqual(second)
  await expect(t.control.permit('generation-two', 'running')).resolves.toHaveProperty('turn.tasks', second.tasks)
  await expect(t.control.permit('generation-one', 'running')).rejects.toThrow('requested state')
})

it('keeps task results unconfirmed after local Cancel and cannot reacquire their former running authority', async () => {
  const t = setup([{ hookEvent: 'preToolUse', toolName: 'Task', toolUseId: 'original-tool', input: {} }])
  t.observe(); await t.control.refresh()
  const permit = await t.control.permit('generation-one', 'running')
  t.control.cancel()
  expect(() => permit.verify()).toThrow('control revision changed')
  await t.control.refresh()
  expect(t.publish.mock.calls.at(-1)![0]).toMatchObject({ selection: 'cancelled', cancelRequested: true,
    turns: [{ tasks: { tasks: [{ state: 'retired', result: 'unconfirmed' }] } }] })
  await expect(t.control.permit('generation-one', 'running')).rejects.toThrow('Cancel holds')
})

it('admits physical input for submitted-only or stopped generations without inventing execution', async () => {
  const t = setup([{ hookEvent: 'beforeSubmitPrompt', prompt: 'may be rejected by another hook' }])
  await expect(t.control.admit('input')).rejects.toThrow('admission or Cancel')
  t.observe(); await t.control.refresh()
  for (const purpose of ['input', 'control', 'answer'] as const) {
    const permit = await t.control.admit(purpose)
    expect(permit.owner).toEqual(owner)
    expect(permit.generationId).toBeUndefined()
    expect(() => permit.verify()).not.toThrow()
  }
  expect(t.publish.mock.calls[0][0].turns[0].generation).toMatchObject({ executed: false, running: false })
  t.update([{ hookEvent: 'stop', status: 'completed' }]); t.observe(); await t.control.refresh()
  await expect(t.control.admit('input')).resolves.toHaveProperty('generationId', undefined)
})

it('admits an answer to one running native turn and revokes it before a successor or ambiguity can take its key', async () => {
  const t = setup()
  t.observe(); await t.control.refresh()
  await expect(t.control.admit('input')).rejects.toThrow('still running')
  await expect(t.control.admit('control')).rejects.toThrow('still running')
  const answer = await t.control.admit('answer')
  expect(answer.generationId).toBe('generation-one')
  t.update([{}, { generationId: 'generation-two', hookEvent: 'preToolUse', toolUseId: 'second-tool' }]); t.observe()
  expect(() => answer.verify()).toThrow('control revision changed')
  await t.control.refresh()
  await expect(t.control.admit('answer')).rejects.toThrow('selection is ambiguous')
})

it('revokes an input proof on Cancel, including a cancellation recovered by a later fresh inspection', async () => {
  const t = setup([])
  t.observe(); await t.control.refresh()
  const input = await t.control.admit('input')
  Object.assign(t.source(), { cancellations: [{ requestId: 'fixture-cancel-request', nonce: 'fixture-cancel-nonce',
    agentId: owner.agentId, conversationId: owner.sessionId, frontier: { index: 0, digest: '0'.repeat(64) } }] })
  await expect(t.control.admit('answer')).rejects.toThrow('admission or Cancel')
  expect(() => input.verify()).toThrow('admission or Cancel')
  await expect(t.control.admit('input')).rejects.toThrow('admission or Cancel')
})

it('recovers a completed generation quietly without waiting for text, then fills only its late response', async () => {
  const t = setup([{ hookEvent: 'stop', status: 'completed' }])
  t.observe(); await t.control.refresh()
  expect(t.publish).toHaveBeenCalledOnce()
  expect(t.publish.mock.calls[0][0]).toMatchObject({ owner, selection: 'idle', recovered: true,
    turns: [{ generation: { id: 'generation-one', terminal: 'completed', running: false }, content: { response: { state: 'pending' } } }] })
  await expect(t.control.permit('generation-one', 'recap')).rejects.toThrow('unambiguous completed response')
  await expect(t.control.permit('generation-one', 'terminal')).resolves.toHaveProperty('turn.generation.terminal', 'completed')
  const oldVersion = t.publish.mock.calls[0][0].turns[0].version
  t.update([{ hookEvent: 'stop', status: 'completed' }, { responseText: 'Late native response.' },
    { generationId: 'generation-two', hookEvent: 'preToolUse', toolUseId: 'second-tool' }])
  t.observe(); await t.control.refresh()
  const state = t.publish.mock.calls.at(-1)![0]
  expect(state).toMatchObject({ selection: 'one', recovered: false, turns: [
    { generation: { id: 'generation-one', terminal: 'completed', running: false }, content: { response: { state: 'available', text: 'Late native response.' } } },
    { generation: { id: 'generation-two', running: true } },
  ] })
  expect(state.turns[0].version).not.toBe(oldVersion)
  const permit = await t.control.permit('generation-one', 'recap')
  expect(permit.turn.version).toBe(state.turns[0].version)
  expect(() => permit.verify()).not.toThrow()
  expect(t.revoke).toHaveBeenCalledTimes(2)
})

it('does not hide the first live generation when activity beats SessionStart', async () => {
  const t = setup([{}], { ...{ recoveredFactIds: [] } })
  t.observe(); await t.control.refresh()
  expect(t.publish.mock.calls[0][0]).toMatchObject({ recovered: false, turns: [
    { generation: { id: 'generation-one', running: true }, recovery: { started: false, ended: false } },
  ] })
})

it('keeps the recovery baseline when activity arrives during the initial read', async () => {
  const t = setup([], { ...{ recoveredFactIds: [] } })
  let finish!: (source: NativeGenerationSource) => void
  t.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  t.observe()
  t.update([{}])
  finish(t.source())
  await t.control.refresh()
  expect(t.publish.mock.calls[0][0]).toMatchObject({ recovered: false, turns: [
    { recovery: { started: false, ended: false } },
  ] })
})

it('distinguishes a recovered start from a live completion in the same first publication', async () => {
  const prior = contentFixture([{}]).source
  const t = setup([{}, { hookEvent: 'stop', status: 'completed' }], {
    ...{ recoveredFactIds: prior.facts.map(fact => fact.id) },
  })
  t.observe(); await t.control.refresh()
  expect(t.publish.mock.calls[0][0]).toMatchObject({ recovered: false, turns: [
    { generation: { terminal: 'completed' }, recovery: { started: true, ended: false } },
  ] })
})

it('copies the recovery baseline and keeps a recovered Stop quiet when its response arrives later', async () => {
  const baseline = contentFixture([{ hookEvent: 'stop', status: 'completed' }]).source.facts.map(fact => fact.id)
  const t = setup([{ hookEvent: 'stop', status: 'completed' }, { responseText: 'Late answer.' }], { recoveredFactIds: baseline })
  baseline.length = 0
  t.observe(); await t.control.refresh()
  expect(t.publish.mock.calls[0][0]).toMatchObject({ recovered: false, turns: [
    { recovery: { started: true, ended: true }, content: { response: { state: 'available', text: 'Late answer.' } } },
  ] })
})

it.each([
  { name: 'missing', ids: undefined }, { name: 'oversized', ids: Array(4609).fill('id') },
  { name: 'empty identity', ids: [''] }, { name: 'non-text identity', ids: [42] },
  { name: 'long identity', ids: ['x'.repeat(201)] },
])('refuses an invalid recovery baseline: $name', ({ ids }) => {
  expect(() => setup([], { recoveredFactIds: ids as string[] })).toThrow('recovery baseline is invalid')
})

it('publishes the same immutable identities on repeated recovery and never chooses response arrival order', async () => {
  const t = setup([{ hookEvent: 'stop', status: 'completed' }, { responseText: 'one' }, { responseText: 'two' }])
  t.observe(); await t.control.refresh()
  const first = t.publish.mock.calls[0][0]
  t.observe(); await t.control.refresh()
  const second = t.publish.mock.calls.at(-1)![0]
  expect(second.turns).toEqual(first.turns)
  expect(second.turns[0].content.response).toEqual({ state: 'ambiguous' })
  expect(second.selection).toBe('idle')
  for (const value of [second, second.turns, second.turns[0], second.turns[0].owner, second.turns[0].generation, second.turns[0].content]) expect(Object.isFrozen(value)).toBe(true)
  await expect(t.control.permit('generation-one', 'recap')).rejects.toThrow('unambiguous completed response')
})

it('holds fresh control until admission settles and revokes every old permit synchronously', async () => {
  const t = setup()
  await t.control.refresh()
  expect(t.read).not.toHaveBeenCalled()
  await expect(t.control.permit('generation-one', 'running')).rejects.toThrow('admission or Cancel')
  t.observe(); await t.control.refresh()
  const permit = await t.control.permit('generation-one', 'running')
  t.observe(true)
  expect(() => permit.verify()).toThrow('control revision changed')
  expect(t.held).toHaveBeenLastCalledWith(owner, 'Native hook admission is still pending.')
  const reads = t.read.mock.calls.length
  await vi.advanceTimersByTimeAsync(6000)
  expect(t.read).toHaveBeenCalledTimes(reads)
  t.observe(); await t.control.refresh()
  expect(t.read.mock.calls.length).toBeGreaterThan(reads)
})

it.each(['cancel', 'close', 'binding', 'proof', 'notification'] as const)('revokes a prepared generation effect after %s', async change => {
  const t = setup()
  t.observe(); await t.control.refresh()
  const permit = await t.control.permit('generation-one', 'running')
  if (change === 'cancel') t.control.cancel()
  else if (change === 'close') t.control.close()
  else if (change === 'binding') t.gone()
  else if (change === 'proof') t.expire()
  else t.observe()
  const effect = vi.fn()
  expect(() => { permit.verify(); effect() }).toThrow()
  expect(effect).not.toHaveBeenCalled()
})

it('does not let a new prompt or refreshed source rearm a requested or recovered cancellation', async () => {
  const t = setup()
  t.observe(); await t.control.refresh()
  t.control.cancel()
  expect(t.held).toHaveBeenLastCalledWith(owner, 'Waiting for the saved native cancellation result.')
  t.update([{ generationId: 'later-generation', hookEvent: 'beforeSubmitPrompt', prompt: 'new prompt' },
    { generationId: 'later-generation' }])
  t.observe(); await t.control.refresh()
  expect(t.publish.mock.calls.at(-1)![0]).toMatchObject({ cancelRequested: true })
  await expect(t.control.permit('later-generation', 'running')).rejects.toThrow('admission or Cancel')
  const recovered = setup()
  Object.assign(recovered.source(), { cancellations: [{ requestId: 'fixture-cancel-request', nonce: 'fixture-cancel-nonce',
    agentId: owner.agentId, conversationId: owner.sessionId, frontier: { index: -1, digest: null } }] })
  recovered.observe(); await recovered.control.refresh()
  expect(recovered.publish.mock.calls[0][0]).toMatchObject({ selection: 'cancelled', recovered: true, cancelRequested: true })
  await expect(recovered.control.permit('generation-one', 'running')).rejects.toThrow('Cancel')
  // Losing the journal tail must not rearm the same native process. This factory
  // has no explicit rearm operation, even if a later source looks complete.
  recovered.update([{ generationId: 'late-activity' }])
  recovered.observe(); await recovered.control.refresh()
  expect(recovered.publish.mock.calls.at(-1)![0]).toMatchObject({ selection: 'cancelled', cancelRequested: true })
  await expect(recovered.control.permit('late-activity', 'running')).rejects.toThrow('Cancel')
})

it('refuses another generation and terminal state without changing the current turn', async () => {
  const t = setup()
  t.observe(); await t.control.refresh()
  await expect(t.control.permit('other-generation', 'running')).rejects.toThrow('no effect authority')
  await expect(t.control.permit('generation-one', 'terminal')).rejects.toThrow('requested state')
  t.update([{ hookEvent: 'stop', status: 'aborted' }]); t.observe(); await t.control.refresh()
  await expect(t.control.permit('generation-one', 'running')).rejects.toThrow('requested state')
  await expect(t.control.permit('generation-one', 'recap')).rejects.toThrow('unambiguous completed response')
})

it.each(['notification', 'read'] as const)('rejects a foreign owner from %s', async point => {
  const t = setup(), other = { ...t.source(), owner: { ...owner, sessionId: 'other-session' } }
  if (point === 'notification') {
    expect(() => t.control.observe(other, false)).toThrow('notification belongs')
    await expect(t.control.permit('generation-one', 'running')).rejects.toThrow('admission')
  } else {
    t.read.mockResolvedValue(other)
    t.observe(); await t.control.refresh()
    expect(t.held).toHaveBeenLastCalledWith(owner, expect.stringContaining('source belongs'))
  }
  expect(t.publish).not.toHaveBeenCalled()
})

it('keeps a missing native payload held and retries the same owner without a service or parser', async () => {
  const t = setup(), source = t.source()
  t.read.mockResolvedValueOnce({ ...source, observations: undefined })
  t.observe(); await t.control.refresh()
  expect(t.publish).not.toHaveBeenCalled()
  expect(t.held).toHaveBeenLastCalledWith(owner, expect.stringContaining('complete observation'))
  await vi.advanceTimersByTimeAsync(1000)
  expect(t.publish).toHaveBeenCalledOnce()
  expect(t.read.mock.calls.every(call => call[0] === owner || JSON.stringify(call[0]) === JSON.stringify(owner))).toBe(true)
})

it.each([Error('fixture storage unavailable'), 'fixture storage unavailable'])('keeps a failed read held and bounded: %s', async error => {
  const t = setup()
  t.read.mockRejectedValueOnce(error)
  t.observe(); await t.control.refresh()
  expect(t.held).toHaveBeenLastCalledWith(owner, 'fixture storage unavailable')
  await vi.advanceTimersByTimeAsync(1000)
  expect(t.publish).toHaveBeenCalledOnce()
})

it('retains one actual read slot after a deadline and repeated notices, then recovers without replay', async () => {
  const t = setup()
  let release!: (source: NativeGenerationSource) => void
  t.read.mockImplementationOnce(() => new Promise(done => { release = done }))
  t.observe()
  await vi.advanceTimersByTimeAsync(5000)
  expect(t.held).toHaveBeenLastCalledWith(owner, expect.stringContaining('read deadline expired'))
  for (let n = 0; n < 5; n++) t.observe()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(t.read).toHaveBeenCalledOnce()
  expect(t.publish).not.toHaveBeenCalled()
  release(t.source())
  await vi.advanceTimersByTimeAsync(1000)
  expect(t.read).toHaveBeenCalledTimes(2)
  expect(t.publish).toHaveBeenCalledOnce()
  expect(t.publish.mock.calls[0][0].recovered).toBe(true)
})

it('bounds concurrent permit waits while keeping the one actual read slot until it settles', async () => {
  const t = setup()
  t.observe(); await t.control.refresh()
  let release!: (source: NativeGenerationSource) => void
  t.read.mockImplementationOnce(() => new Promise(done => { release = done }))
  const attempts = Array.from({ length: 20 }, () => t.control.permit('generation-one', 'running'))
  const outcomes = Promise.allSettled(attempts)
  await vi.advanceTimersByTimeAsync(5000)
  expect((await outcomes).every(result => result.status === 'rejected')).toBe(true)
  expect(t.read).toHaveBeenCalledTimes(2)
  t.observe()
  await expect(t.control.permit('generation-one', 'running')).rejects.toThrow('previous native generation read')
  await vi.advanceTimersByTimeAsync(10_000)
  expect(t.read).toHaveBeenCalledTimes(2)
  release(t.source())
  await vi.advanceTimersByTimeAsync(1000)
  expect(t.read).toHaveBeenCalledTimes(3)
  expect(t.publish).toHaveBeenCalledTimes(2)
})

it.each(['read', 'proof'] as const)('refuses late %s completion even before the queued deadline timer runs', async point => {
  let clock = 0
  const t = setup([{}], { now: () => clock })
  if (point === 'read') t.read.mockImplementationOnce(async () => { clock = 5000; return t.source() })
  else t.verify.mockImplementationOnce(() => {}).mockImplementationOnce(() => { clock = 5000 })
  t.observe(); await t.control.refresh()
  expect(t.publish).not.toHaveBeenCalled()
  expect(t.held).toHaveBeenLastCalledWith(owner, expect.stringContaining('deadline expired'))
})

it('checks the absolute deadline both when granting a permit and at its actual effect boundary', async () => {
  let clock = 0
  const t = setup([{}], { now: () => clock })
  t.observe(); await t.control.refresh()
  const permit = await t.control.permit('generation-one', 'running')
  clock = 5000
  expect(() => permit.verify()).toThrow('deadline expired')
  t.read.mockImplementationOnce(async () => { clock += 5000; return t.source() })
  await expect(t.control.permit('generation-one', 'running')).rejects.toThrow('deadline expired')
})

it.each(['pending', 'granted'] as const)('expires only the old permit while a newer inspection is %s', async newer => {
  let clock = 0
  const t = setup([{}], { now: () => clock })
  t.observe(); await t.control.refresh()
  const older = await t.control.permit('generation-one', 'running')
  clock = 4900
  let release!: (source: NativeGenerationSource) => void
  if (newer === 'pending') t.read.mockImplementationOnce(() => new Promise(done => { release = done }))
  const reading = t.control.permit('generation-one', 'running')
  if (newer === 'granted') await reading
  clock = 5000
  expect(() => older.verify()).toThrow('deadline expired')
  if (newer === 'pending') release(t.source())
  const fresh = await reading
  expect(() => fresh.verify()).not.toThrow()
  expect(t.revoke).toHaveBeenCalledOnce()
  expect(t.held).not.toHaveBeenCalled()
})

it('revokes already granted permits when a separate inspection recovers Cancel', async () => {
  const t = setup()
  t.observe(); await t.control.refresh()
  const permit = await t.control.permit('generation-one', 'running')
  Object.assign(t.source(), { cancellations: [{ requestId: 'fixture-cancel-request', nonce: 'fixture-cancel-nonce',
    agentId: owner.agentId, conversationId: owner.sessionId, frontier: { index: -1, digest: null } }] })
  await expect(t.control.permit('generation-one', 'running')).rejects.toThrow('Cancel')
  expect(() => permit.verify()).toThrow('Cancel')
  expect(t.revoke).toHaveBeenCalledTimes(2)
  await t.control.refresh()
  expect(t.revoke).toHaveBeenCalledTimes(2)
})

it('coalesces a manual refresh with an already scheduled retry', async () => {
  const t = setup()
  t.read.mockRejectedValueOnce(Error('unavailable')).mockRejectedValueOnce(Error('still unavailable'))
  t.observe(); await t.control.refresh()
  await t.control.refresh()
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(1000)
  expect(t.read).toHaveBeenCalledTimes(3)
  expect(t.publish).toHaveBeenCalledOnce()
})

it.each(['binding', 'admission'] as const)('does not replace a newer %s hold with an old read deadline', async change => {
  const t = setup()
  let release!: (source: NativeGenerationSource) => void
  t.read.mockImplementationOnce(() => new Promise(done => { release = done }))
  t.observe()
  const settling = t.control.refresh()
  if (change === 'binding') t.gone()
  else t.observe(true)
  const holds = t.held.mock.calls.length
  await vi.advanceTimersByTimeAsync(5000)
  expect(t.held).toHaveBeenCalledTimes(holds)
  release(t.source()); await settling
  await vi.advanceTimersByTimeAsync(1000)
  expect(t.read).toHaveBeenCalledOnce()
  expect(t.publish).not.toHaveBeenCalled()
})

it.each(['cancel', 'close', 'notification', 'binding'] as const)('discards a read completed after %s while awaiting ownership', async change => {
  const t = setup()
  let release!: (source: NativeGenerationSource) => void
  t.observe(); await t.control.refresh()
  t.read.mockImplementationOnce(() => new Promise(done => { release = done }))
  const permit = t.control.permit('generation-one', 'running')
  if (change === 'cancel') t.control.cancel()
  else if (change === 'close') t.control.close()
  else if (change === 'notification') t.observe(true)
  else t.gone()
  release(t.source())
  await expect(permit).rejects.toThrow('control revision changed')
})

it('cannot change copied native text while scalar projection yields', async () => {
  const t = setup(), source = t.source(), original = source.verify
  const mutable = { ...source.observations![0] }
  Object.assign(source, { observations: [mutable], verify: () => { mutable.responseText = 'replacement'; original() } })
  // The read returns original content; notification verification happens on a
  // separate source so the mutation occurs at the projection's proof boundary.
  t.control.observe({ ...source, verify: original }, false)
  await t.control.refresh()
  expect(t.publish.mock.calls[0][0].turns[0].content.response.text).toBe('A retained response.')
})

it('checks final authority before publication and after a synchronous consumer yields control', async () => {
  const t = setup()
  t.publish.mockImplementation((_state, verify) => { verify(); t.control.cancel() })
  t.observe(); await t.control.refresh()
  expect(t.publish).toHaveBeenCalledOnce()
  await expect(t.control.permit('generation-one', 'running')).rejects.toThrow('Cancel')
  t.control.close()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(t.read).toHaveBeenCalledOnce()
})

it('contains notification errors while keeping revoked effects and the retry obligation', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const t = setup()
  t.revoke.mockImplementation(() => { throw Error('revocation consumer') })
  t.held.mockImplementation(() => { throw Error('hold consumer') })
  t.publish.mockImplementation(() => { throw Error('presentation consumer') })
  t.observe(); await expect(t.control.refresh()).resolves.toBeUndefined()
  expect(warning).toHaveBeenCalled()
  expect(t.publish).toHaveBeenCalledOnce()
  t.control.close(); warning.mockRestore()
})

it('closes outstanding retries, ignores stale notices, and does not touch a lost owner', async () => {
  const t = setup()
  t.read.mockRejectedValue(Error('unavailable'))
  t.observe(); await t.control.refresh()
  t.control.close(); t.control.close(); t.observe(); t.control.cancel()
  await t.control.refresh(); await vi.advanceTimersByTimeAsync(10_000)
  expect(t.read).toHaveBeenCalledOnce()
  const other = setup(); other.gone(); other.observe(); other.control.cancel()
  expect(other.revoke).not.toHaveBeenCalled()
})

it.each([{ readWaitMs: NaN }, { readWaitMs: 0 }, { readWaitMs: 5001 },
  { retryMs: Infinity }, { retryMs: 0 }, { retryMs: 60_001 }])('rejects an unbounded polling option %j', options => {
  expect(() => setup([], options)).toThrow('deadline is invalid')
})
