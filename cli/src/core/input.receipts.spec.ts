import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInput, type InputDeps } from './input.js'
import { createDeliveries } from './deliveries.js'
import { AutonomousDeviceService } from '../lib/autonomous-device/service.js'
import { readInlineScreen } from '../testing/inlineScreen.js'
import { inlineSubmission } from '../testing/inlineSubmission.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { TerminalActionResult } from '../lib/terminalTypes.js'
import { CODEX_0160_COMPOSER } from '../lib/__fixtures__/codexModelPickers.js'

const executed: TerminalActionResult = { state: 'succeeded', dispatch: 'executed' }
const READY = '────────────\n❯\n────────────\n  ? for shortcuts'
const permission = readFileSync(new URL('../lib/__fixtures__/permission-claude.txt', import.meta.url), 'utf8')
const native = (engine: string) => JSON.parse(readFileSync(new URL(`../../../docs/contracts/autonomous-device-summary-correlation/${engine === 'claude' ? 'claude-native-queue' : 'codex-steering'}.json`, import.meta.url), 'utf8'))
function held<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** Actual component admission -> generic service query -> createInput -> terminal; facts return to the component. */
function fixture(engine = 'claude') {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-24T00:00:00Z'))
  let present = true, connected = true, pane: string | null = engine === 'codex' ? CODEX_0160_COMPOSER : READY
  let draft: 'pending' | 'clear' | 'unreadable' = 'clear'
  const session = { agentId: 'agent', sessionId: 'session', engine, cliVersion: '0.106.0' } as RegisteredSession
  const inject = vi.fn(async (): Promise<TerminalActionResult> => executed)
  const key = vi.fn(async (): Promise<TerminalActionResult> => executed)
  const events: Array<Record<string, any>> = []
  const delivery = vi.fn()
  const progress = vi.fn()
  const deliveries = createDeliveries({
    submit: (id, text, deliveryId, options) => inputs.submitInput(id, { content: text, deliveryId, when: options?.when ?? 'turn', current: options?.current }),
    cancel: id => inputs.input.cancelDelivery(id), deliverers: new Set(['wifi']),
    tell: (_maker, event) => { delivery(event); service.delivery(event) },
    tellInput: (_maker, event) => { progress(event); service.inputProgress(event) },
  })
  const deps: InputDeps = {
    resolve: () => present ? session : undefined,
    readScreen: readInlineScreen,
    submission: { ...inlineSubmission, read: vi.fn(async () => ({ draft: draft === 'pending', composer: draft !== 'unreadable', nativeDraft: draft })) },
    terminal: {
      validateTerminal: vi.fn(async () => present), captureTerminal: vi.fn(async () => pane),
      submitTerminalAction: inject, keyTerminalAction: key, pinTerminalControl: () => () => {},
    },
    deliveries: { settled: deliveries.settled, input: deliveries.input, canWrite: () => true },
    clients: { send: vi.fn(), sendCommander: vi.fn() }, agentIdFor: id => id,
    openTurn: async () => [], emit: () => {},
  }
  const inputs = createInput(deps)
  const service = new AutonomousDeviceService({
    machineId: 'machine', serverInstanceId: 'instance',
    agents: () => present ? [{ agentId: 'agent', name: 'Agent', engine, state: 'working' }] : [],
    submit: (id, text, deliveryId) => {
      service.inputContext(deliveryId, session as never)
      deliveries.answer('wifi', 'input', { version: 1, agentId: id, text, deliveryId, when: 'composer' }, { current: () => connected, ownsRequest: () => false })
    },
    cancelDelivery: id => inputs.input.cancelDelivery(id), stop: async () => true, answer: async () => true,
    recent: () => [], emit: event => events.push(event),
  })
  deliveries.ready()
  const send = (id: string, text = id, focusRevision?: string) => service.request('device', {
    type: 'turn.send', requestId: randomUUID(), machineId: 'machine', agentId: 'agent', idempotencyKey: id, text,
    ...(focusRevision ? { focusRevision } : {}),
  })
  const start = (text: string) => { inputs.input.onTurnStarted('agent', text); service.turnStarted('agent') }
  const end = () => { inputs.input.onTurnEnded('agent'); service.turnEnded('agent') }
  const transcript = (row: unknown) => service.observeTranscript('agent', 'session', engine, JSON.stringify(row))
  const user = (text: string, uuid = randomUUID()) => transcript({ type: 'user', uuid, timestamp: new Date().toISOString(), message: { content: text } })
  return { inputs, deps, service, inject, key, delivery, progress, events, send, start, end, transcript, user,
    session,
    receipt: (id: string) => service.receipt('device', id)!,
    pane: (next: string | null) => { pane = next }, draft: (next: typeof draft) => { draft = next },
    disconnect: () => { connected = false; service.coreDisconnected() },
    gone: () => { present = false; inputs.input.forget('agent'); service.agentGone('agent') },
    stop: () => inputs.input.forget('agent'),
  }
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('component receipts through shared session input', () => {
  it.each([['0.105.2', 'native_input'], [undefined, 'native_input'], ['1.0.0', 'steering']])('labels busy Codex %s from its resolved, bound version', async (version, mode) => {
    const f = fixture('codex')
    f.session.cliVersion = version ?? null
    f.start('already working'); await f.send('A'); await vi.advanceTimersByTimeAsync(0)
    expect(f.receipt('A').input).toEqual({ mode, phase: 'accepted' })
    f.stop()
  })

  it.each(['claude', 'codex'])('%s admits B before A ends and assigns results only from its engine evidence', async engine => {
    const f = fixture(engine), captured = native(engine)
    f.service.appFocus('machine', 'agent', 'desktop')
    const revision = f.service.focusSnapshot().focusRevision
    await f.send('A', captured.inputs[0], revision)
    await vi.advanceTimersByTimeAsync(0)
    f.start(captured.inputs[0])
    await f.send('B', captured.inputs[1], revision)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.inject).toHaveBeenCalledTimes(2)
    expect(f.receipt('A').state).toBe('delivered') // body equality is no receipt proof
    expect(f.receipt('B').input).toEqual({ mode: engine === 'claude' ? 'native_queue' : 'steering', phase: 'accepted' })
    f.end()
    f.service.commander({ type: 'commander_event', agentId: 'agent', payload: { kind: 'summary', text: 'unrelated recap' } })
    expect(f.receipt('A').state).toBe('delivered')
    for (const row of captured.records) f.transcript(row)
    expect(f.receipt('A').state).toBe('completed')
    expect(f.receipt('B').state).toBe('completed')
    expect(f.events.filter(event => event.kind === 'turn.summary')).toHaveLength(1)
    expect(await f.send('B', captured.inputs[1], revision)).toMatchObject({ status: 'duplicate', receipt: { state: 'completed' } })
    expect(f.inject).toHaveBeenCalledTimes(2)
    f.stop()
  })

  it('serializes A/B/C, excludes ordinary writes on that pane, and leaves other panes available', async () => {
    const f = fixture(), a = held<TerminalActionResult>()
    f.start('existing task')
    f.inject.mockImplementationOnce(() => a.promise)
    await f.send('A'); await f.send('B'); await f.send('C')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.inject).toHaveBeenCalledTimes(1)
    expect(f.inputs.acquireTerminalControl('agent', { forAnswer: true })).toBeNull()
    let ordinary = false, other = false
    const writing = f.inputs.input.writeTerminal('agent', async () => { ordinary = true; return true })
    await f.inputs.input.writeTerminal('other', async () => { other = true; return true })
    expect(other).toBe(true); expect(ordinary).toBe(false)
    a.resolve(executed)
    await vi.advanceTimersByTimeAsync(0); await writing
    expect(ordinary).toBe(true)
    expect(f.inject).toHaveBeenCalledTimes(3)
    expect(f.key).not.toHaveBeenCalled()
    f.stop()
  })

  it('never replays an ambiguous paste or appends until fresh composer evidence clears it', async () => {
    const f = fixture()
    f.draft('pending')
    f.inject.mockResolvedValueOnce({ state: 'unknown', dispatch: 'possibly_executed', reason: 'timeout' })
    await f.send('A'); await vi.advanceTimersByTimeAsync(0)
    await f.send('B')
    f.start('A'); f.end()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(f.inject).toHaveBeenCalledTimes(1)
    expect(f.key).not.toHaveBeenCalled()
    expect(f.receipt('A').state).toBe('unknown')
    expect(await f.send('A')).toMatchObject({ status: 'duplicate', receipt: { state: 'unknown' } })
    f.draft('clear'); f.start('unrelated event prompts a fresh reading')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.inject).toHaveBeenCalledTimes(2)
    expect(f.receipt('A').state).toBe('unknown')
    f.stop()
  })

  it('does not call an unreadable post-paste pane empty or release it on an equal-body turn', async () => {
    const f = fixture()
    f.draft('unreadable')
    await f.send('A'); await vi.advanceTimersByTimeAsync(0); await f.send('B')
    f.start('A'); await vi.advanceTimersByTimeAsync(20_000)
    expect(f.inject).toHaveBeenCalledTimes(1)
    expect(f.key).not.toHaveBeenCalled()
    expect(f.receipt('A')).toMatchObject({ state: 'unknown', input: { phase: 'unconfirmed' } })
    f.stop()
  })

  it('queues a non-native engine for the whole turn', async () => {
    const f = fixture('commandcode')
    f.start('already working'); await f.send('A'); await vi.advanceTimersByTimeAsync(0)
    expect(f.inject).not.toHaveBeenCalled()
    expect(f.receipt('A').input).toEqual({ mode: 'daemon_queue', phase: 'waiting_for_turn' })
    f.end(); await vi.advanceTimersByTimeAsync(0)
    expect(f.inject).toHaveBeenCalledOnce()
    f.stop()
  })

  it('holds a question and lets its explicit answer take control', async () => {
    const f = fixture()
    f.pane(permission); await f.send('A'); await vi.advanceTimersByTimeAsync(0)
    expect(f.inject).not.toHaveBeenCalled()
    expect(f.receipt('A').input).toEqual({ mode: 'daemon_queue', phase: 'waiting_for_user' })
    const release = f.inputs.acquireTerminalControl('agent', { forAnswer: true })!
    expect(release).toBeTypeOf('function')
    f.pane(READY); f.inputs.input.setUserAction('agent', false); release()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.inject).toHaveBeenCalledOnce()
    f.stop()
  })

  it('keeps a transcript-proven start when the earlier write acknowledgment is lost', async () => {
    const f = fixture(), write = held<TerminalActionResult>()
    f.inject.mockImplementationOnce(() => write.promise)
    await f.send('A'); await vi.advanceTimersByTimeAsync(0)
    f.user('A')
    expect(f.receipt('A').state).toBe('started')
    write.resolve({ state: 'unknown', dispatch: 'possibly_executed', reason: 'timeout' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.receipt('A').state).toBe('started')
    f.gone()
    expect(f.receipt('A')).toMatchObject({ state: 'unknown', error: { code: 'AGENT_GONE' } })
  })

  it('holds the next writer through a retry Enter and never repeats a lost key acknowledgment', async () => {
    const f = fixture(), enter = held<TerminalActionResult>()
    f.draft('pending'); f.key.mockImplementationOnce(() => enter.promise)
    await f.send('A'); await vi.advanceTimersByTimeAsync(3_000)
    expect(f.key).toHaveBeenCalledOnce()
    await f.send('B'); f.start('A'); await vi.advanceTimersByTimeAsync(0)
    expect(f.inject).toHaveBeenCalledOnce()
    enter.resolve({ state: 'unknown', dispatch: 'possibly_executed', reason: 'timeout' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(f.key).toHaveBeenCalledOnce()
    expect(f.inject).toHaveBeenCalledOnce()
    f.stop()
  })

  it('withdraws work cancelled during the screen read, before any effect', async () => {
    const f = fixture()
    const capture = held<string | null>()
    vi.mocked(f.deps.terminal.captureTerminal).mockImplementationOnce(() => capture.promise)
    await f.send('A'); await vi.advanceTimersByTimeAsync(0)
    expect(f.inputs.input.cancelDelivery(f.receipt('A').deliveryId)).toBe(true)
    capture.resolve(READY); await vi.advanceTimersByTimeAsync(0)
    expect(f.inject).not.toHaveBeenCalled()
    expect(f.receipt('A')).toMatchObject({ state: 'rejected', error: { code: 'cancelled' } })
    f.stop()
  })

  it('expires a repeated permission wait at its original five-minute deadline', async () => {
    const f = fixture()
    f.pane(permission); await f.send('A')
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_500)
    expect(f.inject).not.toHaveBeenCalled()
    expect(f.receipt('A')).toMatchObject({ state: 'rejected', error: { code: 'queue_expired' } })
    f.stop()
  })

  it('does not retry Enter after it was withheld for a dialog', async () => {
    const f = fixture()
    f.inject.mockResolvedValueOnce({ state: 'unknown', dispatch: 'possibly_executed', reason: 'enter_withheld:question_open' })
    await f.send('A'); await vi.advanceTimersByTimeAsync(20_000)
    expect(f.receipt('A')).toMatchObject({ state: 'rejected', error: { code: 'enter_withheld' } })
    expect(f.key).not.toHaveBeenCalled()
    f.stop()
  })

  it('revokes future effects on disconnect and retains the component reservation as unknown', async () => {
    const f = fixture(), validation = held<boolean>()
    vi.mocked(f.deps.terminal.validateTerminal).mockImplementationOnce(() => validation.promise)
    await f.send('A'); f.disconnect(); validation.resolve(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.inject).not.toHaveBeenCalled()
    expect(f.receipt('A')).toMatchObject({ state: 'unknown', error: { code: 'CORE_DISCONNECTED' } })
    expect(await f.send('A')).toMatchObject({ status: 'duplicate', receipt: { state: 'unknown' } })
    f.stop()
  })

  it('marks a possibly pasted input unknown and proves the queued input never ran when the agent goes', async () => {
    const f = fixture(), paste = held<TerminalActionResult>()
    f.inject.mockImplementationOnce(() => paste.promise)
    await f.send('A'); await vi.advanceTimersByTimeAsync(0); await f.send('B')
    f.gone(); paste.resolve(executed); await vi.advanceTimersByTimeAsync(0)
    expect(f.receipt('A').state).toBe('unknown')
    expect(f.receipt('B').state).toBe('rejected')
    expect(f.inject).toHaveBeenCalledOnce()
  })

  it('refuses runtime failure before paste and marks a lost runtime after paste unknown', async () => {
    const f = fixture()
    vi.mocked(f.deps.terminal.validateTerminal).mockResolvedValueOnce(false)
    await f.send('refused'); await vi.advanceTimersByTimeAsync(0)
    expect(f.receipt('refused')).toMatchObject({ state: 'rejected', error: { code: 'runtime_gone_pre_paste' } })
    expect(f.inject).not.toHaveBeenCalled()
    f.draft('pending')
    await f.send('A'); await vi.advanceTimersByTimeAsync(0)
    vi.mocked(f.deps.terminal.validateTerminal).mockResolvedValueOnce(false)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(f.receipt('A')).toMatchObject({ state: 'unknown', error: { code: 'runtime_gone_post_paste' } })
    expect(f.key).not.toHaveBeenCalled()
    f.draft('clear'); await f.send('B'); await vi.advanceTimersByTimeAsync(0)
    expect(f.inject).toHaveBeenCalledTimes(2)
    f.stop()
  })

  it('does not release or retry a composer from a different binding even if its read says clear', async () => {
    const f = fixture(), reading = held<{ draft: boolean; composer: boolean; nativeDraft: 'clear' }>()
    vi.mocked(f.deps.submission.read).mockImplementationOnce(() => reading.promise)
    await f.send('A'); await vi.advanceTimersByTimeAsync(0); await f.send('B')
    f.session.sessionId = 'replacement'
    reading.resolve({ draft: false, composer: true, nativeDraft: 'clear' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(f.inject).toHaveBeenCalledOnce()
    expect(f.key).not.toHaveBeenCalled()
    expect(f.progress).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'composer_available' }))
    f.stop()
  })

  it('counts waiting ordinary and tracked content against the same 24KiB bound', async () => {
    const f = fixture(), release = f.inputs.acquireTerminalControl('agent')!, receipt = vi.fn()
    f.inputs.messageRequest({ agentId: 'agent', content: 'x'.repeat(22 * 1024) }, receipt)
    await f.send('overflow', 'y'.repeat(3 * 1024))
    expect(f.receipt('overflow')).toMatchObject({ state: 'rejected', error: { code: 'queue_full' } })
    expect(f.inject).not.toHaveBeenCalled()
    f.stop(); release()
  })
})
