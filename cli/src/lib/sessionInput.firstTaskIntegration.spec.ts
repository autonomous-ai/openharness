import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionInputController, type SessionInputDeps } from './sessionInput.js'
import type { RegisteredSession } from './registry.js'
import { TERMINAL_LEASE_REFUSED, type TerminalActionResult } from './terminalTypes.js'
import { readInlineScreen } from '../testing/inlineScreen.js'
import { inlineSubmission } from '../testing/inlineSubmission.js'
import { OPENCLAW_STATES } from '../engines/openclaw/contract.js'
import { MoveGate } from './hostMove/gate.js'

const row = { schemaVersion: 2, active: true, agentId: 'a', sessionId: 's', engine: 'openclaw', registeredAt: 1,
  boundAt: 1, tmuxPane: '%1', runtimes: [{ backend: 'tmux', paneId: '%1' }], primaryRuntimeKey: 'tmux\0%1',
  processIdentity: null } as RegisteredSession
const notReady: TerminalActionResult = { state: 'failed', dispatch: 'not_started', reason: 'openclaw_not_ready' }
const lease: TerminalActionResult = { state: 'failed', dispatch: 'not_started', reason: TERMINAL_LEASE_REFUSED }
const controllers: SessionInputController[] = []
function screen(kind: 'ready' | 'refused', box = 'First') {
  const name = kind === 'ready' ? 'screen-plain.txt' : 'screen-history-refused.txt'
  const lines = readFileSync(new URL('../engines/openclaw/__fixtures__/' + name, import.meta.url), 'utf8').split('\n')
  const rules = lines.flatMap((line, at) => /^─+$/.test(line) ? [at] : [])
  return [...lines.slice(0, rules.at(-2)! + 1), box, ...lines.slice(rules.at(-1)!)].join('\n')
}
function setup(over: Partial<SessionInputDeps> = {}) {
  const keys: string[] = []
  const inject = vi.fn(async (_id: string, _text: string): Promise<boolean | TerminalActionResult> => true)
  const sendKey = vi.fn(async (_id: string, key: string, current?: () => boolean) => {
    if (current?.() === false) return false
    keys.push(key); return true
  })
  const validateRuntime = vi.fn(async (_session: RegisteredSession) => true), onDelivery = vi.fn(), taken = vi.fn()
  const controller = new SessionInputController({ getSession: () => row, readScreen: readInlineScreen, submission: inlineSubmission,
    validateRuntime, inject, sendKey, capture: async () => screen('ready'), onError: vi.fn(), onDelivery,
    onFirstTaskTaken: taken, ...over })
  controllers.push(controller)
  return { controller, inject, sendKey, keys, validateRuntime, onDelivery, taken }
}
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { for (const c of controllers.splice(0)) c.forget('s'); vi.useRealTimers(); vi.restoreAllMocks() })

it('a withdrawn overlapping handoff cannot end a first task already submitted', async () => {
  const t = setup()
  t.controller.expectFirstTask('s', 'First')
  const withdraw = t.controller.expectFirstTask('s', 'First')
  t.controller.submitFirstTask('s', 'First')
  withdraw?.()
  await vi.advanceTimersByTimeAsync(0)
  expect(t.controller.firstTaskWaiting('s')).toBe(true)
  expect(t.inject).toHaveBeenCalledOnce()
})

it('adopts no task while a caller holds the pane or a cancel is still pressing its key', async () => {
  const t = setup()
  const release = t.controller.acquireControl('s')!
  expect(t.controller.adoptTypedFirstTask('s', 'First')).toBe(false)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(t.keys).toEqual([])
  release()
  let finish!: (value: boolean) => void
  t.sendKey.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const cancelling = t.controller.cancelConfirmed('s')
  await vi.advanceTimersByTimeAsync(0)
  expect(t.controller.adoptTypedFirstTask('s', 'First')).toBe(false)
  finish(true); await cancelling
})

