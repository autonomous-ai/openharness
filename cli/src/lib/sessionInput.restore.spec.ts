import { expect, it, vi } from 'vitest'
import type { RegisteredSession } from './registry.js'
import { MoveGate } from './hostMove/gate.js'
import { SessionInputController } from './sessionInput.js'
import { readInlineScreen } from '../testing/inlineScreen.js'
import { inlineSubmission } from '../testing/inlineSubmission.js'

const restoring = (): RegisteredSession => ({ agentId: 'agent', sessionId: 'conversation', engine: 'claude',
  active: true, registeredAt: 1, boundAt: 2, tmuxPane: '%1', primaryRuntimeKey: 'tmux\0%1',
  runtimes: [{ backend: 'tmux', paneId: '%1' }], processIdentity: null, launch: { state: 'starting', nativeToken: 'launch-one' },
} as RegisteredSession)
const processIdentity = { pid: 7, executable: '/fixture/claude', startMarker: 'born' }

it('waits for the same restored launch to publish its process before validating or typing', async () => {
  let row = restoring(), wake!: () => void
  const inject = vi.fn(async () => true), onSubmitted = vi.fn(), onWaiting = vi.fn(), onError = vi.fn()
  const validateRuntime = vi.fn(async (selected: RegisteredSession) => selected.processIdentity?.pid === 7)
  const controller = new SessionInputController({ getSession: () => row, readScreen: readInlineScreen,
    submission: inlineSubmission, validateRuntime, inject, sendKey: async () => true, onError, onSubmitted, onWaiting,
    ...{ launchRevision: () => 1 }, sleep: () => new Promise(resolve => { wake = resolve }) })
  try {
    controller.submit('agent', 'sent during restore')
    await vi.waitFor(() => expect(onWaiting).toHaveBeenCalledWith('agent', 'engine_starting'))
    expect(validateRuntime).not.toHaveBeenCalled()
    expect(inject).not.toHaveBeenCalled()
    row = { ...row, processIdentity, launch: { state: 'ready' }, evidenceRevision: 3 }
    wake()
    await vi.waitFor(() => expect(onSubmitted).toHaveBeenCalledWith('agent', 'sent during restore'))
    expect(inject).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  } finally { controller.forget('agent') }
})

it.each(['revision', 'conversation', 'pane', 'birth', 'gone', 'token', 'failed', 'caller', 'cancelled', 'forgotten', 'timeout'] as const)(
  'does not type after the pending restore changes: %s', async change => {
    let row: RegisteredSession | undefined = restoring(), revision = 1, caller = true, clock = 0, wake!: () => void
    const inject = vi.fn(async () => true), onWaiting = vi.fn(), onError = vi.fn(), onDelivery = vi.fn()
    const validateRuntime = vi.fn(async () => true)
    const controller = new SessionInputController({ getSession: () => row, readScreen: readInlineScreen,
      submission: inlineSubmission, validateRuntime, inject, sendKey: async () => true, onWaiting, onError, onDelivery,
      launchRevision: () => revision, now: () => clock, sleep: () => new Promise(resolve => { wake = resolve }) })
    try {
      controller.submitInput('agent', { content: 'pending restore', deliveryId: 'restore', when: 'turn', current: () => caller })
      await vi.waitFor(() => expect(onWaiting).toHaveBeenCalled())
      if (change === 'revision') revision++
      if (change === 'conversation') row = { ...row!, sessionId: 'another' }
      if (change === 'pane') row = { ...row!, runtimes: [{ backend: 'tmux', paneId: '%2' }] }
      if (change === 'birth') row = { ...row!, registeredAt: 99 }
      if (change === 'gone') row = undefined
      if (change === 'token') row = { ...row!, launch: { state: 'starting', nativeToken: 'another-launch' } }
      if (change === 'failed') row = { ...row!, launch: { state: 'failed', error: 'FAILED', detail: 'fixture failure' } }
      if (change === 'caller') caller = false
      if (change === 'cancelled') expect(controller.cancelDelivery('restore')).toBe(true)
      if (change === 'forgotten') controller.forget('agent')
      if (change === 'timeout') clock = 15_000
      wake()
      await vi.waitFor(() => expect(controller.waitingFor('agent')).toBeNull())
      expect(validateRuntime).not.toHaveBeenCalled()
      expect(inject).not.toHaveBeenCalled()
      expect(onDelivery).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: 'restore', state: 'rejected' }))
      if (change === 'timeout') expect(onError).toHaveBeenCalledWith('agent', 'This agent is still starting. Try again when it is ready.')
    } finally { controller.forget('agent') }
  },
)

