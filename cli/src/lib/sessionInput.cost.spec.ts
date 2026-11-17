import { AsyncResource, createHook, executionAsyncId } from 'node:async_hooks'
import { Hash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionInputController, type SessionInputDeps, type SessionInputDelivery } from './sessionInput.js'
import { MoveGate } from './hostMove/gate.js'
import type { RegisteredSession } from './registry.js'
import { readInlineScreen } from '../testing/inlineScreen.js'
import { inlineSubmission } from '../testing/inlineSubmission.js'

const READY = '────────────\n❯\n────────────\n  ? for shortcuts'
const controllers: SessionInputController[] = []
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.forget('agent')
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function signal() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function fixture(over: Partial<SessionInputDeps> = {}) {
  vi.useFakeTimers()
  const row = { agentId: 'agent', sessionId: 'session', engine: 'claude', active: true, cliVersion: '2.1.283' } as RegisteredSession
  const events: SessionInputDelivery[] = []
  const inject = vi.fn(async () => true)
  const controller = new SessionInputController({ readScreen: readInlineScreen, submission: inlineSubmission,
    getSession: () => row, validateRuntime: async () => true, inject, sendKey: async () => true,
    capture: async () => READY, onError: vi.fn(), ...over,
    onDelivery: event => { events.push(event); over.onDelivery?.(event) },
  })
  controllers.push(controller)
  return { controller, events, inject }
}

describe('session input work with no queued message or pending match', () => {
  it('does not mark a held agent in use for a lifecycle event with no queued input', async () => {
    const gate = new MoveGate(), { controller } = fixture({ moveGate: gate })
    gate.hold('agent')
    try {
      controller.onTurnEnded('agent')
      expect(gate.touched('agent')).toBe(false)
    } finally { await gate.release('agent') }
  })

  it('still holds and delivers a nonempty queue through the same move gate', async () => {
    const gate = new MoveGate(), { controller, inject, events } = fixture({ moveGate: gate })
    controller.setTurnOpen('agent', true)
    controller.submitInput('agent', { content: 'queued input', deliveryId: 'queued', when: 'turn' })
    gate.hold('agent')
    controller.onTurnEnded('agent')
    expect(gate.touched('agent')).toBe(true)
    expect(inject).not.toHaveBeenCalled()
    await gate.release('agent')
    expect(inject).toHaveBeenCalledOnce()
    expect(events.at(-1)).toMatchObject({ deliveryId: 'queued', state: 'delivered' })
  })

  it('allocates no queue-copy arrays for empty lifecycle and control releases', () => {
    const { controller } = fixture()
    const scope = new AsyncResource('empty-input-queue'), owned = new Set([scope.asyncId()])
    const hook = createHook({ init(id, _type, trigger) { if (owned.has(trigger)) owned.add(id) } })
    const species = Object.getOwnPropertyDescriptor(Array, Symbol.species)!
    let arrays = 0, controls = 0
    // Count standard ArraySpeciesCreate work, without reading or mocking private queue methods.
    Object.defineProperty(Array, Symbol.species, { configurable: true, get() {
      if (owned.has(executionAsyncId())) arrays++
      return this
    } })
    hook.enable()
    try {
      scope.runInAsyncScope(() => {
        for (let index = 0; index < 100; index++) {
          controller.onTurnStarted('agent', 'external turn')
          controller.onTurnEnded('agent')
          const release = controller.acquireControl('agent')
          if (release) { controls++; release() }
        }
      })
    } finally {
      hook.disable()
      Object.defineProperty(Array, Symbol.species, species)
      scope.emitDestroy()
    }
    expect(controls).toBe(100)
    expect(arrays).toBe(0)
  })

  it('does not hash an unrelated turn when there is no pending receipt match', () => {
    const { controller } = fixture()
    const hash = vi.spyOn(Hash.prototype, 'update')
    controller.onTurnStarted('agent', 'external turn')
    expect(hash).not.toHaveBeenCalled()
  })

  it('does not hash the later turn of an already confirmed composer input', async () => {
    const clear = signal()
    const { controller, inject } = fixture({ onInput: event => { if (event.phase === 'composer_available') clear.resolve() } })
    controller.submitInput('agent', { content: 'confirmed input', deliveryId: 'confirmed', when: 'composer' })
    await clear.promise
    const hash = vi.spyOn(Hash.prototype, 'update')
    controller.onTurnStarted('agent', 'confirmed input')
    expect(hash).not.toHaveBeenCalled()
    expect(inject).toHaveBeenCalledOnce()
  })

  it.each([['pending input', 'started'], ['other input', 'unknown']] as const)(
    'still compares a pending receipt against %s once and reports %s', async (observed, outcome) => {
      const written = signal(), settled = signal()
      const { controller, events } = fixture({ submission: { ...inlineSubmission, echo: async () => null },
        onDelivery: event => {
          if (event.state === 'delivered') written.resolve()
          if (event.state === 'started' || event.state === 'unknown') settled.resolve()
        },
      })
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      controller.submitInput('agent', { content: 'pending input', deliveryId: 'pending', when: 'turn' })
      await written.promise
      const hash = vi.spyOn(Hash.prototype, 'update')
      controller.onTurnStarted('agent', observed)
      await settled.promise
      expect(hash).toHaveBeenCalledExactlyOnceWith(observed)
      expect(events.at(-1)).toMatchObject({ deliveryId: 'pending', state: outcome,
        ...(outcome === 'unknown' ? { reason: 'prompt_mismatch' } : {}) })
    },
  )

  it('defers an early start until the pending fingerprint exists, then matches it once', async () => {
    const started = signal()
    let controller!: SessionInputController
    const f = fixture({ inject: async () => { controller.onTurnStarted('agent', 'early input'); return true },
      onDelivery: event => { if (event.state === 'started') started.resolve() },
    })
    controller = f.controller
    const hash = vi.spyOn(Hash.prototype, 'update')
    controller.submitInput('agent', { content: 'early input', deliveryId: 'early', when: 'turn' })
    await started.promise
    expect(f.events.map(event => event.state)).toEqual(['queued', 'delivered', 'started'])
    // One fingerprint for the submitted input, one for the replayed start; none for the premature event.
    expect(hash).toHaveBeenCalledTimes(2)
  })

  it('preserves a receipt queued by a synchronously reentrant delivery callback', async () => {
    const first = signal(), second = signal()
    let controller!: SessionInputController
    const f = fixture({ onDelivery: event => {
      if (event.deliveryId === 'first' && event.state === 'delivered') first.resolve()
      if (event.deliveryId === 'first' && event.state === 'started') {
        controller.submitInput('agent', { content: 'second input', deliveryId: 'second', when: 'turn' })
      }
      if (event.deliveryId === 'second' && event.state === 'delivered') second.resolve()
    } })
    controller = f.controller
    controller.submitInput('agent', { content: 'first input', deliveryId: 'first', when: 'turn' })
    await first.promise
    controller.onTurnStarted('agent', 'first input')
    controller.onTurnEnded('agent')
    await second.promise
    const hash = vi.spyOn(Hash.prototype, 'update')
    controller.onTurnStarted('agent', 'second input')
    expect(hash).toHaveBeenCalledExactlyOnceWith('second input')
    expect(f.events.at(-1)).toMatchObject({ deliveryId: 'second', state: 'started' })
  })
})
