import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { TerminalWriteHeld, type TerminalActionResult, type TerminalWrite } from '../../lib/terminalTypes.js'
import { createTerminalWriter } from '../terminals/writer.js'
import { createNativeInput, type NativeInputAdmission, type NativeInputDeps } from './nativeInput.js'

const inputs: Array<ReturnType<typeof createNativeInput>> = []
const ok: TerminalActionResult = { state: 'succeeded', dispatch: 'executed' }
const flush = async () => { for (let index = 0; index < 25; index++) await Promise.resolve() }
beforeEach(() => vi.useFakeTimers())
afterEach(() => { inputs.splice(0).forEach(input => input.close()); vi.useRealTimers() })
function setup(options: Partial<NativeInputDeps> = {}) {
  const row = { agentId: 'agent', sessionId: 'session', engine: 'cursor' } as RegisteredSession
  const writer = createTerminalWriter()
  let valid = true
  const verify = vi.fn(() => { if (!valid) throw Error('original native frontier changed') })
  const admission = { owns: vi.fn(() => true), prepare: vi.fn<NativeInputAdmission['prepare']>(async () => ({ verify })),
    blocksControl: vi.fn(() => false), held: vi.fn() }
  const delivery = vi.fn(), effect = vi.fn<() => Promise<TerminalActionResult>>(async () => ok)
  const write = vi.fn(async (_id: string, _text: string, ticket: TerminalWrite) => ticket.dispatch(effect))
  const runs = { run: writer.run.bind(writer) }
  const run = vi.spyOn(runs, 'run')
  const input = createNativeInput({ admission, resolve: id => id === 'missing' ? undefined : row,
    reserve: id => writer.reserve(id), run: (id, ticket, operation, signal) => runs.run(id, ticket, operation, signal), write, delivery, ...options })
  inputs.push(input)
  return { input, admission, delivery, effect, write, run, writer, row, verify, expire: () => { valid = false } }
}

it('reports physical delivery without claiming a native execution or sending another Enter', async () => {
  const t = setup()
  expect(t.input.owns('agent')).toBe(true)
  t.input.submit('session', 'hello', 'delivery-one')
  await flush()
  expect(t.effect).toHaveBeenCalledOnce()
  expect(t.delivery.mock.calls.map(([event]) => event.state)).toEqual(['queued', 'delivered'])
  expect(t.admission.prepare).toHaveBeenCalledWith(t.row)
  expect(t.admission.held).toHaveBeenLastCalledWith('agent', undefined)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(t.effect).toHaveBeenCalledOnce()
})

it('retains a message and its original owner throughout an unavailable admission reader', async () => {
  const t = setup()
  t.admission.prepare.mockRejectedValue(Error('Waiting for native hook recovery.'))
  t.input.submit('agent', 'keep this', 'delivery-one')
  t.row.sessionId = 'replacement'
  await flush()
  await vi.advanceTimersByTimeAsync(6 * 60_000)
  expect(t.effect).not.toHaveBeenCalled()
  expect(t.delivery.mock.calls.map(([event]) => event.state)).toEqual(['queued'])
  expect(t.admission.held).toHaveBeenLastCalledWith('agent', 'Waiting for native hook recovery.')
  expect(t.admission.prepare.mock.calls.every(([original]) => original.sessionId === 'session')).toBe(true)
  t.admission.prepare.mockResolvedValue({ verify: t.verify })
  t.input.wake('agent'); await flush()
  expect(t.effect).toHaveBeenCalledOnce()
})

it.each(['not_started', 'rejected'] as const)('keeps an unwritten %s result queued and retries under a fresh proof', async dispatch => {
  const t = setup()
  t.write.mockResolvedValueOnce({ state: 'failed', dispatch, reason: 'screen_unreadable' })
  t.input.submit('agent', 'first', 'delivery-one'); await flush()
  expect(t.admission.held).toHaveBeenLastCalledWith('agent', 'screen_unreadable')
  expect(t.delivery).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1000)
  expect(t.admission.prepare).toHaveBeenCalledTimes(2)
  expect(t.effect).toHaveBeenCalledOnce()
})

it.each(['result', 'throw', 'partial refusal'] as const)('does not repeat an uncertain physical dispatch: %s', async failure => {
  const t = setup()
  if (failure === 'result') t.write.mockResolvedValue({ state: 'unknown', dispatch: 'possibly_executed', reason: 'lost reply' })
  else t.effect.mockImplementation(async () => {
    if (failure === 'throw') throw Error('lost write acknowledgement')
    return { state: 'failed', dispatch: 'not_started', reason: 'Enter held after paste' }
  })
  t.input.submit('agent', 'only once', 'delivery-one'); await flush()
  expect(t.delivery).toHaveBeenLastCalledWith({ sessionId: 'agent', deliveryId: 'delivery-one', state: 'unknown', reason: 'dispatch_ambiguous' })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(t.write).toHaveBeenCalledOnce()
})

