import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installedDsh } from '../../dsh/installed.js'
import { dshSupportedEngines } from '../../dsh/manifest.js'
import { opencodeMajorVersion } from '../../engines/opencode/version.js'
import { AgentCreationReceiptError, AgentCreationReceipts, type AgentCreationOutcome } from '../../lib/agentCreationReceipt.js'
import type { AgentFrame } from '../../lib/agentFrame.js'
import { claudeTrusts, codexTrusts, preTrustClaudeProject, preTrustCodexProject } from '../../lib/claudeTrust.js'
import { MAX_FIRST_PROMPT_CHARS, permissionModeApproves, permissionModeFlags, supportsFirstPrompt, supportsNamedAgent } from '../../lib/engineLaunch.js'
import { parseGridLaunchOverride } from '../../lib/gridLaunch.js'
import { parseNewAgentModel } from '../../lib/newAgentModel.js'
import { parseProjectFolder, prepareProjectFolder, ProjectFolderError } from '../../lib/projectFolder.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createLaunchRequests, type CreateAgent, type ForkAgent, type LaunchRequestDeps, type RestartAgent, type ResumeAgent } from './launches.js'

/**
 * The requests that start an agent's process, answered by the core: every refusal before a pane exists,
 * what each launch is handed, the receipts that let a lost answer be asked for again, and the replies,
 * field for field. Trust records, grid reads, project folders and installed harnesses are fakes here:
 * they are tested with their own modules, and a test must never write the person's own engine config.
 */
const root = vi.hoisted(() => ({ projects: '' }))
vi.mock('../../lib/claudeTrust.js', async (real) => ({
  ...await real<object>(),
  claudeTrusts: vi.fn(() => false), codexTrusts: vi.fn(() => false), preTrustClaudeProject: vi.fn(), preTrustCodexProject: vi.fn(),
}))
vi.mock('../../engines/opencode/version.js', async (real) => ({ ...await real<object>(), opencodeMajorVersion: vi.fn(() => 1) }))
vi.mock('../../lib/newAgentModel.js', async (real) => ({
  ...await real<object>(), parseNewAgentModel: vi.fn(() => ({ state: 'absent' })),
}))
vi.mock('../../lib/gridLaunch.js', async (real) => ({ ...await real<object>(), parseGridLaunchOverride: vi.fn(() => ({ state: 'absent' })) }))
vi.mock('../../dsh/installed.js', async (real) => ({ ...await real<object>(), installedDsh: vi.fn(() => undefined) }))
vi.mock('../../dsh/manifest.js', async (real) => ({ ...await real<object>(), dshSupportedEngines: vi.fn(() => ['claude', 'codex']) }))
vi.mock('../../lib/engineLaunch.js', async (real) => ({
  ...await real<object>(),
  supportsFirstPrompt: vi.fn(() => true), supportsNamedAgent: vi.fn(() => true),
  permissionModeFlags: vi.fn(() => ['--flag']), permissionModeApproves: vi.fn(() => false),
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
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'launches-'))
  root.projects = join(dir, 'harnesses')
  mkdirSync(root.projects)
})
afterEach(() => {
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
    ...over,
  }
  const requests = createLaunchRequests(deps)
  const replies: Array<Record<string, unknown>> = []
  const reply = (result: Record<string, unknown>) => { replies.push(result) }
  return {
    deps, create, fork, resume, restart, replies, requests,
    ask: async (payload: Record<string, unknown>, local = true) => { await requests.create(payload, { local }, reply); return replies.at(-1) },
    status: async (payload: Record<string, unknown>) => { await requests.createStatus(payload, reply); return replies.at(-1) },
    relaunch: async (type: string, payload: Record<string, unknown>) => { await requests.relaunch(type, payload, reply); return replies.at(-1) },
    forkAsk: async (payload: Record<string, unknown>) => { await requests.fork(payload, reply); return replies.at(-1) },
  }
}

