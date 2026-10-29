import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installedDsh } from '../../dsh/installed.js'
import { dshSupportedEngines } from '../../dsh/manifest.js'
import { loadEngine } from '../../engines/inProcess.js'
import { opencodeMajorVersion } from '../../engines/launchControl.js'
import type { NativeLaunchResult } from '../../engines/nativeLaunch.js'
import { createNativeLaunchPreparer } from '../../engines/prepareNativeLaunch.js'
import { AgentCreationReceiptError, AgentCreationReceipts, creationFingerprint, type AgentCreationOutcome } from '../../lib/agentCreationReceipt.js'
import type { AgentFrame } from '../../lib/agentFrame.js'
import { MAX_FIRST_PROMPT_CHARS, permissionModeApproves, permissionModeFlags, supportsFirstPrompt, supportsNamedAgent, unsupportedLaunchModelFlag } from '../../lib/engineLaunch.js'
import { parseGridLaunchOverride } from '../../lib/gridLaunchWire.js'
import { parseNewAgentModel } from '../../lib/newAgentModel.js'
import { parseProjectFolder, prepareProjectFolder, ProjectFolderError } from '../../lib/projectFolder.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createLaunchRequests, type CreateAgent, type ForkAgent, type LaunchRequestDeps, type RestartAgent, type ResumeAgent } from './launches.js'
import * as pendingLaunches from './pendingLaunches.js'
import { SWARM_LAUNCH } from '../../superTabs/inCore/launch.js'

/**
 * The requests that start an agent's process, answered by the core: every refusal before a pane exists,
 * what each launch is handed, the receipts that let a lost answer be asked for again, and the replies,
 * field for field. Trust records, grid reads, project folders and installed harnesses are fakes here:
 * they are tested with their own modules, and a test must never write the person's own engine config.
 */
const root = vi.hoisted(() => ({ projects: '' }))
// The engines' folder trust (engines/launchPrep.ts), one spy per engine.
const trust = vi.hoisted(() => ({
  claudeTrusts: vi.fn((_path: string) => false), codexTrusts: vi.fn((_path: string, _profile?: string | null) => false),
  preTrustClaudeProject: vi.fn((_path: string): unknown => undefined), preTrustCodexProject: vi.fn((_path: string, _profile?: string | null): unknown => undefined),
}))
const { claudeTrusts, codexTrusts, preTrustClaudeProject, preTrustCodexProject } = trust
vi.mock('../../engines/launchPrep.js', () => ({ folderTrust: (engine: string, profile?: string | null) => engine === 'claude'
    ? { trusts: (path: string) => trust.claudeTrusts(path), record: (path: string) => trust.preTrustClaudeProject(path) }
    : engine === 'codex' ? { trusts: (path: string) => trust.codexTrusts(path, profile), record: (path: string) => trust.preTrustCodexProject(path, profile) } : null }))
// OpenCode's version probe is its own code, loaded for an OpenCode launch alone; a test may say it could not be.
vi.mock('../../engines/inProcess.js', async (real) => {
  const actual = await real<typeof import('../../engines/inProcess.js')>()
  return { ...actual, loadEngine: vi.fn(actual.loadEngine) }
})
vi.mock('../../engines/launchControl.js', async (real) => ({ ...await real<object>(), opencodeMajorVersion: vi.fn(() => 1) }))
vi.mock('../../lib/newAgentModel.js', async (real) => ({
  ...await real<object>(), parseNewAgentModel: vi.fn(() => ({ state: 'absent' })),
}))
vi.mock('../../lib/gridLaunchWire.js', async (real) => ({ ...await real<object>(), parseGridLaunchOverride: vi.fn(() => ({ state: 'absent' })) }))
vi.mock('../../dsh/installed.js', async (real) => ({ ...await real<object>(), installedDsh: vi.fn(() => undefined) }))
vi.mock('../../dsh/manifest.js', async (real) => ({ ...await real<object>(), dshSupportedEngines: vi.fn(() => ['claude', 'codex']) }))
vi.mock('../../lib/engineLaunch.js', async (real) => ({
  ...await real<object>(),
  supportsFirstPrompt: vi.fn(() => true), supportsNamedAgent: vi.fn(() => true),
  permissionModeFlags: vi.fn(() => ['--flag']), permissionModeApproves: vi.fn(() => false),
  // The engine's own --help is never run by a spec.
  unsupportedLaunchModelFlag: vi.fn(async () => null),
}))
vi.mock('../../lib/projectFolder.js', async (real) => {
  const actual = await real<typeof import('../../lib/projectFolder.js')>()
  return { ...actual, parseProjectFolder: vi.fn(actual.parseProjectFolder), prepareProjectFolder: vi.fn(async () => '/projects/prepared'), projectsRoot: vi.fn(() => root.projects) }
})

const CREATION = 'creation-0123456789abcdef'
/** Where the models service resolves a new agent's grid model (core/api.ts `ModelsPort.launchTarget`). */
const resolveNewAgentModel = vi.fn<LaunchRequestDeps['modelTarget']>()
const session = (agentId = 'a1', over: Partial<RegisteredSession> = {}) => ({ agentId, sessionId: `${agentId}-session`, engine: 'claude', ...over }) as RegisteredSession
const frameOf = (s: RegisteredSession) => ({ id: s.agentId }) as unknown as AgentFrame
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

