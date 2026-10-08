import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeContext } from '../../engines/facets/runtime.js'
import { blankRuntimeState, encodeRuntimeProfile } from '../../engines/kit/runtime.js'
import type { LiveFrame } from '../../engines/worker/liveProtocol.js'
import type { RuntimeAnswer, RuntimeOperation } from '../../engines/worker/runtimeProtocol.js'
import { RuntimeProfileManager } from '../../lib/runtimeProfile.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createRuntimeProfiles, type RuntimeProfiles } from './runtimeProfiles.js'

const active: RuntimeProfiles[] = []
const frame = (runtime: LiveFrame['runtime']): LiveFrame => ({ raw: 'opaque vendor record', runtime, profile: true,
  observe: false, events: [], replay: false, turn: { turnOpen: false, identity: 'turn', continued: false } })
function setup(isolated = true) {
  const session = { agentId: 'agent', sessionId: 'session', engine: 'codex', model: null, cliVersion: '0.144.0',
    cwd: '/tmp', transcriptPath: '/tmp/transcript' } as RegisteredSession
  const target = { sessionId: session.agentId, engine: session.engine, model: 'reported-model', effort: 'high' }
  const id = encodeRuntimeProfile(target)
  const legacy = new RuntimeProfileManager()
  const read = vi.fn(async (_engine: string, context: RuntimeContext, operation: RuntimeOperation): Promise<RuntimeAnswer> => {
    const state = { ...context.state, model: target.model, effort: target.effort }
    return { state, cliVersion: session.cliVersion, selectedModel: id, control: context.control ?? null,
      supportsControl: true, ...(operation.kind === 'models' ? { models: [{ id, displayName: 'Worker choice' }] } : {}),
      ...(operation.kind === 'catalog' ? { catalog: [{ slug: target.model, displayName: 'Worker choice', listed: true, defaultEffort: 'high', efforts: ['high'] }] } : {}),
      ...(operation.kind === 'effort' ? { effortAllowed: operation.effort === 'high' } : {}) }
  })
  const profiles = createRuntimeProfiles({ legacy, handles: engine => isolated && engine === 'codex',
    resolve: value => [session.agentId, session.sessionId].includes(value) ? session : undefined,
    transport: { read, connected: vi.fn(), disconnected: vi.fn() } })
  active.push(profiles)
  return { session, target: { ...target, id }, legacy, read, profiles }
}
afterEach(() => { active.splice(0).forEach(p => p.stop()); vi.useRealTimers(); vi.restoreAllMocks() })

