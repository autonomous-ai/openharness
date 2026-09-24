import { CodexNormalizer } from '../../engines/codex/normalizer.js'
import { lineToEvents, newTurnState, type LiveEvent } from '../normalize.js'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutonomousDeviceInput, isDeviceInputBoundary, type DeviceInputDeps } from './input.js'
import { SessionInputController } from '../sessionInput.js'
import { AutonomousDeviceService } from './service.js'
import type { RegisteredSession } from '../registry.js'
import type { TerminalActionResult } from '../terminalTypes.js'

function makeDevice(overrides: Partial<DeviceInputDeps>): AutonomousDeviceInput {
  return new AutonomousDeviceInput({
    getSession: () => ({ agentId: 'agent', engine: 'claude' }) as RegisteredSession,
    validateRuntime: async () => true, inject: async () => true, sendKey: async () => true,
    capture: async () => '› ', acquireControl: () => () => {}, legacySubmit: vi.fn(), legacyCancel: () => false,
    onDelivery: vi.fn(), onInputStatus: vi.fn(), ...overrides,
  })
}

function fixture(engine: 'claude' | 'codex' | 'commandcode' = 'codex') {
  let available = true
  const session = { agentId: 'agent', engine, cliVersion: '0.106.0' } as RegisteredSession
  const inject = vi.fn(async (_target: string, _text: string): Promise<TerminalActionResult> => ({ state: 'succeeded', dispatch: 'executed' }))
  const capture = vi.fn(async (): Promise<string | null> => '› \nWorking…')
  const sendKey = vi.fn(async (_id: string, _key: string) => true)
  const events: Record<string, unknown>[] = []
  const service = new AutonomousDeviceService({
    machineId: 'machine', agents: () => available ? [{ agentId: 'agent', engine, name: 'Agent', state: 'working' }] : [],
    submit: (id, text, delivery) => controller.submit(id, text, delivery), cancelDelivery: id => controller.cancelDelivery(id),
    stop: async () => true, answer: async () => true, recent: () => [], emit: frame => events.push(frame),
  })
  const legacy: SessionInputController = new SessionInputController({
    getSession: () => available ? session : undefined, validateRuntime: async () => available,
    inject: (id, text) => controller.legacyWrite(id, () => inject(id, text)),
    sendKey: (id, key) => controller.legacyWrite(id, () => sendKey(id, key)), capture, onError: vi.fn(),
    onDelivery: event => service.delivery(event),
  })
  const controller: AutonomousDeviceInput = new AutonomousDeviceInput({
    acquireControl: id => legacy.acquireControl(id, { forAnswer: true }),
    legacySubmit: (id, text, delivery) => legacy.submit(id, text, delivery),
    legacyCancel: id => legacy.cancelDelivery(id),
    onForget: id => service.agentGone(id),
    getSession: () => available ? session : undefined, validateRuntime: async () => available,
    inject, capture, sendKey, onDelivery: event => service.delivery(event),
    onInputStatus: event => service.inputStatus(event),
  })
  const send = (key: string, text = key, focusRevision?: string) => service.request('device', {
    type: 'turn.send', requestId: randomUUID(), machineId: 'machine', agentId: 'agent', idempotencyKey: key, text,
    ...(focusRevision ? { focusRevision } : {}),
  })
  const start = (text: string) => { legacy.onTurnStarted('agent', text); controller.onTurnStarted('agent', text); service.turnStarted('agent') }
  const end = () => { service.turnEnded('agent'); legacy.onTurnEnded('agent'); controller.onTurnEnded('agent') }
  return { controller, legacy, service, inject, capture, sendKey, send, start, end, events,
    gone: () => { available = false; controller.forget('agent') }, receipt: (key: string) => service.receipt('device', key)! }
}

afterEach(() => vi.useRealTimers())

