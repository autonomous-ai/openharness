import { removeRegistryAgent } from '../testing/registryFixtures.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createResumeAgentService, type ResumeAgentServiceDeps } from './resumeAgentService.js'
import { RESUME_READINESS_BUDGET_MS, resumeChanged, waitForResumedAgent } from './resumeStoppedAgent.js'
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
import { windowsAfterExit, windowsPaneLaunch, windowsHeldPaneArgv } from './windows/engineStart.js'
import { buildEngineCommandArgv, buildEngineLaunchArgv, dropPermissionFlagIfUnsupported, engineLaunchEnv, refusePermissionFlagIfUnsupported } from './engineLaunch.js'
import { engineBin, enginePathOverride } from './engineBin.js'
import { installedDsh } from '../dsh/installed.js'
import { createLaunchHelpers } from '../core/agents/launch.js'
import { createLaunchAuthority } from '../core/agents/launchAuthority.js'
import type { NativeLaunch } from '../engines/nativeLaunch.js'
import type { TerminalInventoryResult } from './terminalTypes.js'
import { WindowsBatchLaunchRefused } from './windows/launch.js'
import { NATIVE_LAUNCH_MARKER } from './nativePaneHold.js'
import { AtomicWriteUnconfirmed } from './registryPersistence.js'
import type { GridLaunchOverride } from './gridLaunchWire.js'

const publication = vi.hoisted(() => ({
  agent: '', wait: undefined as undefined | (() => Promise<void>), release: undefined as undefined | (() => void),
  temporary: '', published: false, failSync: 0, cleanupWait: undefined as undefined | (() => Promise<void>),
  retire: false, pending: false, directoryWait: undefined as undefined | (() => Promise<void>),
}))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    actual.renameSync(...args)
    if (String(args[0]) === publication.temporary) publication.published = true
  }, fsyncSync: (fd: number) => {
    if (publication.published && publication.failSync) {
      publication.failSync--
      throw Object.assign(Error('fixture directory sync failed'), { code: 'EIO' })
    }
    return actual.fsyncSync(fd)
  }, fsync: (fd: number, callback: (error: NodeJS.ErrnoException | null) => void) => {
    const selected = publication.published && actual.fstatSync(fd).isDirectory()
    const wait = selected ? publication.directoryWait : undefined
    if (wait) publication.directoryWait = undefined
    actual.fsync(fd, error => { void (wait?.() ?? Promise.resolve()).then(() => {
      if (selected && publication.failSync) {
        publication.failSync--
        callback(Object.assign(Error('fixture directory sync failed'), { code: 'EIO' }))
      } else callback(error)
    }, callback) })
  } }
})
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args), read = handle.read.bind(handle)
    handle.read = (async (...options: Parameters<typeof handle.read>) => {
      const result = await read(...options)
      if (publication.published && String(args[0]).endsWith('registry.json.lock/owner.json')) await publication.cleanupWait?.()
      return result
    }) as typeof handle.read
    return handle
  } }
})
vi.mock('./sessionPublication.js', async original => {
  const actual = await original<typeof import('./sessionPublication.js')>()
  return { ...actual, prepareSessionPublication: async (...args: Parameters<typeof actual.prepareSessionPublication>) => {
    const prepared = await actual.prepareSessionPublication(...args)
    if (args[1].kind === 'registry') {
      const rows = prepared.value as RegisteredSession[]
      const ready = !!publication.agent && (publication.retire ? !rows.some(row => row.agentId === publication.agent)
        : rows.some(row => row.agentId === publication.agent && row.launch?.state === (publication.pending ? 'starting' : 'ready')))
      if (ready) {
        publication.temporary = (args[0] as unknown as { preparation: { reservation: { temporary: string } } }).preparation.reservation.temporary
        publication.temporary = join(args[0].root, publication.temporary)
        await publication.wait?.()
      }
    }
    return prepared
  } }
})

vi.mock('./windows/engineStart.js', async (original) => {
  const actual = await original<typeof import('./windows/engineStart.js')>()
  return { ...actual, windowsPaneLaunch: vi.fn(actual.windowsPaneLaunch) }
})
vi.mock('./deleteAgentFallback.js', () => ({ checkPidRuntime: vi.fn() }))
vi.mock('./resumeStoppedAgent.js', async original => {
  const actual = await original<typeof import('./resumeStoppedAgent.js')>()
  return { ...actual, waitForResumedAgent: vi.fn(actual.waitForResumedAgent) }
})
// The engine this fake stands for never exits, so there is no settle time to wait out; the rule is tested in
// `resumeStoppedAgent.spec.ts`.
vi.mock('./paneEngineProcess.js', () => ({ checkSessionRuntime: vi.fn(), resolvePaneEngineProcess: vi.fn(), ENGINE_SETTLE_MS: 0 }))
// `resumeCapability` reads the real flag table through this module; only the argv builder and the
// capability gate are faked. The gate would otherwise spawn the tester's own login shell to ask
// `<engine> --help` about a flag, which is neither this file's subject nor the same answer on two
// machines. Its own behaviour is covered in `engineLaunch.spec.ts`.
vi.mock('./engineLaunch.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./engineLaunch.js')>()),
  buildEngineCommandArgv: vi.fn(() => ['fixture-engine']),
  buildEngineLaunchArgv: vi.fn(() => ['fixture-engine']),
  engineLaunchEnv: vi.fn(() => undefined),
  dropPermissionFlagIfUnsupported: vi.fn(async (_engine: unknown, choice: unknown) => ({ choice, droppedFlag: null })),
  refusePermissionFlagIfUnsupported: vi.fn(async () => null),
}))
vi.mock('./engineBin.js', () => ({ enginePathOverride: vi.fn(() => undefined), engineBin: vi.fn((engine: string) => engine) }))
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
async function live(extra: Partial<RegisteredSession> = {}) {
  const admitted = (await registry.resumePendingAgent(saved, extra.runtimes ?? [{ backend: 'tmux', paneId: pane }]))!
  return Object.assign(registry.byAgent(admitted.agentId)!, extra)
}
async function rewrite(extra: Omit<Partial<RegisteredSession>, 'gridLaunch'> & { gridLaunch?: GridLaunchOverride | null }) {
  // Simulate the legacy disk writer; current core reads the resulting projected row through storage.
  const file = join(env.ADAPTER_DATA_DIR, 'stopped-agents', `${saved.agentId}.json`), value = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...value, session: { ...value.session, ...extra } }), { mode: 0o600 })
  saved = (await deps.stoppedAgents.get(saved.agentId))!
}
function start() { return createResumeAgentService(deps)(saved.agentId) }
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

it('refuses a readiness response that lacks its required process proof', async () => {
  vi.mocked(waitForResumedAgent).mockResolvedValueOnce({ ok: true, session: { ...saved, processIdentity: null }, resumed: true })
  expect(await start()).toMatchObject({ ok: false, error: 'AGENT_CHANGED' })
  expect(releaseHold).not.toHaveBeenCalled()
  expect(registry.byAgent(saved.agentId)?.launch?.state).not.toBe('ready')
})

it('preserves the readiness reader\'s ownership refusal without publishing a failed launch', async () => {
  await live()
  vi.mocked(waitForResumedAgent).mockResolvedValueOnce(resumeChanged)
  expect(await start()).toEqual(resumeChanged)
  expect(registry.byAgent(saved.agentId)?.launch).toEqual({ state: 'starting' })
  expect(releaseHold).not.toHaveBeenCalled()
  expect(deps.announceSession).not.toHaveBeenCalled()
})

it('retains allocation uncertainty when transcript verification fails inside the dispatch boundary', async () => {
  let changed = false
  vi.mocked(controlTranscriptEvidence).mockImplementation((_engine, _id, path) => ({ path,
    verify: () => { if (changed) throw new IdentityReadUnavailable('source changed') },
  }))
  create.mockImplementationOnce(async request => {
    await request.onDispatch?.()
    changed = true
    expect(request.current()).toBe(false)
    return { state: 'failed', dispatch: 'possibly_executed', reason: 'lost response' }
  })
  expect(await start()).toMatchObject({ ok: false, error: 'RESUME_UNCONFIRMED' })
  expect(deps.stoppedAgents.resumeReservedAt(saved.agentId)).not.toBeNull()
  expect(releaseHold).not.toHaveBeenCalled()
})

it.each(['gone', 'unknown', 'dead', 'exited'] as const)('keeps a resumed shell unconfirmed when final publication sees it %s', async state => {
  await rewrite({ engine: 'terminal', sessionId: '', transcriptPath: '' })
  paneState.mockResolvedValue(state === 'gone' || state === 'unknown' ? state : { dead: state === 'dead', engineExit: state === 'exited' ? 1 : null })
  expect(await start()).toMatchObject({ ok: false, error: 'RESUME_UNCONFIRMED' })
  expect(releaseHold).not.toHaveBeenCalled()
  expect(deps.stoppedAgents.resumeReservedAt(saved.agentId)).not.toBeNull()
  expect(registry.byAgent(saved.agentId)?.launch?.state).not.toBe('ready')
})

it.each(['prior exit', 'failed readiness'] as const)('rechecks that the %s process remains gone before retirement', async phase => {
  await live(phase === 'prior exit' ? { resumeOnly: undefined, processIdentity: identity, launch: { state: 'ready' } } : {})
  if (phase === 'failed readiness') {
    vi.mocked(resolvePaneEngineProcess).mockResolvedValue(null)
    paneState.mockResolvedValue({ dead: false, engineExit: 1 })
  }
  const retain = vi.mocked(deps.retainExitedSession).getMockImplementation()!
  vi.mocked(deps.retainExitedSession).mockImplementationOnce(async (row, alive, authority) => {
    expect(authority?.current?.()).toBe(true)
    vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'alive' })
    return retain(row, alive, authority)
  })
  await expect(start()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(registry.byAgent(saved.agentId)).toBeDefined()
  expect(create).not.toHaveBeenCalled()
  expect(releaseHold).not.toHaveBeenCalled()
})

