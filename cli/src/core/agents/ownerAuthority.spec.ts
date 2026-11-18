import { type SessionOwnerPort as CloudPort } from '../../lib/sessionOwnerWire.js'
/** Native claims fence service operations even when the claim retires between two service reads. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RegisteredSession, registry as Registry } from '../../lib/registry.js'
import type { SessionStorage } from '../../lib/sessionStorage.js'
import type { ReadRecord, SessionReadHeader, SessionReadValue } from '../api.js'
import type { QuestionWatcherDeps } from '../../lib/questionController.js'
import { closeSessionStorageFixture } from '../../testing/sessionStorageFixture.js'

const fault = vi.hoisted(() => ({ afterSync: false }))
vi.mock('../../lib/bootId.js', async original => ({ ...await original<object>(),
  currentBootId: () => 'owner-authority-fixture', bootChanged: () => false,
}))
vi.mock('../../lib/sessionPublication.js', async original => {
  const actual = await original<typeof import('../../lib/sessionPublication.js')>()
  return { ...actual, prepareSessionPublication: async (...args: Parameters<typeof actual.prepareSessionPublication>) => {
    const prepared = await actual.prepareSessionPublication(...args), sync = prepared.sync
    prepared.sync = async () => {
      await sync()
      if (args[1].kind === 'registry' && fault.afterSync) {
        fault.afterSync = false
        // The real file was renamed and synced, but admission did not run. Recovery must use disk.
        throw new Error('fixture publication acknowledgement lost')
      }
    }
    return prepared
  } }
})

const OWNER = 'cloud_owner', REQUEST = 'cloud_q_owner'
let root: string, registry: typeof Registry, storage: SessionStorage
const registries = new Set<typeof Registry>(), pending: Promise<unknown>[] = [], releases: Array<() => void> = []
const track = <T>(value: Promise<T>): Promise<T> => { pending.push(value); void value.catch(() => {}); return value }
function gate<T>(cleanup: T) {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  releases.push(() => resolve(cleanup))
  return { promise, resolve }
}

beforeEach(async () => {
  vi.resetModules(); fault.afterSync = false; pending.length = 0; releases.length = 0
  root = mkdtempSync(join(tmpdir(), 'core-owner-authority-'))
  for (const name of ['home', 'data', 'runtime', 'codex', 'tmux']) mkdirSync(join(root, name), { mode: 0o700 })
  const projects = join(root, 'home', '.claude', 'projects')
  mkdirSync(join(projects, 'fixture'), { recursive: true, mode: 0o700 })
  for (const [key, value] of Object.entries({ HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    ADAPTER_DATA_DIR: join(root, 'data'), ADAPTER_RUNTIME_DIR: join(root, 'runtime'), CODEX_HOME: join(root, 'codex'),
    CLAUDE_CONFIG_DIR: join(root, 'home', '.claude'), CLAUDE_PROJECTS_DIR: projects,
    TMUX: '', TMUX_PANE: '', TMUX_TMPDIR: join(root, 'tmux'),
  })) vi.stubEnv(key, value)
  writeFileSync(join(root, 'data', 'engine-homes.json'), '{}', { mode: 0o600 })
  storage = (await import('../../lib/sessionStorage.js')).sessionStorage
  registry = (await import('../../lib/registry.js')).registry
  registries.add(registry)
  await registry.load()
})

afterEach(async () => {
  fault.afterSync = false
  for (const release of releases) release()
  await Promise.allSettled(pending)
  await Promise.allSettled([...registries].map(current => current.flush({ exiting: true })))
  registries.clear()
  let closed = false
  try { await closeSessionStorageFixture(storage); closed = true }
  finally {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules()
    if (closed) rmSync(root, { recursive: true, force: true })
  }
})

const nativeClaim = (target = registry, id = OWNER, pane = '%7') => target.openPendingAgent({
  agentId: id, engine: 'claude', runtimes: [{ backend: 'tmux', paneId: pane }], cwd: root,
})
async function nativeRetire(id = OWNER) {
  expect(await registry.confirmEngineExit(id, 'remove')).toMatchObject({ state: 'confirmed', entry: null })
  expect(registry.resolve(id)).toBeUndefined()
}
async function bind(target: typeof Registry, sessionId: string, pane = '%7') {
  const transcriptPath = join(root, 'home', '.claude', 'projects', 'fixture', `${sessionId}.jsonl`)
  writeFileSync(transcriptPath, JSON.stringify({ type: 'user', sessionId, cwd: root,
    message: { role: 'user', content: 'fixture' } }) + '\n', { mode: 0o600 })
  const result = await target.register({ engine: 'claude', sessionId, transcriptPath, tmuxPane: pane, cwd: root })
  expect(result?.entry.sessionId).toBe(sessionId)
  return result!
}
async function peer() {
  const current = new (registry.constructor as new () => typeof registry)()
  registries.add(current); await current.load()
  return current
}

async function fixture(startHeld = false) {
  const [{ createCloudOwners }, { createQuestions, createQuestionResponse }, { cloudFactory, deviceFactory },
    { prepareCloudQuestion, cloudQuestionClose }, { cloudAgentFrame }] = await Promise.all([
    import('../../testing/cloudOwners.js'), import('../questions.js'), import('../../testing/sessionFactories.js'),
    import('../../cloud/questions.js'), import('../../lib/cloudAgents.js'),
  ])
  const clients = { send: vi.fn(), sendCommander: vi.fn(), sendLocal: vi.fn(), sendRemote: vi.fn() }
  const log = vi.fn()
  const asking = createQuestions({
    resolve: id => registry.resolve(id), questionControlFor: () => undefined, readQuestion: async () => null,
    terminal: { captureTerminal: async () => '', submitTerminal: async () => false, keyTerminal: async () => false },
    acquireTerminalControl: () => null, clients, agentIdFor: id => registry.resolve(id)?.agentId ?? id,
    sessionTurnOpen: () => false, observed: () => false, input: { setUserAction: vi.fn() }, waitOver: vi.fn(),
  })
  const row = { agentId: OWNER, agent: 'fo' as const, name: 'Service owner', state: 'idle' as const, activity: null,
    repository: null, branch: null, links: [], messages: 0,
    createdAt: '2026-11-19T00:00:00.000Z', updatedAt: '2026-11-19T00:00:00.000Z' }
  const answer = vi.fn<CloudPort['answer']>(async () => ({ ok: true }))
  const port: CloudPort = {
    answer, create: async () => ({ agent: cloudAgentFrame(row) }), deliver: vi.fn<CloudPort['deliver']>(async () => ({ ok: true })),
    rename: vi.fn<CloudPort['rename']>(async (_id, name) => ({ agent: cloudAgentFrame({ ...row, name }),
      renamed: { type: 'agent_renamed', payload: { agentId: OWNER, name, engine: row.agent } } })),
    stopHarness: vi.fn<CloudPort['stopHarness']>(async () => ({ deleted: true })),
  }
  let selected: CloudPort | null = port
  const start = gate(false), entered = gate(undefined)
  const cloud = createCloudOwners({ ownsFactory: cloudFactory, native: id => registry.resolve(id) !== undefined, port: () => selected, clients,
    questions: asking.presentations, log,
    whenStarting: () => { if (!startHeld) return null; entered.resolve(undefined); return start.promise },
  })
  registry.onEnter = (_engine, owner) => cloud.nativeEntered(owner.agentId, owner.sessionId)
  const question = prepareCloudQuestion(OWNER, REQUEST, { text: 'Continue?', choices: ['Yes'] })
  const publish = () => cloud.doors.publish([row])
  const install = () => { expect(publish()).toEqual({ ok: true }); expect(cloud.doors.ask(OWNER, REQUEST, question)).toEqual({ ok: true }) }
  // Exact main.ts request adapter. The existing native controller remains the fallback, not a fake resolver.
  const response = createQuestionResponse(payload => cloud.answer(payload) ?? asking.answer(payload))
  const ask = () => track(new Promise<Record<string, unknown>>(resolve => response({
    agentId: OWNER, requestId: REQUEST, answers: { answer: 'Yes' },
  }, resolve)))
  const close = () => cloud.doors.unask(OWNER, REQUEST, cloudQuestionClose(OWNER, REQUEST))
  return { cloud, asking, clients, row, port, answer, start, entered, question, publish, install, ask, close, deviceFactory, log,
    disconnect: () => { selected = null },
  }
}

describe('native and service ownership through actual callers', () => {
  it.each(['unchanged', 'identical replay', 'close before reply'] as const)('keeps an ordinary service answer for %s', async mode => {
    const t = await fixture(true); t.install()
    const result = t.ask(); await t.entered.promise
    if (mode === 'identical replay') { t.publish(); t.cloud.doors.ask(OWNER, REQUEST, t.question) }
    if (mode === 'close before reply') t.answer.mockImplementation(async () => { t.close(); return { ok: true } })
    t.start.resolve(true)
    expect(await result).toEqual({ ok: true }); expect(t.answer).toHaveBeenCalledOnce()
  })

  it.each(['no replay', 'identical replay'] as const)('revokes a pending answer across native claim and retirement with %s', async replay => {
    const t = await fixture(true); t.install()
    const result = t.ask(); await t.entered.promise
    expect(await nativeClaim()).not.toBeNull()
    await nativeRetire()
    // No service read between native admission and retirement; checking absence here cannot recover the history.
    if (replay === 'identical replay') t.publish()
    t.start.resolve(true)
    expect(await result).toHaveProperty('error'); expect(t.answer).not.toHaveBeenCalled()
  })

  it('rejects an in-flight result after native claim and retirement on the same physical service port', async () => {
    const t = await fixture(); t.install()
    const entered = gate(undefined), reply = gate<Awaited<ReturnType<CloudPort['answer']>>>({ ok: true })
    t.answer.mockImplementation(() => { entered.resolve(undefined); return reply.promise })
    const result = t.ask(); await entered.promise
    expect(await nativeClaim()).not.toBeNull(); await nativeRetire()
    reply.resolve({ ok: true })
    expect(await result).toHaveProperty('error'); expect(t.answer).toHaveBeenCalledOnce()
  })

  it('retains the independent physical-port fence', async () => {
    const t = await fixture(true); t.install(); const result = t.ask(); await t.entered.promise
    t.disconnect(); t.start.resolve(true)
    expect(await result).toHaveProperty('error'); expect(t.answer).not.toHaveBeenCalled()
  })

  it.each(['deliver', 'update', 'stop'] as const)('fences the actual %s port call across native claim and retirement', async operation => {
    const t = await fixture(true); t.install()
    const result = track((operation === 'deliver' ? t.cloud.deliver(OWNER, 'fixture message')
      : operation === 'update' ? t.cloud.update({ agentId: OWNER, name: 'New name' }) : t.cloud.stop(OWNER))!)
    await t.entered.promise
    expect(await nativeClaim()).not.toBeNull(); await nativeRetire()
    t.start.resolve(true)
    expect(await result).toHaveProperty('error')
    expect(t.port.deliver).not.toHaveBeenCalled(); expect(t.port.rename).not.toHaveBeenCalled()
    expect(t.port.stopHarness).not.toHaveBeenCalled()
  })

  it('rejects a service publication against a current native owner before sending any frame', async () => {
    expect(await nativeClaim()).not.toBeNull()
    const t = await fixture()
    expect(t.publish()).toMatchObject({ ok: false })
    expect(t.clients.send).not.toHaveBeenCalled(); expect(t.clients.sendCommander).not.toHaveBeenCalled()
    expect(registry.byAgent(OWNER)?.engine).toBe('claude')
  })

  it.each(['current', 'retired'] as const)('drops an omitted revoked service row without deleting its %s native successor', async state => {
    const t = await fixture(); t.install()
    expect(await nativeClaim()).not.toBeNull()
    if (state === 'retired') await nativeRetire()
    t.clients.send.mockClear(); t.clients.sendCommander.mockClear()
    // The snapshot may intentionally drop stale service data. Its old token cannot delete a native
    // successor from desktop or the dial, even if that successor retired before this publication.
    expect(t.cloud.doors.publish([])).toEqual({ ok: true })
    expect(t.cloud.frames()).toEqual([])
    expect(t.cloud.doors.checkpoint()).toEqual({ fingerprint: (await import('../../cloud/cards.js')).cloudPresentationFingerprint([]) })
    if (state === 'current') expect(registry.byAgent(OWNER)?.engine).toBe('claude')
    expect(t.clients.send).not.toHaveBeenCalled()
    expect(t.clients.sendCommander).not.toHaveBeenCalled()
  })

  it('keeps ordinary omission deletion on both client paths and permits a new service incarnation', async () => {
    const t = await fixture(); t.install()
    t.clients.send.mockClear(); t.clients.sendCommander.mockClear()
    expect(t.cloud.doors.publish([])).toEqual({ ok: true })
    const gone = { type: 'agent_deleted', payload: { agentId: OWNER } }
    expect(t.clients.send).toHaveBeenCalledExactlyOnceWith(gone)
    expect(t.clients.sendCommander).toHaveBeenLastCalledWith(gone)
    t.install()
    expect(t.cloud.owns(OWNER)).toBe(true)
    expect(await t.cloud.deliver(OWNER, 'fixture')).toEqual({ ok: true })
  })

  it('revokes through a real peer import even when native retirement precedes the next service read', async () => {
    const t = await fixture(true); t.install(); const result = t.ask(); await t.entered.promise
    const other = await peer()
    expect(await nativeClaim(other)).not.toBeNull()
    expect(registry.byAgent(OWNER)).toBeUndefined()
    await registry.flush()
    expect(registry.byAgent(OWNER)?.engine).toBe('claude')
    await nativeRetire(); t.start.resolve(true)
    expect(await result).toHaveProperty('error'); expect(t.answer).not.toHaveBeenCalled()
  })

  it('revokes a peer-recovered held binding before a failed retry can return or its native owner can retire', async () => {
    const t = await fixture(true); t.install(); const result = t.ask(); await t.entered.promise
    fault.afterSync = true
    const failure = await nativeClaim().catch(error => error)
    expect(failure.constructor.name).toBe('AtomicWriteUnconfirmed')
    expect(registry.byAgent(OWNER)).toBeUndefined()
    const other = await peer()
    await bind(other, 'native-recovered-session')
    const retry = await nativeClaim().catch(error => error)
    expect(retry).toBeNull()
    expect(registry.byAgent(OWNER)).toMatchObject({ sessionId: 'native-recovered-session', identityHold: expect.any(String) })
    // The retry exposed the recovered owner via reconcileUnconfirmed, not a successful new admission.
    await nativeRetire(); t.start.resolve(true)
    expect(await result).toHaveProperty('error'); expect(t.answer).not.toHaveBeenCalled()
  })

  it('revokes at native Map installation even when source release fails before optional entry notification', async () => {
    const t = await fixture(true); t.install(); const result = t.ask(); await t.entered.promise
    const retain = storage.retain.bind(storage)
    let failed = false
    vi.spyOn(storage, 'retain').mockImplementation(async document => {
      const source = await retain(document)
      return { ...source, release: async () => {
        await source.release()
        if (!failed && document.kind === 'registry' && registry.byAgent(OWNER)) {
          failed = true; throw new Error('fixture admitted source release failed')
        }
      } }
    })
    const failure = await nativeClaim().catch(error => error)
    expect(failed).toBe(true); expect(failure.constructor.name).toBe('RegistryCleanupUnavailable')
    expect(registry.byAgent(OWNER)?.engine).toBe('claude')
    expect(JSON.parse(readFileSync(join(root, 'data', 'registry.json'), 'utf8'))).toEqual([
      expect.objectContaining({ agentId: OWNER, engine: 'claude' }),
    ])
    await nativeRetire(); t.start.resolve(true)
    expect(await result).toHaveProperty('error'); expect(t.answer).not.toHaveBeenCalled()
  })

  it.each(['native-owner', OWNER])('treats a native session alias as a claim once for owner %s and does not restore old service authority', async nativeId => {
    const t = await fixture(true); t.install(); const result = t.ask(); await t.entered.promise
    expect(await nativeClaim(registry, nativeId)).not.toBeNull()
    await bind(registry, OWNER)
    expect(registry.resolve(OWNER)?.agentId).toBe(nativeId)
    expect(t.clients.sendCommander.mock.calls.filter(([frame]) => frame.type === 'commander_question_close')).toHaveLength(1)
    await nativeRetire(nativeId); t.start.resolve(true)
    expect(await result).toHaveProperty('error'); expect(t.answer).not.toHaveBeenCalled()
  })

  it.each(['web', 'device'])('lists the current native owner once for a %s caller', async role => {
    const t = await fixture(); t.install(); expect(await nativeClaim()).not.toBeNull()
    const [{ createAgentList }, { agentFrame }] = await Promise.all([import('./list.js'), import('../../lib/agentFrame.js')])
    const project = (row: NonNullable<ReturnType<typeof registry.byAgent>>) => agentFrame(row, {
      selectedModel: null, terminalAvailable: registry.terminalAvailable(row.agentId),
    })
    const list = createAgentList({ deviceFactory: t.deviceFactory, registry, stoppedAgents: { available: async () => [] },
      toProject: project, toStoppedProject: project, serviceFrames: t.cloud.frames,
      harnessResourcesReader: async () => ({ sampledAt: '2026-11-19T00:00:00.000Z', agents: [] }),
      harnessStorageReader: async () => new Map(), monitorActivityProvider: null, monitorCompletions: { state: () => 'idle' },
    })
    const reply = vi.fn()
    await list.agentsList({}, () => role, reply)
    expect(reply).toHaveBeenCalledWith({ agents: [expect.objectContaining({ id: OWNER, engine: 'claude' })] })
  })

  it('streams one native member through the actual compact session-read caller', async () => {
    const t = await fixture(); t.install(); expect(await nativeClaim()).not.toBeNull()
    const { readSessions } = await import('../api.js'), { agentFacts } = await import('../../lib/agentFrame.js')
    const { fakeCore } = await import('../../testing/fakeCore.js')
    const events: Array<ReadRecord<SessionReadHeader, SessionReadValue>> = []
    await readSessions({ registry,
      // The existing main.ts adapter; the shared-owner migration removes this cast with the old branch.
      serviceRead: { ids: t.cloud.dialIds, row: id => t.cloud.dialRow(id) },
      facts: row => agentFacts(row, registry.terminalAvailable(row.agentId)), runtimeProfile: () => null,
      turns: fakeCore().turns,
      machine: { id: () => 'fixture', computerId: () => 'fixture', name: () => 'Fixture' },
      signedIn: () => false, environment: () => 'prod', hasWindow: () => false, log: vi.fn(),
    }, (event, settled) => { events.push(event); queueMicrotask(() => settled(true)); return true })
    expect(events[0]).toMatchObject({ type: 'begin', payload: { count: 1 } })
    expect(events.filter(event => event.type === 'row')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ value: expect.arrayContaining(['registered', OWNER, 'claude']) }) }),
    ])
  })

  it('lets a native question replace the old service question and ignores its late service close', async () => {
    const t = await fixture(); t.install(); expect(await nativeClaim()).not.toBeNull()
    const watcher = (t.asking.questionWatcher as unknown as { deps: QuestionWatcherDeps }).deps
    watcher.onQuestion(OWNER, 'native-request', [{ key: 'answer', q: 'Native question', options: ['Yes'], multi: false }])
    t.close()
    expect(t.asking.presentations.current(OWNER)?.requestId).toBe('native-request')
    expect(t.asking.presentations.request(REQUEST)).toBeUndefined()
  })

  it('revokes both imported native keys before a failing first close and still retires the second question', async () => {
    const t = await fixture(); t.install()
    const alias = 'cloud_alias', aliasRequest = 'cloud_q_alias'
    const { prepareCloudQuestion } = await import('../../cloud/questions.js')
    expect(t.cloud.doors.publish([t.row, { ...t.row, agentId: alias }])).toEqual({ ok: true })
    expect(t.cloud.doors.ask(alias, aliasRequest, prepareCloudQuestion(alias, aliasRequest, { text: 'Alias?', choices: ['Yes'] }))).toEqual({ ok: true })
    const other = await peer()
    expect(await nativeClaim(other)).not.toBeNull(); await bind(other, alias)
    const observed: boolean[][] = []
    t.clients.sendCommander.mockImplementationOnce(() => {
      observed.push([t.cloud.owns(OWNER), t.cloud.owns(alias)])
      throw new Error('fixture first close failed')
    })
    // Even a broken diagnostic cannot stop the second exact question retirement.
    t.log.mockImplementationOnce(() => { throw new Error('fixture log failed') })
    await registry.flush()
    expect(observed).toEqual([[false, false]])
    expect(t.asking.presentations.request(REQUEST)).toBeUndefined()
    expect(t.asking.presentations.request(aliasRequest)).toBeUndefined()
    await nativeRetire()
    expect(t.cloud.deliver(OWNER, 'fixture')).toBeNull(); expect(t.cloud.deliver(alias, 'fixture')).toBeNull()
    expect(await t.cloud.doors.checkpoint()).toEqual({ ok: false, error: 'SESSION_OWNER_CONFLICT' })
  })

  it('keeps a typed recovery conflict after native retirement and refuses unchanged owner replay', async () => {
    const t = await fixture(); t.install()
    const fingerprint = await t.cloud.doors.checkpoint()
    expect(fingerprint).toEqual({ fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(await nativeClaim()).not.toBeNull(); await nativeRetire()
    expect(await t.cloud.doors.checkpoint()).toEqual({ ok: false, error: 'SESSION_OWNER_CONFLICT' })
    expect(t.publish()).toEqual({ ok: false, error: 'SESSION_OWNER_CONFLICT' })
    expect(await t.cloud.doors.checkpoint()).toEqual({ ok: false, error: 'SESSION_OWNER_CONFLICT' })
  })

  it('rejects rename after same-facts removal and recreation without exposing private authority', async () => {
    const t = await fixture(true); t.install()
    const result = track(t.cloud.update({ agentId: OWNER, name: 'New name' })!)
    await t.entered.promise
    expect(t.cloud.doors.publish([])).toEqual({ ok: true }); t.install()
    t.start.resolve(true)
    expect(await result).toHaveProperty('error'); expect(t.port.rename).not.toHaveBeenCalled()
    // A new request captures the new owner, and the prepared payload remains exactly the provider row.
    expect(await t.cloud.update({ agentId: OWNER, name: 'New name' })).toHaveProperty('agent.name', 'New name')
    const captured = vi.mocked(t.port.rename).mock.calls[0][2]
    const expected = JSON.parse((await import('../../lib/sessionPresentation.js')).encodeSessionFacts((await import('../../lib/cloudAgents.js')).cloudPresentation({ ...t.row, said: null })))
    expect(captured).toEqual(expected)
    expect(new Set(Reflect.ownKeys(captured))).toEqual(new Set(Object.keys(expected)))
  })

  it.each(['startup', 'provider reply'] as const)('refuses the three-second Stop reply after native takeover during %s', async phase => {
    const t = await fixture(phase === 'startup'); t.install()
    const reply = gate<Awaited<ReturnType<CloudPort['stopHarness']>>>({ deleted: true })
    vi.mocked(t.port.stopHarness).mockImplementation(() => reply.promise)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const stopped = track(t.cloud.stop(OWNER)!)
      if (phase === 'startup') await t.entered.promise
      else expect(t.port.stopHarness).toHaveBeenCalledOnce()
      expect(await nativeClaim()).not.toBeNull(); await nativeRetire()
      await vi.advanceTimersByTimeAsync(3_000)
      expect(await stopped).toHaveProperty('error')
    } finally { vi.useRealTimers(); t.start.resolve(true); reply.resolve({ deleted: true }) }
  })
})
