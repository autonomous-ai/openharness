import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createResumeAgentService, type ResumeAgentServiceDeps } from './resumeAgentService.js'
import { RESUME_READINESS_BUDGET_MS } from './resumeStoppedAgent.js'
import { registry, type RegisteredSession } from './registry.js'
import { controlTranscriptEvidence } from '../engines/transcriptBindings.js'
import { materializeResumeTranscript } from '../engines/resumeTranscript.js'
import { IdentityReadUnavailable } from '../engines/kit/identityScan.js'
import { ResumePreparationError } from '../engines/kit/resumeRepair.js'
import { env } from '../config/env.js'
import { StoppedAgentStore } from './stoppedAgents.js'
import { AgentRestartCoordinator } from './restartAgent.js'
import { checkPidRuntime } from './deleteAgentFallback.js'
import { checkSessionRuntime, resolvePaneEngineProcess } from './paneEngineProcess.js'
import { windowsAfterExit, windowsPaneLaunch } from './windows/engineStart.js'
import { buildEngineLaunchArgv, dropPermissionFlagIfUnsupported, engineLaunchEnv, refusePermissionFlagIfUnsupported } from './engineLaunch.js'
import { engineBin, enginePathOverride } from './engineBin.js'
import { stopConflictingBackgroundJob } from './claudeBackgroundJob.js'
import { installedDsh } from '../dsh/installed.js'
import { createLaunchHelpers } from '../core/agents/launch.js'
import { createLaunchAuthority } from '../core/agents/launchAuthority.js'
import type { NativeLaunch } from '../engines/nativeLaunch.js'
import type { TerminalInventoryResult } from './terminalTypes.js'
import { WindowsBatchLaunchRefused } from './windows/launch.js'
import { NATIVE_LAUNCH_MARKER } from './nativePaneHold.js'

vi.mock('./windows/engineStart.js', async (original) => {
  const actual = await original<typeof import('./windows/engineStart.js')>()
  return { ...actual, windowsPaneLaunch: vi.fn(actual.windowsPaneLaunch) }
})
vi.mock('./deleteAgentFallback.js', () => ({ checkPidRuntime: vi.fn() }))
vi.mock('./paneEngineProcess.js', () => ({ checkSessionRuntime: vi.fn(), resolvePaneEngineProcess: vi.fn() }))
// `resumeCapability` reads the real flag table through this module; only the argv builder and the
// capability gate are faked. The gate would otherwise spawn the tester's own login shell to ask
// `<engine> --help` about a flag, which is neither this file's subject nor the same answer on two
// machines. Its own behaviour is covered in `engineLaunch.spec.ts`.
vi.mock('./engineLaunch.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./engineLaunch.js')>()),
  buildEngineLaunchArgv: vi.fn(() => ['fixture-engine']),
  engineLaunchEnv: vi.fn(() => undefined),
  dropPermissionFlagIfUnsupported: vi.fn(async (_engine: unknown, choice: unknown) => ({ choice, droppedFlag: null })),
  refusePermissionFlagIfUnsupported: vi.fn(async () => null),
}))
vi.mock('./engineBin.js', () => ({ enginePathOverride: vi.fn(() => undefined), engineBin: vi.fn((engine: string) => engine) }))
vi.mock('./claudeBackgroundJob.js', () => ({ stopConflictingBackgroundJob: vi.fn(async () => {}) }))
vi.mock('./engineInstall.js', async original => ({ ...await original<object>(), engineInstallRecipe: () => ({ command: 'fixture-install' }) }))
vi.mock('../dsh/installed.js', () => ({ installedDsh: vi.fn() }))
vi.mock('../engines/transcriptBindings.js', async original => ({ ...await original<object>(), controlTranscriptEvidence: vi.fn() }))
vi.mock('../engines/resumeTranscript.js', () => ({ materializeResumeTranscript: vi.fn(async (_engine, _id, path) => path) }))

let dir: string
let saved: RegisteredSession
let deps: ResumeAgentServiceDeps
const identity = { pid: 54321, startMarker: 'new-process', executable: 'codex' }
const pane = '%99'
const create = vi.fn()
const kill = vi.fn()
// The pane's backend: its state and hold. Which engine runs in it is `paneEngineProcess.ts`'s, faked above.
const paneState = vi.fn()
const releaseHold = vi.fn()
const rootProcess = vi.fn()
const inventory = vi.fn<() => Promise<TerminalInventoryResult>>()
const tmuxTerminal = { create, kill, paneState, releaseHold, rootProcess, inventory }
/** No backend at all: none to create on, none holding any pane. */
const noBackend = () => { deps.createBackend = null; deps.backendFor = () => undefined }
// A pty host, the backend new panes are made on where it is the only one (Windows).
const pty = { backend: 'ptyhost' as const, instance: 'p1', paneId: '%5' }
const ptyCreate = vi.fn()
const ptyKill = vi.fn()
const ptyPaneState = vi.fn()
const ptyReleaseHold = vi.fn()
const ptyRootProcess = vi.fn()
const ptyInventory = vi.fn<() => Promise<TerminalInventoryResult>>()
const ptyTerminal = { create: ptyCreate, kill: ptyKill, paneState: ptyPaneState, releaseHold: ptyReleaseHold, rootProcess: ptyRootProcess, inventory: ptyInventory }
const ptyListed = (...panes: string[]): TerminalInventoryResult => ({ state: 'available', roots: panes.map(paneId => ({ runtime: { ...pty, paneId }, rootPid: 1, cwd: '/' })) })
/** A machine whose only backend is the pty host. */
const ptyhostOnly = () => { deps.createBackend = ptyTerminal; deps.backendFor = runtime => runtime.backend === 'ptyhost' ? ptyTerminal : undefined }
/** Nothing was asked of tmux. */
const tmuxUntouched = () => { for (const call of Object.values(tmuxTerminal)) expect(call).not.toHaveBeenCalled() }
/** The backend's inventory, listing [panes]. */
const listed = (...panes: string[]): TerminalInventoryResult => ({ state: 'available', roots: panes.map(paneId => ({ runtime: { backend: 'tmux', paneId }, rootPid: 1, cwd: '/' })) })
function live(extra: Partial<RegisteredSession> = {}) {
  return Object.assign(registry.resumePendingAgent(saved, [{ backend: 'tmux', paneId: pane }])!, extra)
}
function rewrite(extra: Partial<RegisteredSession>) { saved = { ...saved, ...extra }; rmSync(join(dir, 'saved', `${saved.agentId}.json`)); deps.stoppedAgents.save(saved) }
function start() { return createResumeAgentService(deps)(saved.agentId) }
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

it('retains the reservation if terminal dispatch starts but loses its reply', async () => {
  create.mockImplementationOnce(async request => { request.onDispatch(); throw Error('Terminal transport disconnected') })
  await expect(start()).rejects.toThrow('Terminal transport disconnected')
  expect(deps.stoppedAgents.resumeReservedAt(saved.agentId)).not.toBeNull()
  expect(registry.byAgent(saved.agentId)).toBeUndefined()
  expect(deps.announceSession).not.toHaveBeenCalled()
})