describe('runtime profile routing', () => {
  it('uses only worker reports for isolated observations, catalog and eligibility', async () => {
    const t = setup(), { profiles: p, session: s } = t
    const inline = vi.spyOn(t.legacy, 'ingestPane').mockImplementation(() => { throw new Error('inline reader called') })
    expect(p.selectedModel(s)).toBeNull()
    expect(await p.ingestPane(s, 'vendor UI')).toBe(true)
    expect(p.selectedModel(s)).toBe(t.target.id)
    expect(await p.ingestConfig(s, true)).toBe(false)
    expect(await p.supportsControl(s)).toBe(true)
    expect(await p.effortAllowed(s, t.target.model, 'high', ['high'])).toBe(true)
    expect(await p.effortAllowed(s, t.target.model, 'low', null)).toBe(false)
    expect(await p.codexCatalog(s)).toMatchObject([{ slug: t.target.model }])
    expect(await p.modelsForSessions([s])).toEqual([{ id: t.target.id, displayName: 'Worker choice' }])
    expect(inline).not.toHaveBeenCalled()
    expect(() => p.ingest(s, '{}')).toThrow('ENGINE_INVALID_REQUEST')
    expect(() => p.hydrate(s, [])).toThrow('ENGINE_INVALID_REQUEST')
    expect(() => p.transcriptFields(s, '{}')).toThrow('ENGINE_INVALID_REQUEST')
    t.read.mockRejectedValueOnce(new Error('ENGINE_UNAVAILABLE'))
    await expect(p.ingestConfig(s)).rejects.toThrow('ENGINE_UNAVAILABLE')
    expect(p.selectedModel(s)).toBe(t.target.id)
  })

  it('keeps gateway sessions display-only without asking the worker for picker permissions', async () => {
    const t = setup(); t.session.gateway = {} as RegisteredSession['gateway']
    expect(await t.profiles.modelsForSession(t.session)).toEqual([])
    expect(await t.profiles.supportsControl(t.session)).toBe(false)
    expect(t.read).not.toHaveBeenCalled()
  })

  it('stages compact evidence atomically and rejects frames from unsupported workers', async () => {
    const t = setup(), { profiles: p, session: s } = t
    const stage = p.beginHydrate(s)
    expect(() => stage.ingest('raw')).toThrow('ENGINE_INVALID_REQUEST')
    expect(() => stage.commit()).toThrow('ENGINE_INVALID_REQUEST')
    await stage.ingestFrames!([frame(null), frame({ model: 'opaque' })])
    await stage.config!()
    expect(p.selectedModel(s)).toBeNull()
    expect(stage.commitWith!(() => false)).toBe(false)
    expect(stage.commitWith!(() => true)).toBe(true)
    expect(p.selectedModel(s)).toBe(t.target.id)
    await expect(p.prepareFrames(s, [frame(undefined)])).rejects.toThrow('ENGINE_INVALID_REPLY')
    const commit = await p.prepareFrames(s, [frame(null), frame({ effort: 'high' })])
    expect(commit()).toBe(true)
    expect(t.read.mock.calls.map(c => c[2].kind)).toEqual(['records', 'config', 'records'])
  })

  it('routes generic control authority, accepted state, notifications and cleanup through core', async () => {
    vi.useFakeTimers()
    const t = setup(), { profiles: p, session: s, target } = t
    const changed = vi.fn(); p.onChanged = changed; expect(p.onChanged).toBe(changed)
    await p.withoutChangeEvents(async () => { await p.ingestPane(s, 'pane') })
    await vi.advanceTimersByTimeAsync(120); expect(changed).not.toHaveBeenCalled()
    expect(p.beginControl(s, target)).toBe(true)
    await expect(p.waitForModel(s.sessionId, 100)).resolves.toBe(true)
    await expect(p.waitForProfile(s.sessionId, 100)).resolves.toBe(true)
    p.confirmEffort(s.sessionId, 'high'); p.confirmControlProfile(target)
    p.finishControl(s); await vi.advanceTimersByTimeAsync(120)
    expect(changed).toHaveBeenCalledWith(s.sessionId)
    p.cancelControl(s.sessionId)
    p.forget(s.sessionId); expect(p.getState(s.sessionId)).toEqual(blankRuntimeState())
    t.legacy.onChanged?.('legacy-session'); expect(changed).toHaveBeenLastCalledWith('legacy-session')
    p.stop(); t.legacy.onChanged?.('later'); expect(changed).toHaveBeenLastCalledWith('legacy-session')
  })

  it('preserves explicit inline compatibility and the unchanged other-engine methods', async () => {
    const t = setup(false), { profiles: p, session: s, legacy } = t
    const pane = vi.spyOn(legacy, 'ingestPane').mockReturnValue(true)
    const config = vi.spyOn(legacy, 'ingestConfig').mockResolvedValue(true)
    const raw = vi.spyOn(legacy, 'ingest').mockReturnValue(false)
    const hydrate = vi.spyOn(legacy, 'hydrate').mockImplementation(() => {})
    const fields = vi.spyOn(legacy, 'transcriptFields').mockReturnValue(['model'])
    const stage = { ingest: vi.fn(), commit: vi.fn() }
    vi.spyOn(legacy, 'beginHydrate').mockReturnValue(stage)
    vi.spyOn(legacy, 'supportsControl').mockReturnValue(true)
    vi.spyOn(legacy, 'effortAllowed').mockReturnValue(true)
    vi.spyOn(legacy, 'codexCatalog').mockResolvedValue([])
    vi.spyOn(legacy, 'modelsForSession').mockResolvedValue([])
    expect(p.ingestPane(s, 'pane')).toBe(true); expect(pane).toHaveBeenCalledWith(s, 'pane', false)
    expect(await p.ingestConfig(s)).toBe(true); expect(config).toHaveBeenCalledWith(s, false)
    expect(p.ingest(s, '{}')).toBe(false); expect(raw).toHaveBeenCalledWith(s, '{}', false)
    p.hydrate(s, []); expect(hydrate).toHaveBeenCalledWith(s, [])
    expect(p.transcriptFields(s, '{}')).toEqual(['model']); expect(fields).toHaveBeenCalled()
    expect(p.beginHydrate(s)).toBe(stage)
    expect(await p.supportsControl(s)).toBe(true)
    expect(await p.effortAllowed(s, 'model', 'high', null)).toBe(true)
    expect(await p.codexCatalog(s)).toEqual([])
    expect(await p.modelsForSession(s)).toEqual([])
    expect((await p.prepareFrames(s, [frame(undefined)]))()).toBe(true)
    expect(p.getState('missing')).toEqual(blankRuntimeState())
    expect(p.selectedModel(s)).toBeNull()
    expect(p.cursorTarget('missing', 'id')).toBeNull()
    expect(p.devinTarget('missing', 'id')).toBeNull()
    expect(p.commandcodeTarget('missing', 'id')).toBeNull()
    expect(p.hermesTarget('missing', 'id')).toBeNull()
    expect(t.read).not.toHaveBeenCalled()
  })
})