it('rechecks the native proof after a delayed screen read and before physical dispatch', async () => {
  const t = setup()
  let resume!: () => void
  t.write.mockImplementation(async (_id, _text, write) => {
    await new Promise<void>(resolve => { resume = resolve })
    expect(write.allowed()).toBe(false)
    return write.dispatch(t.effect)
  })
  t.input.submit('agent', 'hello'); await flush()
  t.expire(); resume(); await flush()
  expect(t.effect).not.toHaveBeenCalled()
  expect(t.admission.held).toHaveBeenLastCalledWith('agent', 'original native frontier changed')
})

it('never renews a writer epoch revoked by Cancel just because another retry is due', async () => {
  const t = setup()
  t.admission.prepare.mockRejectedValue(Error('temporary hold'))
  t.input.submit('agent', 'held'); await flush()
  await t.writer.interrupt('agent', async () => {})
  t.admission.prepare.mockResolvedValue({ verify: t.verify })
  await vi.advanceTimersByTimeAsync(1000)
  expect(t.effect).not.toHaveBeenCalled()
  expect(t.admission.held).toHaveBeenLastCalledWith('agent', expect.stringContaining('original native input owner'))
})

it('holds writer capacity refusal without rejecting or losing accepted messages', async () => {
  const t = setup()
  t.run.mockRejectedValueOnce(new TerminalWriteHeld('Waiting for terminal writer capacity.'))
  t.input.submit('agent', 'held', 'delivery-one'); await flush()
  expect(t.delivery).toHaveBeenCalledOnce()
  expect(t.admission.prepare).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1000)
  expect(t.delivery).toHaveBeenLastCalledWith({ sessionId: 'agent', deliveryId: 'delivery-one', state: 'delivered' })
})

it('keeps FIFO order and lets an answer resolve a dialog that holds queued input', async () => {
  const t = setup()
  t.write.mockResolvedValueOnce({ state: 'failed', dispatch: 'not_started', reason: 'question_open' })
  t.input.submit('agent', 'first', 'one')
  expect(t.input.blocksControl('agent', true)).toBe(true)
  t.input.submit('agent', 'second', 'two'); await flush()
  expect(t.input.blocksControl('agent', false)).toBe(true)
  expect(t.input.blocksControl('agent', true)).toBe(false)
  t.admission.blocksControl.mockReturnValueOnce(true)
  expect(t.input.blocksControl('agent', true)).toBe(true)
  await vi.advanceTimersByTimeAsync(2000)
  expect(t.write.mock.calls.map(call => call[1])).toEqual(['first', 'first', 'second'])
  expect(t.input.blocksControl('agent', false)).toBe(false)
})

it('cancels only undispatched delivery requests and revokes their delayed preparation', async () => {
  const t = setup()
  let resume!: (permit: { verify(): void }) => void
  t.admission.prepare.mockImplementationOnce(() => new Promise(resolve => { resume = resolve }))
  t.input.submit('agent', 'first', 'one')
  t.input.submit('agent', 'second', 'two')
  expect(t.input.cancelDelivery('absent')).toBe(false)
  expect(t.input.cancelDelivery('one')).toBe(true)
  resume({ verify: t.verify }); await flush()
  expect(t.effect).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1000)
  expect(t.write.mock.calls.map(call => call[1])).toEqual(['second'])
})

it('does not claim to cancel a request after its physical dispatch began', async () => {
  const t = setup()
  let done!: (result: TerminalActionResult) => void
  t.effect.mockImplementationOnce(() => new Promise(resolve => { done = resolve }))
  t.input.submit('agent', 'first', 'one'); await flush()
  expect(t.input.cancelDelivery('one')).toBe(false)
  done(ok); await flush()
  expect(t.delivery).toHaveBeenLastCalledWith({ sessionId: 'agent', deliveryId: 'one', state: 'delivered' })
})

it('cancels held queued work without leaving a timer or blocking its successor', async () => {
  const t = setup()
  t.admission.prepare.mockRejectedValue('temporary native hold')
  t.input.submit('agent', 'first', 'one'); await flush()
  t.input.submit('agent', 'second', 'two'); await flush()
  expect(t.input.cancelDelivery('one')).toBe(true)
  expect(t.input.cancelDelivery('two')).toBe(true)
  expect(t.input.blocksControl('agent', false)).toBe(false)
  await vi.advanceTimersByTimeAsync(1000)
  expect(t.effect).not.toHaveBeenCalled()
})