beforeEach(() => {
  vi.clearAllMocks()
  for (const row of registry.list()) registry.removeAgent(row.agentId)
  dir = mkdtempSync(join(tmpdir(), 'resume-service-'))
  const original = registry.openPendingAgent({ engine: 'codex', runtimes: [{ backend: 'tmux', paneId: '%8' }], cwd: dir })!
  saved = { ...original, sessionId: 'original-session', transcriptPath: join(dir, 'history.jsonl'), processIdentity: identity, launch: { state: 'ready' } }
  registry.removeAgent(original.agentId)
  const store = new StoppedAgentStore(join(dir, 'saved'))
  store.save(saved)
  create.mockReset().mockResolvedValue({ state: 'succeeded', runtime: { backend: 'tmux', paneId: pane } })
  kill.mockReset().mockResolvedValue({ state: 'succeeded' })
  vi.mocked(controlTranscriptEvidence).mockImplementation((_engine, _id, path) => ({ path, verify: vi.fn() }))
  vi.mocked(materializeResumeTranscript).mockReset().mockImplementation(async (_engine, _id, path) => path)
  vi.mocked(enginePathOverride).mockReturnValue(undefined)
  vi.mocked(refusePermissionFlagIfUnsupported).mockReset().mockResolvedValue(null)
  vi.mocked(installedDsh).mockReturnValue(undefined)
  inventory.mockReset().mockResolvedValue(listed(pane))
  ptyCreate.mockReset().mockResolvedValue({ state: 'succeeded', runtime: pty })
  ptyKill.mockReset().mockResolvedValue({ state: 'succeeded' })
  ptyPaneState.mockReset().mockResolvedValue({ dead: false })
  ptyReleaseHold.mockReset().mockResolvedValue(undefined)
  ptyInventory.mockReset().mockResolvedValue(ptyListed(pty.paneId))
  vi.mocked(checkPidRuntime).mockReset().mockResolvedValue({ state: 'gone', reason: 'fixture' })
  vi.mocked(checkSessionRuntime).mockReset().mockResolvedValue({ state: 'alive' })
  paneState.mockReset().mockResolvedValue({ dead: false } as any)
  releaseHold.mockReset().mockResolvedValue(undefined)
  vi.mocked(resolvePaneEngineProcess).mockReset().mockImplementation(async () => {
    const row = registry.byAgent(saved.agentId)
    if (row) { Object.assign(row, { processIdentity: identity, lastHookAt: Date.now(), launch: { state: 'ready' } }) }
    return identity
  })
  deps = {
    registry, stoppedAgents: store, createBackend: tmuxTerminal, backendFor: runtime => runtime.backend === 'tmux' ? tmuxTerminal : undefined,
    restartJobs: new AgentRestartCoordinator(),
    stopJobs: new Map(), pinnedControls: new Set(),
    retainExitedSession: vi.fn((row, alive) => { store.save(row); if (alive) registry.releaseEngine(row.agentId, true); else registry.removeAgent(row.agentId) }),
    announceSession: vi.fn(), relaunchOverrides: vi.fn(async () => ({ ok: true as const, overrides: { env: {}, extraArgs: [], clearEnv: [] } })),
    prepareSessionResume: vi.fn(), refreshGridWebSearch: vi.fn(), clearDeleted: vi.fn(), attachDsh: vi.fn(),
    attachSession: vi.fn(async () => true),
  }
})
afterEach(() => { vi.useRealTimers(); for (const row of registry.list()) registry.removeAgent(row.agentId); rmSync(dir, { recursive: true, force: true }) })

