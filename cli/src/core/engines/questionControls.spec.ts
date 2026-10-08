import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import type { EngineQuestionControl, QuestionControlHost, QuestionStep } from '../../engines/facets/questionControl.js'
import { engineQuestionControlRequests } from '../../engines/worker/questionControlRequests.js'
import { QUESTION_CONTROL_CAPABILITIES, QUESTION_CONTROL_HOST, QUESTION_CONTROL_IN_FLIGHT, QUESTION_CONTROL_WAIT_MS } from '../../engines/worker/questionControlProtocol.js'
import { createQuestionControls } from './questionControls.js'

const denied = { version: 1, error: 'ANSWER_FAILED' }
const row = { number: '2', label: 'Coffee', checked: false }
const step: QuestionStep = { kind: 'select', row, enterSubmits: true }
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function setup(engine: 'claude' | 'codex' = 'claude', isolated = true, connected = true) {
  let session = { agentId: 'agent', sessionId: 'session', engine, active: true, boundAt: 1, tmuxPane: '%1' } as RegisteredSession
  const service = `engine-${engine}`
  let token = ''
  const native: EngineQuestionControl = { apply: vi.fn(async () => true) }
  const deps = {
    handles: () => isolated, resolve: () => session, inline: vi.fn(() => native as EngineQuestionControl | undefined),
    call: vi.fn(async (_service: string, method: string, payload: Record<string, unknown>, _ms: number): Promise<Record<string, unknown>> => {
      if (payload.token) token = payload.token as string
      if (!connected) { controls.connected(service); connected = true }
      return { ...await requests[method]({ ...payload, requestId: 'core-request' }, { owner: true, local: true }), requestId: 'worker-reply' }
    }),
    key: vi.fn(async (_target: string, _key: string, allowed: () => boolean) => allowed()),
    text: vi.fn(async (_target: string, _text: string, allowed: () => boolean) => allowed()),
  }
  const controls = createQuestionControls(deps)
  const request = (action: unknown, extra: Record<string, unknown> = {}, source = service) => controls.answer(source, QUESTION_CONTROL_HOST,
    { version: 1, query: QUESTION_CONTROL_HOST, requestId: 'worker-request', token, action, ...extra })!
  const requests = engineQuestionControlRequests(engine, { load: async () => native, recycle: vi.fn(),
    query: async (query, payload) => ({ ...await controls.answer(service, query, { ...payload, query, requestId: 'worker-request' })!, requestId: 'core-reply' }) })
  if (connected) controls.connected(service)
  return { controls, deps, native, service, request, session: () => session, replace: (value: RegisteredSession) => { session = value }, port: () => controls.forSession(session)! }
}

