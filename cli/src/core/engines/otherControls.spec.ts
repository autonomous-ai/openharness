import { afterEach, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { OTHER_ENGINES } from '../../engines/otherEngines.js'
import { RuntimeProfileState } from '../../lib/runtimeProfileState.js'
import { blankRuntimeState, encodeRuntimeProfile } from '../../engines/kit/runtime.js'
import type { RuntimeAnswer } from '../../engines/worker/runtimeProtocol.js'
import { engineScreenRequests } from '../../engines/worker/screenRequests.js'
import { engineQuestionControlRequests } from '../../engines/worker/questionControlRequests.js'
import { screenFor } from '../../engines/screens.js'
import { createScreenTransport } from './screenTransport.js'
import { createQuestionControls } from './questionControls.js'
import { otherRuntimeRequests } from '../../engines/others/runtimeRequests.js'
import { createRuntimeTransport } from './runtimeTransport.js'
import { createRuntimeProfiles } from './runtimeProfiles.js'

const session = (): RegisteredSession => ({ agentId: 'agent', sessionId: 'session', engine: 'pi', active: true,
  boundAt: 1, tmuxPane: '%1', model: null, cliVersion: null, cwd: '/tmp', transcriptPath: '/tmp/transcript',
} as RegisteredSession)
afterEach(() => vi.useRealTimers())

it('routes other-engine screens to their shared worker without loading inline behavior', async () => {
  const calls: string[] = []
  const requests = engineScreenRequests('pi' as never, { load: async () => screenFor('pi') })
  const transport = createScreenTransport({ call: async (service, method, payload) => {
    calls.push(service)
    const { engine, ...snapshot } = payload
    expect(engine).toBe('pi')
    return await requests[method](snapshot, { owner: true, local: true }) as Record<string, unknown>
  } })
  transport.connected('engine-others')
  expect(await transport.read('pi', 'minimax/minimax-m3 • high')).toEqual(screenFor('pi').inspect('minimax/minimax-m3 • high'))
  expect(calls).toEqual(['engine-others', 'engine-others'])
})

it('routes other-engine question steps through the same revocable writer grant', async () => {
  const row = session(), key = vi.fn(async (_target: string, _key: string, allowed: () => boolean) => allowed())
  const inline = vi.fn(() => { throw Error('inline behavior loaded') })
  let host: import('../../engines/facets/questionControl.js').QuestionControlHost | undefined
  const controls = createQuestionControls({ handles: () => true, resolve: () => row, inline, key,
    text: async (_id, _text, allowed) => allowed(), call: async (service, method, payload) => {
      expect(service).toBe('engine-others')
      const { engine, ...snapshot } = payload
      expect(engine).toBe('pi')
      return await requests[method](snapshot, { owner: true, local: true }) as Record<string, unknown>
    } })
  const requests = engineQuestionControlRequests('pi' as never, { recycle: vi.fn(),
    load: async () => ({ apply: async (_step, value) => { host = value; return value.key('2') } }),
    query: (query, payload) => controls.answer('engine-others', query, payload)! })
  controls.connected('engine-others')
  const port = controls.forSession(row)
  expect(port).toBeDefined()
  expect(await port!.apply({ kind: 'select', row: { number: '2', label: 'Approved', checked: false } })).toBe(true)
  expect(key).toHaveBeenCalledWith('agent', '2', expect.any(Function))
  expect(inline).not.toHaveBeenCalled()
  await expect(host!.key('2')).rejects.toThrow()
})

it('keeps live profile evidence and asynchronous reads under one binding revision', async () => {
  const row = { ...session(), engine: 'openclaw' as const }
  let finish!: (answer: RuntimeAnswer) => void
  const local = new RuntimeProfileState(() => undefined)
  const profiles = createRuntimeProfiles({ local, handles: () => true, resolve: () => row,
    transport: { connected: vi.fn(), disconnected: vi.fn(), read: () => new Promise(resolve => { finish = resolve }) } })
  try {
    profiles.hydrateEvidence(row, [{ model: 'first', effort: 'auto', workspace: '/work/first' }])
    expect(profiles.selectedModel(row)).toBe(encodeRuntimeProfile({ sessionId: 'agent', engine: 'openclaw', model: 'first', effort: 'auto' }))
    expect(profiles.workspace(row)).toBe('/work/first')
    const pending = profiles.ingestConfig(row)
    await vi.waitFor(() => expect(finish).toBeDefined())
    profiles.evidence(row, [{ model: 'newer', workspace: '/work/newer' }])
    finish({ state: { ...blankRuntimeState(), model: 'stale', effort: 'auto' }, cliVersion: null,
      selectedModel: encodeRuntimeProfile({ sessionId: 'agent', engine: 'openclaw', model: 'stale', effort: 'auto' }),
      control: null, supportsControl: false })
    await expect(pending).rejects.toThrow('ENGINE_STALE_REPLY')
    expect(profiles.getState('session').model).toBe('newer')
    expect(profiles.workspace(row)).toBe('/work/newer')
    expect(local.getState('session').model).toBeNull()
  } finally { profiles.stop() }
})

it.each(['evidence', 'control'] as const)('refuses captured work queued before newer %s while allowing ordinary serial observations', async change => {
  const row = session()
  const resolve = (id: string) => [row.agentId, row.sessionId].includes(id) ? row : undefined
  let finish!: (answer: RuntimeAnswer) => void
  const read = vi.fn(() => new Promise<RuntimeAnswer>(done => { finish = done }))
  const profiles = createRuntimeProfiles({ handles: () => true, resolve,
    transport: { connected: vi.fn(), disconnected: vi.fn(), read } })
  try {
    const first = profiles.ingestConfig(row)
    await vi.waitFor(() => expect(finish).toBeDefined())
    const queued = profiles.ingestPane(row, 'captured before newer authority')
    const target = { sessionId: row.agentId, engine: row.engine, model: 'newer', effort: 'high', id: '' }
    target.id = encodeRuntimeProfile(target)
    if (change === 'evidence') profiles.evidence(row, [{ model: target.model, effort: target.effort }])
    else profiles.beginControl(row, target)
    finish({ state: blankRuntimeState(), cliVersion: null, selectedModel: null, control: null, supportsControl: false })
    await expect(first).rejects.toThrow('ENGINE_STALE_REPLY')
    await expect(queued).rejects.toThrow('ENGINE_STALE_REPLY')
    expect(read).toHaveBeenCalledOnce()
  } finally { profiles.stop() }
})

it('does not expose a rebound session workspace to a captured old binding', () => {
  const old = session()
  let current = old
  const profiles = createRuntimeProfiles({ handles: () => true, resolve: () => current,
    transport: { connected: vi.fn(), disconnected: vi.fn(), read: vi.fn() } })
  try {
    profiles.evidence(old, [{ workspace: '/first' }])
    current = { ...old, sessionId: 'replacement', boundAt: 2 }
    profiles.evidence(current, [{ workspace: '/replacement' }])
    expect(profiles.workspace(old)).toBeNull()
    expect(profiles.workspace(current)).toBe('/replacement')
  } finally { profiles.stop() }
})

it.each(OTHER_ENGINES)('keeps %s view-only without waiting for its unavailable optional worker', async engine => {
  const row = { ...session(), engine }
  const read = vi.fn(async () => { throw Error('ENGINE_UNAVAILABLE') })
  const profiles = createRuntimeProfiles({ handles: () => true, resolve: () => row,
    transport: { connected: vi.fn(), disconnected: vi.fn(), read } })
  try {
    expect(await profiles.modelsForSession(row)).toEqual([])
    expect(await profiles.supportsControl(row)).toBe(false)
    expect(await profiles.effortAllowed(row, 'model', 'high', null)).toBe(false)
    expect(read).not.toHaveBeenCalled()
  } finally { profiles.stop() }
})


it.each(['picker', 'missing config', 'config warmup'] as const)('does not invalidate an already captured pane for an ignored %s', async ignored => {
  vi.stubEnv('PATH', '/nonexistent-other-runtime-test')
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const row = { ...session(), engine: ignored === 'config warmup' ? 'devin' as const : 'cursor' as const }
  const served = otherRuntimeRequests({ query: async () => ({}), recycle: vi.fn() })
  const transport = createRuntimeTransport({ call: async (_service, method, payload) =>
    await served.requests[method](payload, { owner: true, local: true }) as Record<string, unknown> })
  transport.connected('engine-others')
  const profiles = createRuntimeProfiles({ handles: () => true, resolve: () => row, transport })
  const changed = vi.fn(); profiles.onChanged = changed
  let release!: (text: string) => void
  try {
    profiles.hydrateEvidence(row, [{ model: 'current', effort: 'auto' }])
    const state = profiles.getState(row.sessionId)
    const capture = profiles.capturePane(row, () => new Promise(done => { release = done }))
    const changedByRead = ignored === 'picker' ? await profiles.ingestPane(row, 'Available models') : await profiles.ingestConfig(row)
    expect(changedByRead).toBe(false)
    expect(profiles.getState(row.sessionId)).toEqual(state)
    release('captured before the ignored read')
    expect(await capture).toBe('captured before the ignored read')
    expect(profiles.selectedModel(row)).toBe(encodeRuntimeProfile({ sessionId: row.agentId, engine: row.engine, model: 'current', effort: 'auto' }))
    expect(changed).not.toHaveBeenCalled()
  } finally { profiles.stop(); served.clear(); warning.mockRestore(); vi.unstubAllEnvs() }
})


it('keeps a captured pane queued behind an ignored read valid', async () => {
  const row = { ...session(), engine: 'cursor' as const }
  const served = otherRuntimeRequests({ query: async () => ({}), recycle: vi.fn() })
  let released!: () => void, entered!: () => void
  const held = new Promise<void>(done => { released = done })
  const ready = new Promise<void>(done => { entered = done })
  const transport = createRuntimeTransport({ call: async (_service, method, payload) => {
    const answer = await served.requests[method](payload, { owner: true, local: true }) as Record<string, unknown>
    if ((payload.operation as { kind?: string } | undefined)?.kind === 'config') { entered(); await held }
    return answer
  } })
  transport.connected('engine-others')
  const profiles = createRuntimeProfiles({ handles: () => true, resolve: () => row, transport })
  try {
    profiles.hydrateEvidence(row, [{ model: 'first', effort: 'auto' }])
    const ignored = profiles.ingestConfig(row)
    await ready
    const pane = profiles.capturePane(row, async () => 'Model 42 High · 1%')
    await Promise.resolve()
    released()
    expect(await ignored).toBe(false)
    expect(await pane).toBe('Model 42 High · 1%')
    expect(profiles.getState(row.sessionId)).toMatchObject({ model: 'model-42', effort: 'high' })
  } finally { released(); profiles.stop(); served.clear() }
})

it.each(['hold', 'revision', 'hold-cycle'] as const)('retains accepted profile display but fences old evidence across %s', async change => {
  const row = { ...session(), engine: 'cursor' as const }
  const served = otherRuntimeRequests({ query: async () => ({}), recycle: vi.fn() })
  let released!: () => void, entered!: () => void
  const held = new Promise<void>(done => { released = done }), ready = new Promise<void>(done => { entered = done })
  const transport = createRuntimeTransport({ call: async (_service, method, payload) => {
    const answer = await served.requests[method](payload, { owner: true, local: true }) as Record<string, unknown>
    if ((payload.operation as { kind?: string } | undefined)?.kind === 'config') { entered(); await held }
    return answer
  } })
  transport.connected('engine-others')
  const profiles = createRuntimeProfiles({ handles: () => true,
    resolve: id => [row.agentId, row.sessionId].includes(id) ? row : undefined, transport })
  try {
    await profiles.ingestPane(row, 'Model 7 High · 1%')
    profiles.evidence(row, [{ workspace: '/captured-workspace' }])
    const selected = profiles.selectedModel(row), state = profiles.getState(row.sessionId), old = structuredClone(row)
    const pending = profiles.ingestConfig(row).then(() => 'accepted', e => e.message)
    await ready
    const captured = profiles.capturePane(row, async () => 'Model 8 Low · 1%')
    await Promise.resolve()
    row.evidenceRevision = 1
    if (change !== 'revision') row.identityHold = 'Waiting for interpretation.'
    expect(profiles.selectedModel(row)).toBe(selected)
    expect(profiles.getState(row.sessionId)).toEqual(state)
    expect(profiles.workspace(row)).toBe('/captured-workspace')
    if (change === 'hold-cycle') {
      delete row.identityHold; row.evidenceRevision = 2
      expect(profiles.selectedModel(row)).toBe(selected)
    }
    expect(profiles.selectedModel(old)).toBeNull()
    expect(profiles.workspace(old)).toBeNull()
    released()
    expect(await pending).toBe('ENGINE_STALE_REPLY')
    expect(await captured).toBeNull()
    expect(profiles.getState(row.sessionId)).toEqual(state)
    await profiles.ingestPane(row, 'Model 9 Low · 1%')
    expect(profiles.getState(row.sessionId)).toMatchObject({ model: 'model-9', effort: 'low' })
    const oldSessionId = row.sessionId
    row.sessionId = 'replacement'; row.boundAt = 2
    expect(profiles.getState(oldSessionId).model).toBeNull()
    expect(profiles.getState(row.agentId).model).toBeNull()
    expect(profiles.selectedModel(row)).toBeNull()
    expect(profiles.workspace(row)).toBeNull()
  } finally { released(); profiles.stop(); served.clear() }
})


it('revokes a question grant if its worker asks for a different literal hint', async () => {
  const row = { ...session(), engine: 'cursor' as const }, key = vi.fn(async () => true)
  const controls = createQuestionControls({ handles: () => true, resolve: () => row, inline: () => { throw Error('inline') },
    key, text: async () => false, call: async (_service, method, payload) => {
      if (method.endsWith('capabilities')) return { version: 1, questionControl: 1, engine: 'cursor' }
      for (const key of ['y', 'n']) {
        expect(await controls.answer('engine-others', 'engine.questionControl', { version: 1, token: payload.token,
          action: { kind: 'key', key } })).toEqual({ version: 1, error: 'ANSWER_FAILED' })
      }
      return { version: 1, ok: true }
    } })
  controls.connected('engine-others')
  const port = controls.forSession(row)!
  expect(await port.apply({ kind: 'select', row: { number: 'n', label: 'No', checked: false } })).toBe(false)
  expect(port.failure?.()).toBe('refused')
  expect(key).not.toHaveBeenCalled()
})