it('refuses a new resume when prior engine-exit publication returns no receipt', async () => {
  await live({ resumeOnly: undefined, processIdentity: identity, launch: { state: 'ready' } })
  vi.mocked(deps.retainExitedSession).mockResolvedValueOnce({ state: 'not-published' })
  await expect(start()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(create).not.toHaveBeenCalled()
  expect(registry.byAgent(saved.agentId)).toBeDefined()
})

it.each(['process', 'route', 'home', 'backend'] as const)('discards a prior-exit inventory result after its selected %s is replaced', async change => {
  await live({ resumeOnly: undefined, processIdentity: identity, launch: { state: 'ready' } })
  let selectedBackend = tmuxTerminal
  deps.backendFor = () => selectedBackend
  let replacement!: RegisteredSession
  inventory.mockResolvedValueOnce(listed()).mockImplementationOnce(async () => {
    const current = registry.byAgent(saved.agentId)!
    expect(current.sessionId).toBe(saved.sessionId)
    if (change === 'process') expect(registry.updateProcessIdentity(saved.agentId, { ...identity, startMarker: 'replacement' })).toBe(true)
    if (change === 'route') expect(registry.updateRuntimes(saved.agentId, [{ backend: 'tmux', paneId: '%101' }])).toBe(true)
    if (change === 'home') expect(registry.setCodexHome(saved.agentId, join(dir, 'replacement-home'))).toBe(true)
    if (change === 'backend') selectedBackend = { ...tmuxTerminal }
    await registry.flush()
    replacement = structuredClone(registry.byAgent(saved.agentId)!)
    expect(registry.bySession(saved.sessionId)?.agentId).toBe(saved.agentId)
    expect(JSON.parse(readFileSync(join(env.ADAPTER_DATA_DIR, 'registry.json'), 'utf8')).find((entry: RegisteredSession) => entry.agentId === saved.agentId))
      .toMatchObject({ sessionId: replacement.sessionId, processIdentity: replacement.processIdentity, runtimes: replacement.runtimes })
    return listed()
  })
  const result = await start()
  expect(deps.retainExitedSession).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
  expect(result).toMatchObject({ ok: false, error: 'AGENT_BUSY' })
  expect(registry.byAgent(saved.agentId)).toMatchObject(replacement)
  expect((await deps.stoppedAgents.get(saved.agentId))?.processIdentity).toEqual(identity)
})

it('does not retire a new native binding that commits while prior-exit inventory waits', async () => {
  await live({ resumeOnly: undefined, processIdentity: identity, launch: { state: 'ready' } })
  const sessionId = '33333333-3333-4333-8333-333333333333', home = join(dir, 'codex')
  mkdirSync(join(home, 'sessions'), { recursive: true })
  const transcript = join(home, 'sessions', `rollout-${sessionId}.jsonl`)
  writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: dir, source: 'cli' } }) + '\n')
  let registered = false
  vi.mocked(checkPidRuntime).mockImplementation(async () => registered ? { state: 'alive' } : { state: 'gone', reason: 'original engine exited' })
  inventory.mockResolvedValueOnce(listed()).mockImplementationOnce(async () => {
    const publication = await registry.register({ engine: 'codex', sessionId, transcriptPath: transcript, codexHome: home,
      cwd: dir, runtimes: [{ backend: 'tmux', paneId: pane }], processIdentity: identity })
    expect(publication?.entry.sessionId).toBe(sessionId)
    expect(registry.bySession(sessionId)?.agentId).toBe(saved.agentId)
    registered = true
    return listed()
  })
  expect(await start()).toMatchObject({ ok: false, error: 'AGENT_BUSY' })
  expect(registered).toBe(true)
  expect(deps.retainExitedSession).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
  expect(registry.byAgent(saved.agentId)?.sessionId).toBe(sessionId)
  expect((await deps.stoppedAgents.get(saved.agentId))?.sessionId).toBe(saved.sessionId)
})

it('does not dispatch after the prior engine-exit rename has unconfirmed durability', async () => {
  await live({ resumeOnly: undefined, processIdentity: identity, launch: { state: 'ready' } })
  publication.agent = saved.agentId; publication.retire = true; publication.failSync = 2
  await expect(start()).rejects.toBeInstanceOf(AtomicWriteUnconfirmed)
  expect(publication.published).toBe(true)
  expect(create).not.toHaveBeenCalled()
  expect(releaseHold).not.toHaveBeenCalled()
  expect((await deps.stoppedAgents.get(saved.agentId))?.sessionId).toBe(saved.sessionId)
})

it.each(['another owner', 'source changed'] as const)('refuses a launch whose source authority changes during overrides: %s', async change => {
  let unavailable = false
  vi.mocked(controlTranscriptEvidence).mockImplementation((_engine, _id, path) => ({ path,
    verify: () => { if (unavailable) throw new IdentityReadUnavailable('source changed') },
  }))
  vi.mocked(deps.relaunchOverrides).mockImplementationOnce(async (_row, _launch, current) => {
    expect(current?.()).toBe(true)
    if (change === 'another owner') {
      const peer = (await registry.resumePendingAgent({ ...saved, agentId: 'peer' }, [{ backend: 'tmux', paneId: '%101' }]))!
      expect(registry.bySession(saved.sessionId)?.agentId).toBe(peer.agentId)
    } else unavailable = true
    expect(current?.()).toBe(false)
    expect(current?.()).toBe(false)
    return { ok: true, overrides: { env: {}, extraArgs: [], clearEnv: [] } }
  })
  expect(await start()).toMatchObject({ ok: false, error: 'IDENTITY_UNAVAILABLE' })
  expect(create).not.toHaveBeenCalled()
  expect(deps.stoppedAgents.resumeReservedAt(saved.agentId)).toBeNull()
})

it('retains the reservation if terminal dispatch starts but loses its reply', async () => {
  create.mockImplementationOnce(async request => { await request.onDispatch(); throw Error('Terminal transport disconnected') })
  await expect(start()).rejects.toThrow('Terminal transport disconnected')
  expect(deps.stoppedAgents.resumeReservedAt(saved.agentId)).not.toBeNull()
  expect(registry.byAgent(saved.agentId)).toBeUndefined()
  expect(deps.announceSession).not.toHaveBeenCalled()
})

beforeEach(async () => {
  vi.clearAllMocks()
  for (const row of registry.list()) (await removeRegistryAgent(registry, row.agentId))
  dir = mkdtempSync(join(tmpdir(), 'resume-service-'))
  const original = (await registry.openPendingAgent({ engine: 'codex', runtimes: [{ backend: 'tmux', paneId: '%8' }], cwd: dir }))!
  saved = { ...original, sessionId: 'original-session', transcriptPath: join(dir, 'history.jsonl'), processIdentity: identity, launch: { state: 'ready' } }
  ;(await removeRegistryAgent(registry, original.agentId))
  const store = new StoppedAgentStore()
  await store.save(saved)
  create.mockReset().mockImplementation(async request => { await request.onDispatch?.(); if (typeof request.command === 'function') request.command(); return { state: 'succeeded', runtime: { backend: 'tmux', paneId: pane } } })
  kill.mockReset().mockResolvedValue({ state: 'succeeded' })
  vi.mocked(controlTranscriptEvidence).mockImplementation((_engine, _id, path) => ({ path, verify: vi.fn() }))
  vi.mocked(materializeResumeTranscript).mockReset().mockImplementation(async (_engine, _id, path) => path)
  vi.mocked(enginePathOverride).mockReturnValue(undefined)
  vi.mocked(refusePermissionFlagIfUnsupported).mockReset().mockResolvedValue(null)
  vi.mocked(installedDsh).mockReturnValue(undefined)
  inventory.mockReset().mockResolvedValue(listed(pane))
  ptyCreate.mockReset().mockImplementation(async request => { await request.onDispatch?.(); if (typeof request.command === 'function') request.command(); return { state: 'succeeded', runtime: pty } })
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
    retainExitedSession: vi.fn(async (row, alive, authority) => { await store.save(row); return registry.confirmEngineExit(row.agentId, alive ? 'successor' : 'remove', authority) }),
    announceSession: vi.fn(), relaunchOverrides: vi.fn(async () => ({ ok: true as const, overrides: { env: {}, extraArgs: [], clearEnv: [] } })),
    prepareSessionResume: vi.fn(), stopBackgroundJob: vi.fn(async () => {}), refreshGridWebSearch: vi.fn(), clearDeleted: vi.fn(), attach: vi.fn(),
    attachSession: vi.fn(async () => true),
  }
})
afterEach(async () => { publication.wait = undefined; publication.release?.(); publication.release = undefined; publication.agent = ''; publication.temporary = ''; publication.published = false; publication.failSync = 0; publication.cleanupWait = undefined; publication.retire = false; publication.pending = false; publication.directoryWait = undefined; vi.useRealTimers(); for (const row of registry.list()) (await removeRegistryAgent(registry, row.agentId)); await registry.flush(); await deps.stoppedAgents.close(); rmSync(join(env.ADAPTER_DATA_DIR, 'stopped-agents'), { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }) })

it.each(['stop', 'binding'] as const)('keeps the terminal hold when %s revokes Resume during backend release', async change => {
  const entered = deferred<void>(), waiting = deferred<void>()
  let released = false
  releaseHold.mockImplementationOnce(async (_runtime, current?: () => boolean) => {
    expect(current?.()).toBe(true)
    entered.resolve(); await waiting.promise
    if (current?.() !== false) released = true
  })
  const result = start()
  await entered.promise
  vi.mocked(deps.announceSession).mockClear()
  if (change === 'stop') deps.restartJobs.cancel(saved.agentId)
  else registry.byAgent(saved.agentId)!.sessionId = 'replacement-conversation'
  waiting.resolve()
  expect(await result).toMatchObject({ ok: false, error: 'AGENT_CHANGED' })
  expect(released).toBe(false)
  expect(deps.announceSession).not.toHaveBeenCalled()
  expect(deps.stoppedAgents.resumeReservedAt(saved.agentId)).not.toBeNull()
})