describe('in-flight input through the Autonomous Device contract', () => {
  it.each(['harness-use', 'Harness-only voice'])('%s delivers B before A ends, preserving retry and focus guards', async caller => {
    vi.useFakeTimers()
    const f = fixture()
    f.service.appFocus('machine', 'agent', 'desktop')
    const revision = caller === 'Harness-only voice' ? f.service.focusSnapshot().focusRevision : undefined
    await f.send('A', 'Create a house', revision)
    await vi.advanceTimersByTimeAsync(0)
    f.start('Create a house')
    await f.send('B', 'Make the roof red', revision)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.inject.mock.calls.map(call => call[1])).toEqual(['Create a house', 'Make the roof red'])
    expect(f.receipt('A').state).toBe('started')
    expect(f.receipt('B')).toMatchObject({ state: 'delivered', input: { mode: 'steering', phase: 'accepted' } })
    // Lost RPC acknowledgment + reconnect: same key returns its own reservation.
    const before = f.receipt('B').deliveryId
    const cursor = f.service.resume().cursor
    const replay: unknown[] = []
    f.service.replay({ serverInstanceId: f.service.serverInstanceId, cursor: 0 }, event => replay.push(event))
    expect(replay.length).toBe(cursor)
    expect(await f.send('B', 'Make the roof red', revision)).toMatchObject({ status: 'duplicate', receipt: { deliveryId: before } })
    expect(f.inject).toHaveBeenCalledTimes(2)
    f.end()
    expect(f.receipt('A').state).toBe('completed')
    expect(f.receipt('B').state).toBe('delivered')
    f.start('Make the roof red')
    f.end()
    expect(f.receipt('B').state).toBe('completed')
    expect(f.receipt('B').turnId).not.toBe(f.receipt('A').turnId)
    f.controller.forget('agent')
  })

  it('serializes rapid Device A/B/C writes, while the agent stays busy', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const finish: Array<() => void> = []
    f.inject.mockImplementation(() => new Promise(resolve => finish.push(() => resolve({ state: 'succeeded', dispatch: 'executed' }))))
    f.start('existing task')
    await f.send('A')
    await f.send('B')
    await f.send('C')
    expect(f.inject.mock.calls.map(call => call[1])).toEqual(['A'])
    expect(f.legacy.acquireControl('agent', { forAnswer: true })).toBeNull()
    finish[0]()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.inject.mock.calls.map(call => call[1])).toEqual(['A', 'B'])
    finish[1]()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.inject.mock.calls.map(call => call[1])).toEqual(['A', 'B', 'C'])
    finish[2]()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.sendKey).not.toHaveBeenCalled()
    f.controller.forget('agent')
  })

  it('keeps native-queue receipts independent across the old turn ending', async () => {
    vi.useFakeTimers()
    const f = fixture('claude')
    f.start('existing task')
    await f.send('B')
    await f.send('C')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.inject.mock.calls.map(call => call[1])).toEqual(['B', 'C'])
    expect(f.receipt('B').input).toEqual({ mode: 'native_queue', phase: 'accepted' })
    f.end()
    expect(f.receipt('B').state).toBe('delivered')
    expect(f.receipt('C').state).toBe('delivered')
    f.start('B'); f.end()
    expect(f.receipt('B').state).toBe('completed')
    expect(f.receipt('C').state).toBe('delivered')
    f.start('C'); f.end()
    expect(f.receipt('C').state).toBe('completed')
    f.controller.forget('agent')
  })

  it('does not assign one session done or summary to overlapping steered inputs', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.send('A'); await vi.advanceTimersByTimeAsync(0); f.start('A')
    await f.send('B'); await vi.advanceTimersByTimeAsync(0); f.start('B')
    f.end()
    f.service.commander({ type: 'commander_event', agentId: 'agent', payload: { kind: 'summary', text: 'A answer' } })
    expect(f.receipt('A')).toMatchObject({ state: 'unknown', error: { code: 'OVERLAPPING_INPUTS' } })
    expect(f.receipt('B')).toMatchObject({ state: 'unknown', error: { code: 'OVERLAPPING_INPUTS' } })
    expect(f.events.findLast(event => event.kind === 'turn.done')).toMatchObject({ payload: {} })
    expect(await f.send('B')).toMatchObject({ status: 'duplicate' })
    expect(f.inject).toHaveBeenCalledTimes(2)
    f.controller.forget('agent')
  })

  it('does not attribute an untracked running task completion to a steered message', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.start('local task')
    await f.send('B'); await vi.advanceTimersByTimeAsync(0); f.start('B'); f.end()
    expect(f.receipt('B').state).toBe('unknown')
    f.controller.forget('agent')
  })

  it('never retries a timed-out native write or appends to an unconfirmed composer', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.inject.mockResolvedValue({ state: 'unknown', dispatch: 'possibly_executed', reason: 'ack lost' })
    f.capture.mockResolvedValue('› A')
    await f.send('A'); await f.send('B')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.receipt('A').state).toBe('unknown')
    expect(f.receipt('B').state).toBe('queued')
    expect(f.inject).toHaveBeenCalledTimes(1)
    expect(f.sendKey).not.toHaveBeenCalled()
    expect(await f.send('A')).toMatchObject({ status: 'duplicate' })
    // A later transcript match is evidence; a timer was never permission to resend.
    f.start('A')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.inject.mock.calls.map(call => call[1])).toEqual(['A', 'B'])
    f.controller.forget('agent')
  })

  it('does not treat an unreadable or dialog-only screen as an empty composer', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.capture.mockResolvedValue('Allow this tool?')
    await f.send('A'); await f.send('B'); await vi.advanceTimersByTimeAsync(30_000)
    expect(f.inject).toHaveBeenCalledTimes(1)
    expect(f.receipt('A').input?.phase).toBe('unconfirmed')
    f.controller.forget('agent')
  })

  it('queues unsupported engines in the daemon, with an explicit disposition', async () => {
    vi.useFakeTimers()
    const f = fixture('commandcode')
    f.start('existing task')
    await f.send('B')
    expect(f.inject).not.toHaveBeenCalled()
    expect(f.receipt('B').input).toEqual({ mode: 'daemon_queue', phase: 'waiting_for_turn' })
    f.end(); await vi.advanceTimersByTimeAsync(0)
    expect(f.inject.mock.calls.map(call => call[1])).toEqual(['B'])
    f.controller.forget('agent')
  })

  it('holds new prompts for a user action but lets the explicit answer acquire control', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.start('existing task')
    f.controller.setUserAction('agent', true)
    await f.send('B')
    expect(f.receipt('B').input).toEqual({ mode: 'daemon_queue', phase: 'waiting_for_user' })
    const release = f.legacy.acquireControl('agent', { forAnswer: true })
    expect(release).not.toBeNull()
    f.controller.setUserAction('agent', false)
    expect(f.inject).not.toHaveBeenCalled()
    release!(); await vi.advanceTimersByTimeAsync(1500)
    expect(f.inject.mock.calls.map(call => call[1])).toEqual(['B'])
    f.controller.forget('agent')
  })

  it('marks pasted work unknown and unsent work rejected when the session disappears', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let finish!: () => void
    f.inject.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ state: 'succeeded', dispatch: 'executed' }) }))
    await f.send('A'); await f.send('B')
    f.gone(); finish(); await vi.advanceTimersByTimeAsync(0)
    expect(f.receipt('A')).toMatchObject({ state: 'unknown', error: { code: 'AGENT_GONE' } })
    expect(f.receipt('B')).toMatchObject({ state: 'rejected', error: { code: 'agent_gone' } })
    expect(f.inject).toHaveBeenCalledTimes(1)
  })
})