it.each(['runtime gone', 'same text', 'retry throws'] as const)('an adopted task never borrows a waiting delivery when %s', async failure => {
  const t = setup()
  t.inject.mockResolvedValue(notReady)
  let caller = true
  t.controller.submitInput('s', { content: failure === 'same text' ? 'First' : 'Later', deliveryId: 'd', when: 'turn', current: () => caller })
  await vi.advanceTimersByTimeAsync(0)
  expect(t.controller.waitsForPane('s')).toBe(true)
  expect(t.controller.adoptTypedFirstTask('s', 'First')).toBe(true)
  // Still queued and never pasted: adoption cannot hide it from cancellation.
  if (failure !== 'same text') expect(t.controller.cancelDelivery('d')).toBe(true)
  else caller = false
  if (failure === 'runtime gone') t.validateRuntime.mockResolvedValue(false)
  if (failure === 'retry throws') t.validateRuntime.mockRejectedValueOnce(new Error('unavailable'))
  await vi.advanceTimersByTimeAsync(10_000)
  expect(t.onDelivery.mock.calls.filter(([event]) => ['unknown', 'started', 'delivered'].includes(event.state))).toEqual([])
  expect(t.onDelivery.mock.calls.filter(([event]) => event.state === 'rejected')).toHaveLength(failure === 'same text' ? 0 : 1)
  if (failure === 'same text') expect(t.keys).toEqual(['Enter'])
  expect(t.controller.firstTaskWaiting('s')).toBe(true)
})

it('gives a lease-refused delivery back to the queue before adopting a task', async () => {
  const t = setup()
  t.inject.mockResolvedValueOnce(notReady).mockResolvedValueOnce(lease)
  t.controller.submitInput('s', { content: 'Later', deliveryId: 'd', when: 'turn' })
  await vi.advanceTimersByTimeAsync(1_000)
  expect(t.inject).toHaveBeenCalledTimes(2)
  expect(t.controller.adoptTypedFirstTask('s', 'First')).toBe(true)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(t.inject).toHaveBeenCalledTimes(2)
  expect(t.controller.awaitingConfirmation('s')).toBe(true)
  expect(t.controller.cancelDelivery('d')).toBe(true)
})

it('one clear owns the whole untype-to-retype interval despite a turn ending', async () => {
  let release!: (value: boolean) => void
  let shown = screen('refused')
  const untypeFirstTask = vi.fn(() => new Promise<boolean>(resolve => { release = resolve }))
  const t = setup({ capture: async () => shown, untypeFirstTask, retypeFirstTask: async () => true })
  t.controller.expectFirstTask('s', 'First')
  t.controller.submitFirstTask('s', 'First')
  await vi.advanceTimersByTimeAsync(10_000)
  expect(untypeFirstTask).toHaveBeenCalledOnce()
  t.controller.onTurnEnded('s')
  shown = screen('ready')
  await vi.advanceTimersByTimeAsync(10_000)
  expect(t.keys).toEqual([])
  expect(t.controller.acquireControl('s')).toBeNull()
  release(true); await vi.advanceTimersByTimeAsync(0)
  expect(t.inject).toHaveBeenCalledOnce()
})

it('a matching user row with expanded tabs confirms the first task inside another turn', async () => {
  const t = setup()
  t.controller.expectFirstTask('s', 'First\ttask')
  t.controller.submitFirstTask('s', 'First\ttask')
  await vi.advanceTimersByTimeAsync(0)
  t.controller.onTurnStarted('s', 'Another turn')
  t.controller.onUserMessage('s', 'First task')
  expect(t.controller.firstTaskWaiting('s')).toBe(false)
  expect(t.taken).toHaveBeenCalledOnce()
})

it('a Stop retires the durable typed task and cannot re-adopt or later paste it', async () => {
  const t = setup()
  t.inject.mockResolvedValue(notReady)
  t.controller.expectFirstTask('s', 'First')
  t.controller.submitFirstTask('s', 'First')
  await vi.advanceTimersByTimeAsync(0)
  expect(await t.controller.cancelConfirmed('s')).toBe(true)
  expect(t.taken).toHaveBeenCalledOnce()
  expect(t.controller.adoptTypedFirstTask('s', 'First')).toBe(false)
  t.inject.mockResolvedValue(true)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(t.inject).toHaveBeenCalledOnce()
})