describe('resuming a stopped harness with new launch words', () => {
  const WORDS = ['--chrome']
  const resumeWith = (launchArgs?: string[], mode?: string) => createResumeAgentService(deps)(saved.agentId, mode, launchArgs)

  it('builds the launch with them, applies them to the argv, and the resumed row keeps them', async () => {
    await rewrite({ launchArgs: ['--old'] })
    vi.mocked(deps.relaunchOverrides).mockImplementation(async (_row, source) => ({ ok: true, overrides: { env: {}, extraArgs: [], clearEnv: [], ownerArgs: source.launchArgs } }))
    expect(await resumeWith(WORDS)).toMatchObject({ ok: true, session: { launchArgs: WORDS } })
    expect(deps.relaunchOverrides).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ agentId: saved.agentId, launchArgs: WORDS }), expect.any(Function))
    expect(buildEngineLaunchArgv).toHaveBeenCalledWith('codex', expect.objectContaining({ ownerArgs: WORDS }))
    expect(registry.byAgent(saved.agentId)?.launchArgs).toEqual(WORDS)
    await registry.load()
    expect(registry.byAgent(saved.agentId)?.launchArgs).toEqual(WORDS)
  })

  it('clears them with an empty list', async () => {
    await rewrite({ launchArgs: ['--old'] })
    expect(await resumeWith([])).toMatchObject({ ok: true })
    expect(deps.relaunchOverrides).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ launchArgs: [] }), expect.any(Function))
    expect(registry.byAgent(saved.agentId)?.launchArgs).toBeUndefined()
  })

  it('without them, relaunches from the saved row and leaves its words as they were', async () => {
    await rewrite({ launchArgs: ['--old'] })
    expect(await resumeWith()).toMatchObject({ ok: true })
    expect(deps.relaunchOverrides).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ launchArgs: ['--old'] }), expect.any(Function))
    expect(registry.byAgent(saved.agentId)?.launchArgs).toEqual(['--old'])
  })

  // The new row exists as soon as the pane does, but the words are only the record's once the engine is confirmed.
  it('saves nothing when the engine does not come back, and the retained row keeps the words that last worked', async () => {
    await rewrite({ launchArgs: ['--old'] })
    ;(await live())
    vi.mocked(resolvePaneEngineProcess).mockResolvedValue(null)
    paneState.mockResolvedValueOnce({ dead: false, engineExit: 1 } as any).mockResolvedValueOnce('gone')
    expect(await resumeWith(WORDS)).toMatchObject({ ok: false, error: 'RESUME_FAILED' })
    expect((await deps.stoppedAgents.get(saved.agentId))?.launchArgs).toEqual(['--old'])
  })

  it('saves nothing when the launch is refused before a pane exists', async () => {
    await rewrite({ launchArgs: ['--old'] })
    vi.mocked(deps.relaunchOverrides).mockResolvedValue({ ok: false, error: 'GRID_UNAVAILABLE', detail: 'x' })
    expect(await resumeWith(WORDS)).toMatchObject({ ok: false, error: 'GRID_UNAVAILABLE' })
    expect(create).not.toHaveBeenCalled()
    expect((await deps.stoppedAgents.get(saved.agentId))?.launchArgs).toEqual(['--old'])
    expect(registry.byAgent(saved.agentId)).toBeUndefined()
  })

  it('keeps the terminal engine\'s resume, which has no launch to confirm, saving them as well', async () => {
    await rewrite({ engine: 'terminal' })
    expect(await resumeWith(WORDS)).toMatchObject({ ok: true })
    expect(registry.byAgent(saved.agentId)?.launchArgs).toEqual(WORDS)
  })

  it('asked with other words, an overlapping resume is refused rather than answered by the first launch', async () => {
    const stop = deferred<void>(); (deps.stopJobs as Map<string, Promise<void>>).set(saved.agentId, stop.promise)
    const resume = createResumeAgentService(deps)
    const first = resume(saved.agentId, undefined, WORDS)
    expect(await resume(saved.agentId, undefined, ['--other'])).toMatchObject({ ok: false, error: 'AGENT_BUSY' })
    stop.resolve()
    expect(await first).toMatchObject({ ok: true })
    expect(registry.byAgent(saved.agentId)?.launchArgs).toEqual(WORDS)
  })

  it('does not claim to have applied them to a harness that was already running', async () => {
    ;(await live({ processIdentity: identity, lastHookAt: Date.now(), launch: { state: 'ready' } }))
    vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'alive' })
    expect(await resumeWith(WORDS)).toMatchObject({ ok: true })
    expect(create).not.toHaveBeenCalled()
    expect(registry.byAgent(saved.agentId)?.launchArgs).toBeUndefined()
  })
})