describe('native input write evidence', () => {
  it('waits for a detected permission dialog to close before touching the composer', async () => {
    vi.useFakeTimers()
    let blocked = true
    const inject = vi.fn(async (_target: string, _text: string) => true)
    const statuses: unknown[] = []
    const controller = makeDevice({
      getSession: () => ({ agentId: 'agent', engine: 'claude' }) as RegisteredSession,
      validateRuntime: async () => true, isAwaitingUser: async () => blocked,
      inject, sendKey: async () => true, onInputStatus: event => statuses.push(event),
    })
    controller.onTurnStarted('agent', 'existing task')
    controller.submit('agent', 'B', 'B')
    await vi.advanceTimersByTimeAsync(0)
    expect(inject).not.toHaveBeenCalled()
    expect(statuses).toContainEqual({ sessionId: 'agent', deliveryId: 'B', mode: 'daemon_queue', phase: 'waiting_for_user' })
    blocked = false
    await vi.advanceTimersByTimeAsync(1500)
    expect(inject).toHaveBeenCalledExactlyOnceWith('agent', 'B')
    controller.forget('agent')
  })

  it('does not downgrade a transcript-confirmed start when the write acknowledgment is lost', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let fail!: () => void
    f.inject.mockImplementation(() => new Promise((_resolve, reject) => { fail = () => reject(new Error('ack lost')) }))
    await f.send('A'); await vi.advanceTimersByTimeAsync(0)
    f.start('A'); fail(); await vi.advanceTimersByTimeAsync(0)
    expect(f.receipt('A').state).toBe('started')
    expect(f.receipt('A').input?.phase).toBe('accepted')
    expect(await f.send('A')).toMatchObject({ status: 'duplicate' })
    expect(f.inject).toHaveBeenCalledTimes(1)
    f.end()
    expect(f.receipt('A').state).toBe('completed')
    f.controller.forget('agent')
  })

  it('marks an observed running delivery unknown when its session disappears', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.send('A'); await vi.advanceTimersByTimeAsync(0); f.start('A')
    f.gone()
    expect(f.receipt('A')).toMatchObject({ state: 'unknown', error: { code: 'AGENT_GONE' } })
    f.end()
    expect(f.receipt('A').state).toBe('unknown')
  })

  it('holds the next writer across an evidence-backed Enter retry and never repeats a lost key acknowledgment', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.capture.mockResolvedValue('› A')
    let resolveKey!: (value: boolean) => void
    f.sendKey.mockImplementation(() => new Promise(resolve => { resolveKey = resolve }))
    await f.send('A'); await f.send('B')
    await vi.advanceTimersByTimeAsync(1500)
    expect(f.sendKey).toHaveBeenCalledExactlyOnceWith('agent', 'Enter')
    expect(f.inject).toHaveBeenCalledTimes(1)
    resolveKey(false) // no proof whether the key took effect
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.sendKey).toHaveBeenCalledTimes(1)
    expect(f.inject).toHaveBeenCalledTimes(1)
    expect(f.receipt('A').state).toBe('unknown')
    expect(f.receipt('B').state).toBe('queued')
    f.controller.forget('agent')
  })
})

