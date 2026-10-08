import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineRuntime, RuntimeContext } from '../facets/runtime.js'
import { runtimeFor } from '../runtime.js'
import { blankRuntimeState, encodeRuntimeProfile, transcriptFields } from '../kit/runtime.js'
import { engineRuntimeRequests } from './runtimeRequests.js'
import { RUNTIME_CAPABILITIES, RUNTIME_IN_FLIGHT, RUNTIME_READ, RUNTIME_REPLY_BYTES, RUNTIME_WAIT_MS,
  runtimeAnswer, runtimeContext, runtimeOperation, type RuntimeOperation } from './runtimeProtocol.js'

const who = { owner: true, local: true }
const context = (engine: 'claude' | 'codex' = 'claude'): RuntimeContext => ({
  session: { agentId: 'agent', sessionId: 'session', engine, model: null, cliVersion: '2.1.209', cwd: null, transcriptPath: null, codexHome: null },
  state: blankRuntimeState(),
})
const failure = (error: string, retryable = true) => ({ version: 1, error, retryable })
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const target = (ctx: RuntimeContext, model = 'opus', effort = 'high') => {
  const data = { sessionId: ctx.session.agentId, engine: ctx.session.engine, model, effort }
  return { id: encodeRuntimeProfile(data), ...data }
}
function setup() {
  const adapter = { ...runtimeFor('claude')!, configuredEffort: vi.fn(async () => 'high'), models: vi.fn(async () => []),
    catalog: vi.fn(async () => []), effortAllowed: vi.fn(() => true) }
  const load = vi.fn(async () => adapter), recycle = vi.fn()
  const requests = engineRuntimeRequests('claude', { load, recycle })
  const payload = { version: 1, context: context(), operation: { kind: 'describe' } }
  const send = async (overrides: Record<string, unknown> = {}, asker = who, signal?: AbortSignal): Promise<Record<string, any>> =>
    await requests[RUNTIME_READ]({ ...payload, ...overrides }, asker, signal) as Record<string, any>
  return { adapter, load, recycle, requests, payload, send }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('runtime worker contract', () => {
  it('serves a catalog for an unbound agent but refuses conversation controls without a binding', async () => {
    const t = setup(), ctx = context(); ctx.session.sessionId = ''
    expect((await t.send({ context: ctx, operation: { kind: 'models' } })).answer.models).toEqual([])
    ctx.control = { target: target(ctx), before: null, modelConfirmed: false, effortConfirmed: false }
    expect(await t.send({ context: ctx })).toEqual(failure('ENGINE_INVALID_REQUEST', false))
  })

  it('reduces a supplied snapshot and survives a fresh worker without mutating the caller', async () => {
    for (const engine of ['claude', 'codex'] as const) {
      const ctx = context(engine), adapter = runtimeFor(engine)!
      const raw = engine === 'claude'
        ? { type: 'assistant', version: '2.1.209', message: { model: 'claude-opus-5', content: 'Set effort level to high' } }
        : { type: 'turn_context', payload: { model: 'gpt-6-astra', effort: 'persistent', collaboration_mode: { mode: 'plan' } } }
      const operation: RuntimeOperation = { kind: 'records', records: [adapter.decode(raw)!] }
      const before = structuredClone(ctx)
      const worker = engineRuntimeRequests(engine)
      const first = await worker[RUNTIME_READ]({ version: 1, context: ctx, operation }, who) as any
      expect(first.answer.state.model).toBe(engine === 'claude' ? 'claude-opus-5' : 'gpt-6-astra')
      expect(first.answer.state.effort).toBe(engine === 'claude' ? 'high' : 'persistent')
      expect(runtimeAnswer(first.answer, ctx, operation)).toBe(true)
      expect(ctx).toEqual(before)
      const resumed = { ...ctx, state: first.answer.state, session: { ...ctx.session, cliVersion: first.answer.cliVersion } }
      const fresh = engineRuntimeRequests(engine)
      expect(await fresh[RUNTIME_READ]({ version: 1, context: resumed, operation: { kind: 'describe' } }, who)).toEqual(first)
    }
  })

  it('keeps compact engine evidence and metadata probes independent of live controls', () => {
    const ctx = context(), adapter = runtimeFor('claude')!
    ctx.control = { target: target(ctx), before: null, modelConfirmed: false, effortConfirmed: false }
    const raw = { type: 'assistant', version: '2.1.209', message: { model: 'claude-opus-5', content: 'x'.repeat(2_000_000) } }
    expect(JSON.stringify(adapter.decode(raw)).length).toBeLessThan(200)
    expect(transcriptFields(adapter, ctx.session, JSON.stringify(raw))).toEqual(['model'])
    expect(ctx.state.model).toBeNull()
    expect(ctx.control.modelConfirmed).toBe(false)
    const unknown = adapter.decode({ content: 'Set model to ' + 'x'.repeat(2_000_000) })!
    expect(JSON.stringify(unknown).length).toBeLessThan(200)
    adapter.reduce(ctx, unknown)
    expect(ctx.state.model).toBe('opus')
    expect(ctx.control.modelConfirmed).toBe(true)
    expect(adapter.decode({ type: 'assistant', message: { model: '<synthetic>', content: 'Quota exceeded' } })).toBeNull()
    expect(transcriptFields(undefined, ctx.session, '{}')).toEqual([])
    expect(transcriptFields(adapter, ctx.session, 'bad')).toEqual([])
    expect(transcriptFields(adapter, ctx.session, '[]')).toEqual([])
  })

  it('negotiates without loading, reads only in workers, and returns only supplied transaction evidence', async () => {
    const t = setup(), ctx = context()
    ctx.control = { target: target(ctx), before: null, modelConfirmed: false, effortConfirmed: false }
    expect(await t.requests[RUNTIME_CAPABILITIES]({ version: 1 }, who)).toEqual({ version: 1, runtime: 1, engine: 'claude' })
    expect(t.load).not.toHaveBeenCalled()
    const data = t.adapter.decode({ content: 'Set model to Opus\nSet effort level to high' })!
    const reply = await t.send({ context: ctx, operation: { kind: 'records', records: [data] } })
    expect(reply.answer.control).toMatchObject({ modelConfirmed: true, effortConfirmed: true })
    expect(ctx.control.modelConfirmed).toBe(false)
    const legacyTarget = { ...ctx.control.target, sessionId: ctx.session.sessionId }
    legacyTarget.id = encodeRuntimeProfile(legacyTarget)
    const legacy = { ...ctx, control: { ...ctx.control, target: legacyTarget } }
    const legacyReply = await t.send({ context: legacy, operation: { kind: 'records', records: [data] } })
    expect(legacyReply.answer.control.target).toEqual(legacyTarget)
    expect(runtimeAnswer(legacyReply.answer, legacy, { kind: 'records', records: [data] })).toBe(true)
    expect((await t.send({ operation: { kind: 'config' } })).answer.state.effort).toBe('high')
    expect((await t.send({ operation: { kind: 'pane', text: 'Opus 5 with high effort' } })).answer.state.model).toBe('claude-opus-5')
    expect((await t.send({ operation: { kind: 'models' } })).answer.models).toEqual([])
    expect((await t.send({ operation: { kind: 'catalog' } })).answer.catalog).toEqual([])
    expect((await t.send({ operation: { kind: 'effort', model: 'opus', effort: 'high', listed: ['high'] } })).answer.effortAllowed).toBe(true)
    expect(t.load).toHaveBeenCalledOnce()
    delete (t.adapter as Partial<EngineRuntime>).configuredEffort
    delete (t.adapter as Partial<EngineRuntime>).catalog
    delete (t.adapter as Partial<EngineRuntime>).effortAllowed
    expect((await t.send({ operation: { kind: 'config' } })).answer.state.effort).toBeNull()
    expect((await t.send({ operation: { kind: 'catalog' } })).answer.catalog).toEqual([])
    expect((await t.send({ operation: { kind: 'effort', model: 'opus', effort: 'high', listed: null } })).answer.effortAllowed).toBe(false)
  })

  it('refuses public callers and malformed snapshots before loading any engine', async () => {
    const t = setup()
    for (const asker of [{ owner: false, local: true }, { owner: true, local: false }, { ...who, connection: 'client' }]) {
      expect(await t.send({}, asker)).toEqual(failure('ENGINE_INVALID_REQUEST', false))
    }
    expect(await t.send({ version: 2 })).toEqual(failure('ENGINE_INVALID_REQUEST', false))
    const ctx = context()
    for (const bad of [undefined, [], {}, { ...ctx, session: { ...ctx.session, engine: 'codex' } },
      { ...ctx, session: { ...ctx.session, cwd: 'relative' } }, { ...ctx, state: { ...ctx.state, observedAt: Infinity } },
      { ...ctx, control: { target: target(ctx), before: null, modelConfirmed: true } },
      { ...ctx, control: { target: { ...target(ctx), sessionId: 'other' }, before: null, modelConfirmed: false, effortConfirmed: false } }]) {
      expect(await t.send({ context: bad })).toEqual(failure('ENGINE_INVALID_REQUEST', false))
    }
    for (const operation of [undefined, [], {}, { kind: 'unknown' }, { kind: 'describe', extra: true }, { kind: 'pane', text: 'x'.repeat(256 * 1024 + 1) },
      { kind: 'records', records: Array(513).fill({}) }, { kind: 'records', records: [{ nested: {} }] }, { kind: 'effort', model: 'opus', effort: 'high', listed: [1] }]) {
      expect(await t.send({ operation })).toEqual(failure('ENGINE_INVALID_REQUEST', false))
    }
    expect(await t.send({ surplus: 'x'.repeat(1024 * 1024) })).toEqual(failure('ENGINE_INVALID_REQUEST', false))
    expect(t.load).not.toHaveBeenCalled()
    const copied = runtimeContext({ ...ctx, session: { ...ctx.session, processIdentity: { pid: 1 } }, control: null }, 'claude')!
    expect(copied.session).not.toHaveProperty('processIdentity')
    expect(copied.state).not.toBe(ctx.state)
  })

  it('bounds concurrent work and drops results after a connection closes', async () => {
    const t = setup(), work = deferred<EngineRuntime>()
    t.load.mockImplementation(() => work.promise as Promise<typeof t.adapter>)
    const gone = new AbortController(); gone.abort()
    expect(await t.send({}, who, gone.signal)).toEqual(failure('ENGINE_UNAVAILABLE'))
    const closed = new AbortController()
    const tasks = Array.from({ length: RUNTIME_IN_FLIGHT }, () => t.send({}, who, closed.signal))
    expect(await t.send()).toEqual(failure('ENGINE_BUSY'))
    closed.abort(); work.resolve(t.adapter)
    for (const reply of await Promise.all(tasks)) expect(reply).toEqual(failure('ENGINE_UNAVAILABLE'))
    expect((await t.send()).answer).toBeDefined()
  })

  it('retries failed loads, bounds replies, and recycles an asynchronous operation past its deadline', async () => {
    vi.useFakeTimers()
    const t = setup()
    t.load.mockRejectedValueOnce(new Error('load failed'))
    expect(await t.send()).toEqual(failure('ENGINE_UNAVAILABLE'))
    expect((await t.send()).answer).toBeDefined()
    expect(t.load).toHaveBeenCalledTimes(2)
    t.adapter.models.mockResolvedValue([{ id: 'large', displayName: 'x'.repeat(RUNTIME_REPLY_BYTES) }] as never[])
    expect(await t.send({ operation: { kind: 'models' } })).toEqual(failure('ENGINE_REPLY_TOO_LARGE', false))
    const work = deferred<string>()
    t.adapter.configuredEffort.mockImplementation(() => work.promise)
    const slow = t.send({ operation: { kind: 'config' } })
    await vi.advanceTimersByTimeAsync(RUNTIME_WAIT_MS)
    expect(await slow).toEqual(failure('ENGINE_UNAVAILABLE'))
    expect(t.recycle).toHaveBeenCalledOnce()
    work.resolve('high')
  })

  it('validates results against the same agent and control transaction', async () => {
    const t = setup(), ctx = context()
    ctx.control = { target: target(ctx), before: null, modelConfirmed: false, effortConfirmed: false }
    const operation: RuntimeOperation = { kind: 'describe' }
    const good = (await t.send({ context: ctx })).answer
    expect(runtimeAnswer(good, ctx, operation)).toBe(true)
    for (const bad of [null, {}, { ...good, control: null }, { ...good, control: undefined }, { ...good, supportsControl: 1 },
      { ...good, selectedModel: 'runtime-v1:other:claude:opus@high' },
      ...['runtime-v1:agent:claude:opus', 'runtime-v1:agent:claude:%ZZ@high', 'runtime-v1:agent:claude:opus@HIGH', 'runtime-v1:agent:claude:@high']
        .map(selectedModel => ({ ...good, selectedModel })),
      { ...good, control: { ...good.control, before: 'another' } },
      { ...good, control: { ...good.control, target: target(ctx, 'sonnet') } }]) expect(runtimeAnswer(bad, ctx, operation)).toBe(false)
    expect(runtimeAnswer({ ...good, models: [{ id: target(ctx).id, displayName: 'Opus' }] }, ctx, { kind: 'models' })).toBe(true)
    expect(runtimeAnswer({ ...good, models: [{ id: 'another', displayName: 'Opus' }] }, ctx, { kind: 'models' })).toBe(false)
    expect(runtimeAnswer({ ...good, catalog: [{ slug: 'model', displayName: 'Model', listed: true, defaultEffort: 'high', efforts: ['high'] }] }, ctx, { kind: 'catalog' })).toBe(true)
    expect(runtimeAnswer({ ...good, catalog: [{}] }, ctx, { kind: 'catalog' })).toBe(false)
    expect(runtimeAnswer({ ...good, effortAllowed: true }, ctx, { kind: 'effort', model: 'opus', effort: 'high', listed: null })).toBe(true)
    expect(runtimeOperation({ kind: 'effort', model: 'opus', effort: 'high', listed: null })).not.toBeNull()
  })
})
