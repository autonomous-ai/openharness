import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeRuntimeProfile } from '../kit/runtime.js'
import { RuntimeProfileControlError, type EngineModelControl, type ModelControlHost } from '../facets/modelControl.js'
import { engineModelControlRequests } from './modelControlRequests.js'
import { createModelControlHost } from './modelControlHost.js'
import { MODEL_CONTROL_APPLY as APPLY, MODEL_CONTROL_CAPABILITIES as CAP, MODEL_CONTROL_VALIDATE as CHECK,
  MODEL_CONTROL_CHECK_MS, MODEL_CONTROL_WAIT_MS, MODEL_CONTROL_QUERY_MS, modelControlCheck, modelControlInput } from './modelControlProtocol.js'

const session = { agentId: 'agent', sessionId: 'session', engine: 'claude' as const, model: null, cliVersion: null, cwd: '/tmp', transcriptPath: null }
const state = { model: null, effort: null, mode: 'default' as const, cliVersion: null, observedAt: null }
const target = { id: '', sessionId: 'agent', engine: 'claude' as const, model: 'sonnet', effort: 'high' }
target.id = encodeRuntimeProfile(target)
const input = { session, target, current: null, options: [{ id: target.id, displayName: 'Sonnet / High' }], catalog: [] }
const check = { session, target, state, stage: 'target' as const, catalog: [] }
const asker = { owner: true, local: true }
const apply = { version: 1, input, token: 'a'.repeat(64), requestId: 'core-route' }
function setup() {
  const control: EngineModelControl = { validate: vi.fn(async () => {}), apply: vi.fn(async () => {}) }
  const deps = { load: vi.fn(async () => control), recycle: vi.fn(), query: vi.fn(async () => ({ version: 1, value: true, requestId: 'core-reply' } as Record<string, unknown>)) }
  const requests = engineModelControlRequests('claude', deps)
  return { requests, control, deps }
}