describe('the grid a resumed harness is on', () => {
  // The saved API's endpoint as saved now: the record a relaunch refreshes (apiModels.ts `refreshApiLaunch`).
  const override = { networkId: 'api', networkName: 'Saved', baseUrl: 'https://saved.example/now/v1', apiKey: 'k', model: 'm' }
  const savedOnGrid = async () => (await rewrite({ grid: { baseUrl: 'https://saved.example/then/v1', model: 'm' },
    gridLaunch: { ...override, baseUrl: 'https://saved.example/then/v1' } }))

  it('announces the refreshed web-search status in the first detached resume frame', async () => {
    await savedOnGrid()
    await rewrite({ gridWebSearch: 'unsupported' })
    vi.mocked(deps.relaunchOverrides).mockResolvedValueOnce({ ok: true, overrides: { env: {}, extraArgs: [], clearEnv: [],
      gridLaunchRecord: { override, webSearch: 'on' } } })
    vi.mocked(deps.refreshGridWebSearch).mockImplementation(async (id, options) => { await registry.setGridLaunch(id, options.gridLaunchRecord ?? null) })
    expect(await start()).toMatchObject({ ok: true })
    const first = vi.mocked(deps.announceSession).mock.calls[0]![0]
    expect(first.gridWebSearch).toBe('on')
    expect(first.gridLaunch).toMatchObject({ networkId: override.networkId, baseUrl: override.baseUrl, credential: { version: 1 } })
    expect(Object.hasOwn(first.gridLaunch!, 'apiKey')).toBe(false)
    const { agentFrame } = await import('./agentFrame.js')
    expect((await agentFrame(first, { selectedModel: null, terminalAvailable: true })).grid?.webSearch).toBe('on')
  })

  it('does not announce or attach a different owner after refreshing resume metadata', async () => {
    vi.mocked(deps.refreshGridWebSearch).mockImplementationOnce(async id => { registry.byAgent(id)!.sessionId = 'replacement-conversation' })
    expect(await start()).toEqual(resumeChanged)
    expect(deps.announceSession).not.toHaveBeenCalled()
    expect(deps.attach).not.toHaveBeenCalled()
    expect(waitForResumedAgent).not.toHaveBeenCalled()
    expect(registry.byAgent(saved.agentId)?.sessionId).toBe('replacement-conversation')
  })

  it('does not refresh metadata after its detached admission owner was replaced', async () => {
    const resumePendingAgent = registry.resumePendingAgent.bind(registry)
    const admission = vi.spyOn(registry, 'resumePendingAgent').mockImplementationOnce(async (...args) => {
      const pending = await resumePendingAgent(...args)
      registry.byAgent(saved.agentId)!.sessionId = 'replacement-conversation'
      return pending
    })
    try {
      expect(await start()).toEqual(resumeChanged)
      expect(deps.refreshGridWebSearch).not.toHaveBeenCalled()
      expect(deps.announceSession).not.toHaveBeenCalled()
      expect(deps.attach).not.toHaveBeenCalled()
      expect(waitForResumedAgent).not.toHaveBeenCalled()
    } finally { admission.mockRestore() }
  })

  it.each(['cancelled', 'missing'] as const)('does not publish a %s resume after refreshing metadata', async change => {
    let missing = false
    const byAgent = registry.byAgent.bind(registry)
    const lookup = vi.spyOn(registry, 'byAgent').mockImplementation(id => missing && id === saved.agentId ? undefined : byAgent(id))
    vi.mocked(deps.refreshGridWebSearch).mockImplementationOnce(async () => {
      if (change === 'cancelled') deps.restartJobs.cancel(saved.agentId)
      else missing = true
    })
    try {
      expect(await start()).toMatchObject({ ok: false, error: 'AGENT_CHANGED' })
      expect(deps.announceSession).not.toHaveBeenCalled()
      expect(deps.attach).not.toHaveBeenCalled()
      expect(waitForResumedAgent).not.toHaveBeenCalled()
    } finally { lookup.mockRestore() }
  })

  it('is its launch record\'s, as this launch refreshed it, written with its process', async () => {
    await savedOnGrid()
    vi.mocked(deps.relaunchOverrides).mockResolvedValueOnce({ ok: true, overrides: { env: {}, extraArgs: [], clearEnv: [],
      gridLaunchRecord: { override, webSearch: 'on' } } })
    expect(await start()).toMatchObject({ ok: true })
    expect(registry.byAgent(saved.agentId)?.grid).toEqual({ baseUrl: 'https://saved.example/now/v1', model: 'm' })
  })

  it('is none for a launch with no record, whatever grid the saved row had', async () => {
    await savedOnGrid()
    expect(await start()).toMatchObject({ ok: true })
    expect(registry.byAgent(saved.agentId)?.grid).toBeNull()
  })

  it('is the launch record\'s on the row when an allocation the launch left unconfirmed is checked again', async () => {
    // The launch wrote its record on the row (`refreshGridWebSearch`), and its engine was not confirmed then.
    ;(await live({ grid: { baseUrl: 'https://saved.example/then/v1', model: 'm' } }))
    await registry.setGridLaunch(saved.agentId, { override, webSearch: 'unsupported' })
    expect(await start()).toMatchObject({ ok: true })
    expect(create).not.toHaveBeenCalled()
    expect(registry.byAgent(saved.agentId)?.grid).toEqual({ baseUrl: 'https://saved.example/now/v1', model: 'm' })
  })
})

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
      ;(await registry.resumePendingAgent({ ...saved, agentId: 'other' }, [{ backend: 'tmux', paneId: '%101' }]))
      expect(current()).toBe(false)
      throw new IdentityReadUnavailable('another harness owns the conversation')
    })
    expect(await start()).toMatchObject({ error: 'IDENTITY_UNAVAILABLE' })
    expect(create).not.toHaveBeenCalled()
    expect(deps.stoppedAgents.resumeReservedAt(saved.agentId)).toBeNull()
  })

  it('composes stopped resume with real launch preparation before any live row exists', async () => {
    const apiNotes = vi.fn(async () => {})
    const helpers = createLaunchHelpers({
      authority: createLaunchAuthority({ byAgent: id => registry.byAgent(id), revision: id => deps.restartJobs.revision(id), cancelled: id => deps.stopJobs.has(id) }),
      prepareInstructions: apiNotes, setGridLaunch: vi.fn(), prepareResume: async () => ({ repairedItems: 0 }),
      launchOverridesDeps: { machine: () => ({ hermesSystemManaged: false }), gridLaunch: vi.fn(),
        capabilities: async () => ({ sessionEnv: true }), writeGridConfigDir: vi.fn(), installCodexHooks: vi.fn(async () => true), readCodexConfig: () => null },
    })
    deps.relaunchOverrides = helpers.relaunchOverrides
    expect(registry.byAgent(saved.agentId)).toBeUndefined()
    expect(await start()).toMatchObject({ ok: true, resumed: true, session: { agentId: saved.agentId, sessionId: saved.sessionId } })
    expect(apiNotes).toHaveBeenCalledWith(dir, 'codex')
    expect(create).toHaveBeenCalledOnce()
  })

  it.each(['auto', 'ask'])('resumes the same conversation with an explicit %s permission choice', async permissionMode => {
    await rewrite({ engine: 'opencode', permissionMode: permissionMode === 'auto' ? 'ask' : 'auto' })
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
    await registry.load()
    expect(registry.byAgent(saved.agentId)?.permissionMode).toBe(permissionMode)
  })

  it('keeps the exact Windows held argv and omits an engine handoff on Resume', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    const held = windowsHeldPaneArgv('fixture waiting', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    try {
      // Keep the real fixture registry on this OS; only the pure launch/metadata turn uses Windows rules.
      vi.mocked(buildEngineCommandArgv).mockImplementationOnce(() => {
        Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
        return ['fixture-engine']
      })
      vi.mocked(buildEngineLaunchArgv).mockReturnValueOnce(held)
      create.mockImplementationOnce(async request => {
        Object.defineProperty(process, 'platform', platform)
        await request.onDispatch?.()
        return { state: 'succeeded', runtime: { backend: 'tmux', paneId: pane } }
      })
      expect(await start()).toMatchObject({ ok: true })
      expect(create.mock.calls[0][0].command).toBe(held)
      expect(create.mock.calls[0][0]).not.toHaveProperty('afterExit')
      expect(buildEngineLaunchArgv).toHaveBeenCalledOnce()
    } finally { Object.defineProperty(process, 'platform', platform) }
  })

  it.each(['dispatch', 'refusal'] as const)('publishes no Resume script before backend %s', async outcome => {
    create.mockImplementationOnce(async request => {
      expect(buildEngineLaunchArgv).not.toHaveBeenCalled()
      expect(typeof request.command).toBe('function')
      if (outcome === 'refusal') return { state: 'failed', dispatch: 'not_started', reason: 'fixture refusal' }
      await request.onDispatch?.()
      request.command()
      return { state: 'succeeded', dispatch: 'executed', runtime: { backend: 'tmux', paneId: pane } }
    })
    expect(await start()).toMatchObject({ ok: outcome === 'dispatch' })
    expect(buildEngineLaunchArgv).toHaveBeenCalledTimes(outcome === 'dispatch' ? 1 : 0)
  })

  it('carries the captured native launch and token through permission, argv and registration', async () => {
    const prepareSettings = vi.fn(async () => ({ values: { instructions: 'owner optional', settings: null }, current: () => true }))
    const native: NativeLaunch = { token: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', opencodeMajor: null,
      environment: {}, proofs: [], current: vi.fn(() => true),
      prepareHooks: vi.fn(async () => true), permission: vi.fn(async () => 'supported' as const), prepareSettings }
    vi.mocked(deps.relaunchOverrides).mockResolvedValue({ ok: true,
      overrides: { env: {}, extraArgs: [], clearEnv: [], native } })
    const starting = vi.fn()
    vi.mocked(deps.announceSession).mockImplementation(row => {
      if (row.launch?.state === 'starting') starting(row.launch.nativeToken)
    })
    create.mockImplementationOnce(async request => {
      expect(request.current()).toBe(true)
      expect(prepareSettings).toHaveBeenCalledOnce()
      await request.onDispatch?.()
      if (typeof request.command === 'function') request.command()
      return { state: 'succeeded', runtime: { backend: 'tmux', paneId: pane } }
    })
    expect(await start()).toMatchObject({ ok: true, resumed: true })
    expect(dropPermissionFlagIfUnsupported).toHaveBeenCalledWith('codex', expect.any(Object), native)
    expect(buildEngineLaunchArgv).toHaveBeenCalledWith('codex', expect.objectContaining({ native }))
    expect(prepareSettings).toHaveBeenCalledOnce()
    expect(vi.mocked(buildEngineLaunchArgv).mock.lastCall![1]?.extraArgs).toContain('developer_instructions="owner optional"')
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
    expect((await deps.stoppedAgents.get(saved.agentId))).toMatchObject({ sessionId: saved.sessionId, transcriptPath: saved.transcriptPath })
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
    expect((await deps.stoppedAgents.get(saved.agentId))?.sessionId).toBe(saved.sessionId)
  })

  it('notes where the relaunched engine\'s writing begins, after the history is prepared and before the launch', async () => {
    writeFileSync(saved.transcriptPath!, '{"type":"session_meta"}\n')
    const note = vi.fn((_sessionId: string, _offset: number, _engineStarted?: boolean) => {
      // The pane is not allocated yet: the engine has written nothing of its own.
      expect(create).not.toHaveBeenCalled()
    })
    vi.mocked(deps.prepareSessionResume).mockImplementation(async () => { writeFileSync(saved.transcriptPath!, '{"type":"session_meta"}\n{"prepared":true}\n'); return true })
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
    await rewrite({ engine: 'opencode', permissionMode: 'ask' })
    expect(await createResumeAgentService(deps)(saved.agentId, 'full')).toMatchObject({ error: 'INVALID_PERMISSION_MODE' })
    vi.mocked(refusePermissionFlagIfUnsupported).mockResolvedValue({ error: 'CODEX_CLI_TOO_OLD', detail: 'Update OpenCode.' })
    expect(await createResumeAgentService(deps)(saved.agentId, 'auto')).toMatchObject({ error: 'CODEX_CLI_TOO_OLD' })
    expect(create).not.toHaveBeenCalled()
    expect((await deps.stoppedAgents.get(saved.agentId))?.permissionMode).toBe('ask')
  })

  it('does not claim a permission change when Open attaches to a running process', async () => {
    await rewrite({ engine: 'opencode', permissionMode: 'ask' })
    ;(await live({ resumeOnly: undefined, permissionMode: 'ask' }))
    vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'alive' })
    expect(await createResumeAgentService(deps)(saved.agentId, 'auto')).toMatchObject({ error: 'PERMISSION_CHANGE_REQUIRES_STOP' })
    expect(create).not.toHaveBeenCalled()
    expect(registry.byAgent(saved.agentId)?.permissionMode).toBe('ask')
  })

  // Its browser and its login were kept while it was stopped: the resume is a look at it, which starts it again.
  it('looks at the resumed agent for the services that follow agents, its row as it was saved', async () => {
    await rewrite({ browser: true })
    expect(await createResumeAgentService(deps)(saved.agentId)).toMatchObject({ ok: true })
    expect(deps.attach).toHaveBeenCalledWith(expect.objectContaining({ agentId: saved.agentId, browser: true }))
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
    await rewrite({ engine, codexHome: '/profile', permissionMode: 'plan', bypassPermission: true, dsh: 'fixture' })
    vi.mocked(installedDsh).mockReturnValue({} as any)
    vi.mocked(enginePathOverride).mockReturnValue('/fixture/bin')
    vi.mocked(deps.relaunchOverrides).mockResolvedValue({ ok: true, overrides: { env: { CODEX_HOME: '/profile', HARNESS_DSH: 'fixture' }, extraArgs: ['--fixture'], clearEnv: ['OLD'] } })
    const result = await start()
    expect(result).toMatchObject({ ok: true, resumed: true, session: { agentId: saved.agentId, sessionId: saved.sessionId, tmuxPane: pane, launch: { state: 'ready' } } })
    expect(buildEngineLaunchArgv).toHaveBeenCalledWith(engine, expect.objectContaining({ resumeSessionId: saved.sessionId, cwd: dir, permissionMode: 'plan', bypassPermission: true, extraArgs: ['--fixture'], clearEnv: ['OLD'], harnessNode: true }))
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][0].env).toEqual({ CODEX_HOME: '/profile', HARNESS_DSH: 'fixture' })
    expect(deps.attach).toHaveBeenCalledTimes(1)
    expect((await deps.stoppedAgents.get(saved.agentId))?.sessionId).toBe(saved.sessionId)
    expect(deps.stoppedAgents.beginResume(saved.agentId)).not.toBeNull()
    const disk = JSON.parse(readFileSync(join(env.ADAPTER_DATA_DIR, 'registry.json'), 'utf8'))
    expect(JSON.stringify(disk)).toContain(saved.sessionId)
    expect(JSON.stringify(disk)).toContain('resumeOnly')
  })
  it('resumes a database-backed engine on its id alone, with no transcript to demand', async () => {
    // opencode/kilo/hermes/devin keep the conversation in SQLite; requiring a transcript file here
    // refused a resume that works, and refused it AFTER the harness had been paused.
    await rewrite({ engine: 'opencode', transcriptPath: '' })
    expect(await start()).toMatchObject({ ok: true, resumed: true, session: { launch: { state: 'ready' } } })
    expect(buildEngineLaunchArgv).toHaveBeenCalledWith('opencode', expect.objectContaining({ resumeSessionId: saved.sessionId }))
  })

  it('stops a live `claude --bg` job on the exact session before building the resume argv', async () => {
    await rewrite({ engine: 'claude' })
    expect(await start()).toMatchObject({ ok: true, resumed: true })
    expect(deps.stopBackgroundJob).toHaveBeenCalledWith('claude', expect.objectContaining({
      bin: engineBin('claude'), sessionId: saved.sessionId,
    }), expect.any(Function))
    const stopOrder = vi.mocked(deps.stopBackgroundJob!).mock.invocationCallOrder[0]
    const argvOrder = vi.mocked(buildEngineLaunchArgv).mock.invocationCallOrder[0]
    expect(stopOrder).toBeLessThan(argvOrder)
    // What the stop reports reaches the daemon's log under the agent's short id.
    const said = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      vi.mocked(deps.stopBackgroundJob!).mock.calls[0]![2]('stopped background job bg-1')
      expect(said).toHaveBeenCalledWith(`[resume] ${saved.agentId.slice(0, 8)} stopped background job bg-1`)
    } finally { said.mockRestore() }
  })

  it('builds nothing when the resume is cancelled while the background job stops', async () => {
    await rewrite({ engine: 'claude' })
    vi.mocked(deps.stopBackgroundJob!).mockImplementationOnce(async () => { deps.restartJobs.cancel(saved.agentId) })
    expect(await start()).toMatchObject({ ok: false, error: 'AGENT_CHANGED' })
    expect(buildEngineLaunchArgv).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('never checks for a background job on a fresh or fork launch (no resumeSessionId)', async () => {
    await rewrite({ engine: 'claude', sessionId: '' })
    await start()
    expect(deps.stopBackgroundJob).not.toHaveBeenCalled()
  })

  it('does not check for a background job on a non-Claude engine', async () => {
    expect(saved.engine).toBe('codex')
    await start()
    expect(deps.stopBackgroundJob).not.toHaveBeenCalled()
  })

  it('skips the background-job check for a DSH agent: its pane may run on a different host', async () => {
    await rewrite({ engine: 'claude', dsh: { id: 'fixture-dsh', url: 'https://example.test' } as any })
    vi.mocked(installedDsh).mockReturnValue(true as any)
    await start()
    expect(deps.stopBackgroundJob).not.toHaveBeenCalled()
  })

  it('still checks for a background job on a captured-native launch, with that launch\'s own environment', async () => {
    // `native` is the captured launch for every ordinary LOCAL Claude run (launchOverrides.ts), not a
    // signal the pane is elsewhere — it must not turn this off. `launchEnv` here stands in for what
    // launchOverrides.ts really produces: `native.environment` (its CLAUDE_CONFIG_DIR) merged in already.
    await rewrite({ engine: 'claude' })
    const native: NativeLaunch = { token: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', opencodeMajor: null,
      environment: { CLAUDE_CONFIG_DIR: '/native/claude-home' }, proofs: [], current: vi.fn(() => true),
      prepareHooks: vi.fn(async () => true), permission: vi.fn(async () => 'supported' as const) }
    vi.mocked(deps.relaunchOverrides).mockResolvedValue({ ok: true,
      overrides: { env: { CLAUDE_CONFIG_DIR: '/native/claude-home' }, extraArgs: [], clearEnv: [], native } })
    await start()
    expect(deps.stopBackgroundJob).toHaveBeenCalledWith('claude', expect.objectContaining({
      sessionId: saved.sessionId, env: expect.objectContaining({ CLAUDE_CONFIG_DIR: '/native/claude-home' }),
    }), expect.any(Function))
  })

  it('marks an engine with no startup hook ready off its own process', async () => {
    // muse never hooks, so nothing else would ever leave this row `starting` — it would read as
    // "Starting" for ever and keep discovery out of the pane.
    await rewrite({ engine: 'muse' })
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
    await registry.load()
    expect(registry.byAgent(saved.agentId)?.processIdentity).toEqual(identity)
  })

  it('attaches a resume its own process confirmed when no hook registered it, and says so if that fails', async () => {
    // Round 23: the SessionStart was refused, and discovery, finding the row ready already, did not
    // attach it either, so the resumed agent never showed a turn.
    vi.mocked(resolvePaneEngineProcess).mockResolvedValue(identity)
    expect(await start()).toMatchObject({ ok: true, session: { launch: { state: 'ready' } } })
    expect(deps.attachSession).toHaveBeenCalledTimes(1)
    expect(deps.attachSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: saved.agentId, sessionId: saved.sessionId, processIdentity: identity }))

    for (const row of registry.list()) (await removeRegistryAgent(registry, row.agentId))
    deps.stoppedAgents.finishResume(saved.agentId)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(deps.attachSession).mockRejectedValueOnce(new Error('transcript unreadable'))
    expect(await start()).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(`[resume] ${saved.agentId.slice(0, 8)} attach failed:`, 'transcript unreadable'))
    vi.mocked(deps.attachSession).mockRejectedValueOnce('gone')
    for (const row of registry.list()) (await removeRegistryAgent(registry, row.agentId))
    deps.stoppedAgents.finishResume(saved.agentId)
    expect(await start()).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(`[resume] ${saved.agentId.slice(0, 8)} attach failed:`, 'gone'))
    error.mockRestore()
  })

  it('attaches nothing for a resume that started a new conversation: the engine has yet to name it', async () => {
    // A stopped harness that never had a conversation resumes into a new one.
    await rewrite({ sessionId: '', transcriptPath: '' })
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
    await rewrite({ engine: 'terminal', sessionId: '', transcriptPath: '' })
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
    ['missing provider', async () => (await rewrite({ grid: { baseUrl: 'https://fixture.invalid', model: null }, gridLaunch: null })), 'GRID_CREDENTIAL_REQUIRED'],
    ['missing DSH', async () => { await rewrite({ dsh: 'missing' }); vi.mocked(deps.relaunchOverrides).mockResolvedValue({ ok: false, error: 'DSH_NOT_INSTALLED', detail: 'missing' }) }, 'INVALID_DSH'],
    ['missing cwd', async () => (await rewrite({ cwd: null })), 'CWD_NOT_FOUND'],
    ['removed cwd', async () => (await rewrite({ cwd: join(dir, 'gone') })), 'CWD_NOT_FOUND'],
    ['file cwd', async () => { const file = join(dir, 'file'); writeFileSync(file, 'file'); await rewrite({ cwd: file }) }, 'CWD_NOT_FOUND'],
    ['missing transcript', async () => (await rewrite({ transcriptPath: '' })), 'RESUME_UNAVAILABLE'],
    ['invalid transcript', () => vi.mocked(controlTranscriptEvidence).mockImplementation(() => { throw new IdentityReadUnavailable('fixture source unavailable') }), 'IDENTITY_UNAVAILABLE'],
    ['old process alive', () => vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'alive' }), 'AGENT_BUSY'],
    ['old process unknown', () => vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'unknown', reason: 'fixture' }), 'AGENT_BUSY'],
  ] as const)('refuses %s without allocating or losing history', async (_label, setup, error) => {
    await setup(); expect(await start()).toMatchObject({ ok: false, error }); expect(create).not.toHaveBeenCalled()
    expect((await deps.stoppedAgents.get(saved.agentId))?.agentId).toBe(saved.agentId)
  })
  it('answers a launch Windows refuses by its reason, opening nothing and keeping the stopped harness', async () => {
    vi.mocked(buildEngineCommandArgv).mockImplementationOnce(() => { throw new WindowsBatchLaunchRefused('codex', 'C:\\tools\\codex.cmd') })
    expect(await start()).toEqual({ ok: false, error: 'ENGINE_LAUNCH_REFUSED', detail: expect.stringContaining('codex.cmd is a batch file') })
    expect(create).not.toHaveBeenCalled()
    expect((await deps.stoppedAgents.get(saved.agentId))?.agentId).toBe(saved.agentId)
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
    expect((await deps.stoppedAgents.get(saved.agentId))?.agentId).toBe(saved.agentId)
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
    const held = join(env.ADAPTER_DATA_DIR, 'stopped-agents', `${saved.agentId}.resume`)
    const stale = Date.now() - RESUME_READINESS_BUDGET_MS - 60_000
    utimesSync(held, new Date(stale), new Date(stale))
    expect(await start()).toMatchObject({ ok: true })
    expect(create).toHaveBeenCalled()
  })

  it.each(['provider', 'prepare', 'cancel', 'conversation'] as const)('releases the reservation before allocation after %s failure', async reason => {
    if (reason === 'provider') vi.mocked(deps.relaunchOverrides).mockResolvedValue({ ok: false, error: 'PROVIDER_FAILED', detail: 'fixture' })
    if (reason === 'prepare') vi.mocked(deps.prepareSessionResume).mockImplementation(async () => { throw new Error('fixture') })
    if (reason === 'cancel') vi.mocked(deps.relaunchOverrides).mockImplementation(async () => { deps.restartJobs.cancel(saved.agentId); return { ok: true, overrides: { env: {}, extraArgs: [], clearEnv: [] } } })
    if (reason === 'conversation') vi.mocked(deps.prepareSessionResume).mockImplementation(async () => { (await registry.resumePendingAgent({ ...saved, agentId: 'other' }, [{ backend: 'tmux', paneId: '%101' }])); return false })
    expect(await start()).toMatchObject({ ok: false })
    expect(create).not.toHaveBeenCalled(); expect(deps.stoppedAgents.beginResume(saved.agentId)).not.toBeNull()
  })
  // The history is prepared a chunk at a time while the core goes on (engines/kit/resumeRepair.ts): it is replaced only
  // while this resume holds, and no other live harness has the conversation.
  it('prepares the history under the resume\'s own hold, which another live harness taking the conversation ends', async () => {
    const holds: boolean[] = []
    vi.mocked(deps.prepareSessionResume).mockImplementation(async (_session, current) => {
      holds.push(current())
      ;(await registry.resumePendingAgent({ ...saved, agentId: 'other' }, [{ backend: 'tmux', paneId: '%101' }]))
      holds.push(current())
      return false
    })
    expect(await start()).toMatchObject({ ok: false, error: 'AGENT_BUSY' })
    expect(holds).toEqual([true, false])
    expect(create).not.toHaveBeenCalled()
  })
  // Preparing can take many seconds now. A history it left in place must still be the file proven before it; only one
  // it replaced, checked byte for byte against that file, is proven anew (review of core-loop-1).
  it.each([false, true])('holds the history to the proof taken before its preparation unless it replaced it: replaced %s', async replaced => {
    const proofs: Array<ReturnType<typeof vi.fn>> = []
    vi.mocked(controlTranscriptEvidence).mockImplementation((_engine, _id, path) => {
      const verify = vi.fn()
      proofs.push(verify)
      return { path, verify }
    })
    vi.mocked(deps.prepareSessionResume).mockImplementation(async () => {
      proofs[0]!.mockImplementation(() => { throw new IdentityReadUnavailable('the saved conversation file was replaced during the operation') })
      return replaced
    })
    if (replaced) {
      expect(await start()).toMatchObject({ ok: true })
      expect(create).toHaveBeenCalled()
    } else {
      expect(await start()).toMatchObject({ ok: false, error: 'IDENTITY_UNAVAILABLE', detail: expect.stringContaining('replaced during the operation') })
      expect(create).not.toHaveBeenCalled()
    }
  })
  it('opens nothing for a resume cancelled while its history was prepared', async () => {
    vi.mocked(deps.prepareSessionResume).mockImplementation(async (_session, current) => {
      deps.restartJobs.cancel(saved.agentId)
      expect(current()).toBe(false)
      return false
    })
    expect(await start()).toMatchObject({ ok: false, error: resumeChanged.error })
    expect(create).not.toHaveBeenCalled()
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
    expect((await deps.stoppedAgents.get(saved.agentId))?.sessionId).toBe(saved.sessionId)
  })

  it.each(['permission', 'command preflight'] as const)('checks cancellation after %s preparation before allocating a pane', async phase => {
    if (phase === 'permission') vi.mocked(dropPermissionFlagIfUnsupported).mockImplementationOnce(async (_engine, choice) => {
      deps.restartJobs.cancel(saved.agentId)
      return { choice, droppedFlag: null }
    })
    else vi.mocked(buildEngineCommandArgv).mockImplementationOnce(() => { deps.restartJobs.cancel(saved.agentId); return ['fixture-engine'] })
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
    expect((await deps.stoppedAgents.get(saved.agentId))?.sessionId).toBe(saved.sessionId)
  })

  it('cancels a tmux allocation without registering or reusing its pane', async () => {
    create.mockImplementation(async () => { deps.restartJobs.cancel(saved.agentId); return { state: 'succeeded', runtime: { backend: 'tmux', paneId: pane } } })
    expect(await start()).toMatchObject({ error: 'AGENT_CHANGED' }); expect(kill).toHaveBeenCalledTimes(1)
    expect(registry.byAgent(saved.agentId)).toBeUndefined()
  })
  it.each(['confirmed', 'kill unavailable', 'retirement unavailable'] as const)('cancels after a durable registry claim, cleanup=%s', async outcome => {
    kill.mockResolvedValue(outcome === 'kill unavailable' ? { state: 'failed' } : { state: 'succeeded' })
    const claim = registry.resumePendingAgent.bind(registry)
    deps.registry = { ...deps.registry, byAgent: registry.byAgent.bind(registry), bySession: registry.bySession.bind(registry), setLaunch: registry.setLaunch.bind(registry), resumePendingAgent: async (...args) => {
      const pending = await claim(...args)
      expect(pending).not.toBeNull()
      expect(registry.bySession(saved.sessionId)?.agentId).toBe(saved.agentId)
      deps.restartJobs.cancel(saved.agentId)
      return pending
    } }
    if (outcome === 'retirement unavailable') vi.mocked(deps.retainExitedSession).mockResolvedValueOnce({ state: 'not-published' })
    expect(await start()).toMatchObject({ error: 'AGENT_CHANGED' }); expect(deps.announceSession).not.toHaveBeenCalled()
    expect(kill).toHaveBeenCalledTimes(1)
    expect(registry.byAgent(saved.agentId) === undefined).toBe(outcome === 'confirmed')
    expect(deps.stoppedAgents.resumeReservedAt(saved.agentId) === null).toBe(outcome === 'confirmed')
  })
  it('serializes two saved identities for the same conversation', async () => {
    const second = { ...saved, agentId: 'alias' }; await deps.stoppedAgents.save(second)
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
    if (engine === 'terminal') await rewrite({ engine, sessionId: '', transcriptPath: '' })
    ;(await live({ engine, resumeOnly: undefined, launch: { state: 'ready' } })); vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'alive' })
    expect(await start()).toMatchObject({ ok: true }); expect(create).not.toHaveBeenCalled()
    if (engine === 'claude') expect(checkSessionRuntime).toHaveBeenCalledWith(tmuxTerminal, expect.objectContaining({ agentId: saved.agentId }), { backend: 'tmux', paneId: pane })
  })
  it('checks a mixed row through its tmux pane, not the ptyhost pane its `tmuxPane` projects', async () => {
    const tmux = { backend: 'tmux' as const, paneId: '%9' }
    ;(await live({ resumeOnly: undefined, launch: { state: 'ready' }, runtimes: [{ backend: 'ptyhost', instance: 'p1', paneId: pane }, tmux] }))
    vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'alive' }); inventory.mockResolvedValue(listed('%9'))
    expect(await start()).toMatchObject({ ok: true }); expect(create).not.toHaveBeenCalled()
    expect(checkSessionRuntime).toHaveBeenCalledExactlyOnceWith(tmuxTerminal, expect.objectContaining({ agentId: saved.agentId }), tmux)
  })
  it.each(['no route', 'no inventory', 'process unknown', 'process detached', 'unidentified engine', 'no tmux backend'] as const)('does not disturb %s', async reason => {
    // No tmux route: a ptyhost pane only, whose `tmuxPane` projection names the id tmux lists below.
    ;(await live({ resumeOnly: undefined, launch: { state: 'ready' }, ...(reason === 'no route' ? { runtimes: [{ backend: 'ptyhost', instance: 'p1', paneId: pane }] } : {}) }))
    if (reason === 'no route') vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'alive' })
    if (reason === 'no tmux backend') { noBackend(); vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'alive' }) }
    if (reason === 'no inventory') inventory.mockResolvedValue({ state: 'unavailable', reason: 'fixture' })
    if (reason === 'process unknown') vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'unknown', reason: 'fixture' })
    if (reason === 'process detached') { vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'alive' }); inventory.mockResolvedValue(listed()) }
    expect(await start()).toMatchObject({ error: 'RESUME_UNCONFIRMED' }); expect(create).not.toHaveBeenCalled()
    if (reason === 'no route') { expect(inventory).not.toHaveBeenCalled(); expect(checkSessionRuntime).not.toHaveBeenCalled() }
  })
  it.each([true, false])('retains a confirmed engine exit, surviving shell = %s', async alive => {
    ;(await live({ resumeOnly: undefined, processIdentity: identity, launch: { state: 'ready' } }))
    inventory.mockResolvedValue(alive ? listed(pane) : listed())
    // New pane must be distinct from the shell retained by this scenario.
    create.mockResolvedValue({ state: 'succeeded', runtime: { backend: 'tmux', paneId: '%100' } })
    expect(await start()).toMatchObject({ ok: true }); expect(deps.retainExitedSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: saved.agentId }), alive, expect.objectContaining({ current: expect.any(Function) }))
    if (alive) expect(registry.byRuntimeTerminal({ backend: 'tmux', paneId: pane })?.engine).toBe('terminal')
  })
  it('awaits the prior engine exit publication before deciding a new resume', async () => {
    await live({ resumeOnly: undefined, processIdentity: identity, launch: { state: 'ready' } })
    inventory.mockResolvedValue(listed())
    const held = deferred<void>(), entered = deferred<void>()
    deps.retainExitedSession = vi.fn(async row => {
      entered.resolve(); await held.promise
      ;(await removeRegistryAgent(registry, row.agentId))
      return { state: 'confirmed' as const, entry: null }
    })
    let settled = false
    const pending = start().finally(() => { settled = true })
    await entered.promise
    try { await Promise.resolve(); await Promise.resolve(); expect(settled).toBe(false); expect(create).not.toHaveBeenCalled() }
    finally { held.resolve(); await pending }
  })
  it('keeps a failed resume reservation until exit publication confirms', async () => {
    await live()
    deps.stoppedAgents.beginResume(saved.agentId)
    vi.mocked(resolvePaneEngineProcess).mockResolvedValue(null)
    paneState.mockResolvedValue({ dead: false, engineExit: 1 })
    const held = deferred<void>(), entered = deferred<void>()
    deps.retainExitedSession = vi.fn(async () => {
      entered.resolve(); await held.promise
      return { state: 'not-published' as const }
    })
    let settled = false
    const pending = start().finally(() => { settled = true })
    await entered.promise
    try { await Promise.resolve(); await Promise.resolve(); expect(settled).toBe(false); expect(deps.stoppedAgents.resumeReservedAt(saved.agentId)).not.toBeNull() }
    finally { held.resolve(); await pending }
    expect(deps.stoppedAgents.resumeReservedAt(saved.agentId)).not.toBeNull()
  })
  it('cannot verify a surviving shell with no tmux backend to list it', async () => {
    ;(await live({ engine: 'terminal', resumeOnly: undefined, launch: { state: 'ready' } })); noBackend()
    await expect(start()).rejects.toThrow('Could not verify')
    expect(deps.retainExitedSession).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled()
  })
  it('resumes a missing shell', async () => {
    await rewrite({ engine: 'terminal', sessionId: '', transcriptPath: '' }); (await live({ resumeOnly: undefined, launch: { state: 'ready' } }))
    inventory.mockResolvedValue(listed())
    expect(await start()).toMatchObject({ ok: true }); expect(create).toHaveBeenCalledTimes(1)
  })
  it.each(['unknown', 'cancel'] as const)('refuses to retire the old route when its second probe is %s', async mode => {
    ;(await live({ resumeOnly: undefined, processIdentity: identity, launch: { state: 'ready' } }))
    inventory.mockResolvedValueOnce(listed(pane)).mockImplementationOnce(async () => {
      if (mode === 'cancel') deps.restartJobs.cancel(saved.agentId)
      return mode === 'unknown' ? { state: 'unavailable', reason: 'fixture' } : listed(pane)
    })
    if (mode === 'unknown') await expect(start()).rejects.toThrow('Could not verify')
    else expect(await start()).toMatchObject({ error: 'AGENT_CHANGED' })
    expect(deps.retainExitedSession).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled()
  })
  it('rechecks a pending allocation after reconnect without spawning again', async () => {
    ;(await live()); expect(await start()).toMatchObject({ ok: true }); expect(create).not.toHaveBeenCalled()
    // Asked of the pane's own backend, about the pane the row records.
    expect(resolvePaneEngineProcess).toHaveBeenCalledWith(tmuxTerminal, { backend: 'tmux', paneId: pane }, 'codex')
    expect(releaseHold).toHaveBeenCalledWith({ backend: 'tmux', paneId: pane }, expect.any(Function))
  })
  it('confirms nothing of a pending allocation with no tmux backend to ask', async () => {
    ;(await live()); noBackend()
    expect(await start()).toEqual({ ok: false, error: 'TMUX_UNAVAILABLE' })
    expect(resolvePaneEngineProcess).not.toHaveBeenCalled(); expect(deps.announceSession).not.toHaveBeenCalled()
  })
  it('asks a live unconfirmed resume for confirmation again, withdrawing the old verdict first', async () => {
    ;(await live({ processIdentity: identity, launch: { state: 'failed', error: 'RESUME_UNCONFIRMED', detail: 'fixture' } }))
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
    ;(await live({ processIdentity: identity, lastHookAt: 0, launch: { state: 'failed', error: 'RESUME_UNCONFIRMED', detail: 'fixture' } }))
    vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'alive' })
    vi.mocked(resolvePaneEngineProcess).mockResolvedValue(identity)
    expect(await start()).toMatchObject({ ok: true, resumed: true })
    // Ready, not `starting`: a row left starting is made dormant without being retained by
    // discovery, and the desk reads its own resume receipt as unknown.
    expect(registry.byAgent(saved.agentId)?.launch).toEqual({ state: 'ready' })
    // The reservation is released, so the next Enter is not refused by `beginResume`.
    expect(existsSync(join(env.ADAPTER_DATA_DIR, 'stopped-agents', `${saved.agentId}.resume`))).toBe(false)
    expect(create).not.toHaveBeenCalled()
  })
  it('does not re-verify a live process that reported another conversation', async () => {
    ;(await live({ processIdentity: identity, launch: { state: 'failed', error: 'RESUME_SESSION_MISMATCH', detail: 'fixture' } }))
    vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'alive' })
    expect(await start()).toMatchObject({ error: 'RESUME_SESSION_MISMATCH', detail: 'fixture' })
    expect(registry.byAgent(saved.agentId)?.launch).toMatchObject({ state: 'failed', error: 'RESUME_SESSION_MISMATCH' })
    expect(deps.announceSession).not.toHaveBeenCalled()
  })
  it('waits for a real readiness observation before replying', async () => {
    const inspected = deferred<void>()
    vi.mocked(resolvePaneEngineProcess).mockImplementationOnce(async () => { inspected.resolve(); return null })
    let replied = false
    const result = start().then(value => { replied = true; return value })
    await inspected.promise
    expect(replied).toBe(false)
    expect(await result).toMatchObject({ ok: true })
    // No process, then ready, and fresh proof at both sides of asynchronous durability.
    expect(resolvePaneEngineProcess).toHaveBeenCalledTimes(process.platform === 'win32' ? 3 : 4)
  })
  it('honors a stop requested as the newly allocated runtime is announced', async () => {
    vi.mocked(deps.announceSession).mockImplementation(() => deps.restartJobs.cancel(saved.agentId))
    expect(await start()).toMatchObject({ error: 'AGENT_CHANGED' })
    expect((await deps.stoppedAgents.get(saved.agentId))?.sessionId).toBe(saved.sessionId)
    expect(deps.stoppedAgents.beginResume(saved.agentId)).toBeNull()
  })
  it.each([true, false])('cancels while clearing remain-on-exit, terminal=%s', async terminal => {
    if (terminal) await rewrite({ engine: 'terminal', sessionId: '', transcriptPath: '' })
    releaseHold.mockImplementation(async () => { deps.restartJobs.cancel(saved.agentId) })
    expect(await start()).toMatchObject({ error: 'AGENT_CHANGED' })
  })
  it('does not finish a reservation when the route changes during final readiness cleanup', async () => {
    releaseHold.mockImplementation(async () => { registry.byAgent(saved.agentId)!.tmuxPane = '%102' })
    expect(await start()).toMatchObject({ error: 'AGENT_CHANGED' })
    expect(deps.stoppedAgents.beginResume(saved.agentId)).toBeNull()
  })
  it.each(['operation', 'route'] as const)('cancels a readiness check when %s changes', async mode => {
    ;(await live())
    vi.mocked(resolvePaneEngineProcess).mockImplementation(async () => { if (mode === 'operation') deps.restartJobs.cancel(saved.agentId); else registry.byAgent(saved.agentId)!.tmuxPane = '%102'; return identity })
    expect(await start()).toMatchObject({ error: 'AGENT_CHANGED' })
  })
  it.each(['missing row', 'exit dead pane', 'exit surviving pane', 'exit unknown process', 'mismatched session', 'failed hook', 'cancel process probe', 'cancel pane probe'] as const)('preserves work on %s', async mode => {
    ;(await live())
    vi.mocked(resolvePaneEngineProcess).mockImplementation(async () => {
      if (mode === 'missing row') (await removeRegistryAgent(registry, saved.agentId))
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
    expect(create).not.toHaveBeenCalled(); expect((await deps.stoppedAgents.get(saved.agentId))).not.toBeNull()
  })
  it.each([
    ['gone', false], ['unknown', true],
  ] as const)('an exited engine whose pane tmux reads as %s keeps its row as a terminal: %s', async (pane, kept) => {
    // Only a pane known to be gone loses its row. One tmux could not read (a call that timed out while
    // the daemon's event loop was held) keeps it, for the reconciler to judge with scans that agree.
    ;(await live())
    vi.mocked(resolvePaneEngineProcess).mockResolvedValue(null)
    paneState.mockResolvedValueOnce({ dead: false, engineExit: 1 } as any).mockResolvedValueOnce(pane)
    expect(await start()).toMatchObject({ ok: false, error: 'RESUME_FAILED' })
    expect(deps.retainExitedSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: saved.agentId }), kept, expect.objectContaining({ current: expect.any(Function) }))
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
    await rewrite({ permissionMode: mode, bypassPermission: bypass })
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
    expect(ptyCreate.mock.calls[0][0].command).toBeTypeOf('function')
    expect(vi.mocked(buildEngineLaunchArgv).mock.results.at(-1)!.value).toEqual(['fixture-engine'])
    expect(resolvePaneEngineProcess).toHaveBeenCalledWith(ptyTerminal, pty, 'codex')
    expect(ptyReleaseHold).toHaveBeenCalledWith(pty, expect.any(Function))
    tmuxUntouched()
  })

  it('opens a stopped shell in a new pty host pane', async () => {
    await rewrite({ engine: 'terminal', sessionId: '', transcriptPath: '' })
    expect(await start()).toMatchObject({ ok: true, session: { runtimes: [pty], launch: { state: 'ready' } } })
    expect(ptyReleaseHold).toHaveBeenCalledWith(pty, expect.any(Function))
    tmuxUntouched()
  })

  it('closes a cancelled allocation on the pty host', async () => {
    ptyCreate.mockImplementation(async () => { deps.restartJobs.cancel(saved.agentId); return { state: 'succeeded', runtime: pty } })
    expect(await start()).toMatchObject({ error: 'AGENT_CHANGED' })
    expect(ptyKill).toHaveBeenCalledExactlyOnceWith(pty)
    tmuxUntouched()
  })

  it('attaches a live pty host harness verified through its own inventory and pane', async () => {
    ;(await live({ resumeOnly: undefined, launch: { state: 'ready' }, runtimes: [pty] }))
    vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'alive' })
    expect(await start()).toMatchObject({ ok: true }); expect(ptyCreate).not.toHaveBeenCalled()
    expect(ptyInventory).toHaveBeenCalledOnce()
    expect(checkSessionRuntime).toHaveBeenCalledExactlyOnceWith(ptyTerminal, expect.objectContaining({ agentId: saved.agentId }), pty)
    tmuxUntouched()
  })

  it.each([true, false])('retains a pty host engine that exited, its shell surviving = %s', async alive => {
    ;(await live({ resumeOnly: undefined, processIdentity: identity, launch: { state: 'ready' }, runtimes: [pty] }))
    ptyInventory.mockResolvedValue(alive ? ptyListed(pty.paneId) : ptyListed())
    ptyCreate.mockResolvedValue({ state: 'succeeded', runtime: { ...pty, paneId: '%6' } })
    expect(await start()).toMatchObject({ ok: true })
    expect(deps.retainExitedSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: saved.agentId }), alive, expect.objectContaining({ current: expect.any(Function) }))
    tmuxUntouched()
  })

  it('rechecks a pending pty host allocation through its own backend', async () => {
    ;(await live({ runtimes: [pty] }))
    expect(await start()).toMatchObject({ ok: true }); expect(ptyCreate).not.toHaveBeenCalled()
    expect(resolvePaneEngineProcess).toHaveBeenCalledWith(ptyTerminal, pty, 'codex')
    expect(ptyReleaseHold).toHaveBeenCalledWith(pty, expect.any(Function))
    tmuxUntouched()
  })

  it('reads a pty host pane whose engine exited, to keep or drop its row', async () => {
    ;(await live({ runtimes: [pty] }))
    vi.mocked(resolvePaneEngineProcess).mockResolvedValue(null)
    ptyPaneState.mockResolvedValueOnce({ dead: false, engineExit: 1 }).mockResolvedValueOnce('gone')
    expect(await start()).toMatchObject({ ok: false, error: 'RESUME_FAILED' })
    expect(ptyPaneState).toHaveBeenCalledWith(pty)
    expect(deps.retainExitedSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: saved.agentId }), false, expect.objectContaining({ current: expect.any(Function) }))
    tmuxUntouched()
  })

  it('names the pty host when a pty host row has no backend to ask', async () => {
    ;(await live({ runtimes: [pty] })); deps.backendFor = () => undefined
    expect(await start()).toEqual({ ok: false, error: 'PTY_HOST_UNAVAILABLE' })
    expect(resolvePaneEngineProcess).not.toHaveBeenCalled()
  })

  it('asks tmux for the tmux pane of a mixed row', async () => {
    deps.backendFor = runtime => runtime.backend === 'tmux' ? tmuxTerminal : ptyTerminal
    const tmux = { backend: 'tmux' as const, paneId: pane }
    ;(await live({ runtimes: [pty, tmux] }))
    expect(await start()).toMatchObject({ ok: true })
    expect(resolvePaneEngineProcess).toHaveBeenCalledWith(tmuxTerminal, tmux, 'codex')
    expect(releaseHold).toHaveBeenCalledWith(tmux, expect.any(Function))
    expect(ptyReleaseHold).not.toHaveBeenCalled()
  })
})

