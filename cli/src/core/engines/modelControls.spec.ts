import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { encodeRuntimeProfile } from '../../engines/kit/runtime.js'
import { RuntimeProfileControlError, type EngineModelControl, type ModelControlHost } from '../../engines/facets/modelControl.js'
import { engineModelControlRequests } from '../../engines/worker/modelControlRequests.js'
import { MODEL_CONTROL_APPLY, MODEL_CONTROL_CAPABILITIES, MODEL_CONTROL_HOST, MODEL_CONTROL_WAIT_MS, MODEL_CONTROL_CHECK_MS } from '../../engines/worker/modelControlProtocol.js'
import { createModelControls } from './modelControls.js'

const state = { model: null, effort: null, cliVersion: null, observedAt: null, mode: 'default' as const }
const denied = { version: 1, error: 'BUSY' }
const catalog = [{ slug: 'next', displayName: 'Next', listed: true, defaultEffort: 'high', efforts: ['high'] }]
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
function setup(engine: 'claude' | 'codex' = 'claude', isolated = true, connected = true) {
  let session: RegisteredSession | undefined = {
    agentId: 'agent', sessionId: 'session', engine, model: 'old', cliVersion: '1.0.0', cwd: '/tmp', transcriptPath: '/tmp/session',
    active: true, registeredAt: 1, boundAt: 1, tmuxPane: '%1', runtimes: [], primaryRuntimeKey: 'tmux:%1', processIdentity: null,
  } as unknown as RegisteredSession
  const target = { sessionId: 'agent', engine, model: 'next', effort: 'high', id: '' }
  target.id = encodeRuntimeProfile(target)
  const input = { target, current: null, options: [{ id: target.id, displayName: 'Next' }] }
  const check = { stage: 'target' as const, target, state }
  const native: EngineModelControl = { validate: vi.fn(async () => {}), apply: vi.fn(async () => {}) }
  const service = `engine-${engine}`
  let token = ''
  const asks: Record<string, unknown>[] = []
  const deps = {
    handles: () => isolated, inline: vi.fn(() => native as EngineModelControl | undefined), resolve: () => session,
    call: vi.fn(async (_service: string, method: string, payload: Record<string, unknown>, _ms: number): Promise<Record<string, unknown>> => {
      if (payload.token) token = payload.token as string
      asks.push(payload)
      if (!connected) { controls.connected(service); connected = true }
      // The real link adds requestId. Keep that metadata in this fixture.
      return { ...await requests[method]({ ...payload, requestId: 'core-request' }, { owner: true, local: true }), requestId: 'routed-reply' }
    }),
    catalog: vi.fn(async () => catalog), capture: vi.fn(async () => 'screen' as string | null),
    text: vi.fn(async (_id: string, _text: string, allowed: () => boolean) => allowed()),
    key: vi.fn(async (_id: string, _key: string, allowed: () => boolean) => allowed()),
    waitForModel: vi.fn(async () => true), waitForProfile: vi.fn(async () => false), confirmEffort: vi.fn(),
  }
  const controls = createModelControls(deps)
  const request = (action: unknown, extra: Record<string, unknown> = {}, source = service) => controls.answer(source, MODEL_CONTROL_HOST,
    { version: 1, token, action, query: MODEL_CONTROL_HOST, requestId: 'worker-query', ...extra })!
  const requests = engineModelControlRequests(engine, { load: async () => native, recycle: vi.fn(),
    query: (query, payload) => controls.answer(service, query, { ...payload, query, requestId: 'worker-query' })! })
  if (connected) controls.connected(service)
  return { controls, deps, target, check, input, native, asks, service, request,
    session: () => session!, replace: (value?: RegisteredSession) => { session = value },
    port: () => controls.forSession(session!)!,
  }
}