describe('private model-control worker', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('accepts only the core owner envelope and uses a lazy, retryable facet import', async () => {
    const s = setup()
    expect(await s.requests[CAP]({ version: 1 }, asker)).toEqual({ version: 1, modelControl: 1, engine: 'claude' })
    expect(s.deps.load).not.toHaveBeenCalled()
    for (const caller of [{ owner: false, local: true }, { owner: true, local: false }, { ...asker, connection: 'client' }]) {
      expect(await s.requests[APPLY](apply, caller)).toHaveProperty('error', 'BUSY')
    }
    for (const payload of [{ ...apply, version: 2 }, { ...apply, terminal: '%1' }, { ...apply, token: 'guess' }, { ...apply, requestId: 7 }, { ...apply, input: { ...input, target: { ...target, engine: 'codex' } } }]) {
      expect(await s.requests[APPLY](payload, asker)).toHaveProperty('error', 'INVALID_RUNTIME_PROFILE')
    }
    s.deps.load.mockRejectedValueOnce(new Error('import failed'))
    expect(await s.requests[APPLY](apply, asker)).toHaveProperty('error', 'BUSY')
    expect(await s.requests[APPLY](apply, asker)).toEqual({ version: 1, ok: true })
    expect(await s.requests[CHECK]({ version: 1, check }, asker)).toEqual({ version: 1, ok: true })
    expect(s.deps.load).toHaveBeenCalledTimes(2)
    expect(s.control.apply).toHaveBeenCalledOnce()
  })

  it('rejects mismatched profiles, unbounded evidence and extra terminal authority', () => {
    for (const value of [null, { ...input, terminal: '%1' }, { ...input, current: {} }, { ...input, session: { ...session, cwd: 'relative' } },
      { ...input, options: [{ id: target.id, displayName: 4 }] }, { ...input, options: Array(4097).fill(input.options[0]) }, { ...input, catalog: [{}] },
      { ...input, target: { ...target, model: 'sonnet\nanswer', id: encodeRuntimeProfile({ ...target, model: 'sonnet\nanswer' }) } }]) {
      expect(modelControlInput(value, 'claude')).toBeNull()
    }
    for (const value of [null, { ...check, stage: 'write' }, { ...check, state: {} }, { ...check, catalog: null }, { ...check, pane: { idle: true } },
      { ...check, pane: { idle: true, draft: false, plan: false, dialog: false, tmuxPane: '%1' } }]) expect(modelControlCheck(value, 'claude')).toBeNull()
    expect(modelControlInput({ ...input, current: target }, 'claude')?.current).toEqual(target)
    expect(modelControlCheck({ ...check, pane: { idle: true, draft: false, plan: false, dialog: false } }, 'claude')?.pane?.idle).toBe(true)
  })

  it('propagates known refusals, and makes no late request after abort or completion', async () => {
    const s = setup(), closed = new AbortController()
    closed.abort()
    expect(await s.requests[APPLY](apply, asker, closed.signal)).toHaveProperty('error', 'BUSY')
    s.control.validate = vi.fn(async () => { throw new RuntimeProfileControlError('PLAN_SCOPE_AMBIGUOUS') })
    expect(await s.requests[CHECK]({ version: 1, check }, asker)).toHaveProperty('error', 'PLAN_SCOPE_AMBIGUOUS')
    let host!: ModelControlHost
    s.control.apply = vi.fn(async (_input, value) => { host = value; await value.key('Enter') })
    expect(await s.requests[APPLY](apply, asker)).toHaveProperty('ok', true)
    await expect(host.key('Escape')).rejects.toMatchObject({ code: 'BUSY' })
    expect(s.deps.query).toHaveBeenCalledTimes(1)
    expect(s.deps.query).toHaveBeenCalledWith('engine.modelControl', { version: 1, token: apply.token, action: { kind: 'key', key: 'Enter' } })
    const second = new AbortController()
    s.control.apply = vi.fn(async (_input, value) => { host = value; second.abort(); await value.text('/model late') })
    expect(await s.requests[APPLY](apply, asker, second.signal)).toHaveProperty('error', 'BUSY')
    expect(s.deps.query).toHaveBeenCalledTimes(1)
  })

  it.each([['load', MODEL_CONTROL_CHECK_MS], ['apply', MODEL_CONTROL_WAIT_MS], ['query', MODEL_CONTROL_QUERY_MS]] as const)('bounds and recycles a hung %s', async (kind, timeout) => {
    const s = setup()
    let host!: ModelControlHost
    if (kind === 'load') s.deps.load.mockImplementation(() => new Promise(() => {}))
    else s.control.apply = vi.fn(async (_input, value) => { host = value; if (kind === 'query') await value.capture(100); else await new Promise(() => {}) })
    if (kind === 'query') s.deps.query.mockImplementation(() => new Promise(() => {}))
    const result = kind === 'load' ? s.requests[CHECK]({ version: 1, check }, asker) : s.requests[APPLY](apply, asker)
    await vi.advanceTimersByTimeAsync(timeout + 1)
    expect(await result).toHaveProperty('error', 'BUSY')
    expect(s.deps.recycle).toHaveBeenCalledOnce()
    if (host) await expect(host.key('Escape')).rejects.toMatchObject({ code: 'BUSY' })
  })

  it('bounds simultaneous operations and aborts all work tied to the old core', async () => {
    const s = setup(), closed = new AbortController()
    s.control.apply = vi.fn(() => new Promise<void>(() => {}))
    const calls = Array.from({ length: 4 }, () => s.requests[APPLY](apply, asker, closed.signal))
    expect(await s.requests[APPLY](apply, asker)).toHaveProperty('error', 'BUSY')
    closed.abort()
    expect(await Promise.all(calls)).toEqual(Array(4).fill({ version: 1, error: 'BUSY' }))
    expect(s.deps.recycle).not.toHaveBeenCalled()
  })

  it('refuses malformed or denied host answers, including false effort confirmation', async () => {
    for (const reply of [{ version: 2, value: true }, { version: 1, error: 'BUSY', value: true }, { version: 1, value: 1 },
      { version: 1, value: true, terminal: '%9' }, { version: 1, value: true, requestId: 1 }, { version: 1, value: 'x'.repeat(1024 * 1024) }]) {
      await expect(createModelControlHost(async () => reply).key('Enter')).rejects.toMatchObject({ code: 'BUSY' })
    }
    await expect(createModelControlHost(async () => ({ version: 1, value: false })).confirmEffort('high')).rejects.toMatchObject({ code: 'BUSY' })
  })
})