function holdReadyPublication() {
  const arrived = deferred<void>(), held = deferred<void>()
  publication.agent = saved.agentId
  publication.release = () => held.resolve()
  publication.wait = async () => { publication.wait = undefined; arrived.resolve(); await held.promise }
  vi.mocked(resolvePaneEngineProcess).mockResolvedValue(identity)
  return { arrived: arrived.promise, release: () => held.resolve() }
}

it('does not release or announce resumed authority before its selected process and launch words are durable', async () => {
  const held = holdReadyPublication()
  const result = createResumeAgentService(deps)(saved.agentId, undefined, ['--durable']).catch(error => error)
  await held.arrived
  try {
    expect(releaseHold).not.toHaveBeenCalled()
    expect(deps.announceSession).not.toHaveBeenCalledWith(expect.objectContaining({ launch: { state: 'ready' } }))
    expect(deps.stoppedAgents.resumeReservedAt(saved.agentId)).not.toBeNull()
  } finally { held.release(); await result }
  expect(await result).toMatchObject({ ok: true })
  const persisted = JSON.parse(readFileSync(join(env.ADAPTER_DATA_DIR, 'registry.json'), 'utf8')) as RegisteredSession[]
  expect(persisted.find(row => row.agentId === saved.agentId)).toMatchObject({ processIdentity: identity, launchArgs: ['--durable'], launch: { state: 'ready' } })
})