describe('production resume handler', () => {
  it('holds the reservation and restores cold history before checking its control identity', async () => {
    const restored = join(dir, 'restored.jsonl')
    vi.mocked(materializeResumeTranscript).mockImplementation(async (_engine, _id, _path, _profile, current) => {
      expect(deps.stoppedAgents.resumeReservedAt(saved.agentId)).not.toBeNull()
      expect(current()).toBe(true)
      expect(controlTranscriptEvidence).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
      return restored
    })
    expect(await start()).toMatchObject({ ok: true })
    expect(controlTranscriptEvidence).toHaveBeenCalledWith('codex', saved.sessionId, restored, undefined, saved.cwd)
  })

  it('does not allocate when Stop cancels an asynchronous history restoration', async () => {
    vi.mocked(materializeResumeTranscript).mockImplementation(async (_engine, _id, path, _profile, current) => {
      deps.restartJobs.cancel(saved.agentId)
      expect(current()).toBe(false)
      return path
    })
    expect(await start()).toMatchObject({ error: 'AGENT_CHANGED' })
    expect(create).not.toHaveBeenCalled()
    expect(deps.stoppedAgents.resumeReservedAt(saved.agentId)).toBeNull()
  })

  it('restoration loses permission if another harness takes the conversation', async () => {
    vi.mocked(materializeResumeTranscript).mockImplementation(async (_engine, _id, _path, _profile, current) => {
      registry.resumePendingAgent({ ...saved, agentId: 'other' }, [{ backend: 'tmux', paneId: '%101' }])
      expect(current()).toBe(false)
      throw new IdentityReadUnavailable('another harness owns the conversation')
    })
    expect(await start()).toMatchObject({ error: 'IDENTITY_UNAVAILABLE' })
    expect(create).not.toHaveBeenCalled()
    expect(deps.stoppedAgents.resumeReservedAt(saved.agentId)).toBeNull()
  })

  it('composes stopped resume with real launch preparation before any live row exists', async () => {
    const apiNotes = vi.fn()
    const helpers = createLaunchHelpers({
      authority: createLaunchAuthority({ byAgent: id => registry.byAgent(id), revision: id => deps.restartJobs.revision(id), cancelled: id => deps.stopJobs.has(id) }),
      prepareApiTools: apiNotes, setGridLaunch: vi.fn(), setTail: vi.fn(),
      launchOverridesDeps: { machine: () => ({ hermesSystemManaged: false }), gridLaunch: vi.fn(),
        capabilities: async () => ({ sessionEnv: true }), writeGridConfigDir: vi.fn(), installCodexHooks: vi.fn(async () => true), readCodexConfig: () => null },
    })
    deps.relaunchOverrides = helpers.relaunchOverrides
    expect(registry.byAgent(saved.agentId)).toBeUndefined()
    expect(await start()).toMatchObject({ ok: true, resumed: true, session: { agentId: saved.agentId, sessionId: saved.sessionId } })
    expect(apiNotes).toHaveBeenCalledWith(dir, 'codex')
    expect(create).toHaveBeenCalledOnce()
  })

  it('persists an adopted old worker role in the resumed registry row', async () => {
    const swarmSkill = { role: 'dev' as const, key: saved.agentId }
    deps.adoptSwarmSkill = async row => ({ ...row, swarmSkill })
    expect(await start()).toMatchObject({ ok: true, session: { swarmSkill } })
    registry.load()
    expect(registry.byAgent(saved.agentId)?.swarmSkill).toEqual(swarmSkill)
  })

  it('does not resume a session that changed during role adoption', async () => {
    deps.adoptSwarmSkill = async () => null
    expect(await start()).toMatchObject({ error: 'AGENT_CHANGED' })
    expect(create).not.toHaveBeenCalled()
  })

  it.each(['auto', 'ask'])('resumes the same conversation with an explicit %s permission choice', async permissionMode => {
    rewrite({ engine: 'opencode', permissionMode: permissionMode === 'auto' ? 'ask' : 'auto' })
    vi.mocked(deps.relaunchOverrides).mockResolvedValue({ ok: true, overrides: {
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'custom/kept', permission: 'ask', mcp: { custom: { enabled: true } } }) },
      extraArgs: [], clearEnv: [],
    } })
    const result = await createResumeAgentService(deps)(saved.agentId, permissionMode)
    expect(result).toMatchObject({ ok: true, resumed: true, session: { agentId: saved.agentId, sessionId: saved.sessionId,
      permissionMode, bypassPermission: permissionMode === 'auto' } })
    expect(buildEngineLaunchArgv).toHaveBeenCalledWith('opencode', expect.objectContaining({
      permissionMode, bypassPermission: permissionMode === 'auto', resumeSessionId: saved.sessionId,
    }))
    expect(JSON.parse(create.mock.calls[0][0].env.OPENCODE_CONFIG_CONTENT)).toEqual({
      model: 'custom/kept', permission: permissionMode === 'auto' ? 'allow' : 'ask', mcp: { custom: { enabled: true } },
    })
    registry.load()
    expect(registry.byAgent(saved.agentId)?.permissionMode).toBe(permissionMode)
  })

  it('carries the captured native launch and token through permission, argv and registration', async () => {
    const native: NativeLaunch = { token: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', opencodeMajor: null,
      environment: {}, proofs: [], current: vi.fn(() => true),
      prepareHooks: vi.fn(async () => true), permission: vi.fn(async () => 'supported' as const) }
    vi.mocked(deps.relaunchOverrides).mockResolvedValue({ ok: true,
      overrides: { env: {}, extraArgs: [], clearEnv: [], native } })
    const starting = vi.fn()
    vi.mocked(deps.announceSession).mockImplementation(row => {
      if (row.launch?.state === 'starting') starting(row.launch.nativeToken)
    })
    create.mockImplementationOnce(async request => {
      expect(request.current()).toBe(true)
      return { state: 'succeeded', runtime: { backend: 'tmux', paneId: pane } }
    })
    expect(await start()).toMatchObject({ ok: true, resumed: true })
    expect(dropPermissionFlagIfUnsupported).toHaveBeenCalledWith('codex', expect.any(Object), undefined, native)
    expect(buildEngineLaunchArgv).toHaveBeenCalledWith('codex', expect.objectContaining({ native }))
    expect(starting).toHaveBeenCalledExactlyOnceWith(native.token)
  })

  it.each(['permission', 'expired'] as const)('holds a saved resume when native %s evidence is unavailable', async reason => {
    const native: NativeLaunch = { opencodeMajor: null, environment: {}, proofs: [], current: () => reason !== 'expired',
      prepareHooks: async () => true, permission: async () => 'supported' }
    vi.mocked(deps.relaunchOverrides).mockResolvedValue({ ok: true,
      overrides: { env: {}, extraArgs: [], clearEnv: [], native } })
    if (reason === 'permission') vi.mocked(dropPermissionFlagIfUnsupported).mockImplementationOnce(async (_engine, choice) => ({
      choice, droppedFlag: null, nativeHold: 'Waiting for the captured executable permission probe.',
    }))
    expect(await start()).toEqual({ ok: false, error: 'NATIVE_LAUNCH_HELD', detail: reason === 'permission'
      ? 'Waiting for the captured executable permission probe.' : 'Waiting for fresh executable and hook evidence.' })
    expect(create).not.toHaveBeenCalled()
    expect(buildEngineLaunchArgv).not.toHaveBeenCalled()
    expect(registry.byAgent(saved.agentId)).toBeUndefined()
    expect(deps.stoppedAgents.resumeReservedAt(saved.agentId)).toBeNull()
    expect(deps.stoppedAgents.get(saved.agentId)).toMatchObject({ sessionId: saved.sessionId, transcriptPath: saved.transcriptPath })
  })

  it.each(['native', 'cancel'] as const)('rechecks %s authority at terminal dispatch and releases an unstarted reservation', async reason => {
    let valid = true
    const native: NativeLaunch = { opencodeMajor: null, environment: {}, proofs: [], current: () => valid,
      prepareHooks: async () => true, permission: async () => 'supported' }
    vi.mocked(deps.relaunchOverrides).mockResolvedValue({ ok: true,
      overrides: { env: {}, extraArgs: [], clearEnv: [], native } })
    create.mockImplementationOnce(async request => {
      expect(request.current()).toBe(true)
      if (reason === 'native') valid = false
      else deps.restartJobs.cancel(saved.agentId)
      expect(request.current()).toBe(false)
      return { state: 'failed', reason: 'launch authority changed', dispatch: 'not_started' }
    })
    expect(await start()).toMatchObject({ ok: false, error: reason === 'native' ? 'RESUME_UNCONFIRMED' : 'AGENT_CHANGED' })
    expect(kill).not.toHaveBeenCalled()
    expect(registry.byAgent(saved.agentId)).toBeUndefined()
    expect(deps.stoppedAgents.resumeReservedAt(saved.agentId)).toBeNull()
    expect(deps.stoppedAgents.get(saved.agentId)?.sessionId).toBe(saved.sessionId)
  })

  it('notes where the relaunched engine\'s writing begins, after the history is prepared and before the launch', async () => {
    writeFileSync(saved.transcriptPath!, '{"type":"session_meta"}\n')
    const note = vi.fn((_sessionId: string, _offset: number, _engineStarted?: boolean) => {
      // The pane is not allocated yet: the engine has written nothing of its own.
      expect(create).not.toHaveBeenCalled()
    })
    vi.mocked(deps.prepareSessionResume).mockImplementation(() => { writeFileSync(saved.transcriptPath!, '{"type":"session_meta"}\n{"prepared":true}\n') })
    deps = { ...deps, relaunchMarks: { note } }
    expect(await start()).toMatchObject({ ok: true, resumed: true })
    // A resume always starts a new engine: a turn left open before it is over.
    expect(note).toHaveBeenCalledWith(saved.sessionId, Buffer.byteLength('{"type":"session_meta"}\n{"prepared":true}\n'), true)
  })

  it('notes nothing for a conversation with no file to tail, or a file that is gone', async () => {
    const note = vi.fn()
    deps = { ...deps, relaunchMarks: { note } }
    // history.jsonl was never written: there is no byte to begin at.
    expect(await start()).toMatchObject({ ok: true, resumed: true })
    expect(note).not.toHaveBeenCalled()
  })

  it('refuses an unsupported explicit permission choice before allocating a pane', async () => {
    rewrite({ engine: 'opencode', permissionMode: 'ask' })
    expect(await createResumeAgentService(deps)(saved.agentId, 'full')).toMatchObject({ error: 'INVALID_PERMISSION_MODE' })
    vi.mocked(refusePermissionFlagIfUnsupported).mockResolvedValue({ error: 'CODEX_CLI_TOO_OLD', detail: 'Update OpenCode.' })
    expect(await createResumeAgentService(deps)(saved.agentId, 'auto')).toMatchObject({ error: 'CODEX_CLI_TOO_OLD' })
    expect(create).not.toHaveBeenCalled()
    expect(deps.stoppedAgents.get(saved.agentId)?.permissionMode).toBe('ask')
  })

  it('does not claim a permission change when Open attaches to a running process', async () => {
    rewrite({ engine: 'opencode', permissionMode: 'ask' })
    live({ resumeOnly: undefined, permissionMode: 'ask' })
    vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'alive' })
    expect(await createResumeAgentService(deps)(saved.agentId, 'auto')).toMatchObject({ error: 'PERMISSION_CHANGE_REQUIRES_STOP' })
    expect(create).not.toHaveBeenCalled()
    expect(registry.byAgent(saved.agentId)?.permissionMode).toBe('ask')
  })

  it('does not join concurrent Open requests with different permission choices', async () => {
    const stop = deferred<void>(); (deps.stopJobs as Map<string, Promise<void>>).set(saved.agentId, stop.promise)
    const resume = createResumeAgentService(deps)
    const first = resume(saved.agentId, 'ask')
    expect(await resume(saved.agentId, 'auto')).toMatchObject({ error: 'AGENT_BUSY' })
    stop.resolve(); expect(await first).toMatchObject({ ok: true })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it.each(['claude', 'codex'] as const)('resumes exact %s conversation on a new route and persists it', async engine => {
    rewrite({ engine, codexHome: '/profile', permissionMode: 'plan', bypassPermission: true, dsh: 'fixture' })
    vi.mocked(installedDsh).mockReturnValue({} as any)
    vi.mocked(enginePathOverride).mockReturnValue('/fixture/bin')
    vi.mocked(deps.relaunchOverrides).mockResolvedValue({ ok: true, overrides: { env: { CODEX_HOME: '/profile', HARNESS_DSH: 'fixture' }, extraArgs: ['--fixture'], clearEnv: ['OLD'] } })
    const result = await start()
    expect(result).toMatchObject({ ok: true, resumed: true, session: { agentId: saved.agentId, sessionId: saved.sessionId, tmuxPane: pane, launch: { state: 'ready' } } })
    expect(buildEngineLaunchArgv).toHaveBeenCalledWith(engine, expect.objectContaining({ resumeSessionId: saved.sessionId, cwd: dir, permissionMode: 'plan', bypassPermission: true, extraArgs: ['--fixture'], clearEnv: ['OLD'], harnessNode: true, installIfMissing: undefined }))
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][0].env).toEqual({ CODEX_HOME: '/profile', HARNESS_DSH: 'fixture' })
    expect(deps.attachDsh).toHaveBeenCalledTimes(1)
    expect(deps.stoppedAgents.get(saved.agentId)?.sessionId).toBe(saved.sessionId)
    expect(deps.stoppedAgents.beginResume(saved.agentId)).not.toBeNull()
    const disk = JSON.parse(readFileSync(join(env.ADAPTER_DATA_DIR, 'registry.json'), 'utf8'))
    expect(JSON.stringify(disk)).toContain(saved.sessionId)
    expect(JSON.stringify(disk)).toContain('resumeOnly')
  })
  it('resumes a database-backed engine on its id alone, with no transcript to demand', async () => {
    // opencode/kilo/hermes/devin keep the conversation in SQLite; requiring a transcript file here
    // refused a resume that works, and refused it AFTER the harness had been paused.
    rewrite({ engine: 'opencode', transcriptPath: '' })
    expect(await start()).toMatchObject({ ok: true, resumed: true, session: { launch: { state: 'ready' } } })
    expect(buildEngineLaunchArgv).toHaveBeenCalledWith('opencode', expect.objectContaining({ resumeSessionId: saved.sessionId }))
  })

  it('stops a live `claude --bg` job on the exact session before building the resume argv', async () => {
    rewrite({ engine: 'claude' })
    expect(await start()).toMatchObject({ ok: true, resumed: true })
    expect(stopConflictingBackgroundJob).toHaveBeenCalledWith(expect.objectContaining({
      bin: engineBin('claude'), sessionId: saved.sessionId,
    }))
    const stopOrder = vi.mocked(stopConflictingBackgroundJob).mock.invocationCallOrder[0]
    const argvOrder = vi.mocked(buildEngineLaunchArgv).mock.invocationCallOrder[0]
    expect(stopOrder).toBeLessThan(argvOrder)
  })

  it('never checks for a background job on a fresh or fork launch (no resumeSessionId)', async () => {
    rewrite({ engine: 'claude', sessionId: '' })
    await start()
    expect(stopConflictingBackgroundJob).not.toHaveBeenCalled()
  })

  it('does not check for a background job on a non-Claude engine', async () => {
    expect(saved.engine).toBe('codex')
    await start()
    expect(stopConflictingBackgroundJob).not.toHaveBeenCalled()
  })

  it('skips the background-job check for a DSH agent: its pane may run on a different host', async () => {
    rewrite({ engine: 'claude', dsh: { id: 'fixture-dsh', url: 'https://example.test' } as any })
    vi.mocked(installedDsh).mockReturnValue(true as any)
    await start()
    expect(stopConflictingBackgroundJob).not.toHaveBeenCalled()
  })

  it('still checks for a background job on a captured-native launch, with that launch\'s own environment', async () => {
    // `native` is the captured launch for every ordinary LOCAL Claude run (launchOverrides.ts), not a
    // signal the pane is elsewhere — it must not turn this off. `launchEnv` here stands in for what
    // launchOverrides.ts really produces: `native.environment` (its CLAUDE_CONFIG_DIR) merged in already.
    rewrite({ engine: 'claude' })
    const native: NativeLaunch = { token: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', opencodeMajor: null,
      environment: { CLAUDE_CONFIG_DIR: '/native/claude-home' }, proofs: [], current: vi.fn(() => true),
      prepareHooks: vi.fn(async () => true), permission: vi.fn(async () => 'supported' as const) }
    vi.mocked(deps.relaunchOverrides).mockResolvedValue({ ok: true,
      overrides: { env: { CLAUDE_CONFIG_DIR: '/native/claude-home' }, extraArgs: [], clearEnv: [], native } })
    await start()
    expect(stopConflictingBackgroundJob).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: saved.sessionId, env: expect.objectContaining({ CLAUDE_CONFIG_DIR: '/native/claude-home' }),
    }))
  })

  it('marks an engine with no startup hook ready off its own process', async () => {
    // muse never hooks, so nothing else would ever leave this row `starting` — it would read as
    // "Starting" for ever and keep discovery out of the pane.
    rewrite({ engine: 'muse' })
    vi.mocked(resolvePaneEngineProcess).mockResolvedValue(identity)
    expect(await start()).toMatchObject({ ok: true, session: { launch: { state: 'ready' } } })
  })

  it('persists the verified process before announcing a resume that has no hook yet', async () => {
    // A process probe only reads. The ordinary fixture also imitates discovery, which used to
    // hide a ready row with no process identity until the next reconcile or SessionStart hook.
    vi.mocked(resolvePaneEngineProcess).mockResolvedValue(identity)
    const result = await start()
    expect(result).toMatchObject({ ok: true, session: { processIdentity: identity, launch: { state: 'ready' } } })
    expect(registry.byAgent(saved.agentId)?.processIdentity).toEqual(identity)
    expect(deps.announceSession).toHaveBeenLastCalledWith(expect.objectContaining({ processIdentity: identity }))
    registry.load()
    expect(registry.byAgent(saved.agentId)?.processIdentity).toEqual(identity)
  })

  it('attaches a resume its own process confirmed when no hook registered it, and says so if that fails', async () => {
    // Round 23: the SessionStart was refused, and discovery, finding the row ready already, did not
    // attach it either, so the resumed agent never showed a turn.
    vi.mocked(resolvePaneEngineProcess).mockResolvedValue(identity)
    expect(await start()).toMatchObject({ ok: true, session: { launch: { state: 'ready' } } })
    expect(deps.attachSession).toHaveBeenCalledTimes(1)
    expect(deps.attachSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: saved.agentId, sessionId: saved.sessionId, processIdentity: identity }))

    for (const row of registry.list()) registry.removeAgent(row.agentId)
    deps.stoppedAgents.finishResume(saved.agentId)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(deps.attachSession).mockRejectedValueOnce(new Error('transcript unreadable'))
    expect(await start()).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(`[resume] ${saved.agentId.slice(0, 8)} attach failed:`, 'transcript unreadable'))
    vi.mocked(deps.attachSession).mockRejectedValueOnce('gone')
    for (const row of registry.list()) registry.removeAgent(row.agentId)
    deps.stoppedAgents.finishResume(saved.agentId)
    expect(await start()).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(`[resume] ${saved.agentId.slice(0, 8)} attach failed:`, 'gone'))
    error.mockRestore()
  })

  it('attaches nothing for a resume that started a new conversation: the engine has yet to name it', async () => {
    // A stopped harness that never had a conversation resumes into a new one.
    rewrite({ sessionId: '', transcriptPath: '' })
    vi.mocked(resolvePaneEngineProcess).mockResolvedValue(identity)
    expect(await start()).toMatchObject({ ok: true, resumed: false, session: { launch: { state: 'ready' } } })
    expect(deps.attachSession).not.toHaveBeenCalled()
  })

  it('leaves the attach to the hook that registered the resume first', async () => {
    // The fixture's probe imitates a hook that already landed (`lastHookAt`): its registration attached it.
    expect(await start()).toMatchObject({ ok: true, session: { launch: { state: 'ready' } } })
    expect(deps.attachSession).not.toHaveBeenCalled()
  })

  it('opens a retained terminal as a new shell without a vendor resume argument', async () => {
    rewrite({ engine: 'terminal', sessionId: '', transcriptPath: '' })
    expect(await start()).toMatchObject({ ok: true, resumed: true, session: { engine: 'terminal', launch: { state: 'ready' } } })
    expect(buildEngineLaunchArgv).toHaveBeenCalledWith('terminal', expect.objectContaining({ resumeSessionId: undefined }))
    expect(deps.prepareSessionResume).not.toHaveBeenCalled()
  })
  it('joins two clients and waits for Stop to finish before allocating', async () => {
    const stop = deferred<void>(); (deps.stopJobs as Map<string, Promise<void>>).set(saved.agentId, stop.promise)
    const resume = createResumeAgentService(deps); const one = resume(saved.agentId); const two = resume(saved.agentId)
    expect(two).toBe(one); await Promise.resolve(); expect(create).not.toHaveBeenCalled()
    stop.resolve(); expect(await one).toMatchObject({ ok: true }); expect(create).toHaveBeenCalledTimes(1)
  })
  it('honors cancellation while waiting for Stop', async () => {
    const stop = deferred<void>(); (deps.stopJobs as Map<string, Promise<void>>).set(saved.agentId, stop.promise)
    const result = start(); await Promise.resolve(); deps.restartJobs.cancel(saved.agentId); stop.resolve()
    expect(await result).toMatchObject({ error: 'AGENT_CHANGED' }); expect(create).not.toHaveBeenCalled()
  })
  it('refuses a conflicting pinned terminal control', async () => {
    (deps.pinnedControls as Set<string>).add(saved.agentId)
    expect(await start()).toMatchObject({ error: 'AGENT_BUSY' }); expect(create).not.toHaveBeenCalled()
  })
  it.each([
    ['missing tmux', () => { noBackend() }, 'TMUX_UNAVAILABLE'],
    ['missing provider', () => rewrite({ grid: { baseUrl: 'https://fixture.invalid', model: null }, gridLaunch: null }), 'GRID_CREDENTIAL_REQUIRED'],
    ['missing DSH', () => rewrite({ dsh: 'missing' }), 'INVALID_DSH'],
    ['missing cwd', () => rewrite({ cwd: null }), 'CWD_NOT_FOUND'],
    ['removed cwd', () => rewrite({ cwd: join(dir, 'gone') }), 'CWD_NOT_FOUND'],
    ['file cwd', () => { const file = join(dir, 'file'); writeFileSync(file, 'file'); rewrite({ cwd: file }) }, 'CWD_NOT_FOUND'],
    ['missing transcript', () => rewrite({ transcriptPath: '' }), 'RESUME_UNAVAILABLE'],
    ['invalid transcript', () => vi.mocked(controlTranscriptEvidence).mockImplementation(() => { throw new IdentityReadUnavailable('fixture source unavailable') }), 'IDENTITY_UNAVAILABLE'],
    ['old process alive', () => vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'alive' }), 'AGENT_BUSY'],
    ['old process unknown', () => vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'unknown', reason: 'fixture' }), 'AGENT_BUSY'],
  ] as const)('refuses %s without allocating or losing history', async (_label, setup, error) => {
    setup(); expect(await start()).toMatchObject({ ok: false, error }); expect(create).not.toHaveBeenCalled()
    expect(deps.stoppedAgents.get(saved.agentId)?.agentId).toBe(saved.agentId)
  })
  it('answers a launch Windows refuses by its reason, opening nothing and keeping the stopped harness', async () => {
    vi.mocked(buildEngineLaunchArgv).mockImplementationOnce(() => { throw new WindowsBatchLaunchRefused('codex', 'C:\\tools\\codex.cmd') })
    expect(await start()).toEqual({ ok: false, error: 'ENGINE_LAUNCH_REFUSED', detail: expect.stringContaining('codex.cmd is a batch file') })
    expect(create).not.toHaveBeenCalled()
    expect(deps.stoppedAgents.get(saved.agentId)?.agentId).toBe(saved.agentId)
    expect(deps.stoppedAgents.resumeReservedAt(saved.agentId)).toBeNull()
  })
  it('sends a native launch\'s marker in the pane env on Windows, where the argv has no /usr/bin/env', async () => {
    const native = { token: 'resume-native', current: () => true } as NativeLaunch
    vi.mocked(deps.relaunchOverrides).mockResolvedValue({ ok: true, overrides: { env: { GRID: '1' }, extraArgs: [], clearEnv: [], native } })
    // What engineLaunchEnv answers on Windows (engineLaunch.spec.ts pins it there).
    vi.mocked(engineLaunchEnv).mockReturnValueOnce({ [NATIVE_LAUNCH_MARKER]: 'resume-native' })
    await start()
    expect(engineLaunchEnv).toHaveBeenCalledWith(saved.engine, native)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ env: { GRID: '1', [NATIVE_LAUNCH_MARKER]: 'resume-native' } }))
  })
  it('starts a resumed Windows engine in its folder, its pane becoming the person\'s shell after it', async () => {
    // What windowsPaneLaunch answers on Windows (windows/engineStart.spec.ts pins it there).
    vi.mocked(windowsPaneLaunch).mockReturnValueOnce({ cwd: dir, afterExit: windowsAfterExit(saved.engine) })
    await start()
    expect(windowsPaneLaunch).toHaveBeenCalledWith(saved.engine, expect.objectContaining({ cwd: dir, held: false }))
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ cwd: dir, afterExit: windowsAfterExit(saved.engine) }))
  })
  it('names the configured backend when none can open the resumed pane', async () => {
    deps.createBackend = null
    expect(await start()).toEqual({ ok: false, error: 'TMUX_UNAVAILABLE' })
    deps.noBackendCode = 'PTY_HOST_UNAVAILABLE'
    expect(await start()).toEqual({ ok: false, error: 'PTY_HOST_UNAVAILABLE' })
    expect(create).not.toHaveBeenCalled()
    expect(deps.stoppedAgents.get(saved.agentId)?.agentId).toBe(saved.agentId)
  })
  it('does not rewrite a profile while an earlier allocation is unconfirmed', async () => {
    deps.stoppedAgents.beginResume(saved.agentId)
    expect(await start()).toMatchObject({ error: 'RESUME_UNCONFIRMED' })
    expect(deps.relaunchOverrides).not.toHaveBeenCalled(); expect(deps.prepareSessionResume).not.toHaveBeenCalled()
  })
  // The other half of the rule: a reservation older than the readiness budget cannot still belong to
  // a running resume, and leaving it in place made the harness permanently unresumable — every Enter
  // refused before it looked at anything.
  it('takes over a reservation older than the readiness budget', async () => {
    deps.stoppedAgents.beginResume(saved.agentId)
    const held = join(dir, 'saved', `${saved.agentId}.resume`)
    const stale = Date.now() - RESUME_READINESS_BUDGET_MS - 60_000
    utimesSync(held, new Date(stale), new Date(stale))
    expect(await start()).toMatchObject({ ok: true })
    expect(create).toHaveBeenCalled()
  })

  it.each(['provider', 'prepare', 'cancel', 'conversation'] as const)('releases the reservation before allocation after %s failure', async reason => {
    if (reason === 'provider') vi.mocked(deps.relaunchOverrides).mockResolvedValue({ ok: false, error: 'PROVIDER_FAILED', detail: 'fixture' })
    if (reason === 'prepare') vi.mocked(deps.prepareSessionResume).mockImplementation(() => { throw new Error('fixture') })
    if (reason === 'cancel') vi.mocked(deps.relaunchOverrides).mockImplementation(async () => { deps.restartJobs.cancel(saved.agentId); return { ok: true, overrides: { env: {}, extraArgs: [], clearEnv: [] } } })
    if (reason === 'conversation') vi.mocked(deps.prepareSessionResume).mockImplementation(() => { registry.resumePendingAgent({ ...saved, agentId: 'other' }, [{ backend: 'tmux', paneId: '%101' }]) })
    expect(await start()).toMatchObject({ ok: false })
    expect(create).not.toHaveBeenCalled(); expect(deps.stoppedAgents.beginResume(saved.agentId)).not.toBeNull()
  })
  it.each(['tmux is unavailable', 'allocation reply lost'])('handles allocation error: %s', async reason => {
    create.mockResolvedValue({ state: 'failed', reason })
    expect(await start()).toMatchObject({ error: reason === 'tmux is unavailable' ? 'TMUX_UNAVAILABLE' : 'RESUME_UNCONFIRMED' })
    expect(deps.stoppedAgents.beginResume(saved.agentId) === null).toBe(reason !== 'tmux is unavailable')
    expect(registry.byAgent(saved.agentId)).toBeUndefined()
  })
  // On 2026-10-26, 10 of 17 failed resumes were a preparation failure, and nothing said which check refused.
  it('reports why preparation failed, in the reply and the daemon log', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(deps.prepareSessionResume).mockImplementationOnce(() => {
      throw new ResumePreparationError('changed_during', 'Codex rollout changed during resume preparation; retry after its writer stops')
    })
    expect(await start()).toEqual({ ok: false, error: 'RESUME_PREPARATION_FAILED', reason: 'changed_during',
      detail: 'Codex is still writing this conversation. Try again once it stops.' })
    expect(warned.mock.calls.map(call => call.join(' '))).toContainEqual(expect.stringContaining(
      'resume preparation failed: changed_during: Codex rollout changed during resume preparation; retry after its writer stops'))
    expect(create).not.toHaveBeenCalled()
  })

  it('names a preparation failure of no known kind as other, with the usual words', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(deps.prepareSessionResume).mockImplementationOnce(() => { throw new Error('EACCES: permission denied') })
    expect(await start()).toEqual({ ok: false, error: 'RESUME_PREPARATION_FAILED', reason: 'other',
      detail: 'Could not prepare the saved conversation. Its history has been retained.' })
    expect(warned.mock.calls.map(call => call.join(' '))).toContainEqual(expect.stringContaining('resume preparation failed: other: Error'))
  })

  // An error of no known kind can carry anything: a profile path, a token, a line of the conversation.
  it('logs a preparation failure of no known kind by its class only, never its message', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {})
    const secret = 'SECRET-SENTINEL /Users/someone/.codex/sessions/rollout.jsonl user said: my password is hunter2'
    vi.mocked(deps.prepareSessionResume).mockImplementationOnce(() => { throw new TypeError(secret) })
    expect(await start()).toMatchObject({ ok: false, error: 'RESUME_PREPARATION_FAILED', reason: 'other' })
    const logged = [...warned.mock.calls, ...printed.mock.calls].map(call => call.join(' ')).join('\n')
    expect(logged).toContain('resume preparation failed: other: TypeError')
    expect(logged).not.toContain('SECRET-SENTINEL')
    expect(logged).not.toContain('hunter2')
  })

  it('logs a non-Error throw as its type only', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(deps.prepareSessionResume).mockImplementationOnce(() => { throw 'SECRET-SENTINEL thrown as a string' })
    expect(await start()).toMatchObject({ ok: false, error: 'RESUME_PREPARATION_FAILED', reason: 'other' })
    const logged = warned.mock.calls.map(call => call.join(' ')).join('\n')
    expect(logged).toContain('resume preparation failed: other: string')
    expect(logged).not.toContain('SECRET-SENTINEL')
  })

  it('retains a typed native hold from synchronous history repair and releases its reservation', async () => {
    vi.mocked(deps.prepareSessionResume).mockImplementationOnce(() => { throw new IdentityReadUnavailable('the native store is incomplete') })
    expect(await start()).toMatchObject({ ok: false, error: 'IDENTITY_UNAVAILABLE' })
    expect(create).not.toHaveBeenCalled()
    expect(deps.stoppedAgents.resumeReservedAt(saved.agentId)).toBeNull()
    expect(deps.stoppedAgents.get(saved.agentId)?.sessionId).toBe(saved.sessionId)
  })

  it.each(['permission', 'argv'] as const)('checks cancellation after %s preparation before allocating a pane', async phase => {
    if (phase === 'permission') vi.mocked(dropPermissionFlagIfUnsupported).mockImplementationOnce(async (_engine, choice) => {
      deps.restartJobs.cancel(saved.agentId)
      return { choice, droppedFlag: null }
    })
    else vi.mocked(buildEngineLaunchArgv).mockImplementationOnce(() => { deps.restartJobs.cancel(saved.agentId); return ['fixture-engine'] })
    expect(await start()).toMatchObject({ ok: false, error: 'AGENT_CHANGED' })
    expect(create).not.toHaveBeenCalled()
    expect(deps.stoppedAgents.resumeReservedAt(saved.agentId)).toBeNull()
  })

  it('releases the reservation and preserves an unexpected launch preparation failure', async () => {
    const failure = new Error('private configuration write refused')
    vi.mocked(deps.relaunchOverrides).mockRejectedValueOnce(failure)
    await expect(start()).rejects.toBe(failure)
    expect(create).not.toHaveBeenCalled()
    expect(deps.stoppedAgents.resumeReservedAt(saved.agentId)).toBeNull()
    expect(deps.stoppedAgents.get(saved.agentId)?.sessionId).toBe(saved.sessionId)
  })

  it('cancels a tmux allocation without registering or reusing its pane', async () => {
    create.mockImplementation(async () => { deps.restartJobs.cancel(saved.agentId); return { state: 'succeeded', runtime: { backend: 'tmux', paneId: pane } } })
    expect(await start()).toMatchObject({ error: 'AGENT_CHANGED' }); expect(kill).toHaveBeenCalledTimes(1)
    expect(registry.byAgent(saved.agentId)).toBeUndefined()
  })
  it.each([true, false])('cancels after a registry claim, cleanup confirmed=%s', async confirmed => {
    kill.mockResolvedValue(confirmed ? { state: 'succeeded' } : { state: 'failed' })
    const claim = registry.resumePendingAgent.bind(registry)
    deps.registry = { ...deps.registry, byAgent: registry.byAgent.bind(registry), bySession: registry.bySession.bind(registry), setLaunch: registry.setLaunch.bind(registry), resumePendingAgent: (row, routes) => { const pending = claim(row, routes); deps.restartJobs.cancel(saved.agentId); return pending } }
    expect(await start()).toMatchObject({ error: 'AGENT_CHANGED' }); expect(deps.announceSession).not.toHaveBeenCalled()
    expect(kill).toHaveBeenCalledTimes(1)
    expect(registry.byAgent(saved.agentId) === undefined).toBe(confirmed)
  })
  it('serializes two saved identities for the same conversation', async () => {
    const second = { ...saved, agentId: 'alias' }; deps.stoppedAgents.save(second)
    const build = deferred<any>(); vi.mocked(deps.relaunchOverrides).mockReturnValue(build.promise)
    const resume = createResumeAgentService(deps); const one = resume(saved.agentId)
    await vi.waitFor(() => expect(deps.relaunchOverrides).toHaveBeenCalledTimes(1))
    expect(await resume(second.agentId)).toMatchObject({ error: 'AGENT_BUSY' })
    build.resolve({ ok: true, overrides: { env: {}, extraArgs: [], clearEnv: [] } })
    expect(await one).toMatchObject({ ok: true }); expect(create).toHaveBeenCalledTimes(1)
  })
})