it('keeps a team restore wait private, then refuses a new lifecycle during validation', async () => {
  let row = restoring(), revision = 1, wake!: () => void, validated!: (alive: boolean) => void
  const onWaiting = vi.fn(), onWaitChanged = vi.fn(), inject = vi.fn(async () => true), onDelivery = vi.fn()
  const validateRuntime = vi.fn(() => new Promise<boolean>(resolve => { validated = resolve }))
  const controller = new SessionInputController({ getSession: () => row, readScreen: readInlineScreen,
    submission: inlineSubmission, validateRuntime, inject, sendKey: async () => true, onError: vi.fn(), onDelivery,
    onWaiting, onWaitChanged, launchRevision: () => revision, sleep: () => new Promise(resolve => { wake = resolve }) })
  try {
    controller.submit('agent', 'automatic restore input', 'team:service:messages:restore')
    await vi.waitFor(() => expect(wake).toBeTypeOf('function'))
    expect(controller.waitingFor('agent')).toBeNull()
    expect(onWaiting).not.toHaveBeenCalled()
    row = { ...row, processIdentity, launch: undefined }
    wake()
    await vi.waitFor(() => expect(validateRuntime).toHaveBeenCalled())
    revision++
    validated(true)
    await vi.waitFor(() => expect(onDelivery).toHaveBeenCalledWith(expect.objectContaining({ state: 'rejected' })))
    expect(inject).not.toHaveBeenCalled()
    expect(onWaitChanged).not.toHaveBeenCalled()
  } finally { controller.forget('agent') }
})

it.each(['before input', 'during wait'] as const)('does not treat a process discovered %s as the committed ready launch', async arrival => {
  let row = { ...restoring(), ...(arrival === 'before input' ? { processIdentity } : {}) }, wake!: () => void
  const onSubmitted = vi.fn(), onWaiting = vi.fn(), validateRuntime = vi.fn(async () => true)
  const controller = new SessionInputController({ getSession: () => row, readScreen: readInlineScreen,
    submission: inlineSubmission, validateRuntime, inject: async () => true, sendKey: async () => true,
    onError: vi.fn(), onSubmitted, onWaiting, launchRevision: () => 1,
    sleep: () => new Promise(resolve => { wake = resolve }) })
  try {
    controller.submit('agent', 'after readiness publication')
    await vi.waitFor(() => expect(onWaiting).toHaveBeenCalled())
    row = { ...row, processIdentity }
    const first = wake
    first()
    await vi.waitFor(() => expect(wake).not.toBe(first))
    expect(validateRuntime).not.toHaveBeenCalled()
    row = { ...row, launch: undefined }
    wake()
    await vi.waitFor(() => expect(onSubmitted).toHaveBeenCalled())
  } finally { controller.forget('agent') }
})

it('leaves ready input on the existing path without consulting a launch revision or timer', async () => {
  const row = { ...restoring(), processIdentity, launch: { state: 'ready' as const } }
  const launchRevision = vi.fn(() => 1), sleep = vi.fn(async () => {}), onSubmitted = vi.fn()
  const controller = new SessionInputController({ getSession: () => row, readScreen: readInlineScreen,
    submission: inlineSubmission, validateRuntime: async () => true, inject: async () => true,
    sendKey: async () => true, onError: vi.fn(), onSubmitted, launchRevision, sleep })
  try {
    controller.submit('agent', 'ordinary input')
    await vi.waitFor(() => expect(onSubmitted).toHaveBeenCalled())
    expect(launchRevision).not.toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
  } finally { controller.forget('agent') }
})


it('uses a bounded native timer for a restore without injected timing', async () => {
  vi.useFakeTimers()
  let row = restoring()
  const onSubmitted = vi.fn(), onWaiting = vi.fn()
  const controller = new SessionInputController({ getSession: () => row, readScreen: readInlineScreen,
    submission: inlineSubmission, validateRuntime: async () => true, inject: async () => true,
    sendKey: async () => true, onError: vi.fn(), onSubmitted, onWaiting, launchRevision: () => 1 })
  try {
    controller.submit('agent', 'native timer')
    expect(onWaiting).toHaveBeenCalled()
    expect(onSubmitted).not.toHaveBeenCalled()
    row = { ...row, processIdentity, launch: undefined }
    await vi.advanceTimersByTimeAsync(250)
    expect(onSubmitted).toHaveBeenCalledOnce()
  } finally { controller.forget('agent'); vi.useRealTimers() }
})

it('refuses a pending restored message when terminal ownership is held', async () => {
  const row = restoring()
  let refused = false, wake!: () => void
  const inject = vi.fn(async () => true), onWaiting = vi.fn(), onError = vi.fn()
  const controller = new SessionInputController({ getSession: () => row, readScreen: readInlineScreen,
    submission: inlineSubmission, validateRuntime: async () => true, inject, sendKey: async () => true,
    onError, onWaiting, launchRevision: () => 1, moveGate: new MoveGate(() => refused),
    sleep: () => new Promise(resolve => { wake = resolve }) })
  try {
    controller.submit('agent', 'ownership held during restore')
    await vi.waitFor(() => expect(onWaiting).toHaveBeenCalled())
    refused = true
    wake()
    await vi.waitFor(() => expect(controller.waitingFor('agent')).toBeNull())
    expect(inject).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('agent', 'This harness is held until the daemon restarts.')
  } finally { controller.forget('agent') }
})