it.each(['cancel', 'process', 'owner'] as const)('revokes resumed authority when %s changes during durable preparation', async change => {
  const held = holdReadyPublication(), result = start().catch(error => error)
  await held.arrived
  try {
    if (change === 'cancel') deps.restartJobs.cancel(saved.agentId)
    else if (change === 'process') vi.mocked(resolvePaneEngineProcess).mockResolvedValue({ ...identity, startMarker: 'replacement-process' })
    else {
      // A ready process observation can replace native ownership while the old image waits.
      registry.updateProcessIdentity(saved.agentId, { ...identity, startMarker: 'replacement-owner' })
    }
  } finally { held.release() }
  const outcome = await result
  expect(outcome).not.toMatchObject({ ok: true })
  expect(releaseHold).not.toHaveBeenCalled()
  expect(deps.stoppedAgents.resumeReservedAt(saved.agentId)).not.toBeNull()
})

it('refuses resumed authority when a peer changes the selected durable row', async () => {
  const peer = Reflect.construct(registry.constructor, []) as typeof registry
  const plan = { id: '12345678-1234-1234-1234-123456789012', identity: 'fixture-conversation', requestedAt: Date.now(), state: 'waiting' as const }
  vi.mocked(resolvePaneEngineProcess).mockImplementationOnce(async () => {
    await peer.load()
    await peer.setClosePlan(saved.agentId, plan)
    return identity
  }).mockResolvedValue(identity)
  try {
    expect(await start()).toMatchObject({ ok: false, error: 'RESUME_UNCONFIRMED' })
    expect(releaseHold).not.toHaveBeenCalled()
    expect(deps.stoppedAgents.resumeReservedAt(saved.agentId)).not.toBeNull()
    const persisted = JSON.parse(readFileSync(join(env.ADAPTER_DATA_DIR, 'registry.json'), 'utf8')) as RegisteredSession[]
    expect(persisted.find(row => row.agentId === saved.agentId)).toMatchObject({ closePlan: plan, processIdentity: null, launch: { state: 'starting' } })
  } finally {
    await peer.flush({ exiting: true })
    // The test deliberately published a peer owner; refresh before strict cleanup selects it.
    await registry.flush()
  }
})