describe('existing runtime and readiness verification', () => {
  it.each(['claude', 'terminal'] as const)('attaches a verified live %s without a new pane', async engine => {
    if (engine === 'terminal') rewrite({ engine, sessionId: '', transcriptPath: '' })
    live({ engine, resumeOnly: undefined, launch: { state: 'ready' } }); vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'alive' })
    expect(await start()).toMatchObject({ ok: true }); expect(create).not.toHaveBeenCalled()
    if (engine === 'claude') expect(checkSessionRuntime).toHaveBeenCalledWith(tmuxTerminal, expect.objectContaining({ agentId: saved.agentId }), { backend: 'tmux', paneId: pane })
  })
  it('checks a mixed row through its tmux pane, not the ptyhost pane its `tmuxPane` projects', async () => {
    const tmux = { backend: 'tmux' as const, paneId: '%9' }
    live({ resumeOnly: undefined, launch: { state: 'ready' }, runtimes: [{ backend: 'ptyhost', instance: 'p1', paneId: pane }, tmux] })
    vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'alive' }); inventory.mockResolvedValue(listed('%9'))
    expect(await start()).toMatchObject({ ok: true }); expect(create).not.toHaveBeenCalled()
    expect(checkSessionRuntime).toHaveBeenCalledExactlyOnceWith(tmuxTerminal, expect.objectContaining({ agentId: saved.agentId }), tmux)
  })
  it.each(['no route', 'no inventory', 'process unknown', 'process detached', 'unidentified engine', 'no tmux backend'] as const)('does not disturb %s', async reason => {
    // No tmux route: a ptyhost pane only, whose `tmuxPane` projection names the id tmux lists below.
    live({ resumeOnly: undefined, launch: { state: 'ready' }, ...(reason === 'no route' ? { runtimes: [{ backend: 'ptyhost', instance: 'p1', paneId: pane }] } : {}) })
    if (reason === 'no route') vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'alive' })
    if (reason === 'no tmux backend') { noBackend(); vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'alive' }) }
    if (reason === 'no inventory') inventory.mockResolvedValue({ state: 'unavailable', reason: 'fixture' })
    if (reason === 'process unknown') vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'unknown', reason: 'fixture' })
    if (reason === 'process detached') { vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'alive' }); inventory.mockResolvedValue(listed()) }
    expect(await start()).toMatchObject({ error: 'RESUME_UNCONFIRMED' }); expect(create).not.toHaveBeenCalled()
    if (reason === 'no route') { expect(inventory).not.toHaveBeenCalled(); expect(checkSessionRuntime).not.toHaveBeenCalled() }
  })
  it.each([true, false])('retains a confirmed engine exit, surviving shell = %s', async alive => {
    live({ resumeOnly: undefined, processIdentity: identity, launch: { state: 'ready' } })
    inventory.mockResolvedValue(alive ? listed(pane) : listed())
    // New pane must be distinct from the shell retained by this scenario.
    create.mockResolvedValue({ state: 'succeeded', runtime: { backend: 'tmux', paneId: '%100' } })
    expect(await start()).toMatchObject({ ok: true }); expect(deps.retainExitedSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: saved.agentId }), alive)
    if (alive) expect(registry.byRuntimeTerminal({ backend: 'tmux', paneId: pane })?.engine).toBe('terminal')
  })
  it('cannot verify a surviving shell with no tmux backend to list it', async () => {
    live({ engine: 'terminal', resumeOnly: undefined, launch: { state: 'ready' } }); noBackend()
    await expect(start()).rejects.toThrow('Could not verify')
    expect(deps.retainExitedSession).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled()
  })
  it('resumes a missing shell', async () => {
    rewrite({ engine: 'terminal', sessionId: '', transcriptPath: '' }); live({ resumeOnly: undefined, launch: { state: 'ready' } })
    inventory.mockResolvedValue(listed())
    expect(await start()).toMatchObject({ ok: true }); expect(create).toHaveBeenCalledTimes(1)
  })
  it.each(['unknown', 'cancel'] as const)('refuses to retire the old route when its second probe is %s', async mode => {
    live({ resumeOnly: undefined, processIdentity: identity, launch: { state: 'ready' } })
    inventory.mockResolvedValueOnce(listed(pane)).mockImplementationOnce(async () => {
      if (mode === 'cancel') deps.restartJobs.cancel(saved.agentId)
      return mode === 'unknown' ? { state: 'unavailable', reason: 'fixture' } : listed(pane)
    })
    if (mode === 'unknown') await expect(start()).rejects.toThrow('Could not verify')
    else expect(await start()).toMatchObject({ error: 'AGENT_CHANGED' })
    expect(deps.retainExitedSession).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled()
  })
  it('rechecks a pending allocation after reconnect without spawning again', async () => {
    live(); expect(await start()).toMatchObject({ ok: true }); expect(create).not.toHaveBeenCalled()
    // Asked of the pane's own backend, about the pane the row records.
    expect(resolvePaneEngineProcess).toHaveBeenCalledWith(tmuxTerminal, { backend: 'tmux', paneId: pane }, 'codex')
    expect(releaseHold).toHaveBeenCalledWith({ backend: 'tmux', paneId: pane })
  })
  it('confirms nothing of a pending allocation with no tmux backend to ask', async () => {
    live(); noBackend()
    expect(await start()).toEqual({ ok: false, error: 'TMUX_UNAVAILABLE' })
    expect(resolvePaneEngineProcess).not.toHaveBeenCalled(); expect(deps.announceSession).not.toHaveBeenCalled()
  })
  it('asks a live unconfirmed resume for confirmation again, withdrawing the old verdict first', async () => {
    live({ processIdentity: identity, launch: { state: 'failed', error: 'RESUME_UNCONFIRMED', detail: 'fixture' } })
    vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'alive' })
    // The registry hands out its live row, so read the state as each announcement is made.
    const announced: string[] = []; vi.mocked(deps.announceSession).mockImplementation(row => { announced.push(row.launch?.state ?? '') })
    expect(await start()).toMatchObject({ ok: true, resumed: true, session: { launch: { state: 'ready' } } })
    expect(create).not.toHaveBeenCalled()
    expect(announced).toEqual(['starting', 'ready'])
  })
  // The regression openharness#189 left behind. The fixture above fakes a SessionStart on every
  // process probe; here it deliberately does not, which is the real shape of a re-check: the engine
  // has been running for hours and will never send another hook. The re-check re-arms `starting` to
  // withdraw the old verdict, and the readiness probe used to refuse to confirm while it read
  // `starting` — so every Enter bought ten minutes of "Starting" and the same banner again.
  it('confirms a live unconfirmed resume that has no further hook coming', async () => {
    live({ processIdentity: identity, lastHookAt: 0, launch: { state: 'failed', error: 'RESUME_UNCONFIRMED', detail: 'fixture' } })
    vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'alive' })
    vi.mocked(resolvePaneEngineProcess).mockResolvedValue(identity)
    expect(await start()).toMatchObject({ ok: true, resumed: true })
    // Ready, not `starting`: a row left starting is made dormant without being retained by
    // discovery, and the desk reads its own resume receipt as unknown.
    expect(registry.byAgent(saved.agentId)?.launch).toEqual({ state: 'ready' })
    // The reservation is released, so the next Enter is not refused by `beginResume`.
    expect(existsSync(join(dir, 'saved', `${saved.agentId}.resume`))).toBe(false)
    expect(create).not.toHaveBeenCalled()
  })
  it('does not re-verify a live process that reported another conversation', async () => {
    live({ processIdentity: identity, launch: { state: 'failed', error: 'RESUME_SESSION_MISMATCH', detail: 'fixture' } })
    vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'alive' })
    expect(await start()).toMatchObject({ error: 'RESUME_SESSION_MISMATCH', detail: 'fixture' })
    expect(registry.byAgent(saved.agentId)?.launch).toMatchObject({ state: 'failed', error: 'RESUME_SESSION_MISMATCH' })
    expect(deps.announceSession).not.toHaveBeenCalled()
  })
  it('waits for a real readiness observation before replying', async () => {
    vi.useFakeTimers(); vi.mocked(resolvePaneEngineProcess).mockResolvedValueOnce(null)
    const result = start(); await vi.advanceTimersByTimeAsync(500)
    expect(await result).toMatchObject({ ok: true }); expect(resolvePaneEngineProcess).toHaveBeenCalledTimes(2)
  })
  it('honors a stop requested as the newly allocated runtime is announced', async () => {
    vi.mocked(deps.announceSession).mockImplementation(() => deps.restartJobs.cancel(saved.agentId))
    expect(await start()).toMatchObject({ error: 'AGENT_CHANGED' })
    expect(deps.stoppedAgents.get(saved.agentId)?.sessionId).toBe(saved.sessionId)
    expect(deps.stoppedAgents.beginResume(saved.agentId)).toBeNull()
  })
  it.each([true, false])('cancels while clearing remain-on-exit, terminal=%s', async terminal => {
    if (terminal) rewrite({ engine: 'terminal', sessionId: '', transcriptPath: '' })
    releaseHold.mockImplementation(async () => { deps.restartJobs.cancel(saved.agentId) })
    expect(await start()).toMatchObject({ error: 'AGENT_CHANGED' })
  })
  it('does not finish a reservation when the route changes during final readiness cleanup', async () => {
    releaseHold.mockImplementation(async () => { registry.byAgent(saved.agentId)!.tmuxPane = '%102' })
    expect(await start()).toMatchObject({ error: 'AGENT_CHANGED' })
    expect(deps.stoppedAgents.beginResume(saved.agentId)).toBeNull()
  })
  it.each(['operation', 'route'] as const)('cancels a readiness check when %s changes', async mode => {
    live()
    vi.mocked(resolvePaneEngineProcess).mockImplementation(async () => { if (mode === 'operation') deps.restartJobs.cancel(saved.agentId); else registry.byAgent(saved.agentId)!.tmuxPane = '%102'; return identity })
    expect(await start()).toMatchObject({ error: 'AGENT_CHANGED' })
  })
  it.each(['missing row', 'exit dead pane', 'exit surviving pane', 'exit unknown process', 'mismatched session', 'failed hook', 'cancel process probe', 'cancel pane probe'] as const)('preserves work on %s', async mode => {
    live()
    vi.mocked(resolvePaneEngineProcess).mockImplementation(async () => {
      if (mode === 'missing row') registry.removeAgent(saved.agentId)
      if (mode === 'mismatched session') registry.byAgent(saved.agentId)!.sessionId = 'other'
      if (mode === 'failed hook') registry.setLaunch(saved.agentId, { state: 'failed', error: 'RESUME_SESSION_MISMATCH', detail: 'fixture' })
      return null
    })
    paneState.mockResolvedValueOnce({ dead: false, engineExit: 1 } as any)
    if (mode === 'exit dead pane') paneState.mockResolvedValueOnce({ dead: true } as any)
    if (mode === 'exit unknown process') vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'unknown', reason: 'fixture' })
    if (mode === 'cancel process probe') vi.mocked(checkPidRuntime).mockImplementation(async () => { deps.restartJobs.cancel(saved.agentId); return { state: 'gone', reason: 'fixture' } })
    if (mode === 'cancel pane probe') paneState.mockImplementationOnce(async () => { deps.restartJobs.cancel(saved.agentId); return 'gone' })
    expect(await start()).toMatchObject({ ok: false })
    expect(create).not.toHaveBeenCalled(); expect(deps.stoppedAgents.get(saved.agentId)).not.toBeNull()
  })
  it.each([
    ['gone', false], ['unknown', true],
  ] as const)('an exited engine whose pane tmux reads as %s keeps its row as a terminal: %s', async (pane, kept) => {
    // Only a pane known to be gone loses its row. One tmux could not read (a call that timed out while
    // the daemon's event loop was held) keeps it, for the reconciler to judge with scans that agree.
    live()
    vi.mocked(resolvePaneEngineProcess).mockResolvedValue(null)
    paneState.mockResolvedValueOnce({ dead: false, engineExit: 1 } as any).mockResolvedValueOnce(pane)
    expect(await start()).toMatchObject({ ok: false, error: 'RESUME_FAILED' })
    expect(deps.retainExitedSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: saved.agentId }), kept)
  })
})