describe('model-control authority', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each(['claude', 'codex'] as const)('routes %s validation and each effect through the real private envelopes', async engine => {
    const s = setup(engine, true, false), p = s.port()
    let owned: ModelControlHost | undefined
    s.native.apply = vi.fn(async (input, host) => {
      owned = host
      expect(input.session).not.toHaveProperty('tmuxPane')
      expect(input.catalog).toEqual(catalog)
      expect(await host.catalog()).toEqual(catalog)
      expect(await host.capture(80)).toBe('screen')
      expect(await host.text('/model next')).toBe(true)
      expect(await host.key('Enter')).toBe(true)
      expect(await host.waitForModel(1200)).toBe(true)
      expect(await host.waitForProfile(8000)).toBe(false)
      await host.confirmEffort('high')
    })
    await p.validate(s.check)
    await p.validate({ ...s.check, stage: 'scope', pane: { idle: true, draft: false, dialog: false, plan: false } })
    await p.apply(s.input)
    expect(s.deps.catalog).toHaveBeenCalledTimes(2) // preflight + the explicit refresh
    expect(s.deps.confirmEffort).toHaveBeenCalledWith('session', 'high')
    expect(s.deps.text).toHaveBeenCalledWith('agent', '/model next', expect.any(Function))
    expect(s.deps.inline).not.toHaveBeenCalled()
    expect(s.deps.call.mock.calls.filter(c => c[1] === MODEL_CONTROL_CAPABILITIES)).toHaveLength(1)
    await expect(owned!.key('Escape')).rejects.toMatchObject({ code: 'BUSY' })
    expect(await s.request({ kind: 'key', key: 'Enter' })).toEqual(denied)
  })

  it('uses the same revocable broker in explicit inline mode, and leaves other engines alone', async () => {
    const s = setup('claude', false), p = s.port()
    let host!: ModelControlHost
    s.native.apply = vi.fn(async (_input, value) => { host = value; await value.key('Enter') })
    await p.validate(s.check)
    await p.apply(s.input)
    expect(s.deps.call).not.toHaveBeenCalled()
    await expect(host.text('/model late')).rejects.toMatchObject({ code: 'BUSY' })
    expect(s.controls.forSession({ ...s.session(), engine: 'cursor' })).toBeUndefined()
    expect(s.controls.answer(s.service, 'live', {})).toBeNull()
    s.controls.connected('other'); s.controls.disconnected('other')
    s.deps.inline.mockReturnValue(undefined)
    await expect(s.port().validate(s.check)).rejects.toMatchObject({ code: 'BUSY' })
    await expect(s.port().apply(s.input)).rejects.toMatchObject({ code: 'BUSY' })
  })

  it('rejects an inline result after replacement and leaves other engines’ grants intact', async () => {
    const s = setup('claude', false)
    s.native.apply = vi.fn(async (_input, host) => {
      s.controls.disconnected('engine-codex')
      expect(await host.key('Enter')).toBe(true)
    })
    await s.port().apply(s.input)
    s.native.validate = vi.fn(async () => { s.session().boundAt = 2 })
    await expect(s.port().validate(s.check)).rejects.toMatchObject({ code: 'BUSY' })
  })

  it('preserves engine refusal codes and contains unexpected exceptions', async () => {
    const s = setup(), p = s.port()
    s.native.validate = vi.fn(async () => { throw new RuntimeProfileControlError('EFFORT_UNSUPPORTED') })
    await expect(p.validate(s.check)).rejects.toMatchObject({ code: 'EFFORT_UNSUPPORTED' })
    s.deps.call.mockRejectedValueOnce(new Error('broken pipe'))
    await expect(p.validate(s.check)).rejects.toMatchObject({ code: 'BUSY' })
    s.deps.call.mockResolvedValueOnce({ version: 1, error: 'UNKNOWN' })
    await expect(p.validate(s.check)).rejects.toMatchObject({ code: 'BUSY' })
    s.deps.call.mockResolvedValueOnce({ version: 1, ok: false })
    await expect(p.validate(s.check)).rejects.toMatchObject({ code: 'BUSY' })
    s.deps.call.mockResolvedValueOnce({ version: 2, ok: true })
    await expect(p.validate(s.check)).rejects.toMatchObject({ code: 'BUSY' })
    expect(s.deps.inline).not.toHaveBeenCalled()
  })

  it.each(['version', 'modelControl', 'engine'])('rejects an incompatible capability %s without an inline fallback', async field => {
    const s = setup()
    s.deps.call.mockResolvedValueOnce({ version: 1, modelControl: 1, engine: 'claude', [field]: 'wrong' })
    await expect(s.port().validate(s.check)).rejects.toMatchObject({ code: 'BUSY' })
    expect(s.native.validate).not.toHaveBeenCalled()
    expect(s.deps.inline).not.toHaveBeenCalled()
  })

  it.each(['capability', 'validation', 'apply'] as const)('rejects unexpected fields in a worker %s reply', async phase => {
    const s = setup(), p = s.port()
    if (phase !== 'capability') await p.validate(s.check)
    s.deps.call.mockResolvedValueOnce({ version: 1, ...(phase === 'capability' ? { modelControl: 1, engine: 'claude' } : { ok: true }), terminal: '%9' })
    await expect(phase === 'apply' ? p.apply(s.input) : p.validate(s.check)).rejects.toMatchObject({ code: 'BUSY' })
    expect(s.deps.inline).not.toHaveBeenCalled()
    expect(s.deps.key).not.toHaveBeenCalled()
  })

  it('fences in-place rebinding during catalog reads and before any request starts', async () => {
    const s = setup(), p = s.port()
    s.deps.catalog.mockImplementationOnce(async () => { s.session().sessionId = 'replacement'; return catalog })
    await expect(p.validate(s.check)).rejects.toMatchObject({ code: 'BUSY' })
    expect(s.native.validate).not.toHaveBeenCalled()
    await expect(p.apply(s.input)).rejects.toMatchObject({ code: 'BUSY' })
    s.replace()
    await expect(p.validate(s.check)).rejects.toMatchObject({ code: 'BUSY' })
  })

  it('does not resume UI intent after a worker reconnect or while disconnected', async () => {
    const s = setup(), p = s.port()
    await p.validate(s.check)
    s.controls.disconnected(s.service)
    await expect(p.apply(s.input)).rejects.toMatchObject({ code: 'BUSY' })
    s.controls.connected(s.service)
    await expect(p.apply(s.input)).rejects.toMatchObject({ code: 'BUSY' })
    await s.port().apply(s.input)
    await expect(p.apply(s.input)).rejects.toMatchObject({ code: 'BUSY' }) // new worker's capability cache cannot rescue an old intent
    s.controls.connected(s.service) // replacement connection, without an observed close
    await expect(p.validate(s.check)).rejects.toMatchObject({ code: 'BUSY' })
  })

  it('rejects invalid snapshots before native interpretation', async () => {
    const s = setup(), p = s.port()
    await expect(p.validate({ ...s.check, target: { ...s.target, model: 'other' } })).rejects.toMatchObject({ code: 'BUSY' })
    await expect(p.apply({ ...s.input, target: { ...s.target, engine: 'codex' } })).rejects.toMatchObject({ code: 'BUSY' })
    expect(s.native.apply).not.toHaveBeenCalled()
    expect(s.native.validate).not.toHaveBeenCalled()
  })

  it('bounds hung startup and refuses overflow without queuing a later UI action', async () => {
    const s = setup()
    s.deps.call.mockImplementation(() => new Promise(() => {}))
    const results = Array.from({ length: 4 }, () => s.port().validate(s.check).catch(e => e.code))
    await expect(s.port().apply(s.input)).rejects.toMatchObject({ code: 'BUSY' })
    await vi.advanceTimersByTimeAsync(MODEL_CONTROL_CHECK_MS + 1)
    expect(await Promise.all(results)).toEqual(['BUSY', 'BUSY', 'BUSY', 'BUSY'])
    expect(s.deps.call).toHaveBeenCalledTimes(4)
    expect(s.deps.key).not.toHaveBeenCalled()
  })

  it.each(['timeout', 'disconnect', 'rebind', 'completed'] as const)('revokes delayed terminal validation on %s', async reason => {
    const s = setup(), p = s.port(), dispatched: string[] = [], done = deferred<void>(), started = deferred<void>()
    let permitted!: () => boolean
    s.deps.key.mockImplementation(async (_id, key, allowed) => {
      permitted = allowed; started.resolve()
      await done.promise
      if (allowed()) dispatched.push(key)
      return allowed()
    })
    s.deps.call.mockImplementation(async (_service, method, payload) => {
      if (method === MODEL_CONTROL_CAPABILITIES) return { version: 1, modelControl: 1, engine: 'claude' }
      const answer = s.controls.answer(s.service, MODEL_CONTROL_HOST, { version: 1, token: payload.token, action: { kind: 'key', key: 'Enter' } })!
      if (reason === 'completed') { void answer; return { version: 1, ok: true } }
      await answer
      return { version: 1, ok: true }
    })
    const outcome = p.apply(s.input).then(() => 'ok', e => e.code)
    await started.promise
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(MODEL_CONTROL_WAIT_MS + 1)
    if (reason === 'disconnect') s.controls.disconnected(s.service)
    if (reason === 'rebind') s.session().processIdentity = { pid: 999, startTime: 'new' } as any
    if (reason === 'completed') await outcome
    expect(permitted()).toBe(false)
    done.resolve()
    expect(await outcome).toBe('BUSY')
    expect(dispatched).toEqual([])
  })

  it('bounds the complete operation even when the worker never answers, then denies its late query', async () => {
    const s = setup(), p = s.port(), entered = deferred<void>()
    await p.validate(s.check)
    let payload: Record<string, unknown> = {}
    s.deps.call.mockImplementation(async (_service, _method, value) => { payload = value; entered.resolve(); return new Promise(() => {}) })
    const result = p.apply(s.input).catch(e => e.code)
    await entered.promise
    await vi.advanceTimersByTimeAsync(MODEL_CONTROL_WAIT_MS + 1)
    expect(await result).toBe('BUSY')
    expect(await s.controls.answer(s.service, MODEL_CONTROL_HOST, { version: 1, token: payload.token, action: { kind: 'key', key: 'Enter' } })).toEqual(denied)
  })

  it('does not grant other services, targets, operations or effects without an active request', async () => {
    const s = setup()
    expect(await s.request({ kind: 'key', key: 'Enter' })).toEqual(denied)
    s.native.apply = vi.fn(async () => {
      expect(await s.request({ kind: 'key', key: 'Enter' }, {}, 'engine-codex')).toEqual(denied)
      expect(await s.request({ kind: 'key', key: 'Enter' }, { token: 'guess' })).toEqual(denied)
      for (const action of [{ kind: 'key', key: 'C-c' }, { kind: 'text', text: '/model next\nother' }, { kind: 'capture', lines: 101 }, { kind: 'key', key: 'Enter', target: '%9' }]) {
        expect(await s.request(action)).toEqual(denied)
      }
      expect(await s.request({ kind: 'key', key: 'Enter' }, { extra: true })).toEqual(denied)
      expect(s.deps.key).not.toHaveBeenCalled()
      expect(await s.request({ kind: 'confirmEffort', effort: 'ultra' })).toEqual(denied)
      expect(await s.request({ kind: 'key', key: 'Enter' })).toEqual(denied)
    })
    await expect(s.port().apply(s.input)).rejects.toMatchObject({ code: 'BUSY' })
    expect(s.deps.confirmEffort).not.toHaveBeenCalled()
  })

  it.each(['query', 'write'] as const)('limits the %s budget for one granted control', async kind => {
    const s = setup()
    s.native.apply = vi.fn(async () => {
      const action = kind === 'query' ? { kind: 'capture', lines: 100 } : { kind: 'key', key: 'Enter' }
      for (let i = 0; i < (kind === 'query' ? 128 : 32); i++) expect(await s.request(action)).not.toHaveProperty('error')
      expect(await s.request(action)).toEqual(denied)
      expect(await s.request({ kind: 'key', key: 'Escape' })).toEqual(denied)
    })
    await expect(s.port().apply(s.input)).rejects.toMatchObject({ code: 'BUSY' })
  })

  it('revokes overlapping host requests before the delayed effect can dispatch', async () => {
    const s = setup(), effect = deferred<void>()
    s.deps.key.mockImplementation(async (_id, _key, allowed) => { await effect.promise; return allowed() })
    s.native.apply = vi.fn(async () => {
      const first = s.request({ kind: 'key', key: 'Enter' })
      expect(await s.request({ kind: 'capture', lines: 10 })).toEqual(denied)
      effect.resolve()
      expect(await first).toEqual(denied)
    })
    await expect(s.port().apply(s.input)).rejects.toMatchObject({ code: 'BUSY' })
  })

  it.each(['throw', 'oversize'] as const)('contains a %s from the host and revokes subsequent effects', async kind => {
    const s = setup()
    if (kind === 'throw') s.deps.capture.mockRejectedValueOnce(new Error('gone'))
    else s.deps.capture.mockResolvedValueOnce('x'.repeat(256 * 1024 + 1))
    s.native.apply = vi.fn(async () => {
      expect(await s.request({ kind: 'capture', lines: 10 })).toEqual(denied)
      expect(await s.request({ kind: 'key', key: 'Enter' })).toEqual(denied)
    })
    await expect(s.port().apply(s.input)).rejects.toMatchObject({ code: 'BUSY' })
  })

  it('bounds the aggregate catalog reply even when every entry fits, then revokes the grant', async () => {
    const s = setup()
    s.deps.catalog.mockResolvedValueOnce(Array.from({ length: 512 }, (_, i) => ({
      ...catalog[0], slug: `model-${i}`, displayName: 'x'.repeat(2000), efforts: ['high', 'x'.repeat(2000)],
    })))
    s.native.apply = vi.fn(async () => {
      expect(await s.request({ kind: 'catalog' })).toEqual(denied)
      expect(await s.request({ kind: 'key', key: 'Enter' })).toEqual(denied)
    })
    await expect(s.port().apply(s.input)).rejects.toMatchObject({ code: 'BUSY' })
    expect(s.deps.key).not.toHaveBeenCalled()
  })
})