it.each(['codex', 'terminal'] as const)('retains resumed authority for %s after post-rename uncertainty until the same candidate is confirmed', async engine => {
  if (engine === 'terminal') await rewrite({ engine: 'terminal', sessionId: '', transcriptPath: '' })
  publication.agent = saved.agentId; publication.failSync = 2
  if (engine === 'terminal') vi.mocked(resolvePaneEngineProcess).mockRejectedValue(Error('a terminal has no engine process to probe'))
  else vi.mocked(resolvePaneEngineProcess).mockResolvedValue(identity)
  const resume = () => createResumeAgentService(deps)(saved.agentId, undefined, ['--durable'])
  const result = await resume().catch(error => error)
  expect(result).not.toMatchObject({ ok: true })
  expect(releaseHold).not.toHaveBeenCalled()
  expect(deps.announceSession).not.toHaveBeenCalledWith(expect.objectContaining({ launch: { state: 'ready' } }))
  expect(deps.stoppedAgents.resumeReservedAt(saved.agentId)).not.toBeNull()
  expect(registry.byAgent(saved.agentId)?.processIdentity).toBeNull()
  expect(await resume()).toMatchObject({ ok: true, session: { processIdentity: engine === 'terminal' ? null : identity, launchArgs: ['--durable'], launch: { state: 'ready' } } })
  expect(releaseHold).toHaveBeenCalledOnce()
  expect(deps.stoppedAgents.resumeReservedAt(saved.agentId)).toBeNull()
})

