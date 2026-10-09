/**
 * The pane writer lock's edges (core/deviceInput.ts): what happens when the agent goes, the queue fills,
 * a write is cancelled or fails part way, or the pane cannot be read. Each is a write into a person's
 * pane that must either happen once or be said not to have happened.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutonomousDeviceInput, type DeviceInputDeps } from './deviceInput.js'
import { inlineSubmission } from '../testing/inlineSubmission.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { TerminalActionResult } from '../lib/terminalTypes.js'

afterEach(() => vi.useRealTimers())

const claude = { agentId: 'agent', engine: 'claude' } as RegisteredSession
const codex = (cliVersion?: string) => ({ agentId: 'agent', engine: 'codex', cliVersion }) as RegisteredSession
const executed: TerminalActionResult = { state: 'succeeded', dispatch: 'executed' }

function lock(overrides: Partial<DeviceInputDeps> = {}) {
  const onDelivery = vi.fn()
  const onInputStatus = vi.fn()
  const device = new AutonomousDeviceInput({
    getSession: () => claude,
    validateRuntime: async () => true, inject: async () => executed, sendKey: async () => true,
    capture: async () => '› ', submission: inlineSubmission, acquireControl: () => () => {}, legacySubmit: vi.fn(), legacyCancel: () => false,
    onDelivery, onInputStatus, ...overrides,
  })
  const states = (deliveryId: string) => onDelivery.mock.calls.map(([event]) => event).filter((event) => event.deliveryId === deliveryId)
    .map((event) => event.reason ? `${event.state}:${event.reason}` : event.state)
  return { device, onDelivery, onInputStatus, states }
}

/** A promise and the hand that settles it. */
function held<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('the pane writer lock, at its edges', () => {
  it('refuses a turn for an agent that is gone, and a queue that is full by count or by size', async () => {
    const gone = lock({ getSession: () => undefined })
    gone.device.submit('agent', 'hello', 'd0')
    expect(gone.states('d0')).toEqual(['rejected:agent_gone'])

    // The pane never comes free, so every turn waits in the queue.
    const busy = lock({ acquireControl: () => null })
    for (let i = 1; i <= 9; i++) busy.device.submit('agent', `turn ${i}`, `d${i}`)
    expect(busy.states('d8')).toEqual(['queued'])
    expect(busy.states('d9')).toEqual(['rejected:queue_full'])
    const big = lock({ acquireControl: () => null })
    big.device.submit('agent', 'x'.repeat(20 * 1024), 'b1')
    big.device.submit('agent', 'y'.repeat(5 * 1024), 'b2')
    expect(big.states('b2')).toEqual(['rejected:queue_full'])
    busy.device.forget('agent')
    big.device.forget('agent')
  })

  it('lets a queued turn expire, and forgets an agent that went while its turn waited', async () => {
    vi.useFakeTimers()
    let session: RegisteredSession | undefined = claude
    let free = false
    const f = lock({ getSession: () => session, acquireControl: () => free ? () => {} : null })
    f.device.submit('agent', 'old', 'old')
    await vi.advanceTimersByTimeAsync(6 * 60_000)
    f.device.submit('agent', 'new', 'new')
    expect(f.states('old')).toEqual(['queued', 'rejected:queue_expired'])
    session = undefined
    free = true
    await vi.advanceTimersByTimeAsync(200)
    expect(f.states('new')).toEqual(['queued', 'rejected:agent_gone'])
  })

  it('waits for a write already in the pane, then writes', async () => {
    vi.useFakeTimers()
    const f = lock()
    const legacy = held<void>()
    const writing = f.device.legacyWrite('agent', () => legacy.promise)
    f.device.submit('agent', 'after the window', 'd1')
    await vi.advanceTimersByTimeAsync(150)
    expect(f.states('d1')).toEqual(['queued'])
    legacy.resolve()
    await writing
    await vi.advanceTimersByTimeAsync(150)
    expect(f.states('d1')).toEqual(['queued', 'delivered'])
    f.device.forget('agent')
  })

  it('refuses before it writes when the agent cannot be checked, or the turn was cancelled meanwhile', async () => {
    const dead = lock({ validateRuntime: async () => false })
    dead.device.submit('agent', 'hello', 'd1')
    await vi.waitFor(() => expect(dead.states('d1')).toEqual(['queued', 'rejected:runtime_gone_pre_paste']))

    const validating = held<boolean>()
    const cancelled = lock({ validateRuntime: () => validating.promise })
    cancelled.device.submit('agent', 'hello', 'd2')
    // Cancelled while it is checked: it is the active write, not yet dispatched, so it can still be withdrawn.
    expect(cancelled.device.cancelDelivery('d2')).toBe(true)
    validating.resolve(true)
    await vi.waitFor(() => expect(cancelled.states('d2')).toEqual(['queued', 'rejected:cancelled']))
    expect(cancelled.device.cancelDelivery('nothing')).toBe(false)

    const asking = held<boolean>()
    let looking = false
    const waiting = lock({ isAwaitingUser: () => { looking = true; return asking.promise } })
    waiting.device.submit('agent', 'hello', 'd3')
    await vi.waitFor(() => expect(looking).toBe(true))
    expect(waiting.device.cancelDelivery('d3')).toBe(true)
    asking.resolve(false)
    await vi.waitFor(() => expect(waiting.states('d3')).toEqual(['queued', 'rejected:cancelled']))

    // A throw while checking, before anything was written, is a refusal too.
    const thrown = lock({ validateRuntime: async () => { throw new Error('ps failed') } })
    thrown.device.submit('agent', 'hello', 'd4')
    await vi.waitFor(() => expect(thrown.states('d4')).toEqual(['queued', 'rejected:runtime_gone_pre_paste']))
  })

  it('writes a turn into a busy Codex as steering on 0.106 and later, and as plain input before it', async () => {
    for (const [version, mode] of [['0.105.2', 'native_input'], [undefined, 'native_input'], ['1.0.0', 'steering']] as const) {
      const f = lock({ getSession: () => codex(version) })
      f.device.onTurnStarted('agent', 'already working')
      f.device.submit('agent', 'and this', 'd1')
      await vi.waitFor(() => expect(f.onInputStatus).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: 'd1', mode, phase: 'submitted' })))
      f.device.forget('agent')
    }
  })

  it('writes a busy Claude Code turn into its own queue, and never claims steering for an engine retargeted after it was queued', async () => {
    for (const [engine, mode] of [['claude', 'native_queue'], ['commandcode', 'native_input'], ['codex', 'steering']] as const) {
      // Queued for a native engine; the registry row changes in place before it is typed.
      const session = codex('0.200.0')
      const f = lock({ getSession: () => session, validateRuntime: async () => { session.engine = engine; return true } })
      f.device.onTurnStarted('agent', 'already working')
      f.device.submit('agent', 'and this', 'd1')
      await vi.waitFor(() => expect(f.onInputStatus).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: 'd1', mode, phase: 'submitted' })))
      f.device.forget('agent')
    }
  })

  it('reads the composer through the engine\'s worker, and takes no reading as an unreadable pane', async () => {
    vi.useFakeTimers()
    const sendKey = vi.fn(async () => true)
    // The draft is still there as the worker reads it: the one evidence-backed Enter.
    const pending = lock({ sendKey, submission: { ...inlineSubmission, read: async () => ({ draft: true, composer: true, nativeDraft: 'pending' }) } })
    pending.device.submit('agent', 'hello', 'd1')
    await vi.advanceTimersByTimeAsync(1_600)
    expect(sendKey).toHaveBeenCalledWith('agent', 'Enter')
    pending.device.forget('agent')
    for (const read of [async () => null, async () => { throw new Error('worker gone') }]) {
      sendKey.mockClear()
      const f = lock({ sendKey, submission: { ...inlineSubmission, read } })
      f.device.submit('agent', 'hello', 'd2')
      await vi.advanceTimersByTimeAsync(20_000)
      expect(sendKey).not.toHaveBeenCalled()
      expect(f.onInputStatus).toHaveBeenLastCalledWith(expect.objectContaining({ deliveryId: 'd2', phase: 'unconfirmed' }))
      f.device.forget('agent')
    }
    // The agent gone by the time the pane was read: nothing to read it for.
    let present = true
    const read = vi.fn(async () => ({ draft: false, composer: true, nativeDraft: 'clear' as const }))
    const gone = lock({ sendKey, getSession: () => present ? claude : undefined, submission: { ...inlineSubmission, read }, capture: async () => { present = false; return '› ' } })
    gone.device.submit('agent', 'hello', 'd3')
    await vi.advanceTimersByTimeAsync(1_600)
    expect(read).not.toHaveBeenCalled()
    gone.device.forget('agent')
  })

  it('drops a reading that comes back after the write was settled', async () => {
    const reading = held<{ draft: boolean; composer: boolean; nativeDraft: 'pending' } | null>()
    const sendKey = vi.fn(async () => true)
    const f = lock({ sendKey, submission: { ...inlineSubmission, read: () => reading.promise } })
    f.device.submit('agent', 'hello', 'd1')
    await vi.waitFor(() => expect(f.states('d1')).toEqual(['queued', 'delivered']))
    f.device.onTurnStarted('agent', 'hello')
    reading.resolve({ draft: true, composer: true, nativeDraft: 'pending' })
    await vi.waitFor(() => expect(f.states('d1')).toEqual(['queued', 'delivered', 'started']))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(sendKey).not.toHaveBeenCalled()
    f.device.forget('agent')
  })

  it('finishes a write whose turn began while it was being typed', async () => {
    const typing = held<TerminalActionResult>()
    const f = lock({ inject: () => typing.promise })
    f.device.submit('agent', 'hello', 'd1')
    await vi.waitFor(() => expect(f.onInputStatus).toHaveBeenCalledTimes(1))
    f.device.onTurnStarted('agent', 'hello')
    typing.resolve(executed)
    await vi.waitFor(() => expect(f.states('d1')).toEqual(['queued', 'started']))
    // The next turn is not held behind it.
    f.device.submit('agent', 'next', 'd2')
    await vi.waitFor(() => expect(f.states('d2')).toContain('delivered'))
    f.device.forget('agent')
  })

  it('says a write that failed after typing began is unknown, and looks again', async () => {
    vi.useFakeTimers()
    const f = lock({ inject: async () => { throw new Error('tmux went away') }, capture: async () => null })
    f.device.submit('agent', 'hello', 'd1')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.states('d1')).toEqual(['queued', 'unknown:dispatch_ambiguous'])
    // It looks at the pane again: unreadable, it keeps looking, then says it could not confirm.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(f.onInputStatus).toHaveBeenLastCalledWith(expect.objectContaining({ deliveryId: 'd1', phase: 'unconfirmed' }))
    f.device.forget('agent')

    // A write that failed but whose turn started is simply finished.
    const late = lock({ inject: async () => { late.device.onTurnStarted('agent', 'hello'); throw new Error('late') } })
    late.device.submit('agent', 'hello', 'd2')
    await vi.advanceTimersByTimeAsync(0)
    expect(late.states('d2')).toEqual(['queued', 'started'])

    // Forgotten while it was being written: nothing more is said about it.
    const typing = held<TerminalActionResult>()
    const forgotten = lock({ inject: () => typing.promise })
    forgotten.device.submit('agent', 'hello', 'd3')
    await vi.advanceTimersByTimeAsync(0)
    forgotten.device.forget('agent')
    typing.reject(new Error('gone'))
    await vi.advanceTimersByTimeAsync(0)
    expect(forgotten.states('d3')).toEqual(['queued', 'unknown:agent_gone'])
  })

  it('keeps reading a pane that cannot be read, and gives up saying so', async () => {
    vi.useFakeTimers()
    const f = lock({ capture: async () => { throw new Error('capture failed') } })
    f.device.submit('agent', 'hello', 'd1')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.states('d1')).toEqual(['queued', 'delivered', 'unknown:dispatch_ambiguous'])
    await vi.advanceTimersByTimeAsync(20_000)
    expect(f.onInputStatus).toHaveBeenLastCalledWith(expect.objectContaining({ deliveryId: 'd1', phase: 'unconfirmed' }))
    f.device.forget('agent')

    // Forgotten while its pane was being read: the read's answer is not acted on.
    const reading = held<string | null>()
    const gone = lock({ capture: () => reading.promise })
    gone.device.submit('agent', 'hello', 'd2')
    await vi.advanceTimersByTimeAsync(0)
    gone.device.forget('agent')
    reading.resolve('› hello')
    await vi.advanceTimersByTimeAsync(0)
    expect(gone.states('d2')).toEqual(['queued', 'delivered', 'unknown:agent_gone'])

    // A read that fails after the turn started says nothing more.
    const failing = held<string | null>()
    const started = lock({ capture: () => failing.promise })
    started.device.submit('agent', 'hello', 'd3')
    await vi.advanceTimersByTimeAsync(0)
    started.device.onTurnStarted('agent', 'hello')
    failing.reject(new Error('late'))
    await vi.advanceTimersByTimeAsync(0)
    expect(started.states('d3')).toEqual(['queued', 'delivered', 'started'])
  })

  it('does not press Enter again while a question holds the pane', async () => {
    vi.useFakeTimers()
    const sendKey = vi.fn(async () => true)
    let asking = false
    const f = lock({ capture: async () => '› hello', sendKey, isAwaitingUser: async () => asking })
    f.device.submit('agent', 'hello', 'd1')
    await vi.advanceTimersByTimeAsync(0)
    asking = true
    await vi.advanceTimersByTimeAsync(1_600)
    expect(sendKey).not.toHaveBeenCalled()
    f.device.forget('agent')

    // Forgotten while the question was being looked for.
    const looking = held<boolean>()
    let first = true
    const g = lock({ capture: async () => '› hello', sendKey, isAwaitingUser: () => first ? (first = false, Promise.resolve(false)) : looking.promise })
    g.device.submit('agent', 'hello', 'd2')
    await vi.advanceTimersByTimeAsync(1_600)
    g.device.forget('agent')
    looking.resolve(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(sendKey).not.toHaveBeenCalled()
  })

  it('stops looking at a write once its turn starts', async () => {
    vi.useFakeTimers()
    const capture = vi.fn(async () => '› hello')
    const f = lock({ capture })
    f.device.submit('agent', 'hello', 'd1')
    await vi.advanceTimersByTimeAsync(0)
    // Still in the composer when looked at: it is looked at again, until the turn starts.
    const looked = capture.mock.calls.length
    f.device.onTurnStarted('agent', 'hello')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(capture.mock.calls.length).toBe(looked)
    expect(f.states('d1')).toEqual(['queued', 'delivered', 'started'])
    f.device.forget('agent')
  })

  it('looks at a write again when its turn ends before it was seen to start', async () => {
    vi.useFakeTimers()
    const capture = vi.fn(async () => '› hello')
    const f = lock({ capture })
    f.device.onTurnStarted('agent', 'something else')
    f.device.submit('agent', 'hello', 'd1')
    await vi.advanceTimersByTimeAsync(0)
    const looked = capture.mock.calls.length
    f.device.onTurnEnded('agent')
    await vi.advanceTimersByTimeAsync(1_600)
    expect(capture.mock.calls.length).toBeGreaterThan(looked)
    f.device.forget('agent')
  })

  it('withdraws a queued turn, and hands any other to the window\'s queue', () => {
    const legacyCancel = vi.fn(() => true)
    const f = lock({ acquireControl: () => null, legacyCancel })
    f.device.submit('agent', 'first', 'd1')
    f.device.submit('agent', 'second', 'd2')
    expect(f.device.cancelDelivery('d2')).toBe(true)
    expect(f.states('d2')).toEqual(['queued', 'rejected:cancelled'])
    expect(f.device.cancelDelivery('elsewhere')).toBe(true)
    expect(legacyCancel).toHaveBeenCalledWith('elsewhere')
    f.device.forget('agent')
  })
})