describe('agent_create, refused before any pane exists', () => {
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
    vi.mocked(opencodeMajorVersion).mockReturnValueOnce(2)
    expect(await ask({ engine: 'opencode', cwd: '/w', agent: 'reviewer' })).toMatchObject({ error: 'AGENT_UNSUPPORTED' })
    expect(supportsNamedAgent).toHaveBeenLastCalledWith('opencode', 2)
    expect(create).not.toHaveBeenCalled()
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
    vi.mocked(parseNewAgentModel).mockReturnValueOnce({ state: 'ok', selection: { model: 'm' } } as never)
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
    vi.mocked(parseNewAgentModel).mockReturnValue({ state: 'ok', selection: { model: 'm' } } as never)
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

  it('records the prepared folder of a launch that then failed, so the person can open it', async () => {
    const { ask, replies } = setup({}, { create: vi.fn(async () => ({ ok: false as const, error: 'ENGINE_MISSING' })) })
    await ask({ engine: 'claude', projectSource: 'new', creationId: CREATION })
    await vi.waitFor(() => expect(replies).toStrictEqual([{ creationId: CREATION, state: 'failed', preparedFolder: '/projects/prepared', failure: { code: 'ENGINE_MISSING' } }]))
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

  it('resolves a model picked by name inside the receipt, and records it unavailable when it cannot be read', async () => {
    const { ask, create, replies } = setup()
    vi.mocked(parseNewAgentModel).mockReturnValue({ state: 'ok', selection: { model: 'm' } } as never)
    resolveNewAgentModel.mockResolvedValueOnce({ networkId: 'resolved' } as never).mockRejectedValueOnce(new Error('offline'))
    await ask({ engine: 'claude', cwd: '/w', creationId: CREATION })
    await ask({ engine: 'claude', cwd: '/w', creationId: `${CREATION}-2` })
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(vi.mocked(create!).mock.calls[0][0].grid).toEqual({ networkId: 'resolved' })
    expect(replies[1]).toStrictEqual({ creationId: `${CREATION}-2`, state: 'failed',
      failure: { code: 'GRID_UNAVAILABLE', detail: 'The selected model is unavailable. Choose another model or refresh the list.' } })
  })

  it('says why a receipt could not be kept, and answers INTERNAL when the answer cannot be put together', async () => {
    const storage = setup({ receipts: { status: vi.fn(), run: vi.fn(() => { throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED') }) } })
    expect(await storage.ask({ engine: 'claude', cwd: '/w', creationId: CREATION })).toStrictEqual({ error: 'CREATION_STORAGE_FAILED' })
    const broken = setup({ receipts: { status: vi.fn(), run: vi.fn(() => { throw new Error('bug') }) } })
    expect(await broken.ask({ engine: 'claude', cwd: '/w', creationId: CREATION })).toStrictEqual({ error: 'INTERNAL' })
    const frameless = setup({ toProject: vi.fn(async () => { throw new Error('no frame') }) })
    await frameless.ask({ engine: 'claude', cwd: '/w', creationId: CREATION })
    await vi.waitFor(() => expect(frameless.replies).toStrictEqual([{ error: 'INTERNAL' }]))
  })
})

describe('agent_create_status', () => {
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
    expect(await status({ creationId: CREATION })).toStrictEqual({ creationId: CREATION, state: 'unavailable' })
    outcome({ state: 'failed', error: 'ENGINE_MISSING', detail: 'claude is not installed', preparedFolder: '/projects/prepared' })
    expect(await status({ creationId: CREATION })).toStrictEqual({ creationId: CREATION, state: 'failed', preparedFolder: '/projects/prepared', failure: { code: 'ENGINE_MISSING', detail: 'claude is not installed' } })
    outcome({ state: 'unconfirmed' })
    expect(await status({ creationId: CREATION })).toStrictEqual({ creationId: CREATION, state: 'unconfirmed' })
  })

  it('says why a receipt could not be read', async () => {
    const storage = setup({ receipts: { run: vi.fn(), status: vi.fn(() => { throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED') }) } })
    expect(await storage.status({ creationId: CREATION })).toStrictEqual({ error: 'CREATION_STORAGE_FAILED' })
    const broken = setup({ receipts: { run: vi.fn(), status: vi.fn(() => { throw new Error('bug') }) } })
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
    const storage = setup({ receipts: { status: vi.fn(), run: vi.fn(() => { throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED') }) } })
    expect(await storage.relaunch('agent_restart', { agentId: 'a1', creationId: CREATION })).toStrictEqual({ error: 'CREATION_STORAGE_FAILED' })
    const broken = setup({ receipts: { status: vi.fn(), run: vi.fn(() => { throw new Error('bug') }) } })
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
    const storage = setup({ receipts: { status: vi.fn(), run: vi.fn(() => { throw new AgentCreationReceiptError('CREATION_CONFLICT') }) } })
    expect(await storage.forkAsk({ agentId: 'a1', creationId: CREATION })).toStrictEqual({ error: 'CREATION_CONFLICT' })
    const broken = setup({ receipts: { status: vi.fn(), run: vi.fn(() => { throw new Error('bug') }) } })
    expect(await broken.forkAsk({ agentId: 'a1', creationId: CREATION })).toStrictEqual({ error: 'INTERNAL' })
    const frameless = setup({ toProject: vi.fn(async () => { throw new Error('no frame') }) })
    await frameless.forkAsk({ agentId: 'a1', creationId: CREATION })
    await settle()
    await vi.waitFor(() => expect(frameless.replies).toStrictEqual([{ error: 'INTERNAL' }]))
  })
})