it('pending write chains yield to the first task without reversing their original queue order', async () => {
  const t = setup()
  let ready = false
  const typed: string[] = []
  t.inject.mockImplementation(async (_id, text) => {
    if (!ready) return notReady
    typed.push(text); return true
  })
  t.controller.submit('s', 'Early')
  await vi.advanceTimersByTimeAsync(0)
  t.controller.submit('s', 'Later')
  t.controller.expectFirstTask('s', 'First')
  t.controller.submitFirstTask('s', 'First')
  ready = true
  await vi.advanceTimersByTimeAsync(1_000)
  expect(typed).toEqual(['First'])
  for (const text of ['First', 'Early']) {
    t.controller.onTurnStarted('s', text)
    t.controller.onTurnEnded('s')
    await vi.advanceTimersByTimeAsync(0)
  }
  expect(typed).toEqual(['First', 'Early', 'Later'])
})


it('a matching turn before handover retires its claim so delayed submit cannot type it again', async () => {
  const t = setup()
  t.controller.expectFirstTask('s', 'First')
  t.controller.onTurnStarted('s', 'First')
  t.controller.onTurnEnded('s')
  t.controller.submitFirstTask('s', 'First')
  await vi.advanceTimersByTimeAsync(1_000)
  expect(t.inject).not.toHaveBeenCalled()
  expect(t.controller.firstTaskWaiting('s')).toBe(false)
})

it('a composer delivery can retry a refused lease during a Claude turn', async () => {
  const t = setup({ getSession: () => ({ ...row, engine: 'claude' }), capture: async () => '──────────────\n❯ \n──────────────' })
  t.controller.onTurnStarted('s', 'Active')
  t.inject.mockResolvedValueOnce(lease).mockResolvedValue(true)
  t.controller.submitInput('s', { content: 'Later', deliveryId: 'next', when: 'composer' })
  await vi.advanceTimersByTimeAsync(1_000)
  expect(t.inject).toHaveBeenCalledTimes(2)
})

it('a personal followup retries its lease while Claude still awaits the earlier prompt', async () => {
  const t = setup({ getSession: () => ({ ...row, engine: 'claude' }), capture: async () => '──────────────\n❯ \n──────────────' })
  t.controller.submit('s', 'Active')
  await vi.advanceTimersByTimeAsync(0)
  t.inject.mockResolvedValueOnce(lease).mockResolvedValue(true)
  t.controller.submit('s', 'Later')
  await vi.advanceTimersByTimeAsync(1_000)
  expect(t.inject).toHaveBeenCalledTimes(3)
})


it.each(['Earlier', 'First'])('clearing an earlier %s message preserves its receipt and does not untype a queued first task', async message => {
  let shown = screen('refused', message)
  const receipt = vi.fn(), untypeFirstTask = vi.fn(async () => true)
  const t = setup({ capture: async () => shown, untypeFirstTask, retypeFirstTask: async () => true })
  t.sendKey.mockImplementation(async (_id, key) => { if (key === 'C-u') shown = screen('refused', ''); return true })
  t.controller.submit('s', message, undefined, receipt)
  await vi.advanceTimersByTimeAsync(0)
  t.controller.expectFirstTask('s', 'First')
  t.controller.submitFirstTask('s', 'First')
  await vi.advanceTimersByTimeAsync(10_000)
  expect(untypeFirstTask).not.toHaveBeenCalled()
  expect(receipt).not.toHaveBeenCalled()
  expect(t.inject.mock.calls.map(([, text]) => text)).toEqual([message, 'First'])
  t.controller.onTurnStarted('s', 'First')
  t.controller.onTurnEnded('s')
  shown = screen('ready', '')
  await vi.advanceTimersByTimeAsync(0)
  expect(t.inject.mock.calls.map(([, text]) => text)).toEqual([message, 'First', message])
  expect(receipt).not.toHaveBeenCalled()
})

it('confirmation during the final clear capture holds the next write and preserves its observation', async () => {
  let shown = screen('refused', 'First')
  let release!: (value: string) => void
  let finalCapture = false
  const receipt = vi.fn()
  const t = setup({ capture: async () => finalCapture ? new Promise(resolve => { release = resolve }) : shown,
    untypeFirstTask: async () => true, retypeFirstTask: async () => false })
  t.sendKey.mockImplementation(async (_id, key) => { if (key === 'C-u') { shown = screen('refused', ''); finalCapture = true }; return true })
  t.controller.expectFirstTask('s', 'First')
  t.controller.submitFirstTask('s', 'First')
  t.controller.submit('s', 'Later', undefined, receipt)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(release).toBeTypeOf('function')
  t.controller.firstTaskConfirmed('s')
  await vi.advanceTimersByTimeAsync(0)
  expect(t.inject.mock.calls.map(([, text]) => text)).toEqual(['First'])
  finalCapture = false
  release(shown)
  await vi.advanceTimersByTimeAsync(0)
  expect(t.inject.mock.calls.map(([, text]) => text)).toEqual(['First', 'Later'])
  expect(t.controller.awaitingConfirmation('s')).toBe(true)
  expect(receipt).not.toHaveBeenCalled()
})

