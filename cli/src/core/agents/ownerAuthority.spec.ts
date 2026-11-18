/** Native claims fence service operations even when the claim retires between two service reads. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RegisteredSession, registry as Registry } from '../../lib/registry.js'
import type { SessionStorage } from '../../lib/sessionStorage.js'
import type { CloudPort, ReadRecord, SessionReadHeader, SessionReadValue } from '../api.js'
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
  const [{ createCloudAgents }, { createQuestions, createQuestionResponse }, { cloudFactory, deviceFactory },
    { prepareCloudQuestion, cloudQuestionClose }, { cloudAgentFrame }] = await Promise.all([
    import('./cloud.js'), import('../questions.js'), import('../../testing/sessionFactories.js'),
    import('../../cloud/questions.js'), import('../../lib/cloudAgents.js'),
  ])
  const clients = { send: vi.fn(), sendCommander: vi.fn(), sendLocal: vi.fn(), sendRemote: vi.fn() }
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
    answer, create: async () => ({ agent: cloudAgentFrame(row) }), deliver: vi.fn(async () => ({ ok: true })),
    rename: vi.fn(async (_id, name) => ({ agent: cloudAgentFrame({ ...row, name }),
      renamed: { type: 'agent_renamed', payload: { agentId: OWNER, name, engine: row.agent } } })),
    stopHarness: vi.fn(async () => ({ deleted: true })),
  }
  let selected: CloudPort | null = port
  const start = gate(false), entered = gate(undefined)
  const cloud = createCloudAgents({ ownsFactory: cloudFactory, port: () => selected, clients,
    questions: asking.presentations, log: vi.fn(),
    whenStarting: () => { if (!startHeld) return null; entered.resolve(undefined); return start.promise },
  })
  const question = prepareCloudQuestion(OWNER, REQUEST, { text: 'Continue?', choices: ['Yes'] })
  const publish = () => cloud.doors.publish([row])
  const install = () => { expect(publish()).toEqual({ ok: true }); expect(cloud.doors.ask(OWNER, REQUEST, question)).toEqual({ ok: true }) }
  // Exact main.ts request adapter. The existing native controller remains the fallback, not a fake resolver.
  const response = createQuestionResponse(payload => cloud.answer(payload) ?? asking.answer(payload))
  const ask = () => track(new Promise<Record<string, unknown>>(resolve => response({
    agentId: OWNER, requestId: REQUEST, answers: { answer: 'Yes' },
  }, resolve)))
  const close = () => cloud.doors.unask(OWNER, REQUEST, cloudQuestionClose(OWNER, REQUEST))
  return { cloud, asking, clients, row, port, answer, start, entered, question, publish, install, ask, close, deviceFactory,
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

  it('treats a native session alias as a claim and does not restore old service authority after retirement', async () => {
    const t = await fixture(true); t.install(); const result = t.ask(); await t.entered.promise
    expect(await nativeClaim(registry, 'native-owner')).not.toBeNull()
    await bind(registry, OWNER)
    expect(registry.resolve(OWNER)?.agentId).toBe('native-owner')
    await nativeRetire('native-owner'); t.start.resolve(true)
    expect(await result).toHaveProperty('error'); expect(t.answer).not.toHaveBeenCalled()
  })

  it.each(['web', 'device'])('lists the current native owner once for a %s caller', async role => {
    const t = await fixture(); t.install(); expect(await nativeClaim()).not.toBeNull()
    const [{ createAgentList }, { agentFrame }] = await Promise.all([import('./list.js'), import('../../lib/agentFrame.js')])
    const project = (row: NonNullable<ReturnType<typeof registry.byAgent>>) => agentFrame(row, {
      selectedModel: null, terminalAvailable: registry.terminalAvailable(row.agentId),
    })
    const list = createAgentList({ deviceFactory: t.deviceFactory, registry, stoppedAgents: { available: async () => [] },
      toProject: project, toStoppedProject: project, cloudFrames: t.cloud.frames,
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
    const events: Array<ReadRecord<SessionReadHeader, SessionReadValue>> = []
    await readSessions({ registry,
      // The existing main.ts adapter; the shared-owner migration removes this cast with the old branch.
      cloudRead: { ids: t.cloud.dialIds, row: id => t.cloud.dialRow(id) as unknown as RegisteredSession | undefined },
      facts: row => agentFacts(row, registry.terminalAvailable(row.agentId)), runtimeProfile: () => null,
      turns: { running: () => false } as Parameters<typeof readSessions>[0]['turns'],
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
    watcher.onQuestion(OWNER, 'native-request', [{ q: 'Native question', options: ['Yes'] }])
    t.close()
    expect(t.asking.presentations.current(OWNER)?.requestId).toBe('native-request')
    expect(t.asking.presentations.request(REQUEST)).toBeUndefined()
  })
})
