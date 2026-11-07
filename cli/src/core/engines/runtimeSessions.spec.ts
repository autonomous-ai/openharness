import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import type { RuntimeContext, RuntimeProfile } from '../../engines/facets/runtime.js'
import type { RuntimeAnswer, RuntimeOperation } from '../../engines/worker/runtimeProtocol.js'
import { blankRuntimeState, encodeRuntimeProfile } from '../../engines/kit/runtime.js'
import { createLiveSessions, type LiveSessions } from './liveSessions.js'
import { createRuntimeSessions, type RuntimeSessions } from './runtimeSessions.js'
import { EngineReadError } from '../../engines/worker/protocol.js'

const active: RuntimeSessions[] = [], liveActive: LiveSessions[] = []
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const session = (id = 'agent'): RegisteredSession => ({ agentId: id, sessionId: `${id}-conversation`, engine: 'claude',
  model: null, cliVersion: '2.1.209', cwd: '/tmp', transcriptPath: '/tmp/transcript', boundAt: 1 } as RegisteredSession)
const profile = (s: RegisteredSession, model = 'new', effort = 'high'): RuntimeProfile => {
  const value = { sessionId: s.agentId, engine: s.engine, model, effort }
  return { ...value, id: encodeRuntimeProfile(value) }
}
function result(context: RuntimeContext, operation: RuntimeOperation): RuntimeAnswer {
  const copy: RuntimeContext = structuredClone(context)
  if (operation.kind === 'records') for (const r of operation.records) {
    if (typeof r.model === 'string') copy.state.model = r.model
    if (typeof r.effort === 'string') copy.state.effort = r.effort
    if (typeof r.version === 'string') copy.session.cliVersion = copy.state.cliVersion = r.version
    if (copy.control) {
      copy.control.modelConfirmed ||= copy.state.model === copy.control.target.model
      copy.control.effortConfirmed ||= copy.state.effort === copy.control.target.effort
    }
  }
  if (operation.kind === 'pane') copy.state.model = operation.text
  if (operation.kind === 'config') copy.state.effort = 'auto'
  const selectedModel = copy.state.model && copy.state.effort ? encodeRuntimeProfile({ sessionId: copy.session.agentId,
    engine: copy.session.engine, model: copy.state.model, effort: copy.state.effort }) : null
  return { state: copy.state, cliVersion: copy.session.cliVersion, control: copy.control ?? null, selectedModel, supportsControl: true }
}
function setup() {
  const s = session(), bindings = new Map([[s.agentId, s]])
  const changed = vi.fn()
  const read = vi.fn(async (_engine: string, context: RuntimeContext, operation: RuntimeOperation) => result(context, operation))
  const sessions = createRuntimeSessions({ resolve: id => bindings.get(id) ?? [...bindings.values()].find(s => s.sessionId === id),
    transport: { read, connected: vi.fn(), disconnected: vi.fn() }, changed })
  active.push(sessions)
  const seed = () => sessions.read(s, { kind: 'records', records: [{ model: 'old', effort: 'low' }] })
  return { s, bindings, changed, read, sessions, seed }
}
afterEach(() => { active.splice(0).forEach(s => s.stop()); liveActive.splice(0).forEach(l => void l.stop()); vi.useRealTimers(); vi.restoreAllMocks() })