describe('question-control authority', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each(['claude', 'codex'] as const)('routes an approved %s step without giving the worker terminal identity', async engine => {
    const s = setup(engine, true, false), port = s.port()
    let host!: QuestionControlHost
    s.native.apply = vi.fn(async (value, ports) => {
      host = ports
      expect(value).toEqual({ kind: 'text', row, text: 'My answer' })
      expect(value).not.toHaveProperty('session')
      expect(await host.key('2')).toBe(true)
      expect(await host.text('My answer')).toBe(true)
      expect(await host.key('Enter')).toBe(true)
      return true
    })
    expect(await port.apply({ kind: 'text', row, text: 'My answer' })).toBe(true)
    expect(await port.apply({ kind: 'text', row, text: 'My answer' })).toBe(true)
    expect(s.deps.key).toHaveBeenCalledWith('agent', 'Enter', expect.any(Function))
    expect(s.deps.call.mock.calls.filter(c => c[1] === QUESTION_CONTROL_CAPABILITIES)).toHaveLength(1)
    expect(s.deps.inline).not.toHaveBeenCalled()
    await expect(host.key('Enter')).rejects.toThrow()
    expect(await s.request({ kind: 'key', key: 'Enter' })).toEqual(denied)
  })

  it('uses the grant in explicit inline mode, refuses a missing driver, and leaves other engines alone', async () => {
    const s = setup('claude', false)
    let host!: QuestionControlHost
    s.native.apply = vi.fn(async (_step, value) => { host = value; return value.key('2') })
    expect(await s.port().apply(step)).toBe(true)
    expect(s.deps.call).not.toHaveBeenCalled()
    await expect(host.key('Enter')).rejects.toThrow()
    s.native.apply = vi.fn(async () => false)
    expect(await s.port().apply(step)).toBe(false)
    s.deps.inline.mockReturnValue(undefined)
    expect(await s.port().apply(step)).toBe(false)
    expect(s.controls.forSession({ ...s.session(), engine: 'cursor' })).toBeUndefined()
    expect(s.controls.answer(s.service, 'live', {})).toBeNull()
  })

  it.each(['version', 'engine', 'questionControl', 'extra'])('rejects an incompatible %s capability before any write', async field => {
    const s = setup()
    s.deps.call.mockResolvedValueOnce({ version: 1, engine: 'claude', questionControl: 1, [field]: 'wrong' })
    expect(await s.port().apply(step)).toBe(false)
    expect(s.native.apply).not.toHaveBeenCalled()
    expect(s.deps.inline).not.toHaveBeenCalled()
  })

  it('rejects failed, malformed and unexpected-field completion replies', async () => {
    const s = setup(), port = s.port()
    expect(await port.apply(step)).toBe(true)
    for (const reply of [{ version: 2, ok: true }, { version: 1, ok: true, extra: true }, { version: 1, error: 'ANSWER_FAILED' }, { version: 1, ok: false }]) {
      s.deps.call.mockResolvedValueOnce(reply)
      expect(await port.apply(step)).toBe(false)
    }
    expect(await port.apply({ ...step, terminal: '%9' } as any)).toBe(false)
  })

  it('binds before the first await and never resumes a pre-reconnect answer', async () => {
    const s = setup(), port = s.port()
    expect(await port.apply(step)).toBe(true)
    s.controls.disconnected(s.service); s.controls.connected(s.service)
    expect(await port.apply(step)).toBe(false)
    const fresh = s.port()
    expect(await fresh.apply(step)).toBe(true)
    s.session().sessionId = 'replacement'
    expect(await fresh.apply(step)).toBe(false)
  })

  it('refuses other services and extra authority, and permits only the reviewed text', async () => {
    const s = setup()
    s.native.apply = vi.fn(async () => {
      expect(await s.request({ kind: 'key', key: '2' }, {}, 'engine-codex')).toEqual(denied)
      expect(await s.request({ kind: 'key', key: '2' }, { token: 'guess' })).toEqual(denied)
      expect(await s.request({ kind: 'key', key: '2', target: '%9' })).toEqual(denied)
      expect(await s.request({ kind: 'key', key: '2' }, { extra: true })).toEqual(denied)
      s.controls.disconnected('engine-codex') // another engine cannot revoke this answer
      expect(await s.request({ kind: 'key', key: '2' })).toEqual({ version: 1, value: true })
      expect(await s.request({ kind: 'text', text: 'unreviewed answer' })).toEqual(denied)
      expect(await s.request({ kind: 'key', key: 'Enter' })).toEqual(denied)
      return true
    })
    expect(await s.port().apply(step)).toBe(false)
    expect(s.deps.text).not.toHaveBeenCalled()
  })

  it('enters the approved text once: the same text again is refused and revokes the step', async () => {
    const s = setup()
    s.native.apply = vi.fn(async () => {
      expect(await s.request({ kind: 'key', key: '2' })).toEqual({ version: 1, value: true })
      expect(await s.request({ kind: 'text', text: 'My answer' })).toEqual({ version: 1, value: true })
      expect(await s.request({ kind: 'text', text: 'My answer' })).toEqual(denied)
      expect(await s.request({ kind: 'key', key: 'Enter' })).toEqual(denied)
      return true
    })
    expect(await s.port().apply({ kind: 'text', row, text: 'My answer' })).toBe(false)
    expect(s.deps.text).toHaveBeenCalledOnce()
  })

  it('says why a step failed: refused when it typed nothing, uncertain once a write had gone out', async () => {
    const s = setup(), port = s.port()
    expect(await port.apply(step)).toBe(true)
    expect(port.failure!()).toBeUndefined()
    s.native.apply = vi.fn(async () => false)
    expect(await port.apply(step)).toBe(false)
    expect(port.failure!()).toBe('refused')
    s.native.apply = vi.fn(async () => {
      expect(await s.request({ kind: 'key', key: '2' })).toEqual({ version: 1, value: true })
      throw new Error('worker killed after the key')
    })
    expect(await port.apply(step)).toBe(false)
    expect(port.failure!()).toBe('uncertain')
    // A write the terminal refused was still handed to it.
    s.deps.key.mockResolvedValueOnce(false)
    s.native.apply = vi.fn(async () => { await s.request({ kind: 'key', key: '2' }); return true })
    expect(await port.apply(step)).toBe(false)
    expect(port.failure!()).toBe('uncertain')
    // A step refused by the broker before it was admitted typed nothing.
    expect(await port.apply({ kind: 'select', row: { ...row, number: 'C-c' } } as never)).toBe(false)
    expect(port.failure!()).toBe('refused')
  })

  it('refuses a step past its engine\'s capacity as typing nothing', async () => {
    const s = setup(), gate = deferred<boolean>()
    s.native.apply = vi.fn(() => gate.promise)
    const ports = Array.from({ length: QUESTION_CONTROL_IN_FLIGHT }, () => s.port())
    const held = ports.map(port => port.apply(step))
    await vi.waitFor(() => expect(s.native.apply).toHaveBeenCalledTimes(QUESTION_CONTROL_IN_FLIGHT))
    const extra = s.port()
    expect(await extra.apply(step)).toBe(false)
    expect(extra.failure!()).toBe('refused')
    gate.resolve(true)
    expect(await Promise.all(held)).toEqual(Array(QUESTION_CONTROL_IN_FLIGHT).fill(true))
  })

  it('limits a granted step and revokes it after excess keys', async () => {
    const s = setup()
    s.native.apply = vi.fn(async () => {
      for (let i = 0; i < 128; i++) expect(await s.request({ kind: 'key', key: 'Down' })).toHaveProperty('value', true)
      expect(await s.request({ kind: 'key', key: 'Enter' })).toEqual(denied)
      return true
    })
    expect(await s.port().apply(step)).toBe(false)
  })

  it('refuses the first effect if the registered conversation changed after admission', async () => {
    const s = setup()
    s.native.apply = vi.fn(async () => {
      s.session().sessionId = 'replacement'
      expect(await s.request({ kind: 'key', key: '2' })).toEqual(denied)
      return true
    })
    expect(await s.port().apply(step)).toBe(false)
    expect(s.deps.key).not.toHaveBeenCalled()
  })

  it.each(['failed', 'throw', 'malformed'] as const)('revokes all later keys after a %s terminal write', async failure => {
    const s = setup()
    if (failure === 'failed') s.deps.key.mockResolvedValueOnce(false)
    else if (failure === 'throw') s.deps.key.mockRejectedValueOnce(new Error('gone'))
    else s.deps.key.mockResolvedValueOnce('yes' as any)
    s.native.apply = vi.fn(async () => {
      expect(await s.request({ kind: 'key', key: '2' })).toEqual(failure === 'failed' ? { version: 1, value: false } : denied)
      expect(await s.request({ kind: 'key', key: 'Enter' })).toEqual(denied)
      return true
    })
    expect(await s.port().apply(step)).toBe(false)
    expect(s.deps.key).toHaveBeenCalledOnce()
  })

  it.each(['disconnect', 'rebind', 'overlap', 'completed', 'timeout'] as const)('revokes queued effects on %s', async reason => {
    const s = setup(), gate = deferred<void>(), entered = deferred<void>(), effects: string[] = []
    let permitted!: () => boolean
    s.deps.key.mockImplementation(async (_target, key, allowed) => {
      permitted = allowed; entered.resolve(); await gate.promise
      if (allowed()) effects.push(key)
      return allowed()
    })
    s.deps.call.mockImplementation(async (_service, method, payload) => {
      if (method === QUESTION_CONTROL_CAPABILITIES) return { version: 1, questionControl: 1, engine: 'claude' }
      const effect = s.controls.answer(s.service, QUESTION_CONTROL_HOST, { version: 1, token: payload.token, action: { kind: 'key', key: 'Enter' } })!
      if (reason === 'completed') { void effect; return { version: 1, ok: true } }
      if (reason === 'overlap') expect(await s.controls.answer(s.service, QUESTION_CONTROL_HOST, { version: 1, token: payload.token, action: { kind: 'key', key: '2' } })).toEqual(denied)
      await effect
      return { version: 1, ok: true }
    })
    const outcome = s.port().apply(step)
    await entered.promise
    if (reason === 'disconnect') s.controls.disconnected(s.service)
    if (reason === 'rebind') s.session().boundAt = 2
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(QUESTION_CONTROL_WAIT_MS + 1)
    if (reason === 'completed') await outcome
    expect(permitted()).toBe(false)
    gate.resolve()
    expect(await outcome).toBe(false)
    expect(effects).toEqual([])
  })
})