it('preserves A/B order if a dialog appears during the first preflight check', async () => {
  vi.useFakeTimers()
  let release!: (blocked: boolean) => void
  const probe = vi.fn<() => Promise<boolean>>().mockImplementationOnce(() => new Promise(resolve => { release = resolve })).mockResolvedValue(false)
  const inject = vi.fn(async (_target: string, _text: string) => true)
  const controller = makeDevice({
    getSession: () => ({ agentId: 'agent', engine: 'claude' }) as RegisteredSession,
    validateRuntime: async () => true, isAwaitingUser: probe, inject, sendKey: async () => true,
  })
  controller.submit('agent', 'A', 'A')
  await vi.advanceTimersByTimeAsync(0)
  controller.submit('agent', 'B', 'B')
  release(true)
  await vi.advanceTimersByTimeAsync(1500)
  expect(inject.mock.calls.map(call => call[1])).toEqual(['A', 'B'])
  controller.forget('agent')
})


it.each(['codex', 'claude'] as const)('%s Device filter rejects an inferred completion without changing normalizer output', async engine => {
  vi.useFakeTimers()
  const f = fixture(engine)
  const codex = new CodexNormalizer('live')
  const claude = newTurnState()
  const normalizeUser = (text: string) => engine === 'codex'
    ? codex.ingest(JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: text } }))
    : lineToEvents(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }), claude)
  const observe = (events: LiveEvent[]) => {
    for (const [index, event] of events.entries()) {
      if (isDeviceInputBoundary(engine, events, index)) continue
      if (event.type === 'turn_started') f.start(event.payload.userMessage)
      if (event.type === 'turn_ended') f.end()
    }
  }
  await f.send('A'); await vi.advanceTimersByTimeAsync(0); observe(normalizeUser('A'))
  if (engine === 'claude') claude.pendingTools.add('running-tool')
  await f.send('B'); await vi.advanceTimersByTimeAsync(0)
  const inputEvents = normalizeUser('B')
  expect(inputEvents.map(event => event.type)).toEqual(['turn_ended', 'turn_started'])
  if (engine === 'claude') expect(claude.pendingTools.has('running-tool')).toBe(false) // unchanged shared normalizer
  observe(inputEvents)
  expect(f.receipt('A').state).toBe('unknown')
  expect(f.receipt('B').state).toBe('unknown')
  const endEvents = engine === 'codex'
    ? codex.ingest(JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }))
    : (() => {
      claude.pendingTools.delete('running-tool')
      return lineToEvents(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } }), claude)
    })()
  expect(endEvents.some(event => event.type === 'turn_ended')).toBe(true)
  observe(endEvents)
  expect(f.receipt('A').state).toBe('unknown')
  expect(f.receipt('B').state).toBe('unknown')
  f.controller.forget('agent')
})

it('excludes legacy writes only during Device ownership of the same pane', async () => {
  vi.useFakeTimers()
  const writes: string[] = []
  let finish!: () => void
  const controller = makeDevice({
    inject: async () => { writes.push('device'); await new Promise<void>(resolve => { finish = resolve }); return true },
  })
  await controller.legacyWrite('agent', async () => { writes.push('local-before') })
  controller.submit('agent', 'A', 'delivery-A')
  await vi.advanceTimersByTimeAsync(0)
  const local = controller.legacyWrite('agent', async () => { writes.push('local-after') })
  await controller.legacyWrite('other', async () => { writes.push('other-pane') })
  expect(writes).toEqual(['local-before', 'device', 'other-pane'])
  finish()
  await vi.advanceTimersByTimeAsync(0)
  await local
  expect(writes).toEqual(['local-before', 'device', 'other-pane', 'local-after'])
  controller.forget('agent')
})