describe('core runtime profile authority', () => {
  it.each(['binding', 'route', 'control', 'version', 'forget', 'unchanged'] as const)(
    'keeps pane capture tied to the authority that dispatched it: %s', async change => {
      const t = setup(); await t.seed()
      t.s.runtimes = [{ backend: 'tmux', paneId: '%1' }]
      await t.seed()
      const captured = deferred<string | null>()
      const pending = t.sessions.capturePane(t.s, () => captured.promise)
      if (change === 'binding') t.s.boundAt = 2
      if (change === 'route') t.s.runtimes[0]!.paneId = '%2'
      if (change === 'control') { t.sessions.beginControl(t.s, profile(t.s)); t.sessions.cancelControl(t.s.agentId) }
      if (change === 'version') t.s.cliVersion = 'new-version'
      if (change === 'forget') t.sessions.forget(t.s.agentId)
      captured.resolve('captured-model')
      expect(await pending).toBe(change === 'unchanged' ? 'captured-model' : null)
      expect(t.sessions.getState(t.s.agentId).model === 'captured-model').toBe(change === 'unchanged')
    },
  )

  it('discards capture authority superseded while queued or while its worker replies', async () => {
    for (const during of ['queue', 'worker'] as const) {
      const t = setup(); await t.seed()
      const entered = deferred<void>(), release = deferred<void>()
      t.read.mockImplementationOnce(async (_e, c, o) => { entered.resolve(); await release.promise; return result(c, o) })
      const ahead = during === 'queue' ? t.sessions.read(t.s, { kind: 'config' }) : undefined
      const pending = t.sessions.capturePane(t.s, async () => 'captured-model', 60, true)
      await entered.promise
      if (during === 'worker') t.sessions.beginControl(t.s, profile(t.s))
      release.resolve()
      await ahead
      expect(await pending, during).toBeNull()
      expect(t.sessions.getState(t.s.agentId).model).toBe('old')
    }
  })

  it('preserves empty-capture and worker-unavailable outcomes', async () => {
    const t = setup(); await t.seed()
    expect(await t.sessions.capturePane(t.s, async () => null)).toBeNull()
    for (const error of [new Error('worker failed'), new EngineReadError('ENGINE_UNAVAILABLE')]) {
      t.read.mockRejectedValueOnce(error)
      await expect(t.sessions.capturePane(t.s, async () => 'pane')).rejects.toBe(error)
      expect(t.sessions.getState(t.s.agentId).model).toBe('old')
    }
  })

  it('stages bounded evidence and installs profile and live cursor together only once', async () => {
    const t = setup(); await t.seed()
    const staged = t.sessions.stage(t.s, true, true)
    const records = Array.from({ length: 1025 }, (_, i) => ({ model: String(i), effort: 'high' }))
    await staged.ingest(records)
    expect(t.read.mock.calls.slice(1).map(c => c[2].kind === 'records' ? c[2].records.length : 0)).toEqual([512, 512, 1])
    expect(t.sessions.getState(t.s.sessionId).model).toBe('old')
    await staged.config()
    expect(staged.commit(() => false)).toBe(false)
    const install = vi.fn(() => { expect(t.sessions.getState(t.s.sessionId).model).toBe('old'); return true })
    expect(staged.commit(install)).toBe(true)
    expect(staged.commit(install)).toBe(false)
    expect(install).toHaveBeenCalledOnce()
    expect(t.sessions.getState(t.s.sessionId)).toMatchObject({ model: '1024', effort: 'auto' })
    expect(t.sessions.selectedModel(t.s)).toBe(profile(t.s, '1024', 'auto').id)
  })

  it('splits byte-heavy evidence and rejects a record larger than the request allowance', async () => {
    const t = setup(), staged = t.sessions.stage(t.s, false, false)
    const large = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, 'x'.repeat(32_768)]))
    await staged.ingest([large, large, large])
    expect(t.read.mock.calls.map(c => c[2].kind === 'records' ? c[2].records.length : 0)).toEqual([1, 1, 1])
    await expect(staged.ingest([{ large: 'x'.repeat(1024 * 1024) }])).rejects.toThrow('ENGINE_REPLY_TOO_LARGE')
    const empty = t.sessions.stage(t.s, false, true)
    await empty.ingest([])
    expect(empty.commit()).toBe(true)
  })

  it.each(['binding', 'control', 'version', 'forget', 'stop'] as const)('rejects late worker evidence after %s changes', async change => {
    const t = setup(); await t.seed()
    const entered = deferred<void>(), response = deferred<RuntimeAnswer>()
    t.read.mockImplementationOnce(async (_e, context, operation) => {
      entered.resolve(); await response.promise; return result(context, operation)
    })
    const read = t.sessions.read(t.s, { kind: 'pane', text: 'late' })
    const rejected = expect(read).rejects.toThrow('ENGINE_STALE_REPLY')
    await entered.promise
    if (change === 'binding') t.bindings.set(t.s.agentId, { ...t.s, boundAt: 2 })
    if (change === 'control') t.sessions.beginControl(t.s, profile(t.s))
    if (change === 'version') t.bindings.set(t.s.agentId, { ...t.s, cliVersion: '2.1.210' })
    if (change === 'forget') t.sessions.forget(t.s.sessionId)
    if (change === 'stop') t.sessions.stop()
    response.resolve(result({ session: t.s, state: blankRuntimeState() }, { kind: 'describe' }))
    await rejected
    expect(t.sessions.getState(t.s.sessionId).model).not.toBe('late')
  })

  it('reads a models list again when an attach commits a newer profile of the same binding while it was read', async () => {
    // 2026-10-23, main e2e (enginehomes, Codex picker): models_list came in as the new agent's attach was finishing
    // its hydration. The commit advanced the profile while the worker answered, and the read was refused as stale.
    const t = setup(); t.s.cliVersion = null
    const hydration = t.sessions.stage(t.s, true, true)
    await hydration.ingest([{ model: 'm', effort: 'low', version: '0.130.0' }])
    const entered = deferred<void>(), response = deferred<void>()
    t.read.mockImplementationOnce(async (_e, context, operation) => { entered.resolve(); await response.promise; return result(context, operation) })
    const models = t.sessions.read(t.s, { kind: 'models' })
    await entered.promise
    expect(hydration.commit()).toBe(true)
    response.resolve()
    const answer = await models
    // Answered from the profile the attach committed, read once more.
    expect(answer.cliVersion).toBe('0.130.0')
    expect(answer.state.model).toBe('m')
    expect(t.read).toHaveBeenCalledTimes(3)
  })

  it.each(['control', 'version'] as const)('reads a query once more after %s changes mid-read, never twice', async change => {
    const t = setup(); await t.seed()
    const advance = () => change === 'control' ? t.sessions.cancelControl(t.s.agentId) : t.s.cliVersion = `${t.s.cliVersion}.1`
    if (change === 'control') t.sessions.beginControl(t.s, profile(t.s))
    t.read.mockImplementation(async (_e, context, operation) => { advance(); return result(context, operation) })
    await expect(t.sessions.read(t.s, { kind: 'catalog' })).rejects.toThrow('ENGINE_STALE_REPLY')
    expect(t.read).toHaveBeenCalledTimes(3)
  })

  it.each(['binding', 'forget', 'stop'] as const)('does not read a query again once its %s is gone', async change => {
    const t = setup(); await t.seed()
    t.read.mockImplementationOnce(async (_e, context, operation) => {
      if (change === 'binding') t.bindings.set(t.s.agentId, { ...t.s, boundAt: 2 })
      if (change === 'forget') t.sessions.forget(t.s.sessionId)
      if (change === 'stop') t.sessions.stop()
      return result(context, operation)
    })
    await expect(t.sessions.read(t.s, { kind: 'models' })).rejects.toThrow('ENGINE_STALE_REPLY')
    expect(t.read).toHaveBeenCalledTimes(2)
  })

  it('stages from the version the live row holds, and still refuses a different identity or a change mid-stage', async () => {
    // 2026-10-19: a hook attach copied the row before discovery's attach taught it the CLI version.
    const t = setup(); t.s.cliVersion = null
    const copy = { ...t.s }
    t.s.cliVersion = '2.1.303'
    const staged = t.sessions.stage(copy, false, true)
    await staged.ingest([{ model: 'm', effort: 'low' }])
    expect(t.read.mock.calls[0]![1].session.cliVersion).toBe('2.1.303')
    expect(staged.commit()).toBe(true)
    expect(t.s.cliVersion).toBe('2.1.303')
    const mid = t.sessions.stage({ ...copy }, false, true)
    t.s.cliVersion = '2.1.304'
    await expect(mid.ingest([{ model: 'n' }])).rejects.toThrow('ENGINE_STALE_REPLY')
    expect(() => t.sessions.stage({ ...copy, sessionId: 'other' }, false, true)).toThrow('ENGINE_STALE_REPLY')
    expect(() => t.sessions.stage({ ...copy, agentId: 'other' }, false, true)).toThrow('ENGINE_STALE_REPLY')
    expect(() => t.sessions.stage({ ...copy, boundAt: 2 }, false, true)).toThrow('ENGINE_STALE_REPLY')
  })

  it('accepts a copy holding an older non-null version', async () => {
    const t = setup(); t.s.cliVersion = '2.1.303'
    const staged = t.sessions.stage({ ...t.s, cliVersion: '2.1.300' }, false, true)
    await staged.ingest([{ model: 'm', effort: 'low' }])
    expect(t.read.mock.calls[0]![1].session.cliVersion).toBe('2.1.303')
    expect(staged.commit()).toBe(true)
  })

  describe('with live sessions retrying through them', () => {
    // The 2026-10-19 race: the hook attach copies the row, discovery's attach learns the version, the copy stages.
    const wire = () => {
      const t = setup(); t.s.cliVersion = null
      const attempts: RegisteredSession[] = []
      const commits: boolean[] = []
      const live = createLiveSessions({ handles: () => true, bySession: id => [...t.bindings.values()].find(b => b.sessionId === id),
        transport: { pull: vi.fn(), forget: vi.fn(async () => {}), close: vi.fn(), connected: vi.fn(), disconnected: vi.fn() },
        frame: vi.fn(), watch: vi.fn(), unwatch: vi.fn(), log: vi.fn(),
        reattach: async copy => {
          attempts.push(copy)
          const staged = t.sessions.stage(copy, false, true)
          await staged.ingest([{ model: 'm', effort: 'low' }])
          commits.push(staged.commit())
        } })
      liveActive.push(live)
      return { ...t, live, attempts, commits }
    }
    it('(a) a copy taken before the version is learned stages on the first try', async () => {
      vi.useFakeTimers()
      const t = wire(), copy = { ...t.s }
      t.s.cliVersion = '2.1.303'
      await t.sessions.stage(copy, false, true).ingest([{ model: 'm' }])
      expect(t.attempts).toHaveLength(0)
    })
    it('(b) a stage that throws mid-way is retried once with the live row, then commits', async () => {
      vi.useFakeTimers()
      const t = wire(), copy = { ...t.s }
      const mid = t.sessions.stage(copy, false, true)
      t.s.cliVersion = '2.1.303'
      await expect(mid.ingest([{ model: 'n' }])).rejects.toThrow('ENGINE_STALE_REPLY')
      t.live.retry(copy)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(t.attempts).toHaveLength(1)
      expect(t.attempts[0]!.cliVersion).toBe('2.1.303')
      expect(t.commits).toEqual([true])
      await vi.advanceTimersByTimeAsync(5_000)
      expect(t.attempts).toHaveLength(1)
    })
  })

  it('does not let an old binding evict a newer view and fences staged configuration', async () => {
    const t = setup(); await t.seed()
    const newer = { ...t.s, sessionId: 'new-conversation', boundAt: 2 }
    t.bindings.set(t.s.agentId, newer)
    await t.sessions.read(newer, { kind: 'records', records: [{ model: 'newer', effort: 'high' }] })
    expect(() => t.sessions.stage(t.s, false, false)).toThrow('ENGINE_STALE_REPLY')
    expect(t.sessions.selectedModel(t.s)).toBeNull()
    expect(t.sessions.getState(newer.sessionId).model).toBe('newer')
    const stage = t.sessions.stage(newer, false, true), entered = deferred<void>(), resume = deferred<void>()
    t.read.mockImplementationOnce(async (_e, c, o) => { entered.resolve(); await resume.promise; return result(c, o) })
    const config = stage.config(), rejected = expect(config).rejects.toThrow('ENGINE_STALE_REPLY')
    await entered.promise
    t.sessions.beginControl(newer, profile(newer))
    resume.resolve(); await rejected
    expect(stage.commit()).toBe(false)
    await expect(stage.ingest([{ model: 'late' }])).rejects.toThrow('ENGINE_STALE_REPLY')
  })

  it('serializes worker observations and uses the accepted state for each next request', async () => {
    const t = setup(), entered = deferred<void>(), resume = deferred<void>()
    t.read.mockImplementationOnce(async (_e, c, o) => { entered.resolve(); await resume.promise; return result(c, o) })
    const one = t.seed(); await entered.promise
    const two = t.sessions.read(t.s, { kind: 'pane', text: 'two' })
    expect(t.read).toHaveBeenCalledOnce()
    resume.resolve(); await Promise.all([one, two])
    expect(t.read.mock.calls[1][1].state).toMatchObject({ model: 'old', effort: 'low' })
    expect(t.sessions.getState(t.s.agentId).model).toBe('two')
    const state = t.sessions.getState(t.s.agentId); state.model = 'caller mutation'
    expect(t.sessions.getState(t.s.agentId).model).toBe('two')
    const before = t.sessions.getState(t.s.agentId)
    await t.sessions.read(t.s, { kind: 'describe' })
    expect(t.sessions.getState(t.s.agentId)).toEqual(before)
  })

  it('bounds queued work and rejects queued calls for a forgotten session', async () => {
    const t = setup(), entered = deferred<void>(), resume = deferred<void>()
    t.read.mockImplementationOnce(async (_e, c, o) => { entered.resolve(); await resume.promise; return result(c, o) })
    const jobs = Array.from({ length: 256 }, () => t.sessions.read(t.s, { kind: 'describe' }).catch(e => e.message))
    await entered.promise
    await expect(t.sessions.read(t.s, { kind: 'describe' })).rejects.toThrow('ENGINE_BUSY')
    t.sessions.forget(t.s.agentId); resume.resolve()
    expect(new Set(await Promise.all(jobs))).toEqual(new Set(['ENGINE_STALE_REPLY']))
    expect(t.read).toHaveBeenCalledOnce()
  })

  it('expires queued work instead of waiting through an entire saturated engine backlog', async () => {
    const t = setup(), entered = deferred<void>(), resume = deferred<void>()
    let time = 0; vi.spyOn(performance, 'now').mockImplementation(() => time)
    t.read.mockImplementationOnce(async (_e, c, o) => { entered.resolve(); await resume.promise; return result(c, o) })
    const first = t.seed(); await entered.promise
    const second = t.sessions.read(t.s, { kind: 'config' }), expired = expect(second).rejects.toThrow('ENGINE_BUSY')
    time = 5000; resume.resolve(); await first; await expired
    expect(t.read).toHaveBeenCalledOnce()
    expect(t.sessions.getState(t.s.sessionId).model).toBe('old')
  })

  it('never commits a partially reduced page after a later worker failure', async () => {
    const t = setup(); await t.seed()
    const stage = t.sessions.stage(t.s, false, false)
    await stage.ingest([{ model: 'partial' }])
    t.read.mockRejectedValueOnce(new Error('ENGINE_UNAVAILABLE'))
    await expect(stage.config()).rejects.toThrow('ENGINE_UNAVAILABLE')
    expect(stage.commit()).toBe(false)
    expect(t.sessions.getState(t.s.sessionId).model).toBe('old')
  })

  it('answers queue expiry while the active request is pending without releasing its successor early', async () => {
    vi.useFakeTimers()
    const t = setup(), firstEntered = deferred<void>(), secondEntered = deferred<void>()
    const firstResume = deferred<void>(), secondResume = deferred<void>()
    t.read.mockImplementationOnce(async (_e, c, o) => { firstEntered.resolve(); await firstResume.promise; return result(c, o) })
    t.read.mockImplementationOnce(async (_e, c, o) => { secondEntered.resolve(); await secondResume.promise; return result(c, o) })
    const first = t.sessions.read(t.s, { kind: 'describe' }); await firstEntered.promise
    await vi.advanceTimersByTimeAsync(1000)
    const second = t.sessions.read(t.s, { kind: 'describe' })
    await vi.advanceTimersByTimeAsync(1000)
    const expired = t.sessions.read(t.s, { kind: 'describe' }).catch(e => e.message)
    await vi.advanceTimersByTimeAsync(2900)
    firstResume.resolve(); await first; await secondEntered.promise
    await vi.advanceTimersByTimeAsync(2100)
    await expect(expired).resolves.toBe('ENGINE_BUSY')
    const next = t.sessions.read(t.s, { kind: 'describe' })
    await vi.advanceTimersByTimeAsync(0)
    expect(t.read).toHaveBeenCalledTimes(2)
    secondResume.resolve(); await second; await next
    expect(t.read).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('copies control snapshots and invalidates hydration when core confirms a newer profile', async () => {
    const t = setup(), target = profile(t.s)
    t.sessions.beginControl(t.s, target)
    const stage = t.sessions.stage(t.s, true, true)
    target.model = 'mutated by caller'
    await stage.ingest([{ model: 'new', effort: 'high' }])
    expect(t.read.mock.calls[0][1].control!.target.model).toBe('new')
    t.sessions.confirmEffort(t.s.sessionId, 'low')
    expect(stage.commit()).toBe(false)
    t.sessions.confirmControlProfile(profile(t.s, 'different'))
    expect(t.sessions.getState(t.s.agentId).model).toBe('different')
  })

  // A confirmed switch is the session's effort, even one equal to what the settings filled (#1966 delta review).
  it.each(['effort', 'profile'] as const)('a confirmed %s is no longer the settings\' effort', async confirmed => {
    const t = setup()
    t.read.mockImplementationOnce(async (_engine, context) => ({ ...result(context, { kind: 'config' }),
      state: { ...context.state, effort: 'high', settingsEffort: 'high' } }))
    await t.sessions.read(t.s, { kind: 'config' })
    expect(t.sessions.getState(t.s.agentId).settingsEffort).toBe('high')
    if (confirmed === 'effort') t.sessions.confirmEffort(t.s.sessionId, 'high')
    else t.sessions.confirmControlProfile(profile(t.s, 'new', 'high'))
    expect(t.sessions.getState(t.s.agentId).effort).toBe('high')
    expect(t.sessions.getState(t.s.agentId)).not.toHaveProperty('settingsEffort')
  })

  it('commits prepared live evidence only while its binding and control revision remain current', async () => {
    const t = setup(); await t.seed()
    const commit = await t.sessions.prepare(t.s, [{ model: 'new', effort: 'high', version: '2.1.210' }])
    expect(t.s.cliVersion).toBe('2.1.209')
    expect(commit()).toBe(true)
    expect(t.s.cliVersion).toBe('2.1.210')
    const stale = await t.sessions.prepare(t.s, [{ model: 'stale' }])
    t.sessions.cancelControl(t.s.agentId)
    expect(stale()).toBe(false)
    expect(t.sessions.getState(t.s.agentId).model).toBe('new')
  })

  it('keeps control confirmations, waiters, cancellation and debounced notifications in core', async () => {
    vi.useFakeTimers()
    const t = setup(); await t.seed(); await vi.advanceTimersByTimeAsync(120); t.changed.mockClear()
    const target = profile(t.s)
    expect(t.sessions.beginControl(t.s, target)).toBe(true)
    expect(t.sessions.beginControl(t.s, target)).toBe(false)
    const model = t.sessions.waitForModel(t.s.agentId, 500), full = t.sessions.waitForProfile(t.s.sessionId, 500)
    await t.sessions.read(t.s, { kind: 'records', records: [{ model: 'new' }] })
    await expect(model).resolves.toBe(true)
    t.sessions.confirmEffort(t.s.agentId, 'invalid')
    expect(t.sessions.getState(t.s.agentId).effort).toBe('low')
    t.sessions.confirmEffort(t.s.sessionId, 'high')
    await expect(full).resolves.toBe(true)
    await expect(t.sessions.waitForProfile(t.s.agentId, 100)).resolves.toBe(true)
    await vi.advanceTimersByTimeAsync(120); expect(t.changed).not.toHaveBeenCalled()
    t.sessions.finishControl(t.s); await vi.advanceTimersByTimeAsync(120)
    expect(t.changed).toHaveBeenCalledOnce()
    expect(t.sessions.selectedModel(t.s)).toBe(target.id)
    expect(t.sessions.beginControl(t.s, target)).toBe(true)
    await expect(t.sessions.waitForModel(t.s.sessionId, 100)).resolves.toBe(true)
    t.sessions.cancelControl(t.s.sessionId); t.sessions.cancelControl(t.s.sessionId)
    await vi.advanceTimersByTimeAsync(120); expect(t.changed).toHaveBeenCalledTimes(2)
  })

  it('does not finish a replacement binding’s model transaction with an old session snapshot', async () => {
    const t = setup(); await t.seed()
    const previous = structuredClone(t.s)
    expect(t.sessions.beginControl(previous, profile(previous))).toBe(true)
    t.s.boundAt = 2
    await t.seed()
    expect(t.sessions.beginControl(t.s, profile(t.s))).toBe(true)
    t.sessions.finishControl(previous)
    expect(t.sessions.beginControl(t.s, profile(t.s))).toBe(false)
    t.sessions.finishControl(t.s)
    expect(t.sessions.beginControl(t.s, profile(t.s))).toBe(true)
  })

  it('confirms public-id and legacy-id targets and cleans up waiters on timeout, forget and shutdown', async () => {
    vi.useFakeTimers()
    const t = setup(); await t.seed()
    const target = profile(t.s), legacy = { ...target, sessionId: t.s.sessionId }
    legacy.id = encodeRuntimeProfile(legacy)
    expect(t.sessions.beginControl(t.s, legacy)).toBe(true)
    const waiting = t.sessions.waitForProfile(t.s.sessionId, 100)
    t.sessions.confirmControlProfile(legacy); await expect(waiting).resolves.toBe(true)
    expect(t.sessions.selectedModel(t.s)).toBe(target.id)
    t.sessions.cancelControl(t.s.sessionId)
    const expired = t.sessions.waitForModel(t.s.agentId, 10)
    await vi.advanceTimersByTimeAsync(10); await expect(expired).resolves.toBe(false)
    const forgotten = t.sessions.waitForModel(t.s.agentId, 100)
    t.sessions.forget(t.s.agentId); await expect(forgotten).resolves.toBe(false)
    const unknown = t.sessions.waitForProfile('unknown', 100)
    t.sessions.stop(); await expect(unknown).resolves.toBe(false)
    await expect(t.sessions.waitForProfile('', 100)).resolves.toBe(false)
    await expect(t.sessions.waitForProfile('unknown', 100)).resolves.toBe(false)
    t.sessions.cancelControl('unknown'); t.sessions.finishControl(t.s)
    t.sessions.confirmEffort('unknown', 'high'); t.sessions.confirmControlProfile(target)
    t.sessions.forget('unknown'); t.sessions.forget('')
  })

  it('suppresses reconciliation changes and cancels stale notifications', async () => {
    vi.useFakeTimers()
    const t = setup()
    await t.sessions.withoutChangeEvents(() => t.sessions.withoutChangeEvents(t.seed))
    await vi.advanceTimersByTimeAsync(120); expect(t.changed).not.toHaveBeenCalled()
    await expect(t.sessions.withoutChangeEvents(async () => { throw new Error('failed') })).rejects.toThrow('failed')
    await t.sessions.read(t.s, { kind: 'pane', text: 'a' }, true)
    await vi.advanceTimersByTimeAsync(120); expect(t.changed).not.toHaveBeenCalled()
    await t.sessions.read(t.s, { kind: 'pane', text: 'b' })
    await t.sessions.read(t.s, { kind: 'pane', text: 'c' })
    await vi.advanceTimersByTimeAsync(120); expect(t.changed).toHaveBeenCalledOnce()
    await t.sessions.read(t.s, { kind: 'pane', text: 'd' })
    t.bindings.clear(); await vi.advanceTimersByTimeAsync(120)
    expect(t.changed).toHaveBeenCalledOnce()
  })

  it('allows unbound catalog reads without caching a conversation or crossing agent state', async () => {
    const t = setup(); t.s.sessionId = ''
    const other = { ...session('other'), sessionId: '' }; t.bindings.set(other.agentId, other)
    await t.seed()
    expect(t.sessions.getState(t.s.agentId)).toEqual(blankRuntimeState())
    expect(t.sessions.selectedModel(t.s)).toBeNull()
    expect(t.sessions.getState(other.agentId)).toEqual(blankRuntimeState())
    expect(t.sessions.beginControl(t.s, profile(t.s))).toBe(false)
    t.sessions.confirmEffort(t.s.agentId, 'high')
    t.sessions.finishControl(t.s)
    expect(t.changed).not.toHaveBeenCalled()
    expect(t.sessions.getState('')).toEqual(blankRuntimeState())
  })

  it('seeds hydration from registry facts, handles confirmation without a control, and times out waiters independently', async () => {
    vi.useFakeTimers()
    const t = setup(); t.s.model = 'registry-model'
    const staged = t.sessions.stage(t.s, true, true)
    await staged.config(); expect(staged.commit()).toBe(true)
    expect(t.sessions.getState(t.s.sessionId).model).toBe('registry-model')
    t.sessions.confirmEffort(t.s.sessionId, 'medium')
    expect(t.sessions.selectedModel(t.s)).toBe(profile(t.s, 'registry-model', 'medium').id)
    const early = t.sessions.waitForModel(t.s.sessionId, 10), later = t.sessions.waitForProfile(t.s.sessionId, 20)
    await vi.advanceTimersByTimeAsync(10); await expect(early).resolves.toBe(false)
    await vi.advanceTimersByTimeAsync(10); await expect(later).resolves.toBe(false)
  })
})