describe('resume edges the desk sees', () => {
  // The probe proves a new process, and the row must record it before anyone is told the harness is up:
  // an engine that is "ready" with no recorded process cannot be attached to or stopped.
  it('does not confirm a resume off a process the registry cannot record, and keeps its reservation', async () => {
    vi.mocked(resolvePaneEngineProcess).mockResolvedValue({ ...identity, pid: 0 })
    expect(await start()).toMatchObject({ ok: false, error: 'AGENT_CHANGED' })
    expect(registry.byAgent(saved.agentId)?.launch?.state).not.toBe('ready')
    expect(deps.stoppedAgents.beginResume(saved.agentId)).toBeNull()
  })

  // A verdict another path set on the row (a hook's mismatch guard) is reported as itself, and said in the
  // log as it is, with no "undefined" where a reason would be.
  it('reports a failure the row was given elsewhere, without a reason, as itself', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.mocked(resolvePaneEngineProcess).mockImplementation(async () => {
      registry.setLaunch(saved.agentId, { state: 'failed', error: 'RESUME_MISMATCH' } as never)
      return null
    })
    const result = await start()
    expect(result).toMatchObject({ ok: false, error: 'RESUME_MISMATCH' })
    expect(registry.byAgent(saved.agentId)?.launch).toMatchObject({ state: 'failed', error: 'RESUME_MISMATCH' })
    const said = log.mock.calls.map(([line]) => String(line)).find((line) => line.startsWith('[resume]') && line.includes('RESUME_MISMATCH'))
    expect(said).toBe(`[resume] ${saved.agentId.slice(0, 8)} RESUME_MISMATCH · engine=codex`)
  })

  // Asking the engine whether it takes the chosen permission flag can take a while (its --help); a Stop
  // or another Open in that time wins, and this one allocates nothing.
  it('allocates nothing when the harness changes while the engine is asked about the permission flag', async () => {
    vi.mocked(refusePermissionFlagIfUnsupported).mockImplementation(async () => { deps.restartJobs.cancel(saved.agentId); return null })
    expect(await createResumeAgentService(deps)(saved.agentId, 'ask')).toMatchObject({ ok: false, error: 'AGENT_CHANGED' })
    expect(create).not.toHaveBeenCalled()
  })

  // An engine downgraded since the pause no longer takes the saved permission flag (openharness#285): the
  // harness still comes back, in Ask, and the log says how to get the saved mode back.
  it.each([
    ['plan', false, 'plan'],
    [undefined, true, 'Auto'],
  ] as const)('resumes in Ask when the engine no longer takes the saved %s flag, and says how to get it back', async (mode, bypass, named) => {
    rewrite({ permissionMode: mode, bypassPermission: bypass })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(dropPermissionFlagIfUnsupported).mockResolvedValueOnce({
      choice: { permissionMode: null, bypassPermission: false }, droppedFlag: '--permission-mode',
    })
    expect(await start()).toMatchObject({ ok: true, resumed: true })
    expect(buildEngineLaunchArgv).toHaveBeenCalledWith('codex', expect.objectContaining({ bypassPermission: false }))
    expect(vi.mocked(buildEngineLaunchArgv).mock.calls[0][1]).not.toHaveProperty('permissionMode')
    expect(warn).toHaveBeenCalledWith(`[resume] ${saved.agentId.slice(0, 8)} · codex does not take --permission-mode`
      + ` · resuming in Ask · update codex to get ${named} back`)
  })
})