let dir: string
let stores = 0
const stopRequests: Array<() => void> = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'launches-'))
  root.projects = join(dir, 'harnesses')
  mkdirSync(root.projects)
})
afterEach(() => {
  stopRequests.splice(0).forEach(stop => stop())
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

function setup(over: Partial<LaunchRequestDeps> = {}, launches: { create?: CreateAgent | null; fork?: ForkAgent | null; resume?: ResumeAgent | null; restart?: RestartAgent | null } = {}) {
  const create = launches.create === undefined ? vi.fn(async () => ({ ok: true as const, session: session('new-agent') })) : launches.create
  const fork = launches.fork === undefined ? vi.fn(async () => ({ ok: true as const, session: session('forked'), level: 'native' as const })) : launches.fork
  const resume = launches.resume === undefined ? vi.fn(async () => ({ ok: true as const, session: session('a1'), resumed: true })) : launches.resume
  const restart = launches.restart === undefined ? vi.fn(async () => ({ ok: true as const, session: session('a1'), resumed: false })) : launches.restart
  const known = new Map([['new-agent', session('new-agent')], ['forked', session('forked')], ['a1', session('a1')]])
  const deps: LaunchRequestDeps = {
    receipts: new AgentCreationReceipts(join(dir, `receipts-${++stores}`)),
    createAgent: () => create, forkAgent: () => fork, resumeAgent: () => resume, restartAgent: () => restart,
    byAgent: (id) => known.get(id), toProject: vi.fn(async (s: RegisteredSession) => frameOf(s)),
    modelTarget: resolveNewAgentModel,
    swarmLaunch: SWARM_LAUNCH,
    ...over,
  }
  const requests = createLaunchRequests(deps)
  stopRequests.push(requests.stop)
  const replies: Array<Record<string, unknown>> = []
  const reply = (result: Record<string, unknown>) => { replies.push(result) }
  return {
    deps, create, fork, resume, restart, replies, requests,
    ask: async (payload: Record<string, unknown>, local = true) => { await requests.create(payload, { local }, reply); return replies.at(-1) },
    status: async (payload: Record<string, unknown>) => { await requests.createStatus(payload, { local: true }, reply); return replies.at(-1) },
    relaunch: async (type: string, payload: Record<string, unknown>) => { await requests.relaunch(type, payload, reply); return replies.at(-1) },
    forkAsk: async (payload: Record<string, unknown>) => { await requests.fork(payload, reply); return replies.at(-1) },
  }
}

describe('agent_create, refused before any pane exists', () => {
  it('keeps a selected model pending before native preparation, then dispatches its fresh resolution once', async () => {
    vi.mocked(parseNewAgentModel).mockReturnValue({ state: 'ok', selection: { model: 'fixture-model', grid: 'fixture-grid' } })
    const grid = { networkId: 'fixture', networkName: 'Fixture', baseUrl: 'http://fixture.invalid', apiKey: 'fixture' }
    resolveNewAgentModel.mockResolvedValueOnce(null).mockResolvedValue(grid)
    const dispatch = vi.fn(async () => ({ ok: true as const, session: session('new-agent') }))
    const prepareCreate = vi.fn<NonNullable<LaunchRequestDeps['prepareCreate']>>(async () => ({ ok: true, dispatch }))
    const run = setup({ prepareCreate })
    const input = { creationId: CREATION, engine: 'claude', cwd: '/fixture/work', prompt: 'original prompt' }
    await run.ask(input)
    await vi.waitFor(() => expect(run.replies[0]).toMatchObject({ state: 'pending', held: { service: 'models' } }))
    expect(prepareCreate).not.toHaveBeenCalled()
    await run.ask(input)
    await vi.waitFor(() => expect(run.replies[1]).toMatchObject({ state: 'created' }))
    expect(prepareCreate).toHaveBeenCalledWith(expect.objectContaining({ grid, prompt: 'original prompt' }), expect.any(Object), { local: true })
    expect(dispatch).toHaveBeenCalledOnce()
  })

  it('names models when its selected-model request rejects before native preparation', async () => {
    vi.mocked(parseNewAgentModel).mockReturnValue({ state: 'ok', selection: { model: 'fixture-model', grid: 'fixture-grid' } })
    const prepareCreate = vi.fn()
    const run = setup({ prepareCreate, modelTarget: async () => { throw Error('models disconnected') } })
    await run.ask({ creationId: CREATION, engine: 'claude', cwd: '/fixture/work' })
    await vi.waitFor(() => expect(run.replies[0]).toMatchObject({ state: 'pending', held: { service: 'models' } }))
    expect(prepareCreate).not.toHaveBeenCalled()
  })

  it.each(['model', 'native'] as const)('retains durable cancellation while %s preparation settles', async phase => {
    vi.mocked(parseNewAgentModel).mockReturnValue({ state: 'ok', selection: { model: 'fixture-model', grid: 'fixture-grid' } })
    const dispatch = vi.fn(async () => ({ ok: true as const, session: session('new-agent') }))
    const run = setup({
      modelTarget: async () => {
        if (phase === 'model') run.deps.receipts.cancelIntent(CREATION)
        return { networkId: 'fixture', networkName: 'Fixture', baseUrl: 'http://fixture.invalid', apiKey: 'fixture' }
      },
      prepareCreate: async () => {
        run.deps.receipts.cancelIntent(CREATION)
        return { ok: true, dispatch }
      },
    })
    await run.ask({ creationId: CREATION, engine: 'claude', cwd: '/fixture/work' })
    await vi.waitFor(() => expect(run.replies[0]).toMatchObject({ state: 'cancelled' }))
    expect(dispatch).not.toHaveBeenCalled()
  })

  it.each(['refused', 'bare refusal', 'held', 'uncertain dispatch'] as const)('records native preparation outcomes truthfully: %s', async outcome => {
    const dispatch = vi.fn(async () => ({ ok: false as const, error: 'SPAWN_FAILED' }))
    const run = setup({ prepareCreate: async () => outcome === 'uncertain dispatch' ? { ok: true, dispatch }
      : outcome === 'held' ? { ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native' }
      : { ok: false, error: 'PERMISSION_MODE_UNSUPPORTED', ...(outcome === 'refused' ? { detail: 'Unsupported fixture mode.' } : {}) } })
    const payload = { creationId: CREATION, engine: 'claude', cwd: '/fixture/work' }
    await run.ask(payload)
    await vi.waitFor(() => expect(run.replies).toHaveLength(1))
    expect(run.replies[0]).toMatchObject(outcome === 'held' ? { state: 'pending', held: { service: 'native', detail: 'Waiting for launch preparation.' } }
      : outcome === 'uncertain dispatch' ? { state: 'unconfirmed' } : { state: 'failed', failure: { code: 'PERMISSION_MODE_UNSUPPORTED' } })
    await run.ask(payload)
    await vi.waitFor(() => expect(run.replies).toHaveLength(2))
    expect(dispatch).toHaveBeenCalledTimes(outcome === 'uncertain dispatch' ? 1 : 0)
  })

  it('fences a prepared native dispatch if receipt authority changes before invocation', async () => {
    let prepare!: Parameters<typeof pendingLaunches.createPendingLaunches>[0]['prepare']
    const factory = pendingLaunches.createPendingLaunches
    vi.spyOn(pendingLaunches, 'createPendingLaunches').mockImplementation(deps => { prepare = deps.prepare; return factory(deps) })
    const dispatch = vi.fn(async () => ({ ok: true as const, session: session('new-agent') }))
    setup({ prepareCreate: async () => ({ ok: true, dispatch }) })
    let current = true
    const ready = await prepare({ kind: 'native-create-v1', input: { engine: 'claude', cwd: '/fixture/work' },
      label: 'harness-claude-fixture', local: false }, { id: CREATION, current: () => current, hold: vi.fn() })
    expect(ready).not.toBeNull()
    current = false
    expect(await ready!()).toEqual({ state: 'unconfirmed' })
    expect(dispatch).not.toHaveBeenCalled()
    expect(preTrustClaudeProject).not.toHaveBeenCalled()
  })

  it('recovers native and later service holds with the same request label and original authority', async () => {
    const dispatch = vi.fn(async () => ({ ok: true as const, session: session('new-agent') }))
    const prepareCreate = vi.fn<NonNullable<LaunchRequestDeps['prepareCreate']>>().mockResolvedValueOnce({ ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native', detail: 'Waiting for installation.' })
      .mockResolvedValueOnce({ ok: false, error: 'GRID_UNAVAILABLE', unavailable: 'models', detail: 'Waiting for models.' })
      .mockImplementation(async (_input, authority) => ({ ok: true, dispatch: async () => { expect(authority.current()).toBe(true); return dispatch() } }))
    const first = setup({ prepareCreate })
    const input = { creationId: CREATION, engine: 'codex', cwd: '/fixture/work', codexHome: '/fixture/profile', prompt: 'fixture first prompt' }
    await first.ask(input, false)
    await vi.waitFor(() => expect(first.replies[0]).toMatchObject({ state: 'pending', held: { service: 'native' } }))
    const label = prepareCreate.mock.calls[0]![1].label
    const saved = first.deps.receipts.pendingIntent(CREATION)!
    expect(saved.request).toMatchObject({ local: false, label, input: { prompt: 'fixture first prompt', codexHome: '/fixture/profile' } })
    first.requests.stop()
    const second = setup({ prepareCreate, receipts: first.deps.receipts })
    await second.ask(input, true)
    await vi.waitFor(() => expect(second.replies[0]).toMatchObject({ state: 'pending', held: { service: 'models' } }))
    await second.ask(input, true)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    expect(prepareCreate.mock.calls.every(([, authority]) => authority.label === label && authority.id === CREATION)).toBe(true)
    expect(first.create).not.toHaveBeenCalled()
    expect(second.create).not.toHaveBeenCalled()
    expect(first.deps.receipts.status(CREATION)).toEqual({ state: 'created', agentId: 'new-agent' })
    expect(preTrustCodexProject).not.toHaveBeenCalled()
    await second.ask(input)
    await settle()
    expect(dispatch).toHaveBeenCalledOnce()
  })
  it('an engine it does not know, a folder it cannot read, or a cwd that is not an absolute path', async () => {
    const { ask, create } = setup()
    expect(await ask({ cwd: '/w' })).toStrictEqual({ error: 'INVALID_ENGINE' })
    expect(await ask({ engine: 'gpt', cwd: '/w' })).toStrictEqual({ error: 'INVALID_ENGINE' })
    expect(await ask({ engine: 'claude', projectSource: 'bogus' })).toStrictEqual({ error: 'INVALID_PROJECT_SOURCE', detail: 'Choose a project.' })
    vi.mocked(parseProjectFolder).mockImplementationOnce(() => { throw new Error('unexpected') })
    expect(await ask({ engine: 'claude', projectSource: 'new' })).toStrictEqual({ error: 'INVALID_PROJECT_SOURCE' })
    expect(await ask({ engine: 'terminal', projectSource: 'new', creationId: CREATION }))
      .toStrictEqual({ error: 'INVALID_PROJECT_SOURCE', detail: 'a terminal opens in a folder, it does not prepare one' })
    expect(await ask({ engine: 'claude', cwd: 'relative/path' })).toStrictEqual({ error: 'INVALID_CWD' })
    expect(await ask({ engine: 'claude' })).toStrictEqual({ error: 'INVALID_CWD' })
    expect(await ask({ engine: 'terminal', cwd: 'relative' })).toStrictEqual({ error: 'INVALID_CWD' })
    expect(create).not.toHaveBeenCalled()
  })

  it('on a machine that cannot launch, a creation id that is not one, and a folder asked for without a receipt or beside a cwd', async () => {
    expect(await setup({}, { create: null }).ask({ engine: 'claude', cwd: '/w' })).toStrictEqual({ error: 'UNSUPPORTED_ON_REMOTE' })
    const { ask } = setup()
    expect(await ask({ engine: 'claude', cwd: '/w', creationId: 'short' })).toStrictEqual({ error: 'INVALID_CREATION_ID' })
    expect(await ask({ engine: 'claude', projectSource: 'new' })).toStrictEqual({ error: 'INVALID_PROJECT_SOURCE' })
    expect(await ask({ engine: 'claude', projectSource: 'new', creationId: CREATION, cwd: '/w' })).toStrictEqual({ error: 'INVALID_PROJECT_SOURCE' })
  })

  it('a model or grid that is not one, a grid for a terminal, and a codexHome anywhere but on codex without a grid', async () => {
    const { ask, create } = setup()
    vi.mocked(parseNewAgentModel).mockReturnValueOnce({ state: 'invalid', detail: 'no such model' } as never)
    expect(await ask({ engine: 'claude', cwd: '/w' })).toStrictEqual({ error: 'INVALID_GRID', detail: 'no such model' })
    vi.mocked(parseGridLaunchOverride).mockReturnValueOnce({ state: 'invalid', reason: 'no baseUrl' } as never)
    expect(await ask({ engine: 'claude', cwd: '/w' })).toStrictEqual({ error: 'INVALID_GRID', detail: 'no baseUrl' })
    vi.mocked(parseGridLaunchOverride).mockReturnValueOnce({ state: 'ok', override: { networkId: 'g' } } as never)
    expect(await ask({ engine: 'terminal' })).toStrictEqual({ error: 'INVALID_GRID', detail: 'a terminal has no engine to point at a grid' })
    const codexHomeRefused = { error: 'INVALID_CODEX_HOME', detail: 'codexHome is only valid for codex, without a grid' }
    expect(await ask({ engine: 'claude', cwd: '/w', codexHome: '/homes/codex' })).toStrictEqual(codexHomeRefused)
    vi.mocked(parseGridLaunchOverride).mockReturnValueOnce({ state: 'ok', override: { networkId: 'g' } } as never)
    expect(await ask({ engine: 'codex', cwd: '/w', codexHome: '/homes/codex' })).toStrictEqual(codexHomeRefused)
    expect(create).not.toHaveBeenCalled()
    // One that is not a plain absolute path is not a codexHome at all, and is dropped rather than refused.
    for (const codexHome of ['relative', '/with\nnewline', `/${'x'.repeat(4096)}`, 7]) await ask({ engine: 'claude', cwd: '/w', codexHome })
    expect(vi.mocked(create!).mock.calls.map(([input]) => input.codexHome)).toEqual([null, null, null, null])
  })

  it('a harness that is not an id, not installed here, a viewer, or not for this engine', async () => {
    const { ask, create } = setup()
    expect(await ask({ engine: 'claude', cwd: '/w', dsh: 'not an id' })).toStrictEqual({ error: 'INVALID_DSH', detail: 'dsh must be an owner/name id' })
    expect(await ask({ engine: 'claude', cwd: '/w', dsh: 7 })).toStrictEqual({ error: 'INVALID_DSH', detail: 'dsh must be an owner/name id' })
    expect(await ask({ engine: 'claude', cwd: '/w', dsh: 'acme/notes' })).toStrictEqual({ error: 'INVALID_DSH', detail: 'acme/notes is not installed on this machine' })
    vi.mocked(installedDsh).mockReturnValueOnce({ id: 'acme/viewer', manifest: { kind: 'viewer' } } as never)
    expect(await ask({ engine: 'claude', cwd: '/w', dsh: 'acme/viewer' })).toStrictEqual({ error: 'INVALID_DSH', detail: 'acme/viewer is a viewer package, not an agent' })
    vi.mocked(installedDsh).mockReturnValueOnce({ id: 'acme/notes', manifest: { kind: 'agent' } } as never)
    expect(await ask({ engine: 'pi', cwd: '/w', dsh: 'acme/notes' })).toStrictEqual({ error: 'INVALID_DSH', detail: 'acme/notes supports claude, codex; pi is not compatible' })
    expect(create).not.toHaveBeenCalled()
  })

  it('passes explicit Swarm roles and refuses invalid role metadata before dispatch', async () => {
    const { ask, create } = setup()
    for (const engine of ['claude', 'codex']) for (const swarmRole of ['lead', 'dev', 'review']) {
      await ask({ engine, cwd: '/w', swarmRole })
      expect(vi.mocked(create!).mock.calls.at(-1)![0]).toMatchObject({ engine, swarmRole })
    }
    for (const swarmRole of [7, '', 'builder', 'reviewer']) {
      expect(await ask({ engine: 'claude', cwd: '/w', swarmRole })).toMatchObject({ error: 'INVALID_SWARM_ROLE' })
    }
    expect(await ask({ engine: 'terminal', cwd: '/w', swarmRole: 'dev' })).toMatchObject({ error: 'INVALID_SWARM_ROLE' })
    expect(await ask({ engine: 'codex', cwd: '/w', swarmRole: 'dev', resumeSessionId: 'old-session' })).toMatchObject({ error: 'INVALID_SESSION' })
  })

  it('passes the project\'s skill mode with a Swarm role, and refuses one it does not know before dispatch', async () => {
    const { ask, create } = setup()
    for (const swarmSkillMode of ['default', 'orchestration']) {
      await ask({ engine: 'claude', cwd: '/w', swarmRole: 'dev', swarmSkillMode })
      expect(vi.mocked(create!).mock.calls.at(-1)![0]).toMatchObject({ swarmRole: 'dev', swarmSkillMode })
    }
    // From a start before modes: the session launches as it did then.
    await ask({ engine: 'claude', cwd: '/w', swarmRole: 'dev' })
    expect(vi.mocked(create!).mock.calls.at(-1)![0]).not.toHaveProperty('swarmSkillMode')
    const calls = vi.mocked(create!).mock.calls.length
    for (const swarmSkillMode of ['light', 7, null]) {
      expect(await ask({ engine: 'claude', cwd: '/w', swarmRole: 'dev', swarmSkillMode })).toMatchObject({ error: 'INVALID_SWARM_ROLE' })
    }
    expect(vi.mocked(create!).mock.calls).toHaveLength(calls)
  })

  it('passes the GitHub App flag with a Swarm role only, and refuses anything else before dispatch', async () => {
    const { ask, create } = setup()
    await ask({ engine: 'codex', cwd: '/w', swarmRole: 'dev', swarmGitHub: true })
    expect(vi.mocked(create!).mock.calls.at(-1)![0]).toMatchObject({ swarmRole: 'dev', swarmGitHub: true })
    await ask({ engine: 'codex', cwd: '/w', swarmRole: 'dev' })
    expect(vi.mocked(create!).mock.calls.at(-1)![0]).not.toHaveProperty('swarmGitHub')
    const calls = vi.mocked(create!).mock.calls.length
    for (const payload of [{ swarmRole: 'dev', swarmGitHub: false }, { swarmRole: 'dev', swarmGitHub: 'yes' }, { swarmGitHub: true }]) {
      expect(await ask({ engine: 'claude', cwd: '/w', ...payload })).toMatchObject({ error: 'INVALID_SWARM_ROLE' })
    }
    expect(vi.mocked(create!).mock.calls).toHaveLength(calls)
  })

  it('passes a Buddy\'s Swarm with the Buddy role only, as one plain id, and refuses anything else before dispatch', async () => {
    const { ask, create } = setup()
    await ask({ engine: 'codex', cwd: '/w', swarmRole: 'buddy', swarmTabId: 'tab_1-a' })
    expect(vi.mocked(create!).mock.calls.at(-1)![0]).toMatchObject({ swarmRole: 'buddy', swarmTabId: 'tab_1-a' })
    await ask({ engine: 'codex', cwd: '/w', swarmRole: 'buddy' })
    expect(vi.mocked(create!).mock.calls.at(-1)![0]).not.toHaveProperty('swarmTabId')
    const calls = vi.mocked(create!).mock.calls.length
    for (const payload of [{ swarmRole: 'dev', swarmTabId: 'tab' }, { swarmTabId: 'tab' }, { swarmRole: 'buddy', swarmTabId: '' },
      { swarmRole: 'buddy', swarmTabId: 'a"b' }, { swarmRole: 'buddy', swarmTabId: 7 }]) {
      expect(await ask({ engine: 'codex', cwd: '/w', ...payload })).toMatchObject({ error: 'INVALID_SWARM_ROLE' })
    }
    expect(vi.mocked(create!).mock.calls).toHaveLength(calls)
  })

  // HARNESS_SWARM=off: nothing of the Swarm's is asked of a launch, and a start that asks for it is refused at the wire.
  it('refuses every Swarm field while the Swarm is off, before dispatch, and starts everything else as before', async () => {
    const { ask, create } = setup({ swarmLaunch: undefined })
    for (const payload of [{ swarmRole: 'dev' }, { swarmSkillMode: 'default' }, { swarmGitHub: true }, { swarmTabId: 'tab' }, { swarmRole: 'lead', swarmSkillMode: 'orchestration', swarmGitHub: true }]) {
      expect(await ask({ engine: 'claude', cwd: '/w', ...payload })).toStrictEqual({ error: 'INVALID_SWARM_ROLE', detail: 'The Swarm is off on this computer (HARNESS_SWARM).' })
    }
    expect(create).not.toHaveBeenCalled()
    await ask({ engine: 'claude', cwd: '/w', swarmRole: null })
    expect(vi.mocked(create!).mock.calls.at(-1)![0]).not.toHaveProperty('swarmRole')
  })

  it('a first prompt that is not text, too long, or for an engine that cannot take one', async () => {
    const { ask, create } = setup()
    expect(await ask({ engine: 'claude', cwd: '/w', prompt: 7 })).toStrictEqual({ error: 'INVALID_PROMPT', detail: 'prompt must be a string' })
    expect(await ask({ engine: 'claude', cwd: '/w', prompt: 'x'.repeat(MAX_FIRST_PROMPT_CHARS + 1) }))
      .toStrictEqual({ error: 'PROMPT_TOO_LONG', detail: `prompt is longer than ${MAX_FIRST_PROMPT_CHARS} characters` })
    vi.mocked(supportsFirstPrompt).mockReturnValueOnce(false)
    expect(await ask({ engine: 'claude', cwd: '/w', prompt: 'fix it' })).toMatchObject({ error: 'PROMPT_UNSUPPORTED' })
    expect(create).not.toHaveBeenCalled()
  })

  it('a named agent that is not a name, or one its engine cannot open as (OpenCode v2 counts as cannot)', async () => {
    const { ask, create } = setup()
    expect(await ask({ engine: 'claude', cwd: '/w', agent: '../reviewer' })).toStrictEqual({ error: 'INVALID_AGENT', detail: 'agent must be 1-64 letters, digits, `-` or `_`' })
    expect(await ask({ engine: 'claude', cwd: '/w', agent: 7 })).toMatchObject({ error: 'INVALID_AGENT' })
    vi.mocked(supportsNamedAgent).mockReturnValueOnce(false)
    vi.mocked(opencodeMajorVersion).mockResolvedValueOnce(2)
    expect(await ask({ engine: 'opencode', cwd: '/w', agent: 'reviewer' })).toMatchObject({ error: 'AGENT_UNSUPPORTED' })
    expect(supportsNamedAgent).toHaveBeenLastCalledWith('opencode', 2)
    expect(create).not.toHaveBeenCalled()
  })

  it('validates a named OpenCode launch without optional code', async () => {
    const { ask, create } = setup()
    vi.mocked(loadEngine).mockResolvedValue(null)
    await ask({ engine: 'opencode', cwd: '/w', agent: 'reviewer' })
    expect(create).toHaveBeenCalledOnce()
    await ask({ engine: 'claude', cwd: '/w', agent: 'reviewer' })
    expect(loadEngine).not.toHaveBeenCalled()
  })

  it('a permission mode the engine does not have, and a conversation to resume that is not one or comes with new-conversation choices', async () => {
    const { ask, create } = setup()
    vi.mocked(permissionModeFlags).mockReturnValueOnce(null as never)
    expect(await ask({ engine: 'claude', cwd: '/w', permissionMode: 'yolo' })).toStrictEqual({ error: 'INVALID_PERMISSION_MODE', detail: 'claude has no permission mode "yolo"' })
    expect(await ask({ engine: 'claude', cwd: '/w', permissionMode: 7 })).toStrictEqual({ error: 'INVALID_PERMISSION_MODE', detail: 'claude has no permission mode 7' })
    const notASession = { error: 'INVALID_SESSION', detail: 'resumeSessionId must be a session id' }
    expect(await ask({ engine: 'claude', cwd: '/w', resumeSessionId: '../x' })).toStrictEqual(notASession)
    expect(await ask({ engine: 'claude', cwd: '/w', resumeSessionId: 7 })).toStrictEqual(notASession)
    const fresh = { error: 'INVALID_SESSION', detail: 'a resumed conversation takes no new folder, grid, harness, prompt or agent' }
    expect(await ask({ engine: 'terminal', resumeSessionId: 'ses_abc' })).toStrictEqual(fresh)
    expect(await ask({ engine: 'claude', projectSource: 'new', creationId: CREATION, resumeSessionId: 'ses_abc' })).toStrictEqual(fresh)
    vi.mocked(parseGridLaunchOverride).mockReturnValueOnce({ state: 'ok', override: { networkId: 'g' } } as never)
    expect(await ask({ engine: 'claude', cwd: '/w', resumeSessionId: 'ses_abc' })).toStrictEqual(fresh)
    vi.mocked(parseNewAgentModel).mockReturnValueOnce({ state: 'ok', selection: { model: 'm', grid: 'fixture-grid' } } as never)
    expect(await ask({ engine: 'claude', cwd: '/w', resumeSessionId: 'ses_abc' })).toStrictEqual(fresh)
    vi.mocked(installedDsh).mockReturnValueOnce({ id: 'acme/notes', manifest: { kind: 'agent' } } as never)
    expect(await ask({ engine: 'claude', cwd: '/w', dsh: 'acme/notes', resumeSessionId: 'ses_abc' })).toStrictEqual(fresh)
    expect(await ask({ engine: 'claude', cwd: '/w', prompt: 'go', resumeSessionId: 'ses_abc' })).toStrictEqual(fresh)
    expect(await ask({ engine: 'claude', cwd: '/w', agent: 'reviewer', resumeSessionId: 'ses_abc' })).toStrictEqual(fresh)
    const takeOver = { error: 'INVALID_SESSION', detail: 'takeOver is idle, now or wait, with a resumeSessionId' }
    expect(await ask({ engine: 'claude', cwd: '/w', takeOver: 'now' })).toStrictEqual(takeOver)
    expect(await ask({ engine: 'claude', cwd: '/w', resumeSessionId: 'ses_abc', takeOver: 'later' })).toStrictEqual(takeOver)
    expect(create).not.toHaveBeenCalled()
  })

  it('a starter that is not another agent: absent is the person, anything else is refused', async () => {
    const { ask, create } = setup()
    const refused = { error: 'INVALID_STARTED_BY', detail: 'startedBy is agent, or absent for the person' }
    expect(await ask({ engine: 'claude', cwd: '/w', startedBy: 'person' })).toStrictEqual(refused)
    expect(await ask({ engine: 'claude', cwd: '/w', startedBy: true })).toStrictEqual(refused)
    // Which harness started it: an agent id, and only beside startedBy agent.
    const noParent = { error: 'INVALID_STARTED_BY', detail: 'parentAgentId is the agent id of the harness that started it, with startedBy agent' }
    expect(await ask({ engine: 'claude', cwd: '/w', parentAgentId: 'a1' })).toStrictEqual(noParent)
    expect(await ask({ engine: 'claude', cwd: '/w', startedBy: 'agent', parentAgentId: '../a1' })).toStrictEqual(noParent)
    expect(await ask({ engine: 'claude', cwd: '/w', startedBy: 'agent', parentAgentId: 7 })).toStrictEqual(noParent)
    expect(create).not.toHaveBeenCalled()
  })
})

describe('agent_create, launched', () => {
  it('hands the creator every choice, as one input, and answers with the new agent\'s frame', async () => {
    vi.mocked(installedDsh).mockReturnValueOnce({ id: 'acme/notes', manifest: { kind: 'agent' } } as never)
    vi.mocked(permissionModeApproves).mockReturnValueOnce(true)
    const { ask, create } = setup()
    const reply = await ask({ engine: 'codex', cwd: '/w', codexHome: '/homes/codex', dsh: 'acme/notes', prompt: '  fix the build  ', name: '  Builder  ',
      agent: 'reviewer', permissionMode: 'auto' })
    expect(reply).toStrictEqual({ agent: { id: 'new-agent' } })
    expect(create).toHaveBeenCalledWith({ engine: 'codex', cwd: '/w', bypassPermission: true, permissionMode: 'auto', grid: null, codexHome: '/homes/codex',
      dsh: 'acme/notes', prompt: 'fix the build', name: 'Builder', agent: 'reviewer', resumeSessionId: null, takeOver: null })
    expect(Object.keys(vi.mocked(create!).mock.calls[0][0])).toEqual(['engine', 'cwd', 'bypassPermission', 'permissionMode', 'grid', 'codexHome', 'dsh', 'prompt', 'name', 'agent', 'resumeSessionId', 'takeOver'])
  })

  it('hands on that another agent started it, and nothing for the person, so their receipts\' fingerprints stay as they were', async () => {
    const { ask, create } = setup()
    await ask({ engine: 'claude', cwd: '/w', startedBy: 'agent' })
    await ask({ engine: 'claude', cwd: '/w', startedBy: null })
    const [byAgent, byPerson] = vi.mocked(create!).mock.calls.map(([input]) => input)
    expect(byAgent).toMatchObject({ engine: 'claude', cwd: '/w', startedBy: 'agent' })
    expect(Object.keys(byPerson!)).not.toContain('startedBy')
  })

  it('hands a Claude launch its model and effort, and nothing for default, so older receipts\' fingerprints stay as they were', async () => {
    const { ask, create } = setup()
    await ask({ engine: 'claude', cwd: '/w', model: 'opus', effort: 'high' })
    await ask({ engine: 'claude', cwd: '/w', model: 'default', effort: 'default' })
    await ask({ engine: 'claude', cwd: '/w' })
    const [routed, byDefault, plain] = vi.mocked(create!).mock.calls.map(([input]) => input)
    expect(routed).toMatchObject({ engine: 'claude', launchModel: { model: 'opus', effort: 'high' } })
    expect(Object.keys(byDefault!)).not.toContain('launchModel')
    expect(Object.keys(plain!)).not.toContain('launchModel')
  })

  it('refuses a launch model before any receipt when the installed engine lacks a flag, and proceeds when it has them', async () => {
    const { ask, create, deps } = setup()
    vi.mocked(unsupportedLaunchModelFlag).mockResolvedValueOnce('--effort')
    expect(await ask({ engine: 'claude', cwd: '/w', creationId: CREATION, model: 'opus', effort: 'high' }))
      .toMatchObject({ error: 'LAUNCH_MODEL_UNSUPPORTED', detail: expect.stringContaining('--effort') })
    expect(unsupportedLaunchModelFlag).toHaveBeenCalledWith('claude', { model: 'opus', effort: 'high' })
    expect(create).not.toHaveBeenCalled()
    expect(deps.receipts.has(CREATION, 'any')).toBe(false)
    expect(deps.receipts.pendingIntent(CREATION)).toBeFalsy()
    // The same creation id is then free to start the agent without them.
    vi.mocked(unsupportedLaunchModelFlag).mockResolvedValueOnce(null)
    await ask({ engine: 'claude', cwd: '/w', creationId: CREATION, model: 'opus', effort: 'high' })
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    expect(vi.mocked(create!).mock.calls[0][0]).toMatchObject({ launchModel: { model: 'opus', effort: 'high' } })
  })

  it('refuses a launch model its engine cannot take, a malformed one, and one beside a grid or a resumed conversation', async () => {
    const { ask, create } = setup()
    expect(await ask({ engine: 'codex', cwd: '/w', model: 'gpt-5', effort: 'high' })).toMatchObject({ error: 'LAUNCH_MODEL_UNSUPPORTED', detail: expect.stringContaining('codex') })
    expect(await ask({ engine: 'claude', cwd: '/w', model: 'opus; ls' })).toMatchObject({ error: 'INVALID_LAUNCH_MODEL' })
    expect(await ask({ engine: 'claude', cwd: '/w', effort: 'enormous' })).toMatchObject({ error: 'INVALID_LAUNCH_MODEL' })
    vi.mocked(parseGridLaunchOverride).mockReturnValueOnce({ state: 'ok', override: { networkName: 'g' } } as never)
    expect(await ask({ engine: 'claude', cwd: '/w', model: 'opus' })).toMatchObject({ error: 'INVALID_LAUNCH_MODEL', detail: expect.stringContaining('grid') })
    vi.mocked(parseNewAgentModel).mockReturnValueOnce({ state: 'ok', selection: { model: 'm', grid: 'g' } })
    expect(await ask({ engine: 'claude', cwd: '/w', model: 'opus' })).toMatchObject({ error: 'INVALID_LAUNCH_MODEL' })
    expect(await ask({ engine: 'claude', cwd: '/w', resumeSessionId: 'abc12345', model: 'opus' })).toMatchObject({ error: 'INVALID_SESSION' })
    expect(create).not.toHaveBeenCalled()
  })

  it('hands on which harness here started it, and leaves out one this machine does not know', async () => {
    const { ask, create } = setup()
    await ask({ engine: 'claude', cwd: '/w', startedBy: 'agent', parentAgentId: 'a1' })
    // Closed and forgotten while it ran `harness new`: its child still starts, beside nothing.
    await ask({ engine: 'claude', cwd: '/w', startedBy: 'agent', parentAgentId: 'gone' })
    await ask({ engine: 'claude', cwd: '/w', startedBy: 'agent', parentAgentId: null })
    const [known, unknown, none] = vi.mocked(create!).mock.calls.map(([input]) => input)
    expect(known).toMatchObject({ startedBy: 'agent', parentAgentId: 'a1' })
    expect(Object.keys(unknown!)).not.toContain('parentAgentId')
    expect(Object.keys(none!)).not.toContain('parentAgentId')
  })

  it('opens a terminal in the home folder, bypasses permission unless told not to, and takes blank choices as none', async () => {
    const { ask, create } = setup()
    vi.mocked(parseGridLaunchOverride).mockReturnValueOnce({ state: 'absent' } as never).mockReturnValueOnce({ state: 'ok', override: { networkId: 'g' } } as never)
    await ask({ engine: 'terminal' })
    await ask({ engine: 'claude', cwd: '/w', bypassPermission: false, prompt: '   ', name: '  ', dsh: null, agent: null, permissionMode: null, resumeSessionId: null, takeOver: null })
    await ask({ engine: 'claude', cwd: '/w', resumeSessionId: 'ses_abc', takeOver: 'idle' })
    const inputs = vi.mocked(create!).mock.calls.map(([input]) => input)
    expect(inputs[0]).toMatchObject({ engine: 'terminal', cwd: homedir(), bypassPermission: true })
    expect(inputs[1]).toMatchObject({ cwd: '/w', bypassPermission: false, prompt: null, name: null, grid: { networkId: 'g' } })
    expect(inputs[2]).toMatchObject({ resumeSessionId: 'ses_abc', takeOver: 'idle' })
  })

  it('points a model picked by name at its grid as read now, or says the model is unavailable', async () => {
    const { ask, create } = setup()
    vi.mocked(parseNewAgentModel).mockReturnValue({ state: 'ok', selection: { model: 'm', grid: 'fixture-grid' } } as never)
    resolveNewAgentModel.mockResolvedValueOnce({ networkId: 'resolved' } as never).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('offline'))
    await ask({ engine: 'claude', cwd: '/w' })
    expect(vi.mocked(create!).mock.calls[0][0].grid).toEqual({ networkId: 'resolved' })
    const unavailable = { error: 'GRID_UNAVAILABLE', detail: 'The selected model is unavailable. Choose another model or refresh the list.' }
    expect(await ask({ engine: 'claude', cwd: '/w' })).toStrictEqual(unavailable)
    expect(await ask({ engine: 'claude', cwd: '/w' })).toStrictEqual(unavailable)
    expect(create).toHaveBeenCalledOnce()
  })

  it('passes a refusal on with its cause when it has one', async () => {
    const refused = setup({}, { create: vi.fn(async () => ({ ok: false as const, error: 'SPAWN_FAILED', detail: 'tmux: no server' })) })
    expect(await refused.ask({ engine: 'claude', cwd: '/w' })).toStrictEqual({ error: 'SPAWN_FAILED', detail: 'tmux: no server' })
    const bare = setup({}, { create: vi.fn(async () => ({ ok: false as const, error: 'ENGINE_MISSING' })) })
    expect(await bare.ask({ engine: 'claude', cwd: '/w' })).toStrictEqual({ error: 'ENGINE_MISSING' })
  })
})

describe('agent_create with a receipt', () => {
  it('keeps a temporary model outage pending across receipt readers instead of completing it as failed', async () => {
    const { ask, create, replies, status } = setup()
    vi.mocked(parseNewAgentModel).mockReturnValue({ state: 'ok', selection: { model: 'fixture-model', grid: 'fixture-grid' } })
    resolveNewAgentModel.mockRejectedValueOnce(new Error('fixture models disconnected'))
    await ask({ engine: 'claude', cwd: '/fixture/work', creationId: CREATION })
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(create).not.toHaveBeenCalled()
    expect(replies[0]).toMatchObject({ creationId: CREATION, state: 'pending', held: { service: 'models', detail: expect.any(String) } })
    expect(await status({ creationId: CREATION })).toMatchObject({ state: 'pending', held: { service: 'models' } })
    const recovered = new AgentCreationReceipts(join(dir, `receipts-${stores}`))
    expect(recovered.status(CREATION)).toMatchObject({ state: 'pending', held: { service: 'models' } })
  })

  it('recovers the original request and authorization after restart, then returns the same created agent', async () => {
    const { ask, replies, deps, create } = setup()
    const cwd = join(root.projects, 'remote-request'); mkdirSync(cwd)
    vi.mocked(parseNewAgentModel).mockReturnValue({ state: 'ok', selection: { model: 'fixture-model', grid: 'fixture-grid' } })
    resolveNewAgentModel.mockRejectedValueOnce(new Error('disconnected'))
    await ask({ engine: 'claude', cwd, prompt: 'Keep this task', creationId: CREATION }, false)
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    const recovered = createLaunchRequests({ ...deps, receipts: new AgentCreationReceipts(join(dir, `receipts-${stores}`)) })
    stopRequests.push(recovered.stop)
    const target = { networkId: 'fixture-grid', networkName: 'Fixture', baseUrl: 'http://fixture.invalid/v1', apiKey: 'rotated-key' }
    resolveNewAgentModel.mockResolvedValue(target)
    await recovered.recover()
    expect(create).not.toHaveBeenCalled()
    recovered.open()
    await recovered.recover()
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ cwd, prompt: 'Keep this task', grid: target }))
    expect(preTrustClaudeProject).not.toHaveBeenCalled()
    const answer = vi.fn()
    await recovered.createStatus({ creationId: CREATION }, { local: true }, answer)
    expect(answer).toHaveBeenCalledWith({ creationId: CREATION, state: 'created', agent: { id: 'new-agent' } })
    await recovered.recover()
    expect(create).toHaveBeenCalledOnce()
  })

  it('cancels an undispatched model request durably and refuses a late create with the same ID', async () => {
    const { ask, requests, create, replies } = setup()
    vi.mocked(parseNewAgentModel).mockReturnValue({ state: 'ok', selection: { model: 'fixture-model', grid: 'fixture-grid' } })
    resolveNewAgentModel.mockResolvedValue(null)
    await ask({ engine: 'claude', cwd: '/fixture/work', creationId: CREATION })
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    const answer = vi.fn()
    await requests.cancelCreate({ creationId: CREATION }, { local: true }, answer)
    expect(answer).toHaveBeenLastCalledWith({ creationId: CREATION, state: 'cancelled' })
    resolveNewAgentModel.mockResolvedValue({ networkId: 'fixture-grid' } as never)
    requests.open(); await requests.recover()
    await ask({ engine: 'claude', cwd: '/fixture/work', creationId: CREATION })
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(replies[1]).toEqual({ creationId: CREATION, state: 'cancelled' })
    expect(create).not.toHaveBeenCalled()
  })

  it('reads a completed receipt before checking mutable package or native version state', async () => {
    const { ask, replies, create } = setup()
    vi.mocked(installedDsh).mockReturnValue({ id: 'fixture/package', manifest: { kind: 'agent', name: 'Fixture' } } as never)
    await ask({ engine: 'claude', cwd: '/fixture/work', dsh: 'fixture/package', agent: 'named', creationId: CREATION })
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    vi.mocked(installedDsh).mockReturnValue(undefined)
    vi.mocked(supportsNamedAgent).mockReturnValue(false)
    await ask({ engine: 'claude', cwd: '/fixture/work', dsh: 'fixture/package', agent: 'named', creationId: CREATION })
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(replies[1]).toEqual(replies[0])
    expect(create).toHaveBeenCalledOnce()
  })

  it('answers outside the connection\'s line, with the creation id and the new agent, and a retry is the same launch', async () => {
    let finish!: (value: { ok: true; session: RegisteredSession }) => void
    const create = vi.fn(() => new Promise<{ ok: true; session: RegisteredSession }>((resolve) => { finish = resolve }))
    const { ask, replies, status } = setup({}, { create })
    await ask({ engine: 'claude', cwd: '/w', creationId: CREATION })
    expect(replies).toEqual([])
    expect(await status({ creationId: CREATION })).toStrictEqual({ creationId: CREATION, state: 'pending' })
    finish({ ok: true, session: session('new-agent') })
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(replies[1]).toStrictEqual({ creationId: CREATION, state: 'created', agent: { id: 'new-agent' } })
    expect(Object.keys(replies[1])).toEqual(['creationId', 'state', 'agent'])
    await ask({ engine: 'claude', cwd: '/w', creationId: CREATION })
    await vi.waitFor(() => expect(replies).toHaveLength(3))
    expect(create).toHaveBeenCalledOnce()
    // The same id for another launch is a conflict, never a second process.
    await ask({ engine: 'codex', cwd: '/w', creationId: CREATION })
    expect(replies.at(-1)).toStrictEqual({ error: 'CREATION_CONFLICT' })
  })

  it('records a launch that may have started as unconfirmed, and any other refusal as failed, with its folder and its cause, cut short', async () => {
    for (const [error, expected] of [['SPAWN_FAILED', 'unconfirmed'], ['REGISTRATION_FAILED', 'unconfirmed'], ['ENGINE_MISSING', 'failed']] as const) {
      const { ask, replies } = setup({}, { create: vi.fn(async () => ({ ok: false as const, error, detail: 'd'.repeat(3000) })) })
      await ask({ engine: 'claude', cwd: '/w', creationId: `${CREATION}-${error.toLowerCase()}`.slice(0, 64).replace(/_/g, '-') })
      await vi.waitFor(() => expect(replies).toHaveLength(1))
      expect(replies[0].state).toBe(expected)
      if (expected === 'failed') expect(replies[0]).toStrictEqual({ creationId: expect.any(String), state: 'failed', failure: { code: 'ENGINE_MISSING', detail: 'd'.repeat(2000) } })
    }
    const bare = setup({}, { create: vi.fn(async () => ({ ok: false as const, error: 'ENGINE_MISSING' })) })
    await bare.ask({ engine: 'claude', cwd: '/w', creationId: CREATION })
    await vi.waitFor(() => expect(bare.replies).toStrictEqual([{ creationId: CREATION, state: 'failed', failure: { code: 'ENGINE_MISSING' } }]))
  })

  it('prepares the project folder it was asked for, named after the harness or the engine, and launches in it', async () => {
    const { ask, create, replies } = setup()
    vi.mocked(installedDsh).mockReturnValue({ id: 'acme/notes', manifest: { kind: 'agent', name: 'Notes' } } as never)
    await ask({ engine: 'claude', projectSource: 'new', projectName: 'Docs', creationId: CREATION, dsh: 'acme/notes' })
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(prepareProjectFolder).toHaveBeenCalledWith({ source: 'new', name: 'Docs' }, { label: 'Notes', onPrepared: expect.any(Function) })
    expect(vi.mocked(create!).mock.calls[0][0].cwd).toBe('/projects/prepared')
    vi.mocked(installedDsh).mockReturnValue(undefined)
    await ask({ engine: 'pi', projectSource: 'new', creationId: `${CREATION}-pi` })
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(prepareProjectFolder).toHaveBeenLastCalledWith({ source: 'new' }, { label: 'Pi', onPrepared: expect.any(Function) })
    expect(vi.mocked(create!).mock.calls[1][0].scmLaunchRecord).toBeNull()
  })

  it('hands the launch the SCM record the prepared workspace reported (registry `scmLaunch`)', async () => {
    const { ask, create, replies } = setup()
    vi.mocked(prepareProjectFolder).mockImplementationOnce(async (_project, options) => {
      options?.onPrepared?.({ cwd: '/projects/prepared', scmLaunchRecord: { kind: 'git' } })
      return '/projects/prepared'
    })
    await ask({ engine: 'claude', projectSource: 'worktree', gitSource: '/work/repo', branchRef: 'refs/heads/main', creationId: CREATION })
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(vi.mocked(create!).mock.calls[0][0]).toMatchObject({ cwd: '/projects/prepared', scmLaunchRecord: { kind: 'git' } })
  })

  it('fetches nothing with this machine\'s login for another person\'s Swarm worktree: its host already fetched with the app\'s token', async () => {
    const { ask, replies } = setup()
    await ask({ engine: 'codex', projectSource: 'worktree', gitSource: '/swarm/project', branchName: 'super-tab/start-1', branchBase: 'default',
      swarmRole: 'dev', swarmGitHub: true, creationId: CREATION })
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(prepareProjectFolder).toHaveBeenLastCalledWith({ source: 'worktree', gitSource: '/swarm/project', branchName: 'super-tab/start-1',
      fromDefaultBranch: true, offline: true }, expect.anything())
    // A Swarm start that is the machine owner's own fetches as before.
    await ask({ engine: 'codex', projectSource: 'worktree', gitSource: '/swarm/project', branchName: 'super-tab/start-2', branchBase: 'default',
      swarmRole: 'dev', creationId: `${CREATION}-own` })
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(vi.mocked(prepareProjectFolder).mock.calls.at(-1)![0]).not.toHaveProperty('offline')
  })

  it('records a folder it could not prepare as failed, in the folder\'s own words when it has them', async () => {
    const { ask, create, replies } = setup()
    vi.mocked(prepareProjectFolder).mockRejectedValueOnce(new ProjectFolderError('CLONE_FAILED', 'Could not clone it.')).mockRejectedValueOnce(new Error('disk full'))
    await ask({ engine: 'claude', projectSource: 'new', creationId: CREATION })
    await ask({ engine: 'claude', projectSource: 'new', creationId: `${CREATION}-2` })
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(replies.map((r) => r.failure)).toEqual([
      { code: 'CLONE_FAILED', detail: 'Could not clone it.' }, { code: 'PROJECT_PREPARATION_FAILED', detail: 'Could not prepare the project folder.' },
    ])
    expect(create).not.toHaveBeenCalled()
  })

  it('records the folder a typed name found already there, so the apps can offer to start in it', async () => {
    const { ask, status, create, replies } = setup()
    vi.mocked(prepareProjectFolder).mockRejectedValueOnce(new ProjectFolderError('PROJECT_EXISTS', '“payments” already exists.', '/projects/payments'))
    await ask({ engine: 'claude', projectSource: 'new', projectName: 'payments', creationId: CREATION })
    const refused = { creationId: CREATION, state: 'failed', failure: { code: 'PROJECT_EXISTS', detail: '“payments” already exists.', existingFolder: '/projects/payments' } }
    await vi.waitFor(() => expect(replies).toStrictEqual([refused]))
    // Kept with the receipt: asked again, the answer is the same.
    expect(await status({ creationId: CREATION })).toStrictEqual(refused)
    expect(create).not.toHaveBeenCalled()
  })

  it('records the prepared folder of a launch that then failed, so the person can open it', async () => {
    const { ask, replies } = setup({}, { create: vi.fn(async () => ({ ok: false as const, error: 'ENGINE_MISSING' })) })
    await ask({ engine: 'claude', projectSource: 'new', creationId: CREATION })
    await vi.waitFor(() => expect(replies).toStrictEqual([{ creationId: CREATION, state: 'failed', preparedFolder: '/projects/prepared', failure: { code: 'ENGINE_MISSING' } }]))
  })

  it('waits for a new project\'s engine to be installed before making its folder, then launches in it', async () => {
    // A fresh Ubuntu VM (2026-10-12): `harness new codex scratch1` was refused at once, its folder made, saying the
    // launch would continue after the install; nothing did, and the folder then refused the same command.
    const installing = { ok: false as const, error: 'NATIVE_LAUNCH_HELD' as const, unavailable: 'native' as const, installing: true as const,
      detail: 'Installing Codex. The harness starts once it is installed.' }
    const prepareEngine = vi.fn<NonNullable<LaunchRequestDeps['prepareEngine']>>().mockResolvedValueOnce(installing)
      .mockResolvedValue({ ok: true, launch: {} as never })
    const dispatch = vi.fn(async () => ({ ok: true as const, session: session('new-agent') }))
    const prepareCreate = vi.fn<NonNullable<LaunchRequestDeps['prepareCreate']>>(async () => ({ ok: true, dispatch }))
    const { ask, replies, create, deps } = setup({ prepareCreate, prepareEngine })
    const payload = { engine: 'codex', projectSource: 'new', projectName: 'scratch1', creationId: CREATION, prompt: 'Reply with pong' }
    await ask(payload)
    await vi.waitFor(() => expect(replies[0]).toMatchObject({ state: 'pending', held: { service: 'install', detail: installing.detail } }))
    expect(prepareProjectFolder).not.toHaveBeenCalled()
    expect(deps.receipts.pendingIntent(CREATION)!.request).toMatchObject({ projectFolder: { source: 'new', name: 'scratch1' }, input: { cwd: '' } })
    await ask(payload)
    await vi.waitFor(() => expect(replies[1]).toMatchObject({ state: 'created', agent: { id: 'new-agent' } }))
    expect(prepareEngine).toHaveBeenCalledWith('codex', expect.objectContaining({ prompt: 'Reply with pong' }), expect.objectContaining({ id: CREATION }))
    expect(prepareProjectFolder).toHaveBeenCalledOnce()
    expect(prepareCreate).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/projects/prepared', prompt: 'Reply with pong' }),
      expect.objectContaining({ id: CREATION, label: expect.stringMatching(/^harness-codex-/) }), { local: true })
    expect(dispatch).toHaveBeenCalledOnce()
    expect(create).not.toHaveBeenCalled()
  })

  it('makes no folder for a new project cancelled while its engine was being made ready', async () => {
    let prepare!: Parameters<typeof pendingLaunches.createPendingLaunches>[0]['prepare']
    const factory = pendingLaunches.createPendingLaunches
    vi.spyOn(pendingLaunches, 'createPendingLaunches').mockImplementation(deps => { prepare = deps.prepare; return factory(deps) })
    let current = true
    const prepareEngine = vi.fn<NonNullable<LaunchRequestDeps['prepareEngine']>>(async () => { current = false; return { ok: true, launch: {} as never } })
    setup({ prepareCreate: vi.fn(), prepareEngine })
    expect(await prepare({ kind: 'native-create-v1', input: { engine: 'codex', cwd: '' }, projectFolder: { source: 'new', name: 'scratch1' },
      label: 'harness-codex-fixture', local: true }, { id: CREATION, current: () => current, hold: vi.fn() })).toBeNull()
    expect(prepareProjectFolder).not.toHaveBeenCalled()
  })

  it('refuses a new project for a harness it does not have at once, before any engine install or folder', async () => {
    const prepareEngine = vi.fn<NonNullable<LaunchRequestDeps['prepareEngine']>>()
    const prepareCreate = vi.fn<NonNullable<LaunchRequestDeps['prepareCreate']>>()
    const { ask, deps } = setup({ prepareCreate, prepareEngine })
    expect(await ask({ engine: 'codex', projectSource: 'new', projectName: 'scratch1', creationId: CREATION, dsh: 'acme/notes' }))
      .toStrictEqual({ error: 'INVALID_DSH', detail: 'acme/notes is not installed on this machine' })
    expect(deps.receipts.status(CREATION)).toEqual({ state: 'missing' })
    expect(prepareEngine).not.toHaveBeenCalled()
    expect(prepareProjectFolder).not.toHaveBeenCalled()
  })

  it('refuses a new project whose engine could not be installed, before any folder exists', async () => {
    const prepareEngine = vi.fn<NonNullable<LaunchRequestDeps['prepareEngine']>>(async () => ({ ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native',
      refusal: 'ENGINE_INSTALL_FAILED', detail: 'Codex could not be installed: getaddrinfo ENOTFOUND registry.npmjs.org' }))
    const prepareCreate = vi.fn<NonNullable<LaunchRequestDeps['prepareCreate']>>()
    const { ask, replies } = setup({ prepareCreate, prepareEngine })
    await ask({ engine: 'codex', projectSource: 'new', projectName: 'scratch1', creationId: CREATION })
    await vi.waitFor(() => expect(replies).toStrictEqual([{ creationId: CREATION, state: 'failed',
      failure: { code: 'ENGINE_INSTALL_FAILED', detail: 'Codex could not be installed: getaddrinfo ENOTFOUND registry.npmjs.org' } }]))
    expect(prepareProjectFolder).not.toHaveBeenCalled()
    expect(prepareCreate).not.toHaveBeenCalled()
  })

  it('removes the empty folder a new project made when nothing starts in it, and keeps one that has anything', async () => {
    const made = join(root.projects, 'scratch1')
    vi.mocked(prepareProjectFolder).mockImplementation(async () => { mkdirSync(made); return made })
    const prepareCreate = vi.fn<NonNullable<LaunchRequestDeps['prepareCreate']>>(async () => ({ ok: false, error: 'CODEX_CLI_TOO_OLD', detail: 'Update codex.' }))
    const { ask, replies } = setup({ prepareCreate })
    await ask({ engine: 'codex', projectSource: 'new', projectName: 'scratch1', creationId: CREATION })
    await vi.waitFor(() => expect(replies).toStrictEqual([{ creationId: CREATION, state: 'failed', failure: { code: 'CODEX_CLI_TOO_OLD', detail: 'Update codex.' } }]))
    expect(existsSync(made)).toBe(false)
    prepareCreate.mockImplementationOnce(async () => { writeFileSync(join(made, 'notes.md'), 'kept'); return { ok: false, error: 'CODEX_CLI_TOO_OLD' } })
    await ask({ engine: 'codex', projectSource: 'new', projectName: 'scratch1', creationId: `${CREATION}-2` })
    await vi.waitFor(() => expect(replies[1]).toStrictEqual({ creationId: `${CREATION}-2`, state: 'failed', preparedFolder: made, failure: { code: 'CODEX_CLI_TOO_OLD' } }))
    expect(existsSync(join(made, 'notes.md'))).toBe(true)
  })

  it('holds a launch whose engine Harness is installing under install', async () => {
    const prepareCreate = vi.fn<NonNullable<LaunchRequestDeps['prepareCreate']>>(async () => ({ ok: false, error: 'NATIVE_LAUNCH_HELD',
      unavailable: 'native', installing: true, detail: 'Installing Codex. The harness starts once it is installed.' }))
    const { ask, replies } = setup({ prepareCreate })
    await ask({ engine: 'codex', cwd: '/fixture/work', creationId: CREATION })
    await vi.waitFor(() => expect(replies[0]).toMatchObject({ state: 'pending', held: { service: 'install', detail: 'Installing Codex. The harness starts once it is installed.' } }))
  })

  it('holds a create while Desktop Harness downloads its engine, and creates it once by itself when the download ends', async () => {
    // A brand-new Mac (2026-10-16): the Desktop sends agent_create as soon as its own download of Codex is under way.
    // The launch is held as an install, tried again every two seconds with nobody asking, and dispatched once.
    let downloading = true, clock = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const missing: NativeLaunchResult = { ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native', detail: 'Not installed',
      install: { command: 'fixture-installer', source: 'fixture', executable: { names: ['codex'] } }, environment: { HOME: '/fixture/home' } }
    const inspect = vi.fn(async (): Promise<NativeLaunchResult> => downloading ? missing : { ok: true, launch: {} as never })
    const ensure = vi.fn()
    // Read as it is asked: an attempt keeps the answer it was given, whatever the test says after.
    const downloadingNow = vi.fn(async () => downloading)
    const prepareEngine = createNativeLaunchPreparer({ installations: { ensure, status: vi.fn(async () => null) }, inspect, downloading: downloadingNow })
    const dispatch = vi.fn(async () => ({ ok: true as const, session: session('new-agent') }))
    const prepareCreate = vi.fn<NonNullable<LaunchRequestDeps['prepareCreate']>>(async () => ({ ok: true, dispatch }))
    const { ask, replies, requests, deps } = setup({ prepareCreate, prepareEngine })
    await ask({ engine: 'codex', projectSource: 'new', projectName: 'scratch1', creationId: CREATION })
    await vi.waitFor(() => expect(replies[0]).toMatchObject({ state: 'pending',
      held: { service: 'install', detail: 'Downloading Codex. The harness starts once it is downloaded.' } }))
    requests.open()
    // Still downloading: asked again and held again, nothing installed beside it, no folder, nothing created.
    clock += 3_000; await requests.recover()
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(downloadingNow).toHaveBeenCalledTimes(2))
    expect(deps.receipts.status(CREATION)).toMatchObject({ state: 'pending', held: { service: 'install' } })
    expect(prepareProjectFolder).not.toHaveBeenCalled()
    // The download ends: the next pass creates it.
    downloading = false
    clock += 3_000; await requests.recover()
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(deps.receipts.status(CREATION)).toEqual({ state: 'created', agentId: 'new-agent' }))
    // Once: later passes find nothing to do.
    for (let pass = 0; pass < 3; pass++) { clock += 3_000; await requests.recover() }
    await settle()
    expect(dispatch).toHaveBeenCalledOnce()
    expect(prepareProjectFolder).toHaveBeenCalledOnce()
    expect(ensure).not.toHaveBeenCalled()
  })

  it('trusts only a folder it just made empty, or a worktree of a repository the engine already trusts', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ask, replies } = setup()
    const launch = async (payload: Record<string, unknown>, n: number) => { await ask({ creationId: `${CREATION}-${n}`, ...payload }); await vi.waitFor(() => expect(replies).toHaveLength(n)) }
    await launch({ engine: 'claude', projectSource: 'new' }, 1)
    expect(preTrustClaudeProject).toHaveBeenCalledWith('/projects/prepared')
    vi.mocked(codexTrusts).mockReturnValueOnce(true)
    await launch({ engine: 'codex', projectSource: 'worktree', gitSource: '/repo', branchName: 'feature' }, 2)
    expect(codexTrusts).toHaveBeenCalledWith('/repo', null)
    expect(preTrustCodexProject).toHaveBeenCalledWith('/projects/prepared', null)
    await launch({ engine: 'claude', projectSource: 'worktree', gitSource: '/repo', branchName: 'feature' }, 3)
    await launch({ engine: 'claude', projectSource: 'branch', gitSource: '/repo', branchRef: 'refs/heads/main' }, 4)
    await launch({ engine: 'pi', projectSource: 'new' }, 5)
    expect(preTrustClaudeProject).toHaveBeenCalledOnce()
    expect(preTrustCodexProject).toHaveBeenCalledOnce()
    vi.mocked(preTrustClaudeProject).mockImplementationOnce(() => { throw new Error('config locked') }).mockImplementationOnce(() => { throw 'busy' })
    await launch({ engine: 'claude', projectSource: 'new' }, 6)
    await launch({ engine: 'claude', projectSource: 'new' }, 7)
    expect(console.warn).toHaveBeenCalledWith('[agent] pre-trust /projects/prepared · config locked')
    expect(console.warn).toHaveBeenCalledWith('[agent] pre-trust /projects/prepared · busy')
    expect(claudeTrusts).toHaveBeenCalledWith('/repo')
  })

  // WIN-DELL and the Mac Studio, 2026-10-26: Swarm Leads in a reused or fresh checkout of the project's repository sat at
  // Claude Code's trust question, and so did the next Lead in a worktree of it, its source never answered.
  it('trusts a Swarm agent\'s checkout of its remote project in the Swarm\'s full mode, and no other existing folder', async () => {
    const { ask, replies } = setup()
    const launch = async (payload: Record<string, unknown>, n: number) => { await ask({ creationId: `${CREATION}-${n}`, ...payload }); await vi.waitFor(() => expect(replies).toHaveLength(n)) }
    const remote = { projectSource: 'remote', repositoryUrl: 'https://github.com/acme/app.git' }
    await launch({ engine: 'claude', ...remote, swarmRole: 'lead', permissionMode: 'full' }, 1)
    expect(preTrustClaudeProject).toHaveBeenCalledWith('/projects/prepared')
    // The guard: the same checkout outside a Swarm or outside full mode, and a Swarm agent in a folder it was handed.
    await launch({ engine: 'claude', ...remote, permissionMode: 'full' }, 2)
    await launch({ engine: 'claude', ...remote, swarmRole: 'lead', permissionMode: 'auto' }, 3)
    await launch({ engine: 'claude', cwd: dir, swarmRole: 'lead', permissionMode: 'full' }, 4)
    await launch({ engine: 'claude', projectSource: 'worktree', gitSource: '/elsewhere', branchName: 'feature', swarmRole: 'lead', permissionMode: 'full' }, 5)
    expect(preTrustClaudeProject).toHaveBeenCalledOnce()
    // Claude Code only: a Codex Lead's checkout is not trusted for it.
    await launch({ engine: 'codex', ...remote, swarmRole: 'lead', permissionMode: 'full' }, 6)
    expect(preTrustCodexProject).not.toHaveBeenCalled()
    // A worktree made from that checkout then inherits its answer.
    vi.mocked(claudeTrusts).mockImplementation(path => path === '/projects/prepared')
    await launch({ engine: 'claude', projectSource: 'worktree', gitSource: '/projects/prepared', branchName: 'feature', swarmRole: 'lead', permissionMode: 'full' }, 7)
    expect(preTrustClaudeProject).toHaveBeenCalledTimes(2)
  })

  // A Codex agent on its own profile reads its trust from THAT profile's config.toml: the trust was
  // read and written in ~/.codex alone, so it got Codex's trust prompt in a folder Harness had just made.
  it('asks and records a Codex agent\'s trust in its own profile', async () => {
    const { ask, replies } = setup()
    const empty = join(root.projects, 'fresh-profile')
    mkdirSync(empty)
    vi.mocked(codexTrusts).mockReturnValueOnce(true)
    await ask({ creationId: `${CREATION}-1`, engine: 'codex', codexHome: '/profiles/work', projectSource: 'worktree', gitSource: '/repo', branchName: 'feature' })
    await ask({ creationId: `${CREATION}-2`, engine: 'codex', codexHome: '/profiles/work', cwd: empty })
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(codexTrusts).toHaveBeenCalledWith('/repo', '/profiles/work')
    expect(preTrustCodexProject).toHaveBeenNthCalledWith(1, '/projects/prepared', '/profiles/work')
    expect(preTrustCodexProject).toHaveBeenNthCalledWith(2, empty, '/profiles/work')
  })

  it('trusts an empty workspace this machine\'s own window made in the projects folder, and nothing else', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ask, replies } = setup()
    const empty = join(root.projects, 'fresh')
    const filled = join(root.projects, 'filled')
    mkdirSync(empty)
    mkdirSync(filled)
    writeFileSync(join(filled, 'README.md'), 'mine')
    const launch = async (payload: Record<string, unknown>, local: boolean, n: number) => { await ask({ creationId: `${CREATION}-${n}`, ...payload }, local); await vi.waitFor(() => expect(replies).toHaveLength(n)) }
    await launch({ engine: 'claude', cwd: empty }, true, 1)
    await launch({ engine: 'codex', cwd: empty }, true, 2)
    expect(preTrustClaudeProject).toHaveBeenCalledWith(empty)
    expect(preTrustCodexProject).toHaveBeenCalledWith(empty, null)
    await launch({ engine: 'claude', cwd: filled }, true, 3)
    await launch({ engine: 'claude', cwd: join(root.projects, 'missing') }, true, 4)
    await launch({ engine: 'claude', cwd: empty }, false, 5)
    await launch({ engine: 'claude', cwd: dir }, true, 6)
    await launch({ engine: 'pi', cwd: empty }, true, 7)
    vi.mocked(installedDsh).mockReturnValueOnce({ id: 'acme/notes', manifest: { kind: 'agent' } } as never)
    await launch({ engine: 'claude', cwd: empty, dsh: 'acme/notes' }, true, 8)
    expect(preTrustClaudeProject).toHaveBeenCalledOnce()
    expect(preTrustCodexProject).toHaveBeenCalledOnce()
    vi.mocked(preTrustCodexProject).mockImplementationOnce(() => { throw new Error('config locked') }).mockImplementationOnce(() => { throw 'busy' })
    await launch({ engine: 'codex', cwd: empty }, true, 9)
    await launch({ engine: 'codex', cwd: empty }, true, 10)
    expect(warn).toHaveBeenCalledWith(`[agent] pre-trust ${empty} · config locked`)
    expect(warn).toHaveBeenCalledWith(`[agent] pre-trust ${empty} · busy`)
  })

  it('resolves a model picked by name inside the receipt, and holds it when it cannot be read', async () => {
    const { ask, create, replies } = setup()
    vi.mocked(parseNewAgentModel).mockReturnValue({ state: 'ok', selection: { model: 'm', grid: 'fixture-grid' } } as never)
    resolveNewAgentModel.mockResolvedValueOnce({ networkId: 'resolved' } as never).mockRejectedValueOnce(new Error('offline'))
    await ask({ engine: 'claude', cwd: '/w', creationId: CREATION })
    await ask({ engine: 'claude', cwd: '/w', creationId: `${CREATION}-2` })
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(vi.mocked(create!).mock.calls[0][0].grid).toEqual({ networkId: 'resolved' })
    expect(replies.find(reply => reply.creationId === `${CREATION}-2`)).toMatchObject({ creationId: `${CREATION}-2`, state: 'pending', held: { service: 'models' } })
  })

  it('says why a receipt could not be kept, and answers INTERNAL when the answer cannot be put together', async () => {
    const storage = setup({ receipts: { has: vi.fn(() => false), creator: vi.fn(), createdLaunchModel: vi.fn(() => null), runIntent: vi.fn(), pendingIntents: vi.fn(), pendingIntent: vi.fn(), cancelIntent: vi.fn(), status: vi.fn(), run: vi.fn(() => { throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED') }) } })
    expect(await storage.ask({ engine: 'claude', cwd: '/w', creationId: CREATION })).toStrictEqual({ error: 'CREATION_STORAGE_FAILED' })
    const broken = setup({ receipts: { has: vi.fn(() => false), creator: vi.fn(), createdLaunchModel: vi.fn(() => null), runIntent: vi.fn(), pendingIntents: vi.fn(), pendingIntent: vi.fn(), cancelIntent: vi.fn(), status: vi.fn(), run: vi.fn(() => { throw new Error('bug') }) } })
    expect(await broken.ask({ engine: 'claude', cwd: '/w', creationId: CREATION })).toStrictEqual({ error: 'INTERNAL' })
    const frameless = setup({ toProject: vi.fn(async () => { throw new Error('no frame') }) })
    await frameless.ask({ engine: 'claude', cwd: '/w', creationId: CREATION })
    await vi.waitFor(() => expect(frameless.replies).toStrictEqual([{ error: 'INTERNAL' }]))
  })
})

describe('durable model request validation', () => {
  it('retains canonical DSH identity for old-name requests and existing v1 fingerprints', async () => {
    const { ask, deps, create, replies } = setup()
    vi.mocked(installedDsh).mockReturnValue({ id: 'acme/current', manifest: { kind: 'agent', formerly: ['acme/former'] } } as never)
    const input = { engine: 'claude', cwd: '/w', bypassPermission: false, permissionMode: null,
      grid: null, codexHome: null, dsh: 'acme/current', prompt: null, name: null, agent: null, resumeSessionId: null, takeOver: null }
    await deps.receipts.run(CREATION, creationFingerprint(input), async () => ({ state: 'created', agentId: 'new-agent' }))
    const payload = { engine: 'claude', cwd: '/w', dsh: 'acme/former', creationId: CREATION, bypassPermission: false }
    await ask(payload)
    await vi.waitFor(() => expect(replies.at(-1)).toMatchObject({ state: 'created' }))
    expect(create).not.toHaveBeenCalled()
    await ask({ ...payload, creationId: `${CREATION}-new` })
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(create).toHaveBeenCalledWith(input)
  })
  it('keeps fresh legacy installation refusals correctable with the same ID', async () => {
    const { ask, replies, deps } = setup()
    const payload = { engine: 'claude', cwd: '/w', dsh: 'acme/notes', creationId: CREATION }
    expect(await ask(payload)).toMatchObject({ error: 'INVALID_DSH' })
    expect(deps.receipts.status(CREATION)).toEqual({ state: 'missing' })
    vi.mocked(installedDsh).mockReturnValue({ id: 'acme/notes', manifest: { kind: 'agent' } } as never)
    await ask(payload)
    await vi.waitFor(() => expect(replies.at(-1)).toMatchObject({ state: 'created' }))
  })

  it('reports a current installation refusal after the model becomes available', async () => {
    const { ask, replies, create } = setup()
    vi.mocked(parseNewAgentModel).mockReturnValue({ state: 'ok', selection: { model: 'm', grid: 'fixture-grid' } })
    resolveNewAgentModel.mockResolvedValue({ networkId: 'resolved' } as never)
    await ask({ engine: 'claude', cwd: '/w', dsh: 'acme/notes', creationId: CREATION })
    await vi.waitFor(() => expect(replies.at(-1)).toMatchObject({ state: 'failed', failure: { code: 'INVALID_DSH' } }))
    expect(create).not.toHaveBeenCalled()
  })

  it('holds unfamiliar or incomplete saved intent without preparing a project or dispatching', async () => {
    const prepareCreate = vi.fn<NonNullable<LaunchRequestDeps['prepareCreate']>>()
    const { deps, requests, create } = setup({ prepareCreate })
    const records = [{ kind: 'future-kind' }, { kind: 'model-create-v1', local: true, input: {}, selection: {} },
      { kind: 'native-create-v1' }, { kind: 'native-create-v1', local: true, input: {}, label: 'harness-claude-fixture' },
      { kind: 'native-create-v1', local: true, input: { engine: 'claude', cwd: '' }, label: 'harness-claude-fixture', projectFolder: { source: 7 } }]
    const held = { service: 'models', detail: 'Waiting for the model.' }
    for (const [n, request] of records.entries()) {
      await deps.receipts.runIntent(`${CREATION}-${n}`, creationFingerprint(request), request, held, async () => null)
    }
    const retry = vi.spyOn(deps.receipts, 'runIntent')
    requests.open(); await requests.recover()
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(records.length))
    for (let n = 0; n < records.length; n++) expect(deps.receipts.status(`${CREATION}-${n}`)).toEqual({ state: 'pending', held })
    expect(resolveNewAgentModel).not.toHaveBeenCalled()
    expect(prepareProjectFolder).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(prepareCreate).not.toHaveBeenCalled()
  })

  it('holds recovery while no local creator is available', async () => {
    const { deps, requests } = setup({}, { create: null })
    const request = { kind: 'model-create-v1', local: true, input: { engine: 'claude', cwd: '/w', grid: null }, selection: { grid: 'fixture-grid', model: 'm' } }
    const held = { service: 'models', detail: 'Waiting for the model.' }
    await deps.receipts.runIntent(CREATION, creationFingerprint(request), request, held, async () => null)
    const retry = vi.spyOn(deps.receipts, 'runIntent')
    requests.open(); await requests.recover()
    await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce())
    expect(deps.receipts.status(CREATION)).toEqual({ state: 'pending', held })
    expect(resolveNewAgentModel).not.toHaveBeenCalled()
  })

  it('rejects invalid cancellation IDs and reports storage uncertainty without acknowledging cancellation', async () => {
    const { deps, requests } = setup()
    const answer = vi.fn()
    await requests.cancelCreate({ creationId: '../invalid' }, { local: true }, answer)
    expect(answer).toHaveBeenLastCalledWith({ error: 'INVALID_CREATION_ID' })
    const cancel = vi.spyOn(deps.receipts, 'cancelIntent')
    cancel.mockImplementationOnce(() => { throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED') })
    await requests.cancelCreate({ creationId: CREATION }, { local: true }, answer)
    expect(answer).toHaveBeenLastCalledWith({ error: 'CREATION_STORAGE_FAILED' })
    cancel.mockImplementationOnce(() => { throw new Error('unknown') })
    await requests.cancelCreate({ creationId: CREATION }, { local: true }, answer)
    expect(answer).toHaveBeenLastCalledWith({ error: 'INTERNAL' })
  })
})

describe('agent_create_status', () => {
  it('reports the model and effort flags saved by a completed native launch', async () => {
    const { status, deps } = setup()
    const request = { kind: 'native-create-v1', input: { launchModel: { model: 'opus', effort: 'high' } } }
    await deps.receipts.runIntent(CREATION, creationFingerprint(request), request,
      { service: 'launch', detail: 'Preparing.' }, async () => async () => ({ state: 'created', agentId: 'new-agent' }))
    expect(await status({ creationId: CREATION })).toStrictEqual({ creationId: CREATION, state: 'created', agent: { id: 'new-agent' },
      launchModel: { model: 'opus', effort: 'high' } })
  })

  it('names a launch by a valid creation id, and says what became of it', async () => {
    const { status, deps } = setup()
    expect(await status({ creationId: 'short' })).toStrictEqual({ error: 'INVALID_CREATION_ID' })
    expect(await status({ creationId: CREATION })).toStrictEqual({ creationId: CREATION, state: 'missing' })
    const outcome = (value: AgentCreationOutcome | { state: 'pending' }) => { vi.spyOn(deps.receipts, 'status').mockReturnValueOnce(value as never) }
    outcome({ state: 'created', agentId: 'forked', level: 'handoff', resumed: true })
    const created = await status({ creationId: CREATION })
    expect(created).toStrictEqual({ creationId: CREATION, state: 'created', agent: { id: 'forked' }, level: 'handoff', resumed: true })
    expect(Object.keys(created!)).toEqual(['creationId', 'state', 'agent', 'level', 'resumed'])
    outcome({ state: 'created', agentId: 'deleted-since' })
    expect(await status({ creationId: CREATION })).toStrictEqual({ creationId: CREATION, state: 'unavailable', createdAgentId: 'deleted-since' })
    outcome({ state: 'failed', error: 'ENGINE_MISSING', detail: 'claude is not installed', preparedFolder: '/projects/prepared' })
    expect(await status({ creationId: CREATION })).toStrictEqual({ creationId: CREATION, state: 'failed', preparedFolder: '/projects/prepared', failure: { code: 'ENGINE_MISSING', detail: 'claude is not installed' } })
    outcome({ state: 'unconfirmed' })
    expect(await status({ creationId: CREATION })).toStrictEqual({ creationId: CREATION, state: 'unconfirmed' })
  })

  it('says why a receipt could not be read', async () => {
    const storage = setup({ receipts: { has: vi.fn(() => false), creator: vi.fn(), createdLaunchModel: vi.fn(() => null), runIntent: vi.fn(), pendingIntents: vi.fn(), pendingIntent: vi.fn(), cancelIntent: vi.fn(), run: vi.fn(), status: vi.fn(() => { throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED') }) } })
    expect(await storage.status({ creationId: CREATION })).toStrictEqual({ error: 'CREATION_STORAGE_FAILED' })
    const broken = setup({ receipts: { has: vi.fn(() => false), creator: vi.fn(), createdLaunchModel: vi.fn(() => null), runIntent: vi.fn(), pendingIntents: vi.fn(), pendingIntent: vi.fn(), cancelIntent: vi.fn(), run: vi.fn(), status: vi.fn(() => { throw new Error('bug') }) } })
    expect(await broken.status({ creationId: CREATION })).toStrictEqual({ error: 'INTERNAL' })
  })
})

describe('agent_resume and agent_restart', () => {
  it('relaunch the agent named, resume taking a permission mode, and answer with its frame and whether it resumed', async () => {
    const { relaunch, resume, restart } = setup()
    expect(await relaunch('agent_restart', { agentId: 'a1' })).toStrictEqual({ agent: { id: 'a1' }, resumed: false })
    expect(await relaunch('agent_resume', { agentId: 'a1' })).toStrictEqual({ agent: { id: 'a1' }, resumed: true })
    expect(await relaunch('agent_resume', { agentId: 'a1', permissionMode: 'plan' })).toMatchObject({ resumed: true })
    expect(restart).toHaveBeenCalledWith('a1')
    expect(vi.mocked(resume!).mock.calls).toEqual([['a1'], ['a1', 'plan']])
  })

  it('refuse a request with no agent, on a machine that cannot relaunch, and a permission mode a restart has no use for', async () => {
    const { relaunch, restart } = setup()
    expect(await relaunch('agent_restart', {})).toStrictEqual({ error: 'MISSING_AGENT_ID' })
    expect(await setup({}, { restart: null }).relaunch('agent_restart', { agentId: 'a1' })).toStrictEqual({ error: 'UNSUPPORTED_ON_REMOTE' })
    expect(await setup({}, { resume: null }).relaunch('agent_resume', { agentId: 'a1' })).toStrictEqual({ error: 'UNSUPPORTED_ON_REMOTE' })
    for (const [type, permissionMode] of [['agent_restart', 'auto'], ['agent_resume', 7], ['agent_resume', 'allow']] as const) {
      expect(await relaunch(type, { agentId: 'a1', permissionMode })).toStrictEqual({ error: 'INVALID_PERMISSION_MODE' })
    }
    expect(restart).not.toHaveBeenCalled()
  })

  it('pass a refusal on with its cause when it has one', async () => {
    const failed = setup({}, { restart: vi.fn(async () => ({ ok: false as const, error: 'RESTART_FAILED', detail: 'claude did not come back up' })) })
    expect(await failed.relaunch('agent_restart', { agentId: 'a1' })).toStrictEqual({ error: 'RESTART_FAILED', detail: 'claude did not come back up' })
    const bare = setup({}, { restart: vi.fn(async () => ({ ok: false as const, error: 'AGENT_NOT_FOUND' })) })
    expect(await bare.relaunch('agent_restart', { agentId: 'a1' })).toStrictEqual({ error: 'AGENT_NOT_FOUND' })
  })

  // Which check refused a resume's history (lib/resumeAgentService.ts) reaches the reply, so its counter can name it.
  it('pass a refusal\'s reason on, directly and through a receipt', async () => {
    const refused = { ok: false as const, error: 'RESUME_PREPARATION_FAILED', reason: 'invalid_json', detail: 'Could not prepare the saved conversation.' }
    const direct = setup({}, { resume: vi.fn(async () => refused) })
    expect(await direct.relaunch('agent_resume', { agentId: 'a1' })).toStrictEqual({ error: 'RESUME_PREPARATION_FAILED', reason: 'invalid_json', detail: 'Could not prepare the saved conversation.' })
    const kept = setup({}, { resume: vi.fn(async () => refused) })
    await kept.relaunch('agent_resume', { agentId: 'a1', creationId: CREATION })
    await vi.waitFor(() => expect(kept.replies).toStrictEqual([{ creationId: CREATION, state: 'failed',
      failure: { code: 'RESUME_PREPARATION_FAILED', reason: 'invalid_json', detail: 'Could not prepare the saved conversation.' } }]))
  })

  it('keep a receipt: one relaunch per creation id, an unobserved one unconfirmed, a refusal failed and cut short', async () => {
    const { relaunch, replies, resume } = setup()
    await relaunch('agent_resume', { agentId: 'a1', creationId: CREATION, permissionMode: 'auto' })
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0]).toStrictEqual({ creationId: CREATION, state: 'created', agent: { id: 'a1' }, resumed: true })
    await relaunch('agent_resume', { agentId: 'a1', creationId: CREATION, permissionMode: 'ask' })
    expect(replies.at(-1)).toStrictEqual({ error: 'CREATION_CONFLICT' })
    expect(resume).toHaveBeenCalledOnce()
    expect(await relaunch('agent_restart', { agentId: 'a1', creationId: 'short' })).toStrictEqual({ error: 'INVALID_CREATION_ID' })
    for (const [error, state] of [['RESTART_FAILED', 'unconfirmed'], ['RESUME_UNCONFIRMED', 'unconfirmed'], ['AGENT_BUSY', 'failed']] as const) {
      const run = setup({}, { restart: vi.fn(async () => ({ ok: false as const, error, detail: 'd'.repeat(3000) })) })
      await run.relaunch('agent_restart', { agentId: 'a1', creationId: CREATION })
      await vi.waitFor(() => expect(run.replies).toHaveLength(1))
      expect(run.replies[0].state).toBe(state)
      if (state === 'failed') expect(run.replies[0].failure).toStrictEqual({ code: 'AGENT_BUSY', detail: 'd'.repeat(2000) })
    }
    const bare = setup({}, { restart: vi.fn(async () => ({ ok: false as const, error: 'AGENT_BUSY' })) })
    await bare.relaunch('agent_restart', { agentId: 'a1', creationId: CREATION })
    await vi.waitFor(() => expect(bare.replies).toStrictEqual([{ creationId: CREATION, state: 'failed', failure: { code: 'AGENT_BUSY' } }]))
  })

  it('say why a receipt could not be kept, and INTERNAL when the answer cannot be put together', async () => {
    const storage = setup({ receipts: { has: vi.fn(() => false), creator: vi.fn(), createdLaunchModel: vi.fn(() => null), runIntent: vi.fn(), pendingIntents: vi.fn(), pendingIntent: vi.fn(), cancelIntent: vi.fn(), status: vi.fn(), run: vi.fn(() => { throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED') }) } })
    expect(await storage.relaunch('agent_restart', { agentId: 'a1', creationId: CREATION })).toStrictEqual({ error: 'CREATION_STORAGE_FAILED' })
    const broken = setup({ receipts: { has: vi.fn(() => false), creator: vi.fn(), createdLaunchModel: vi.fn(() => null), runIntent: vi.fn(), pendingIntents: vi.fn(), pendingIntent: vi.fn(), cancelIntent: vi.fn(), status: vi.fn(), run: vi.fn(() => { throw new Error('bug') }) } })
    expect(await broken.relaunch('agent_restart', { agentId: 'a1', creationId: CREATION })).toStrictEqual({ error: 'INTERNAL' })
    const frameless = setup({ toProject: vi.fn(async () => { throw new Error('no frame') }) })
    await frameless.relaunch('agent_restart', { agentId: 'a1', creationId: CREATION })
    await vi.waitFor(() => expect(frameless.replies).toStrictEqual([{ error: 'INTERNAL' }]))
  })
})

describe('agent_fork', () => {
  it('forks the agent named, with a name and a first message when given, and answers with the new one\'s frame and what it got', async () => {
    const { forkAsk, fork } = setup()
    expect(await forkAsk({ agentId: 'a1', name: `  ${'n'.repeat(130)}  `, prompt: 'carry on' })).toStrictEqual({ agent: { id: 'forked' }, level: 'native' })
    expect(fork).toHaveBeenCalledWith({ agentId: 'a1', name: 'n'.repeat(120), prompt: 'carry on' })
    await forkAsk({ agentId: 'a1', name: '  ', prompt: '   ' })
    await forkAsk({ agentId: 'a1', prompt: null })
    expect(vi.mocked(fork!).mock.calls.slice(1).map(([input]) => input)).toEqual([{ agentId: 'a1', name: null, prompt: null }, { agentId: 'a1', name: null, prompt: null }])
  })

  it('refuses a request with no agent, on a machine that cannot fork, and a first message that is not text or too long', async () => {
    const { forkAsk, fork } = setup()
    expect(await forkAsk({})).toStrictEqual({ error: 'MISSING_AGENT_ID' })
    expect(await setup({}, { fork: null }).forkAsk({ agentId: 'a1' })).toStrictEqual({ error: 'UNSUPPORTED_ON_REMOTE' })
    expect(await forkAsk({ agentId: 'a1', prompt: 7 })).toStrictEqual({ error: 'INVALID_PROMPT' })
    expect(await forkAsk({ agentId: 'a1', prompt: 'x'.repeat(MAX_FIRST_PROMPT_CHARS + 1) })).toStrictEqual({ error: 'PROMPT_TOO_LONG' })
    expect(await forkAsk({ agentId: 'a1', creationId: 'short' })).toStrictEqual({ error: 'INVALID_CREATION_ID' })
    expect(fork).not.toHaveBeenCalled()
  })

  it('passes a refusal on with its cause when it has one', async () => {
    const failed = setup({}, { fork: vi.fn(async () => ({ ok: false as const, error: 'SPAWN_FAILED', detail: 'tmux: no server' })) })
    expect(await failed.forkAsk({ agentId: 'a1' })).toStrictEqual({ error: 'SPAWN_FAILED', detail: 'tmux: no server' })
    const bare = setup({}, { fork: vi.fn(async () => ({ ok: false as const, error: 'NOT_FORKABLE' })) })
    expect(await bare.forkAsk({ agentId: 'a1' })).toStrictEqual({ error: 'NOT_FORKABLE' })
  })

  it('keeps a receipt like agent_create: one fork per creation id, a spawn it cannot confirm unconfirmed, a refusal failed and cut short', async () => {
    const { forkAsk, replies, fork } = setup()
    await forkAsk({ agentId: 'a1', creationId: CREATION })
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0]).toStrictEqual({ creationId: CREATION, state: 'created', agent: { id: 'forked' }, level: 'native' })
    await forkAsk({ agentId: 'a1', creationId: CREATION })
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(fork).toHaveBeenCalledOnce()
    for (const [error, state] of [['SPAWN_FAILED', 'unconfirmed'], ['REGISTRATION_FAILED', 'unconfirmed'], ['NOT_FORKABLE', 'failed']] as const) {
      const run = setup({}, { fork: vi.fn(async () => ({ ok: false as const, error, detail: 'd'.repeat(3000) })) })
      await run.forkAsk({ agentId: 'a1', creationId: CREATION })
      await vi.waitFor(() => expect(run.replies).toHaveLength(1))
      expect(run.replies[0].state).toBe(state)
      if (state === 'failed') expect(run.replies[0].failure).toStrictEqual({ code: 'NOT_FORKABLE', detail: 'd'.repeat(2000) })
    }
    const bare = setup({}, { fork: vi.fn(async () => ({ ok: false as const, error: 'NOT_FORKABLE' })) })
    await bare.forkAsk({ agentId: 'a1', creationId: CREATION })
    await vi.waitFor(() => expect(bare.replies).toStrictEqual([{ creationId: CREATION, state: 'failed', failure: { code: 'NOT_FORKABLE' } }]))
  })

  it('says why a receipt could not be kept, and INTERNAL when the answer cannot be put together', async () => {
    const storage = setup({ receipts: { has: vi.fn(() => false), creator: vi.fn(), createdLaunchModel: vi.fn(() => null), runIntent: vi.fn(), pendingIntents: vi.fn(), pendingIntent: vi.fn(), cancelIntent: vi.fn(), status: vi.fn(), run: vi.fn(() => { throw new AgentCreationReceiptError('CREATION_CONFLICT') }) } })
    expect(await storage.forkAsk({ agentId: 'a1', creationId: CREATION })).toStrictEqual({ error: 'CREATION_CONFLICT' })
    const broken = setup({ receipts: { has: vi.fn(() => false), creator: vi.fn(), createdLaunchModel: vi.fn(() => null), runIntent: vi.fn(), pendingIntents: vi.fn(), pendingIntent: vi.fn(), cancelIntent: vi.fn(), status: vi.fn(), run: vi.fn(() => { throw new Error('bug') }) } })
    expect(await broken.forkAsk({ agentId: 'a1', creationId: CREATION })).toStrictEqual({ error: 'INTERNAL' })
    const frameless = setup({ toProject: vi.fn(async () => { throw new Error('no frame') }) })
    await frameless.forkAsk({ agentId: 'a1', creationId: CREATION })
    await settle()
    await vi.waitFor(() => expect(frameless.replies).toStrictEqual([{ error: 'INTERNAL' }]))
  })
})

describe('agent_create, from a guest', () => {
  // A guest's New Harness never reaches the owner's launch: it is built as the guest's own OS user
  // (core/agents/guestCreate.ts, docs/plans/2026-10-19-guest-machine-sharing-plan.md).
  const guestAsk = async (run: ReturnType<typeof setup>, payload: Record<string, unknown>, guest = 'kim@acme.io') => {
    await run.requests.create(payload, { local: false, guest }, (result) => { run.replies.push(result) })
    return run.replies.at(-1)
  }

  it('is the guest\'s own launch, never the owner\'s, answered as the owner\'s are', async () => {
    const guestCreate = vi.fn(async () => ({ ok: true as const, session: session('guest-agent', { guest: 'kim@acme.io' }) }))
    const run = setup({ guestCreate: () => guestCreate })
    expect(await guestAsk(run, { engine: 'claude', cwd: '/Users/owner' })).toEqual({ agent: { id: 'guest-agent' } })
    expect(guestCreate).toHaveBeenCalledWith({ engine: 'claude', cwd: '/Users/owner' }, 'kim@acme.io')
    expect(run.create).not.toHaveBeenCalled()
    guestCreate.mockResolvedValueOnce({ ok: false, error: 'GUEST_HELPER_REQUIRED', detail: 'Turn it on.' } as never)
    expect(await guestAsk(run, { engine: 'claude' })).toEqual({ error: 'GUEST_HELPER_REQUIRED', detail: 'Turn it on.' })
    guestCreate.mockResolvedValueOnce({ ok: false, error: 'TMUX_UNAVAILABLE' } as never)
    expect(await guestAsk(run, { engine: 'claude' })).toEqual({ error: 'TMUX_UNAVAILABLE' })
  })

  it('keeps a receipt under its creationId, so a retry finds the same harness and a status check what became of it', async () => {
    const guestCreate = vi.fn(async () => ({ ok: true as const, session: session('guest-agent', { guest: 'kim@acme.io' }) }))
    const run = setup({ guestCreate: () => guestCreate, byAgent: (id) => id === 'guest-agent' ? session('guest-agent') : undefined })
    await guestAsk(run, { creationId: CREATION, engine: 'claude' })
    await vi.waitFor(() => expect(run.replies.at(-1)).toEqual({ creationId: CREATION, state: 'created', agent: { id: 'guest-agent' } }))
    await guestAsk(run, { creationId: CREATION, engine: 'claude' })
    await vi.waitFor(() => expect(run.replies).toHaveLength(2))
    expect(guestCreate).toHaveBeenCalledTimes(1)
    // The same id for another launch is a conflict, not a second harness.
    await guestAsk(run, { creationId: CREATION, engine: 'codex' })
    await vi.waitFor(() => expect(run.replies.at(-1)).toEqual({ error: 'CREATION_CONFLICT' }))
  })

  it('records a refusal as the outcome, with its words', async () => {
    const guestCreate = vi.fn(async () => ({ ok: false as const, error: 'GUEST_UNSUPPORTED', detail: 'On a computer shared with you, start a new conversation.' }))
    const run = setup({ guestCreate: () => guestCreate })
    await guestAsk(run, { creationId: CREATION, engine: 'claude' })
    await vi.waitFor(() => expect(run.replies.at(-1)).toEqual({ creationId: CREATION, state: 'failed', failure: { code: 'GUEST_UNSUPPORTED', detail: 'On a computer shared with you, start a new conversation.' } }))
    guestCreate.mockResolvedValueOnce({ ok: false, error: 'TMUX_UNAVAILABLE' } as never)
    await guestAsk(run, { creationId: 'creation-fedcba9876543210', engine: 'claude' })
    await vi.waitFor(() => expect(run.replies.at(-1)).toEqual({ creationId: 'creation-fedcba9876543210', state: 'failed', failure: { code: 'TMUX_UNAVAILABLE' } }))
  })

  it('starts nothing on a machine that cannot start a guest\'s harness, or for an id that is not one', async () => {
    expect(await guestAsk(setup(), { engine: 'claude' })).toEqual({ error: 'GUEST_NOT_ALLOWED' })
    expect(await guestAsk(setup({ guestCreate: () => null }), { engine: 'claude' })).toEqual({ error: 'GUEST_NOT_ALLOWED' })
    const guestCreate = vi.fn()
    expect(await guestAsk(setup({ guestCreate: () => guestCreate }), { creationId: 'short', engine: 'claude' })).toEqual({ error: 'INVALID_CREATION_ID' })
    expect(guestCreate).not.toHaveBeenCalled()
  })

  it('answers INTERNAL when its receipt cannot be kept or its answer cannot be built', async () => {
    const guestCreate = vi.fn(async () => ({ ok: true as const, session: session('guest-agent') }))
    const broken = setup({ guestCreate: () => guestCreate })
    vi.spyOn(broken.deps.receipts, 'run').mockImplementation(() => { throw new Error('disk full') })
    expect(await guestAsk(broken, { creationId: CREATION, engine: 'claude' })).toEqual({ error: 'INTERNAL' })
    const conflict = setup({ guestCreate: () => guestCreate })
    vi.spyOn(conflict.deps.receipts, 'run').mockImplementation(() => { throw new AgentCreationReceiptError('CREATION_CONFLICT') })
    expect(await guestAsk(conflict, { creationId: CREATION, engine: 'claude' })).toEqual({ error: 'CREATION_CONFLICT' })
    const unbuilt = setup({ guestCreate: () => guestCreate, toProject: async () => { throw new Error('gone') }, byAgent: () => session('guest-agent') })
    vi.spyOn(unbuilt.deps.receipts, 'run').mockResolvedValue({ state: 'created', agentId: 'guest-agent' })
    await guestAsk(unbuilt, { creationId: CREATION, engine: 'claude' })
    await vi.waitFor(() => expect(unbuilt.replies.at(-1)).toEqual({ error: 'INTERNAL' }))
  })
})

describe('agent_create_status and agent_create_cancel, by who created the launch', () => {
  // A guest sees and cancels only its own creations; for anyone else's id it hears what an unknown id gets.
  const KIM = 'kim@acme.io', LEE = 'lee@acme.io'
  const OTHER = 'creation-fedcba9876543210'
  const guestCreate = () => vi.fn(async () => ({ ok: true as const, session: session('guest-agent', { guest: KIM }) }))
  const as = (run: ReturnType<typeof setup>, guest?: string) => ({
    status: async (creationId: string) => { const answer = vi.fn(); await run.requests.createStatus({ creationId }, guest ? { local: false, guest } : { local: true }, answer); return answer.mock.calls.at(-1)![0] },
    cancel: async (creationId: string) => { const answer = vi.fn(); await run.requests.cancelCreate({ creationId }, guest ? { local: false, guest } : { local: true }, answer); return answer.mock.calls.at(-1)![0] },
  })
  const ownerHeld = async (run: ReturnType<typeof setup>, id = CREATION) => {
    vi.mocked(parseNewAgentModel).mockReturnValue({ state: 'ok', selection: { model: 'fixture-model', grid: 'fixture-grid' } })
    resolveNewAgentModel.mockResolvedValue(null)
    await run.ask({ engine: 'claude', cwd: '/fixture/work', creationId: id })
    await vi.waitFor(() => expect(run.replies.at(-1)).toMatchObject({ state: 'pending' }))
  }
  const guestMade = async (run: ReturnType<typeof setup>, guest = KIM, id = CREATION) => {
    await run.requests.create({ creationId: id, engine: 'claude' }, { local: false, guest }, (result) => { run.replies.push(result) })
    await vi.waitFor(() => expect(run.replies.at(-1)).toMatchObject({ creationId: id, state: 'created' }))
  }
  const withGuests = () => setup({ guestCreate: guestCreate, byAgent: (id) => id === 'guest-agent' || id === 'new-agent' ? session(id) : undefined })

  it('answers a guest for the owner\'s pending creation exactly as for an unknown id, and cancels nothing', async () => {
    const run = withGuests()
    await ownerHeld(run)
    const unknown = await as(run, KIM).status(OTHER)
    expect(unknown).toEqual({ creationId: OTHER, state: 'missing' })
    expect(await as(run, KIM).status(CREATION)).toEqual({ ...unknown, creationId: CREATION })
    expect(await as(run, KIM).cancel(CREATION)).toEqual({ creationId: CREATION, state: 'missing' })
    expect(await as(run, KIM).cancel(OTHER)).toEqual({ creationId: OTHER, state: 'missing' })
    expect(await as(run).status(CREATION)).toMatchObject({ state: 'pending' })
    // The guest's cancel of an unknown id wrote nothing: no cancelled mark, no receipt file.
    expect(await as(run).status(OTHER)).toEqual({ creationId: OTHER, state: 'missing' })
    expect(existsSync(join(dir, `receipts-${stores}`, `${OTHER}.json`))).toBe(false)
  })

  it('answers a guest for the owner\'s finished creation as for an unknown id, and a cancel leaves it', async () => {
    const run = withGuests()
    await run.ask({ engine: 'claude', cwd: '/fixture/work', creationId: CREATION })
    await vi.waitFor(() => expect(run.replies.at(-1)).toMatchObject({ state: 'created' }))
    expect(await as(run, KIM).status(CREATION)).toEqual({ creationId: CREATION, state: 'missing' })
    expect(await as(run, KIM).cancel(CREATION)).toEqual({ creationId: CREATION, state: 'missing' })
    expect(await as(run).status(CREATION)).toMatchObject({ state: 'created', agent: { id: 'new-agent' } })
  })

  it('keeps one guest\'s creation from another, and shows a guest its own', async () => {
    const run = withGuests()
    await guestMade(run, KIM)
    expect(await as(run, LEE).status(CREATION)).toEqual({ creationId: CREATION, state: 'missing' })
    expect(await as(run, LEE).cancel(CREATION)).toEqual({ creationId: CREATION, state: 'missing' })
    expect(await as(run, KIM).status(CREATION)).toEqual({ creationId: CREATION, state: 'created', agent: { id: 'guest-agent' } })
    expect(await as(run, KIM).cancel(CREATION)).toMatchObject({ creationId: CREATION, state: 'created' })
  })

  it('lets the owner read and cancel its own creations and a guest\'s', async () => {
    const run = withGuests()
    await guestMade(run, KIM)
    expect(await as(run).status(CREATION)).toMatchObject({ state: 'created', agent: { id: 'guest-agent' } })
    await ownerHeld(run, OTHER)
    expect(await as(run).status(OTHER)).toMatchObject({ state: 'pending' })
    expect(await as(run).cancel(OTHER)).toEqual({ creationId: OTHER, state: 'cancelled' })
    expect(await as(run).cancel(CREATION)).toMatchObject({ state: 'created' })
  })

  it('treats a receipt written before creators were recorded as the owner\'s, and keeps a guest\'s across a restart', async () => {
    const run = withGuests()
    await guestMade(run, KIM)
    const reloaded = createLaunchRequests({ ...run.deps, receipts: new AgentCreationReceipts(join(dir, `receipts-${stores}`)) })
    stopRequests.push(reloaded.stop)
    const reread = async (guest: string | undefined, id: string) => {
      const answer = vi.fn(); await reloaded.createStatus({ creationId: id }, guest ? { local: false, guest } : { local: true }, answer); return answer.mock.calls.at(-1)![0]
    }
    expect(await reread(KIM, CREATION)).toMatchObject({ state: 'created' })
    expect(await reread(LEE, CREATION)).toEqual({ creationId: CREATION, state: 'missing' })
    writeFileSync(join(dir, `receipts-${stores}`, `${OTHER}.json`),
      JSON.stringify({ version: 1, fingerprint: creationFingerprint({ old: true }), outcome: { state: 'created', agentId: 'new-agent' } }), { mode: 0o600 })
    expect(await reread(KIM, OTHER)).toEqual({ creationId: OTHER, state: 'missing' })
    expect(await reread(undefined, OTHER)).toMatchObject({ state: 'created' })
  })

  it('refuses a guest that reuses the owner\'s creation id, without telling what became of it', async () => {
    const run = withGuests()
    await run.ask({ engine: 'claude', cwd: '/fixture/work', creationId: CREATION })
    await vi.waitFor(() => expect(run.replies.at(-1)).toMatchObject({ state: 'created' }))
    run.replies.length = 0
    await run.requests.create({ creationId: CREATION, engine: 'claude' }, { local: false, guest: KIM }, (result) => { run.replies.push(result) })
    expect(run.replies).toEqual([{ error: 'CREATION_CONFLICT' }])
    await ownerHeld(run, OTHER)
    run.replies.length = 0
    await run.requests.create({ creationId: OTHER, engine: 'claude' }, { local: false, guest: KIM }, (result) => { run.replies.push(result) })
    expect(run.replies).toEqual([{ error: 'CREATION_CONFLICT' }])
  })

  it('lets a guest repeat its own create and still get its receipt', async () => {
    const run = withGuests()
    await guestMade(run, KIM)
    run.replies.length = 0
    await run.requests.create({ creationId: CREATION, engine: 'claude' }, { local: false, guest: KIM }, (result) => { run.replies.push(result) })
    await vi.waitFor(() => expect(run.replies).toEqual([{ creationId: CREATION, state: 'created', agent: { id: 'guest-agent' } }]))
  })

  it('refuses an invalid id to a guest as to anyone, and hides damaged evidence from a guest but not from the owner', async () => {
    const run = withGuests()
    expect(await as(run, KIM).status('short')).toEqual({ error: 'INVALID_CREATION_ID' })
    expect(await as(run, KIM).cancel('short')).toEqual({ error: 'INVALID_CREATION_ID' })
    const damaged = () => { throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED') }
    vi.spyOn(run.deps.receipts, 'creator').mockImplementation(damaged)
    expect(await as(run, KIM).status(CREATION)).toEqual({ creationId: CREATION, state: 'missing' })
    expect(await as(run, KIM).cancel(CREATION)).toEqual({ creationId: CREATION, state: 'missing' })
    vi.spyOn(run.deps.receipts, 'status').mockImplementation(damaged)
    vi.spyOn(run.deps.receipts, 'cancelIntent').mockImplementation(damaged)
    expect(await as(run).status(CREATION)).toEqual({ error: 'CREATION_STORAGE_FAILED' })
    expect(await as(run).cancel(CREATION)).toEqual({ error: 'CREATION_STORAGE_FAILED' })
  })

  it('answers INTERNAL, not missing, when a guest\'s creator lookup fails for another reason', async () => {
    const run = withGuests()
    vi.spyOn(run.deps.receipts, 'creator').mockImplementation(() => { throw new Error('bug') })
    expect(await as(run, KIM).status(CREATION)).toEqual({ error: 'INTERNAL' })
  })
})