it('a store confirmation before handover prevents a later submit from typing again', async () => {
  const t = setup()
  t.controller.expectFirstTask('s', 'First')
  t.controller.firstTaskConfirmed('s')
  t.controller.submitFirstTask('s', 'First')
  await vi.advanceTimersByTimeAsync(0)
  expect(t.inject).not.toHaveBeenCalled()
})

it('a lease retry cannot write while pane recovery owns control after a not-ready answer', async () => {
  const t = setup()
  t.inject.mockResolvedValueOnce(notReady).mockResolvedValueOnce(lease).mockResolvedValue(true)
  t.controller.submit('s', 'Later')
  await vi.advanceTimersByTimeAsync(1_000)
  expect(t.inject).toHaveBeenCalledTimes(2)
  const release = t.controller.acquireControl('s', { forPaneRecovery: true })
  expect(release).toBeTypeOf('function')
  await vi.advanceTimersByTimeAsync(500)
  expect(t.inject).toHaveBeenCalledTimes(2)
  release!()
  await vi.advanceTimersByTimeAsync(500)
  expect(t.inject).toHaveBeenCalledTimes(3)
})

it('store confirmation of a queued task preserves an earlier ordinary observation', async () => {
  const t = setup(), receipt = vi.fn()
  t.controller.submit('s', 'Earlier', undefined, receipt)
  await vi.advanceTimersByTimeAsync(0)
  t.controller.expectFirstTask('s', 'First')
  t.controller.firstTaskConfirmed('s')
  expect(t.controller.awaitingConfirmation('s')).toBe(true)
  expect(receipt).not.toHaveBeenCalled()
})

it('an earlier ordinary turn with identical text does not retire the queued first task', async () => {
  const t = setup()
  t.controller.submit('s', 'First')
  await vi.advanceTimersByTimeAsync(0)
  t.controller.expectFirstTask('s', 'First')
  t.controller.submitFirstTask('s', 'First')
  t.controller.onTurnStarted('s', 'First')
  expect(t.controller.firstTaskWaiting('s')).toBe(true)
  expect(t.taken).not.toHaveBeenCalled()
  t.controller.onTurnEnded('s')
  await vi.advanceTimersByTimeAsync(0)
  expect(t.inject).toHaveBeenCalledTimes(2)
})