it('acknowledges durable resumed authority during cleanup while retaining the writer slot', async () => {
  const arrived = deferred<void>(), held = deferred<void>()
  publication.agent = saved.agentId
  publication.release = () => held.resolve()
  publication.cleanupWait = async () => { publication.cleanupWait = undefined; arrived.resolve(); await held.promise }
  vi.mocked(resolvePaneEngineProcess).mockResolvedValue(identity)
  const result = start()
  await arrived.promise
  let second: Promise<unknown> | undefined
  let settled = false
  try {
    expect(await result).toMatchObject({ ok: true, session: { processIdentity: identity, launch: { state: 'ready' } } })
    expect(releaseHold).toHaveBeenCalledOnce()
    second = registry.setClosePlan(saved.agentId, null).then(value => { settled = true; return value })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
  } finally { held.resolve(); await result; await second }
  expect(settled).toBe(true)
})

it('preserves unrelated observations made while resumed authority waits in the queue', async () => {
  await live()
  const blocker = (await registry.openPendingAgent({ engine: 'terminal', runtimes: [{ backend: 'tmux', paneId: '%200' }], cwd: dir }))!
  const arrived = deferred<void>(), held = deferred<void>()
  const first = registry.confirmLaunch(blocker.agentId, { processIdentity: null, grid: null }, {
    refresh: async () => { arrived.resolve(); await held.promise },
  })
  await arrived.promise
  const confirmation = registry.confirmLaunch(saved.agentId, { processIdentity: identity, grid: null })
  registry.updateTitle(saved.sessionId, 'New title while queued')
  try { held.resolve(); await first; expect(await confirmation).toMatchObject({ state: 'confirmed', entry: { title: 'New title while queued' } }) }
  finally { held.resolve(); await first; await confirmation }
})

it.skipIf(process.platform === 'win32')('keeps the actual pending Resume pane and reservation after its renamed allocation expires', async () => {
  const arrived = deferred<void>(), held = deferred<void>()
  publication.agent = saved.agentId; publication.pending = true
  publication.release = () => held.resolve()
  publication.directoryWait = async () => { arrived.resolve(); await held.promise }
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const result = start().catch(error => error)
  expect(await Promise.race([arrived.promise.then(() => 'directory'), result.then(() => 'settled')])).toBe('directory')
  expect(create).toHaveBeenCalledOnce()
  expect(kill).not.toHaveBeenCalled()
  expect(releaseHold).not.toHaveBeenCalled()
  expect(deps.announceSession).not.toHaveBeenCalled()
  expect(deps.stoppedAgents.resumeReservedAt(saved.agentId)).not.toBeNull()
  await vi.advanceTimersByTimeAsync(5_000)
  expect((await result).constructor.name).toBe('AtomicWriteUnconfirmed')
  expect(await result).toMatchObject({ retryable: false })
  held.resolve(); vi.useRealTimers()
  await registry.flush()
  expect(create).toHaveBeenCalledOnce()
  expect(kill).not.toHaveBeenCalled()
  expect(releaseHold).not.toHaveBeenCalled()
  expect(deps.announceSession).not.toHaveBeenCalled()
  expect(deps.stoppedAgents.resumeReservedAt(saved.agentId)).not.toBeNull()
})