it.each(['unwritten', 'dispatched'] as const)('forgets an original owner without letting its %s continuation affect replacement work', async phase => {
  const t = setup()
  let done!: () => void
  if (phase === 'unwritten') t.admission.prepare.mockImplementationOnce(async () => {
    await new Promise<void>(resolve => { done = resolve }); return { verify: t.verify }
  })
  else t.effect.mockImplementationOnce(async () => { await new Promise<void>(resolve => { done = resolve }); return ok })
  t.input.submit('agent', 'first', 'one'); await flush()
  t.input.forget('agent'); t.input.forget('absent')
  expect(t.delivery).toHaveBeenLastCalledWith({ sessionId: 'agent', deliveryId: 'one', state: phase === 'dispatched' ? 'unknown' : 'rejected', reason: 'agent_gone' })
  const before = t.delivery.mock.calls.length
  done(); await flush()
  expect(t.delivery).toHaveBeenCalledTimes(before)
  t.input.wake('agent')
})

it.each(['agents', 'items', 'bytes'] as const)('bounds accepted input by %s while preserving the already queued request', async bound => {
  const t = setup({ maxAgents: bound === 'agents' ? 1 : 2, maxQueued: bound === 'items' ? 1 : 4,
    maxBytes: bound === 'bytes' ? 5 : 20 })
  t.admission.prepare.mockRejectedValue(Error('hold'))
  t.input.submit('agent', 'first', 'one'); await flush()
  if (bound === 'agents') t.row.agentId = 'second-agent'
  t.input.submit('agent', bound === 'bytes' ? 'too long' : 'next', 'two')
  expect(t.delivery).toHaveBeenLastCalledWith({ sessionId: t.row.agentId, deliveryId: 'two', state: 'rejected', reason: 'queue_full' })
  expect(t.effect).not.toHaveBeenCalled()
})

it('handles local messages, missing agents, shutdown and unavailable status consumers without another effect', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const t = setup()
  t.delivery.mockImplementation(() => { throw Error('optional delivery service unavailable') })
  t.admission.held.mockImplementation(() => { throw Error('status consumer unavailable') })
  t.input.submit('missing', 'none')
  t.input.submit('agent', 'first', 'one'); await flush()
  expect(t.effect).toHaveBeenCalledOnce()
  t.input.close()
  t.input.submit('agent', 'closed'); t.input.wake('agent'); await flush()
  expect(t.effect).toHaveBeenCalledOnce()
})

it('holds an overflowing local message visibly and can inspect control for an absent agent', async () => {
  const t = setup({ maxBytes: 1 })
  t.input.submit('agent', 'too long')
  expect(t.admission.held).toHaveBeenCalledWith('agent', expect.stringContaining('capacity is full'))
  expect(t.delivery).not.toHaveBeenCalled()
  expect(t.input.blocksControl('missing', true)).toBe(false)
  expect(t.effect).not.toHaveBeenCalled()
})

it('acquires capacity when it returns and reserves that epoch across holds without reviving it after an interrupt', async () => {
  const writer = createTerminalWriter({ maxLanes: 1 })
  const busy = writer.reserve('busy')!
  const t = setup({ reserve: writer.reserve, run: writer.run })
  t.admission.prepare.mockRejectedValue(Error('reader unavailable'))
  t.input.submit('agent', 'kept', 'delivery-one'); await flush()
  expect(t.admission.held).toHaveBeenLastCalledWith('agent', 'Waiting for terminal writer capacity.')
  busy.release()
  t.input.wake('agent'); await flush()
  expect(t.admission.held).toHaveBeenLastCalledWith('agent', 'reader unavailable')
  expect(writer.ticket('another').allowed()).toBe(false)
  await writer.interrupt('agent', async () => {})
  t.admission.prepare.mockResolvedValue({ verify: t.verify })
  t.input.wake('agent'); await flush()
  expect(t.effect).not.toHaveBeenCalled()
  expect(t.admission.held).toHaveBeenLastCalledWith('agent', expect.stringContaining('original native input owner'))
  t.input.cancelDelivery('delivery-one')
  expect(writer.ticket('another').allowed()).toBe(true)
})

it('delivers a queued message after temporary capacity returns without requiring restart', async () => {
  const writer = createTerminalWriter({ maxLanes: 1 }), busy = writer.reserve('busy')!
  const t = setup({ reserve: writer.reserve, run: writer.run })
  t.input.submit('agent', 'kept', 'delivery-one'); await flush()
  expect(t.effect).not.toHaveBeenCalled()
  busy.release()
  await vi.advanceTimersByTimeAsync(1000)
  expect(t.effect).toHaveBeenCalledOnce()
})