it.each([OPENCLAW_STATES.boxHeld, OPENCLAW_STATES.noGateway, OPENCLAW_STATES.approval, OPENCLAW_STATES.signInRefused])(
  'an untyped message survives a temporary pane hold and its release: %s', async hold => {
    let session: RegisteredSession = { ...row, evidenceRevision: 1 }
    const receipt = vi.fn(), t = setup({ getSession: () => session })
    t.inject.mockResolvedValue(notReady)
    t.controller.submit('s', 'Later', undefined, receipt)
    await vi.advanceTimersByTimeAsync(0)
    session = { ...session, identityHold: hold, evidenceRevision: 2 }
    await vi.advanceTimersByTimeAsync(1_000)
    expect(receipt).not.toHaveBeenCalled()
    expect(t.controller.waitsForPane('s')).toBe(true)
    session = { ...session, identityHold: undefined, evidenceRevision: 3 }
    t.inject.mockResolvedValue(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(t.controller.awaitingConfirmation('s')).toBe(true)
    t.controller.onTurnStarted('s', 'Later')
    expect(receipt).toHaveBeenCalledExactlyOnceWith('started')
    expect(t.validateRuntime.mock.calls.some(([seen]) => seen.evidenceRevision === 3)).toBe(true)
  },
)

it('revalidates an untyped message when a short hold starts and ends between retry readings', async () => {
  let session: RegisteredSession = { ...row, evidenceRevision: 1 }
  const receipt = vi.fn(), t = setup({ getSession: () => session })
  t.inject.mockResolvedValueOnce(notReady).mockResolvedValue(true)
  t.controller.submit('s', 'Later', undefined, receipt)
  await vi.advanceTimersByTimeAsync(0)
  session = { ...session, evidenceRevision: 3 }
  await vi.advanceTimersByTimeAsync(1_000)
  expect(receipt).not.toHaveBeenCalled()
  expect(t.inject).toHaveBeenCalledTimes(2)
  expect(t.validateRuntime.mock.calls.some(([seen]) => seen.evidenceRevision === 3)).toBe(true)
})

it.each(['session', 'process', 'pane', 'folder', 'unknown hold', 'remote hold', 'caller'] as const)(
  'a pending pane retry never renews authority after changing %s', async change => {
    let session: RegisteredSession = { ...row, evidenceRevision: 1 }
    let caller = true
    const t = setup({ getSession: () => session })
    t.inject.mockResolvedValue(notReady)
    t.controller.submitInput('s', { content: 'Later', deliveryId: 'd', when: 'turn', current: () => caller })
    await vi.advanceTimersByTimeAsync(0)
    session = { ...session, identityHold: OPENCLAW_STATES.boxHeld, evidenceRevision: 2 }
    if (change === 'session') session.sessionId = 'different'
    if (change === 'process') session.processIdentity = { pid: 123, startTicks: 4 } as RegisteredSession['processIdentity']
    if (change === 'pane') session.tmuxPane = '%2'
    if (change === 'folder') session.openclawStateDir = '/fixture/another-state'
    if (change === 'unknown hold') session.identityHold = 'Native identity is unavailable'
    if (change === 'remote hold') session.identityHold = OPENCLAW_STATES.remote
    if (change === 'caller') caller = false
    await vi.advanceTimersByTimeAsync(1_000)
    expect(t.inject).toHaveBeenCalledOnce()
    expect(t.controller.awaitingConfirmation('s')).toBe(false)
  },
)


it.each(['runtime refused', 'binding changed', 'folder changed', 'local mode changed', 'caller cancelled', 'state forgotten'] as const)(
  'fresh pending-input validation grants no write when %s', async change => {
    let session: RegisteredSession = { ...row, evidenceRevision: 1 }
    let caller = true, finish!: (value: boolean) => void
    const t = setup({ getSession: () => session })
    t.inject.mockResolvedValueOnce(notReady).mockResolvedValue(true)
    t.validateRuntime.mockResolvedValueOnce(true).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    t.controller.submitInput('s', { content: 'Later', deliveryId: 'd', when: 'turn', current: () => caller })
    await vi.advanceTimersByTimeAsync(0)
    session = { ...session, identityHold: OPENCLAW_STATES.boxHeld, evidenceRevision: 2 }
    await vi.advanceTimersByTimeAsync(1_000)
    expect(finish).toBeTypeOf('function')
    expect(t.inject).toHaveBeenCalledOnce()
    if (change === 'binding changed') session = { ...session, evidenceRevision: 3 }
    if (change === 'folder changed') session = { ...session, openclawStateDir: '/fixture/new-state' }
    if (change === 'local mode changed') session = { ...session, openclawLocal: '/fixture/local-runtime' }
    if (change === 'caller cancelled') caller = false
    if (change === 'state forgotten') t.controller.forget('s')
    finish(change !== 'runtime refused')
    await vi.advanceTimersByTimeAsync(0)
    expect(t.inject).toHaveBeenCalledOnce()
    expect(t.controller.awaitingConfirmation('s')).toBe(false)
  },
)


it('a host-move refusal arriving during fresh validation still blocks the pending write', async () => {
  let session: RegisteredSession = { ...row, evidenceRevision: 1 }
  let refused = false, finish!: (value: boolean) => void
  const t = setup({ getSession: () => session, moveGate: new MoveGate(() => refused) })
  t.inject.mockResolvedValueOnce(notReady).mockResolvedValue(true)
  t.validateRuntime.mockResolvedValueOnce(true).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  t.controller.submit('s', 'Later')
  await vi.advanceTimersByTimeAsync(0)
  session = { ...session, identityHold: OPENCLAW_STATES.boxHeld, evidenceRevision: 2 }
  await vi.advanceTimersByTimeAsync(1_000)
  expect(finish).toBeTypeOf('function')
  refused = true; finish(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(t.inject).toHaveBeenCalledOnce()
})