// Resume on the pty host, the only backend on Windows: each pane is asked of the backend it is on, and a new one is made
// where new panes are. Before this, every resume there answered TMUX_UNAVAILABLE once its pane was up.
describe('resume on the pty host', () => {
  beforeEach(() => ptyhostOnly())

  it('resumes a stopped harness in a new pty host pane and confirms it there, never asking tmux', async () => {
    expect(await start()).toMatchObject({ ok: true, resumed: true, session: { agentId: saved.agentId, runtimes: [pty] } })
    expect(ptyCreate).toHaveBeenCalledOnce()
    expect(buildEngineLaunchArgv).toHaveBeenCalledWith('codex', expect.objectContaining({ resumeSessionId: saved.sessionId }))
    expect(ptyCreate.mock.calls[0][0].command).toEqual(['fixture-engine'])
    expect(resolvePaneEngineProcess).toHaveBeenCalledWith(ptyTerminal, pty, 'codex')
    expect(ptyReleaseHold).toHaveBeenCalledWith(pty)
    tmuxUntouched()
  })

  it('opens a stopped shell in a new pty host pane', async () => {
    rewrite({ engine: 'terminal', sessionId: '', transcriptPath: '' })
    expect(await start()).toMatchObject({ ok: true, session: { runtimes: [pty], launch: { state: 'ready' } } })
    expect(ptyReleaseHold).toHaveBeenCalledWith(pty)
    tmuxUntouched()
  })

  it('closes a cancelled allocation on the pty host', async () => {
    ptyCreate.mockImplementation(async () => { deps.restartJobs.cancel(saved.agentId); return { state: 'succeeded', runtime: pty } })
    expect(await start()).toMatchObject({ error: 'AGENT_CHANGED' })
    expect(ptyKill).toHaveBeenCalledExactlyOnceWith(pty)
    tmuxUntouched()
  })

  it('attaches a live pty host harness verified through its own inventory and pane', async () => {
    live({ resumeOnly: undefined, launch: { state: 'ready' }, runtimes: [pty] })
    vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'alive' })
    expect(await start()).toMatchObject({ ok: true }); expect(ptyCreate).not.toHaveBeenCalled()
    expect(ptyInventory).toHaveBeenCalledOnce()
    expect(checkSessionRuntime).toHaveBeenCalledExactlyOnceWith(ptyTerminal, expect.objectContaining({ agentId: saved.agentId }), pty)
    tmuxUntouched()
  })

  it.each([true, false])('retains a pty host engine that exited, its shell surviving = %s', async alive => {
    live({ resumeOnly: undefined, processIdentity: identity, launch: { state: 'ready' }, runtimes: [pty] })
    ptyInventory.mockResolvedValue(alive ? ptyListed(pty.paneId) : ptyListed())
    ptyCreate.mockResolvedValue({ state: 'succeeded', runtime: { ...pty, paneId: '%6' } })
    expect(await start()).toMatchObject({ ok: true })
    expect(deps.retainExitedSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: saved.agentId }), alive)
    tmuxUntouched()
  })

  it('rechecks a pending pty host allocation through its own backend', async () => {
    live({ runtimes: [pty] })
    expect(await start()).toMatchObject({ ok: true }); expect(ptyCreate).not.toHaveBeenCalled()
    expect(resolvePaneEngineProcess).toHaveBeenCalledWith(ptyTerminal, pty, 'codex')
    expect(ptyReleaseHold).toHaveBeenCalledWith(pty)
    tmuxUntouched()
  })

  it('reads a pty host pane whose engine exited, to keep or drop its row', async () => {
    live({ runtimes: [pty] })
    vi.mocked(resolvePaneEngineProcess).mockResolvedValue(null)
    ptyPaneState.mockResolvedValueOnce({ dead: false, engineExit: 1 }).mockResolvedValueOnce('gone')
    expect(await start()).toMatchObject({ ok: false, error: 'RESUME_FAILED' })
    expect(ptyPaneState).toHaveBeenCalledWith(pty)
    expect(deps.retainExitedSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: saved.agentId }), false)
    tmuxUntouched()
  })

  it('names the pty host when a pty host row has no backend to ask', async () => {
    live({ runtimes: [pty] }); deps.backendFor = () => undefined
    expect(await start()).toEqual({ ok: false, error: 'PTY_HOST_UNAVAILABLE' })
    expect(resolvePaneEngineProcess).not.toHaveBeenCalled()
  })

  it('asks tmux for the tmux pane of a mixed row', async () => {
    deps.backendFor = runtime => runtime.backend === 'tmux' ? tmuxTerminal : ptyTerminal
    const tmux = { backend: 'tmux' as const, paneId: pane }
    live({ runtimes: [pty, tmux] })
    expect(await start()).toMatchObject({ ok: true })
    expect(resolvePaneEngineProcess).toHaveBeenCalledWith(tmuxTerminal, tmux, 'codex')
    expect(releaseHold).toHaveBeenCalledWith(tmux)
    expect(ptyReleaseHold).not.toHaveBeenCalled()
  })
})
