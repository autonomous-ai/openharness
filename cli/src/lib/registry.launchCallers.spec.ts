import { releaseRegistryEngine, removeRegistryAgent } from '../testing/registryFixtures.js'
/** Real registry images at the callers that release terminals or announce launches. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { env } from '../config/env.js'
import { registry, RegistryOwnershipChanged, type RegisteredSession } from './registry.js'
import { commitRelaunchedEngine } from '../core/agents/restart.js'
import { createAgentRetargeter, type RetargetDeps } from '../core/agents/retarget.js'
import { createPaneWatcher } from '../core/agents/newPane.js'
import { hostMoveDeps, type HostMoveWiring } from '../core/agents/hostMove.js'
import { resolvePaneEngineProcess } from './paneEngineProcess.js'
import { AgentRestartCoordinator } from './restartAgent.js'
import { restoreAgents, type RestoreAgentsDeps } from './restoreAgents.js'
import { createRetainExitedSession } from './retainExitedSession.js'
import { StoppedAgentStore } from './stoppedAgents.js'
import { MoveGate } from './hostMove/gate.js'
import { AtomicWriteUnconfirmed } from './registryPersistence.js'
import type { TerminalBackend } from './terminalBackend.js'
import { createBinding } from '../core/agents/bind.js'
import { createStopAgentService } from './stopAgentService.js'
import { createForgetSession } from '../core/agents/forget.js'
import { createDiscoveryHandlers, type DiscoveryDeps } from '../core/agents/discovery.js'
import type { DiscoveredTerminalAgent } from './terminalAgentDiscovery.js'
import { createAgentUpdate } from '../core/agents/update.js'
import type { AgentFrame } from './agentFrame.js'

const image = vi.hoisted(() => ({
  match: undefined as undefined | ((rows: RegisteredSession[]) => boolean),
  wait: undefined as undefined | (() => Promise<void>), release: undefined as undefined | (() => void),
  failSync: 0, renamed: false, afterFailure: undefined as undefined | (() => void),
  names: false,
}))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    actual.renameSync(...args)
    if (String(args[1]).endsWith(image.names ? '/agent-names.json' : '/registry.json')) image.renamed = true
  }, fsyncSync: (fd: number) => {
    if (image.renamed && image.failSync > 0) {
      image.renamed = false; image.failSync--
      queueMicrotask(() => image.afterFailure?.())
      throw Object.assign(new Error('fixture directory sync failed'), { code: 'EIO' })
    }
    return actual.fsyncSync(fd)
  } }
})
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args), write = handle.writeFile.bind(handle), sync = handle.sync.bind(handle)
    let selected = false
    handle.writeFile = async (...values) => {
      if (String(args[0]).includes(image.names ? 'names.json.' : 'registry.json.') && String(args[0]).endsWith('.tmp')) {
        selected = image.names || image.match?.(JSON.parse(String(values[0]))) === true
        if (selected) image.match = undefined
      }
      return write(...values)
    }
    handle.sync = async () => { await sync(); if (selected) await image.wait?.() }
    return handle
  } }
})
vi.mock('./paneEngineProcess.js', async original => ({ ...await original<object>(), resolvePaneEngineProcess: vi.fn() }))
vi.mock('./deleteAgentFallback.js', async original => ({ ...await original<object>(), checkPidRuntime: async () => ({ state: 'gone', reason: 'fixture terminated' }) }))
vi.mock('./workspaceCheck.js', () => ({ workspaceMissing: () => null }))
vi.mock('./captureResumeIdentity.js', () => ({ captureResumeIdentity: async (row: RegisteredSession) => row }))
vi.mock('./launchOverrides.js', async original => ({ ...await original<object>(), validateLaunchOverrides: async () => ({ ok: true }) }))
vi.mock('./engineLaunch.js', async original => ({ ...await original<object>(), commandAvailableInInteractiveShell: async () => true }))
vi.mock('./restartAgent.js', async original => ({ ...await original<object>(),
  bypassPermissionFor: async () => false,
  restartAgent: async () => ({ ok: true, resumed: true, processIdentity: { pid: 7002, startMarker: 'new', executable: '/fixture/claude' } }),
}))

const oldProcess = { pid: 7001, startMarker: 'old', executable: '/fixture/claude' }
const newProcess = { pid: 7002, startMarker: 'new', executable: '/fixture/claude' }
const runtime = { backend: 'tmux' as const, paneId: '%70' }
const destination = { backend: 'ptyhost' as const, instance: 'p2-1.2.3', paneId: '%71' }
const startingToken = '11111111-1111-1111-1111-111111111111'
const replacementToken = '22222222-2222-2222-2222-222222222222'
const releaseHold = vi.fn(async () => {})
const announce = vi.fn()
const paneState = vi.fn(async () => ({ dead: false, engineExit: null as number | null }))
const terminal = { name: 'tmux', holdOpen: async () => ({ state: 'succeeded' }), respawn: async () => ({ state: 'succeeded' }),
  rootProcess: async () => null, inventory: async () => ({ state: 'available', roots: [] }), paneState, releaseHold } as unknown as TerminalBackend
let row: RegisteredSession
let directory: string
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function holdImage(match: (rows: RegisteredSession[]) => boolean) {
  const entered = deferred(), held = deferred()
  image.match = match; image.release = held.resolve
  image.wait = async () => { image.wait = undefined; entered.resolve(); await held.promise }
  return { entered: entered.promise, release: held.resolve }
}
const persisted = (): RegisteredSession[] => JSON.parse(readFileSync(join(env.ADAPTER_DATA_DIR, 'registry.json'), 'utf8'))

beforeEach(async () => {
  vi.clearAllMocks()
  vi.mocked(resolvePaneEngineProcess).mockResolvedValue(newProcess)
  paneState.mockResolvedValue({ dead: false, engineExit: null })
  directory = mkdtempSync(join(tmpdir(), 'launch-publication-'))
  const admitted = (await registry.openPendingAgent({ engine: 'claude', runtimes: [runtime], cwd: directory }))!
  row = registry.byAgent(admitted.agentId)!
  registry.updateProcessIdentity(row.agentId, oldProcess)
  await registry.flush()
  row = registry.byAgent(row.agentId)!
})
afterEach(async () => {
  image.match = undefined; image.wait = undefined; image.release?.(); image.release = undefined
  image.failSync = 0; image.renamed = false; image.afterFailure = undefined
  image.names = false
  for (const entry of registry.list()) (await removeRegistryAgent(registry, entry.agentId))
  await registry.flush()
  rmSync(directory, { recursive: true, force: true })
})

it('restart keeps its terminal and ready announcement held until its process is durable', async () => {
  const held = holdImage(rows => rows.some(entry => entry.agentId === row.agentId && entry.processIdentity?.pid === newProcess.pid))
  const result = commitRelaunchedEngine({ registry, announceSession: announce, refreshGridAssignment: vi.fn() },
    row.agentId, newProcess, null, { backend: terminal, runtime } as never, () => true)
  await held.entered
  try { expect(releaseHold).not.toHaveBeenCalled(); expect(announce).not.toHaveBeenCalled() }
  finally { held.release(); await result }
  expect(persisted().find(entry => entry.agentId === row.agentId)?.processIdentity).toEqual(newProcess)
})

it('confirms one immutable launch candidate after a single lost directory sync', async () => {
  image.failSync = 1
  const refresh = vi.fn(async () => {})
  const publication = await registry.confirmLaunch(row.agentId, { processIdentity: newProcess, runtimes: [destination], launchArgs: ['--fixture'] }, { refresh })
  expect(publication).toMatchObject({ state: 'confirmed', entry: { processIdentity: newProcess, runtimes: [destination], launchArgs: ['--fixture'] } })
  expect(refresh).toHaveBeenCalledTimes(2)
  expect(persisted().find(entry => entry.agentId === row.agentId)).toMatchObject({ processIdentity: newProcess, runtimes: [destination] })
})

it.each(['owner', 'observation', 'cancel'] as const)('never converts uncertain launch publication into rollback after a later %s change', async change => {
  image.failSync = 1
  let current = true
  image.afterFailure = () => {
    if (change === 'owner') registry.byAgent(row.agentId)!.processIdentity = { ...oldProcess, startMarker: 'third-owner' }
    else if (change === 'observation') registry.byAgent(row.agentId)!.title = 'Observed while cleanup settles'
    else current = false
  }
  const refresh = vi.fn(async () => {})
  const publication = await registry.confirmLaunch(row.agentId, { processIdentity: newProcess, runtimes: [destination] }, { current: () => current, refresh }).catch(error => error)
  expect(publication).toBeInstanceOf(AtomicWriteUnconfirmed)
  expect(refresh).toHaveBeenCalledOnce()
  // The visible rename may name the destination. A failed recovery cannot publish the old route over it.
  expect(persisted().find(entry => entry.agentId === row.agentId)).toMatchObject({ processIdentity: newProcess, runtimes: [destination] })
})

it.each([['the same', 'confirmed', newProcess], ['another', 'refused', { ...newProcess, pid: 7003, startMarker: 'other' }]] as const)(
  'a launch discovery confirmed first with %s process, while this confirmation waited behind it, is %s', async (_which, outcome, peerProcess) => {
    // A resumed row: no process yet, its launch starting (registry.ts `resumePendingAgent`).
    registry.clearProcessIdentity(row.agentId)
    registry.setLaunch(row.agentId, { state: 'starting', nativeToken: startingToken })
    await registry.flush()
    const held = holdImage(rows => rows.some(entry => entry.agentId === row.agentId && entry.processIdentity?.pid === peerProcess.pid))
    // Discovery's pass over the pane confirms its engine first (discovery.ts `onObserved`)...
    const peer = registry.confirmLaunch(row.agentId, { processIdentity: peerProcess, runtimes: [runtime] })
    await held.entered
    // ...while the resume that launched it confirms the process it verified, behind that write (resumeAgentService.ts).
    const own = registry.confirmLaunch(row.agentId, { processIdentity: newProcess, launchArgs: ['--fixture'] }).catch(error => error)
    held.release()
    expect(await peer).toMatchObject({ state: 'confirmed' })
    if (outcome === 'confirmed') {
      expect(await own).toMatchObject({ state: 'confirmed', entry: { processIdentity: newProcess, launch: { state: 'ready' }, launchArgs: ['--fixture'] } })
    } else expect(await own).toBeInstanceOf(RegistryOwnershipChanged)
  })

it('a starting launch discovery marked dormant, then confirmed first with the same process, is confirmed', async () => {
  // A resumed row whose engine was not yet in its pane at discovery's last pass (discovery.ts `onDormant`).
  registry.clearProcessIdentity(row.agentId)
  registry.setLaunch(row.agentId, { state: 'starting', nativeToken: startingToken })
  registry.setActive(row.agentId, false)
  await registry.flush()
  const held = holdImage(rows => rows.some(entry => entry.agentId === row.agentId && entry.processIdentity?.pid === newProcess.pid))
  const peer = registry.confirmLaunch(row.agentId, { processIdentity: newProcess, runtimes: [runtime] })
  await held.entered
  const own = registry.confirmLaunch(row.agentId, { processIdentity: newProcess }).catch(error => error)
  held.release()
  expect(await peer).toMatchObject({ state: 'confirmed' })
  expect(await own).toMatchObject({ state: 'confirmed', entry: { processIdentity: newProcess, active: true, launch: { state: 'ready' } } })
})

it.each([['the grid it was relaunched on', 'confirmed', 'https://fixture.invalid/v1'], ['another grid', 'refused', 'https://other.invalid/v1']] as const)(
  'a relaunch whose process discovery recorded first with %s is %s', async (_which, outcome, peerUrl) => {
    // A running agent moved to a grid (retarget.ts): its row ready, on its old process and no grid.
    registry.setLaunch(row.agentId, { state: 'ready' })
    await registry.flush()
    const grid = { baseUrl: 'https://fixture.invalid/v1', model: 'fixture-model' }
    const held = holdImage(rows => rows.some(entry => entry.agentId === row.agentId && entry.bypassPermission === true))
    registry.setBypassPermission(row.agentId, true)
    await held.entered
    // The retarget confirms its engine behind that save...
    const own = registry.confirmLaunch(row.agentId, { processIdentity: newProcess, grid }).catch(error => error)
    // ...while discovery's pass records the relaunched engine and the grid its argv names (discovery.ts
    // `updateProcessIdentity`, a Codex's or Pi's).
    registry.updateProcessIdentity(row.agentId, newProcess, undefined, { ...grid, baseUrl: peerUrl })
    held.release()
    if (outcome === 'confirmed') expect(await own).toMatchObject({ state: 'confirmed', entry: { processIdentity: newProcess, grid } })
    else expect(await own).toBeInstanceOf(RegistryOwnershipChanged)
  })

it('retarget keeps provider success and terminal release behind the complete durable launch', async () => {
  const held = holdImage(rows => rows.some(entry => entry.agentId === row.agentId && entry.processIdentity?.pid === newProcess.pid))
  const grid = { networkId: 'fixture-grid', networkName: 'Fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-key', model: 'fixture-model' }
  const deps: RetargetDeps = {
    registry, terminals: { backendFor: () => terminal, instances: () => [terminal] }, sessionTurnOpen: () => false, purgeBusy: () => false,
    runtimeProfiles: { selectedModel: () => null }, launchOverridesDeps: {} as never, acquireTerminalControl: () => () => {},
    relaunchOverrides: async () => ({ ok: true, overrides: { env: {}, extraArgs: [], clearEnv: [], gridLaunchRecord: { override: grid, webSearch: 'on' } } }),
    downgradedPermission: async () => ({ bypassPermission: false, permissionMode: null }), agentReconciler: { holdRoute: () => () => {} },
    restartJobs: new AgentRestartCoordinator(), paneSwapDeps: () => ({}) as never, liveBypassPermission: async () => false,
    announceSession: announce, refreshGridAssignment: vi.fn(), opencodeDb: '/fixture/unused',
  }
  const result = createAgentRetargeter(deps)({ agentId: row.agentId, grid }).catch(error => error)
  await held.entered
  try { expect(releaseHold).not.toHaveBeenCalled(); expect(announce).not.toHaveBeenCalled() }
  finally { held.release(); await result }
  expect(await result).toMatchObject({ ok: true })
  expect(persisted().find(entry => entry.agentId === row.agentId)).toMatchObject({ processIdentity: newProcess, gridLaunch: grid, gridWebSearch: 'on' })
})

it('new-pane readiness cannot release or announce a merely queued process', async () => {
  registry.clearProcessIdentity(row.agentId)
  await registry.flush()
  const held = holdImage(rows => rows.some(entry => entry.agentId === row.agentId && entry.processIdentity?.pid === newProcess.pid))
  const watch = createPaneWatcher({ registry, announceSession: announce, triggerHint: vi.fn(async () => {}), captureTerminal: async () => '',
    retainExitedSession: vi.fn(), terminals: { backendFor: () => terminal }, holdRoute: () => () => {} })
  const result = watch('claude', structuredClone(row), { runtime }, ['fixture-engine'], undefined)
  await held.entered
  try { expect(releaseHold).not.toHaveBeenCalled(); expect(announce).not.toHaveBeenCalled() }
  finally { held.release(); await result }
  expect(persisted().find(entry => entry.agentId === row.agentId)).toMatchObject({ processIdentity: newProcess, launch: { state: 'ready' } })
})

it.each(['conversation', 'home'] as const)('new-pane preparation cannot reselect a changed %s as its first hook', async changed => {
  registry.clearProcessIdentity(row.agentId)
  const pending = structuredClone(registry.byAgent(row.agentId)!)
  if (changed === 'conversation') row.sessionId = 'first-native-session'
  await registry.flush()
  const held = holdImage(rows => rows.some(entry => entry.agentId === row.agentId && entry.processIdentity?.pid === newProcess.pid))
  const watching = createPaneWatcher({ registry, announceSession: announce, triggerHint: async () => {}, captureTerminal: async () => '',
    retainExitedSession: vi.fn(), terminals: { backendFor: () => terminal }, holdRoute: () => () => {} })(
      'claude', pending, { runtime }, ['fixture-engine'], undefined)
  await held.entered
  const live = registry.byAgent(row.agentId)!
  if (changed === 'conversation') live.sessionId = 'replacement-session'
  else live.hermesHome = '/fixture/changed-native-home'
  held.release(); await watching
  expect(releaseHold).not.toHaveBeenCalled(); expect(announce).not.toHaveBeenCalled()
})

it.each([false, true])('new-pane engine exit publishes its shell before release, bound conversation=%s', async bound => {
  if (bound) { row.sessionId = 'fixture-session'; await registry.flush() }
  vi.mocked(resolvePaneEngineProcess).mockResolvedValue(null)
  paneState.mockResolvedValue({ dead: false, engineExit: 1 })
  const held = holdImage(rows => rows.some(entry => entry.engine === 'terminal' && (entry.agentId === row.agentId || entry.previousAgentId === row.agentId)))
  const store = new StoppedAgentStore(join(directory, 'stopped')), send = vi.fn()
  const retain = createRetainExitedSession({ registry, stoppedAgents: store, send, publishStoppedAgent: async () => {}, announceSession: announce,
    invalidateTerminalControl: vi.fn(), forgetInput: vi.fn(), ended: vi.fn(), syncRecapPool: vi.fn(), warn: vi.fn() })
  const watch = createPaneWatcher({ registry, announceSession: announce, triggerHint: async () => {}, captureTerminal: async () => 'engine exited',
    retainExitedSession: retain, terminals: { backendFor: () => terminal }, holdRoute: () => () => {} })
  const result = watch('claude', structuredClone(row), { runtime }, ['fixture-engine'], undefined)
  await held.entered
  try {
    expect(releaseHold).not.toHaveBeenCalled(); expect(announce).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
    if (bound) expect(store.get(row.agentId)?.sessionId).toBe('fixture-session')
  } finally { held.release(); await result }
  expect(persisted().some(entry => entry.engine === 'terminal')).toBe(true)
})

it('host swap does not announce or claim completion before its destination route is durable', async () => {
  const destinationBackend = { ...terminal, name: 'ptyhost' } as TerminalBackend
  const held = holdImage(rows => rows.some(entry => entry.agentId === row.agentId && entry.runtimes.some(route => route.backend === destination.backend)))
  const wiring: HostMoveWiring = {
    registry, terminals: { backendFor: route => route.backend === 'ptyhost' ? destinationBackend : terminal, capture: async () => ({ state: 'succeeded', value: '' }) }, createBackend: () => destinationBackend,
    restore: { respawn: async () => ({ ok: true }), probeProcess: async () => newProcess }, buildLaunch: async () => ({ argv: [] }),
    paneSwapDeps: () => ({}) as never, retarget: async () => {}, gate: new MoveGate(), eligible: () => true,
    holdRoute: () => () => {}, announce, invalidateControl: vi.fn(), waitingArgv: () => [], log: vi.fn(),
  }
  let completed = false
  const result = Promise.resolve(hostMoveDeps(structuredClone(row), () => true, wiring).swap(row.agentId, destination, newProcess))
    .then(value => { completed = true; return value })
  await held.entered
  try { expect(completed).toBe(false); expect(announce).not.toHaveBeenCalled() }
  finally { held.release(); await result }
  expect(persisted().find(entry => entry.agentId === row.agentId)?.runtimes).toEqual([destination])
})

it.each(['restart', 'new pane', 'restore', 'host move'] as const)('revokes prepared %s readiness when its operation is cancelled', async caller => {
  let cancelled = false
  if (caller === 'new pane' || caller === 'restore') {
    registry.clearProcessIdentity(row.agentId)
    registry.setLaunch(row.agentId, { state: 'starting', nativeToken: startingToken })
    await registry.flush()
  }
  const selected = structuredClone(registry.byAgent(row.agentId)!)
  const held = holdImage(rows => rows.some(entry => entry.agentId === row.agentId && entry.processIdentity?.pid === newProcess.pid))
  let pending: Promise<unknown>
  if (caller === 'restart') pending = commitRelaunchedEngine({ registry, announceSession: announce, refreshGridAssignment: vi.fn() },
    row.agentId, newProcess, null, { backend: terminal, runtime } as never, () => !cancelled)
  else if (caller === 'new pane') pending = createPaneWatcher({ registry, announceSession: announce, triggerHint: async () => {}, captureTerminal: async () => '',
    retainExitedSession: vi.fn(), terminals: { backendFor: () => terminal }, holdRoute: () => () => {}, cancelled: () => cancelled })(
      'claude', selected, { runtime }, ['fixture-engine'], undefined)
  else if (caller === 'restore') {
    const done = deferred(), deps = restoreDeps(done.resolve)
    deps.cancelled = () => cancelled
    pending = restoreAgents(deps).then(() => done.promise)
  } else {
    const destinationBackend = { ...terminal, name: 'ptyhost' } as TerminalBackend
    pending = hostMoveDeps(selected, () => !cancelled, { registry,
      terminals: { backendFor: route => route.backend === 'ptyhost' ? destinationBackend : terminal, capture: async () => ({ state: 'succeeded', value: '' }) },
      createBackend: () => destinationBackend, restore: { respawn: async () => ({ ok: true }), probeProcess: async () => newProcess },
      buildLaunch: async () => ({ argv: [] }), paneSwapDeps: () => ({}) as never, retarget: async () => {}, gate: new MoveGate(), eligible: () => true,
      holdRoute: () => () => {}, announce, invalidateControl: vi.fn(), waitingArgv: () => [], log: vi.fn() }).swap(row.agentId, destination, newProcess)
  }
  const settled = pending.catch(error => error)
  await held.entered
  cancelled = true
  held.release(); await settled
  expect(releaseHold).not.toHaveBeenCalled(); expect(announce).not.toHaveBeenCalled()
  expect(persisted().find(entry => entry.agentId === row.agentId)?.processIdentity?.pid).not.toBe(newProcess.pid)
})

function restoreDeps(done: () => void): RestoreAgentsDeps {
  return {
    registry, livePane: async () => true, liveProcess: async () => null, waitingPane: async () => false,
    buildLaunch: async () => ({ argv: ['fixture-engine'], nativeToken: replacementToken }), createPane: async () => ({ ok: true, runtime }),
    respawn: async () => ({ ok: true }), probeProcess: async () => newProcess, paneState,
    clearRemainOnExit: releaseHold, holdRoute: () => done, releaseRoute: done, triggerHint: async () => {}, log: vi.fn(), settleMs: 0,
  }
}

it('binding revalidation cannot change Stop evidence while its prepared image waits', async () => {
  const sessionId = '44444444-4444-4444-8444-444444444444', home = join(directory, 'codex')
  const transcript = join(home, 'sessions', `rollout-${sessionId}.jsonl`)
  mkdirSync(join(home, 'sessions'), { recursive: true })
  writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: directory, source: 'cli' } }) + '\n')
  const process = { ...oldProcess, executable: '/fixture/codex' }
  Object.assign(row, { engine: 'codex', codexHome: home, sessionId, transcriptPath: transcript, boundAt: 1,
    processIdentity: process, launch: { state: 'ready' } })
  await registry.flush()
  registry.setIdentityHold(row.agentId, 'waiting for evidence')
  row = registry.byAgent(row.agentId)!
  row.title = 'observed title pending publication'
  const revision = row.evidenceRevision
  const store = new StoppedAgentStore(join(directory, 'revalidation-stop')), jobs = new Map<string, Promise<void>>()
  const binding = createBinding({ registry, mirror: { inheritSummary: vi.fn() }, forgetSession: vi.fn(), clients: { send: vi.fn() },
    attachSession: vi.fn(async () => true), announceSession: announce, stoppedAgents: store, syncRecapPool: vi.fn(),
    input: { forget: vi.fn(), awaitingConfirmation: () => false }, submitAgent: vi.fn(), deviceInput: { forget: vi.fn() },
    homes: { copilot: directory, grok: directory, agy: directory }, capturePane: async () => null,
    openclawPaneRead: vi.fn(), openclawPaneDue: () => false, openclawStateDir: async () => null, followsLive: () => false })
  binding.whileChanging(id => jobs.has(id))
  const nativeEntered = deferred(), nativeDone = deferred(), deleted = vi.fn()
  const stop = createStopAgentService({ registry, stoppedAgents: store, restartJobs: new AgentRestartCoordinator(), stopJobs: jobs,
    backendFor: () => ({ kill: async () => ({ state: 'succeeded', dispatch: 'executed' }) }),
    agentReconciler: { suppress: vi.fn(), holdRoute: vi.fn(), releaseRoute: vi.fn(), nudge: () => {} },
    forgetSession: async (_id, options) => { await registry.confirmEngineExit(row.agentId, 'remove', options?.authority); deleted() },
    markDeleted: vi.fn(), clearDeleted: vi.fn(), stopNative: async () => { nativeEntered.resolve(); await nativeDone.promise } })
  const held = holdImage(rows => rows.some(entry => entry.agentId === row.agentId && entry.title === row.title))
  const revalidating = binding.bindObservedAgent({ engine: 'codex', processIdentity: process, cwd: directory,
    runtimes: [runtime], primaryRuntimeKey: row.primaryRuntimeKey, args: '', resumeSessionId: null } as DiscoveredTerminalAgent)
  await held.entered
  const stopping = stop(row.agentId).catch(error => error)
  await nativeEntered.promise
  held.release(); await revalidating
  const afterRevision = registry.byAgent(row.agentId)?.evidenceRevision
  nativeDone.resolve()
  expect(await stopping).toBeUndefined()
  expect(afterRevision).toBe(revision)
  expect(announce).not.toHaveBeenCalled()
  expect(deleted).toHaveBeenCalledOnce()
  expect(persisted().some(entry => entry.agentId === row.agentId)).toBe(false)
})

it('Stop keeps its reply, deletion and resume reservation pending until removal is durable', async () => {
  ;(await releaseRegistryEngine(registry, row.agentId))
  await registry.flush()
  row = registry.byAgent(row.agentId)!
  const store = new StoppedAgentStore(join(directory, 'stop-archive'))
  store.save(row); store.beginResume(row.agentId)
  const send = vi.fn(), nextDeletion = vi.fn()
  const forgetSession = createForgetSession({ registry, stoppedAgents: store, syncRecapPool: vi.fn(), normalizers: { forget: vi.fn() },
    forgetAttach: vi.fn(), turnStartedAt: new Map(), prompts: new Map(), neverFoldedHistory: new Set(), replayedFirstTurn: new Set(),
    clearAgyIdleWatch: vi.fn(), cursorDiscovery: { remove: vi.fn() }, runtimeProfiles: { forget: vi.fn() },
    watcher: { removeSession: vi.fn(async () => {}) }, stopHeartbeat: vi.fn(), input: { forget: vi.fn() }, deviceInput: { forget: vi.fn() },
    ended: vi.fn(), mirror: { forget: vi.fn() }, clients: { send, sendCommander: vi.fn() } })
  const stop = createStopAgentService({ registry, stoppedAgents: store, restartJobs: new AgentRestartCoordinator(), stopJobs: new Map(),
    backendFor: () => ({ kill: async () => ({ state: 'succeeded', dispatch: 'executed' }) }),
    agentReconciler: { suppress: vi.fn(), holdRoute: vi.fn(), releaseRoute: vi.fn(), nudge: () => {} },
    forgetSession, markDeleted: vi.fn(), clearDeleted: vi.fn(), stopNative: async () => {} })
  const held = holdImage(rows => !rows.some(entry => entry.agentId === row.agentId))
  let replied = false
  const stopping = stop(row.agentId).then(() => { replied = true; nextDeletion() })
  await held.entered
  try {
    expect(replied).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(store.resumeReservedAt(row.agentId)).not.toBeNull()
    expect(nextDeletion).not.toHaveBeenCalled()
    expect(store.get(row.agentId)).not.toBeNull()
  } finally { held.release(); await stopping }
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_deleted' }))
  expect(persisted().some(entry => entry.agentId === row.agentId)).toBe(false)
})

it.each(['prepare', 'directory sync'] as const)('Stop keeps a failed %s removal unconfirmed with its archive and reservation retained', async phase => {
  await releaseRegistryEngine(registry, row.agentId)
  await registry.flush()
  row = registry.byAgent(row.agentId)!
  const store = new StoppedAgentStore(join(directory, 'failed-stop-archive')), send = vi.fn()
  store.save(row); store.beginResume(row.agentId)
  const forgetSession = createForgetSession({ registry, stoppedAgents: store, syncRecapPool: vi.fn(), normalizers: { forget: vi.fn() },
    forgetAttach: vi.fn(), turnStartedAt: new Map(), prompts: new Map(), neverFoldedHistory: new Set(), replayedFirstTurn: new Set(),
    clearAgyIdleWatch: vi.fn(), cursorDiscovery: { remove: vi.fn() }, runtimeProfiles: { forget: vi.fn() },
    watcher: { removeSession: vi.fn(async () => {}) }, stopHeartbeat: vi.fn(), input: { forget: vi.fn() }, deviceInput: { forget: vi.fn() },
    ended: vi.fn(), mirror: { forget: vi.fn() }, clients: { send, sendCommander: vi.fn() } })
  const stop = createStopAgentService({ registry, stoppedAgents: store, restartJobs: new AgentRestartCoordinator(), stopJobs: new Map(),
    backendFor: () => ({ kill: async () => ({ state: 'succeeded', dispatch: 'executed' }) }),
    agentReconciler: { suppress: vi.fn(), holdRoute: vi.fn(), releaseRoute: vi.fn(), nudge: () => {} },
    forgetSession, markDeleted: vi.fn(), clearDeleted: vi.fn(), stopNative: async () => {} })
  if (phase === 'prepare') {
    image.match = rows => !rows.some(entry => entry.agentId === row.agentId)
    image.wait = async () => { throw Object.assign(new Error('fixture image sync failed'), { code: 'EIO' }) }
  } else image.failSync = 1
  await expect(stop(row.agentId)).rejects.toMatchObject({ code: 'STOP_UNCONFIRMED' })
  expect(registry.byAgent(row.agentId)).toBeDefined()
  expect(persisted().some(entry => entry.agentId === row.agentId)).toBe(phase === 'prepare')
  expect(store.get(row.agentId)).not.toBeNull()
  expect(store.resumeReservedAt(row.agentId)).not.toBeNull()
  expect(send).not.toHaveBeenCalled()
})

it.each((['new owner', 'adopted shell', 'archived owner', 'starting owner'] as const).flatMap(mode => [false, true].map(uncertain => [mode, uncertain] as const)))('discovery keeps %s unpublished until its ownership image is durable (uncertain=%s)', async (mode, uncertain) => {
  const store = new StoppedAgentStore(join(directory, 'discovery-archive')), send = vi.fn(), moved = vi.fn(), forgotten = vi.fn(async () => {})
  let current = row
  if (mode === 'new owner') row.sessionId = 'previous-session'
  if (mode === 'adopted shell') current = (await releaseRegistryEngine(registry, row.agentId))!
  if (mode === 'archived owner') { store.save(row); current = (await releaseRegistryEngine(registry, row.agentId, true))! }
  if (mode === 'starting owner') registry.setLaunch(row.agentId, { state: 'starting', nativeToken: startingToken })
  await registry.flush()
  const identity = mode === 'archived owner' ? oldProcess : newProcess
  vi.mocked(resolvePaneEngineProcess).mockResolvedValue(identity)
  const observed = { engine: 'claude', cwd: directory, runtimes: [runtime], primaryRuntimeKey: current.primaryRuntimeKey,
    processIdentity: identity, args: '/fixture/claude', resumeSessionId: null } as DiscoveredTerminalAgent
  const deps: DiscoveryDeps = { registry, attach: vi.fn(), taken: moved, forgetSession: forgotten,
    announceSession: announce, bindObservedAgent: vi.fn(async () => {}), syncRecapPool: vi.fn(), attachSession: async () => true,
    invalidateTerminalControl: vi.fn(), input: { forget: vi.fn() }, deviceInput: { forget: vi.fn() }, questionWatcher: { stop: vi.fn() },
    stopHeartbeat: vi.fn(), retainExitedSession: vi.fn(), stoppedAgents: store, send, restoreDegraded: () => false,
    terminals: { backendFor: () => terminal } }
  const handlers = createDiscoveryHandlers(deps)
  const failed = deferred()
  if (uncertain) { image.failSync = mode === 'starting owner' ? 2 : 1; image.afterFailure = failed.resolve }
  const held = uncertain ? null : holdImage(rows => rows.some(entry => entry.engine === 'claude' && entry.processIdentity?.pid === identity.pid
    && (mode !== 'archived owner' || entry.agentId === row.agentId) && (mode !== 'starting owner' || entry.launch?.state === 'ready')))
  const pending = (mode === 'new owner' ? handlers.onDiscovered(observed) : handlers.onObserved(observed, current)).catch(error => error)
  if (uncertain) {
    await failed.promise; await pending
    expect(announce).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(forgotten).not.toHaveBeenCalled()
    if (mode === 'archived owner') expect(store.get(row.agentId)).not.toBeNull()
    return
  }
  await held!.entered
  try {
    expect(announce).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(moved).not.toHaveBeenCalled(); expect(forgotten).not.toHaveBeenCalled()
    if (mode === 'archived owner') expect(store.get(row.agentId)).not.toBeNull()
  } finally { held!.release(); await pending }
  expect(announce).toHaveBeenCalled()
})

it.each([false, true])('discovery cleans every fully displaced owner (selected=%s)', async selected => {
  row.sessionId = 'displaced-first'
  const secondRoute = { backend: 'tmux' as const, paneId: '%72' }
  const second = (await registry.openPendingAgent({ engine: 'codex', runtimes: [secondRoute], cwd: directory }))!
  const secondLive = registry.byAgent(second.agentId)!
  secondLive.sessionId = 'displaced-second'
  secondLive.browser = true
  let selectedId: string | undefined
  if (selected) {
    const opened = (await registry.openPendingAgent({ engine: 'claude', runtimes: [destination], cwd: directory }))!
    selectedId = opened.agentId
    registry.updateProcessIdentity(opened.agentId, newProcess)
  }
  await registry.flush()
  const store = new StoppedAgentStore(join(directory, 'discovery-archive')), send = vi.fn(), moved = vi.fn()
  const forgotten = vi.fn(async (id: string, options?: { agentId?: string }) => {
    expect(persisted().some(entry => entry.agentId === options?.agentId)).toBe(false)
    send({ type: 'agent_deleted', payload: { agentId: options?.agentId, id } })
  })
  const handlers = createDiscoveryHandlers({ registry, attach: vi.fn(), taken: moved,
    forgetSession: forgotten, announceSession: announce, bindObservedAgent: vi.fn(async () => {}), syncRecapPool: vi.fn(),
    attachSession: async () => true, invalidateTerminalControl: vi.fn(), input: { forget: vi.fn() }, deviceInput: { forget: vi.fn() },
    questionWatcher: { stop: vi.fn() }, stopHeartbeat: vi.fn(), retainExitedSession: vi.fn(), stoppedAgents: store,
    send, restoreDegraded: () => false, terminals: { backendFor: () => terminal } })
  await registry.transaction(() => handlers.onDiscovered({ engine: 'claude', cwd: directory,
    runtimes: [runtime, secondRoute, ...(selected ? [destination] : [])], primaryRuntimeKey: 'tmux:%70',
    processIdentity: newProcess, args: '/fixture/claude', resumeSessionId: null } as DiscoveredTerminalAgent))
  expect(forgotten.mock.calls.map(([, options]) => options?.agentId)).toEqual([row.agentId, second.agentId])
  expect(send).toHaveBeenCalledTimes(2)
  expect(persisted().some(entry => entry.agentId === row.agentId || entry.agentId === second.agentId)).toBe(false)
  if (selected) { expect(registry.byAgent(selectedId!)?.runtimes).toHaveLength(3); expect(moved).not.toHaveBeenCalled() }
  else expect(moved).toHaveBeenCalledExactlyOnceWith(row.agentId, expect.any(Object))
})

it.each(['name', 'model'] as const)('explicit %s update waits for its durable image before acknowledgement', async choice => {
  const held = holdImage(rows => rows.some(entry => entry.launchModel?.model === 'sonnet'))
  image.names = choice === 'name'
  const reply = vi.fn(), renamed = vi.fn(), send = vi.fn()
  const update = createAgentUpdate({ registry, onRuntimeProfileUpdate: async () => {}, onAgentRename: renamed,
    closeAgentService: () => null, toProject: async s => ({ id: s.agentId, name: registry.displayName(s) }) as AgentFrame,
    clients: { send, sendCommander: vi.fn() } })
  const pending = update.agentUpdate({ agentId: row.agentId,
    ...(choice === 'name' ? { name: 'Durable choice' } : { selectedModel: 'runtime-v1:s1:claude:sonnet@high' }) }, reply)
  await held.entered
  try { expect(reply).not.toHaveBeenCalled(); expect(renamed).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled() }
  finally { held.release(); await pending }
  expect(reply).toHaveBeenCalledWith(expect.objectContaining({ agent: expect.any(Object) }))
  if (choice === 'name') expect(JSON.parse(readFileSync(join(env.ADAPTER_DATA_DIR, 'agent-names.json'), 'utf8'))[row.agentId]).toBe('Durable choice')
  else expect(persisted().find(entry => entry.agentId === row.agentId)?.launchModel).toEqual({ model: 'sonnet', effort: 'high' })
})

it.each((['name', 'model'] as const).flatMap(choice => ['owner', 'uncertain', 'queue expiry'].map(failure => [choice, failure] as const)))('explicit %s update refuses %s without a success frame', async (choice, failure) => {
  const reply = vi.fn(), renamed = vi.fn(), send = vi.fn()
  const update = createAgentUpdate({ registry, onRuntimeProfileUpdate: async () => {}, onAgentRename: renamed,
    closeAgentService: () => null, toProject: async s => ({ id: s.agentId, name: registry.displayName(s) }) as AgentFrame,
    clients: { send, sendCommander: vi.fn() } })
  const request = { agentId: row.agentId, ...(choice === 'name' ? { name: 'Unconfirmed choice' } : { selectedModel: 'runtime-v1:s1:claude:sonnet@high' }) }
  if (failure === 'queue expiry') {
    const held = holdImage(() => true)
    registry.byAgent(row.agentId)!.lastOpenedAt = Date.now()
    const blocking = registry.flush().catch(error => error)
    await held.entered
    const pending = update.agentUpdate(request, reply)
    try {
      await pending
      expect(reply).toHaveBeenCalledExactlyOnceWith({ error: 'PERSISTENCE_UNCONFIRMED' })
    } finally { held.release(); await blocking }
  } else {
    image.names = choice === 'name'
    if (failure === 'uncertain') {
      image.failSync = 1
      await update.agentUpdate(request, reply)
      expect(reply).toHaveBeenCalledExactlyOnceWith({ error: 'PERSISTENCE_UNCONFIRMED' })
    } else {
      const held = holdImage(rows => rows.some(entry => entry.launchModel?.model === 'sonnet'))
      const pending = update.agentUpdate(request, reply)
      await held.entered
      registry.byAgent(row.agentId)!.sessionId = 'replacement-session'
      held.release(); await pending
      expect(reply).toHaveBeenCalledExactlyOnceWith({ error: 'AGENT_CHANGED' })
    }
  }
  expect(send).not.toHaveBeenCalled(); expect(renamed).not.toHaveBeenCalled()
}, 15_000)

it('explicit model update keeps the owner selected before live control waits', async () => {
  const controlled = deferred(), waiting = deferred(), reply = vi.fn()
  const update = createAgentUpdate({ registry, onRuntimeProfileUpdate: async () => { waiting.resolve(); await controlled.promise },
    onAgentRename: vi.fn(), closeAgentService: () => null, toProject: async () => { throw new Error('must not format a success') },
    clients: { send: vi.fn(), sendCommander: vi.fn() } })
  const pending = update.agentUpdate({ agentId: row.agentId, selectedModel: 'runtime-v1:s1:claude:sonnet@high' }, reply)
  await waiting.promise
  registry.byAgent(row.agentId)!.sessionId = 'replacement-session'
  controlled.resolve(); await pending
  expect(reply).toHaveBeenCalledExactlyOnceWith({ error: 'AGENT_CHANGED' })
  expect(registry.byAgent(row.agentId)?.launchModel).toBeUndefined()
})

it('a prepared rename preserves a later queued deletion of the same name', async () => {
  const held = holdImage(() => false)
  image.names = true
  const renamed = registry.rename(row.agentId, 'Deleted after rename')
  await held.entered
  const deleted = registry.deleteSavedNames([row.agentId])
  held.release(); await renamed; await deleted
  expect(JSON.parse(readFileSync(join(env.ADAPTER_DATA_DIR, 'agent-names.json'), 'utf8'))).not.toHaveProperty(row.agentId)
  expect(registry.displayName(row)).not.toBe('Deleted after rename')
})

it('discovery cannot retire an engine that appeared while its exit image was prepared', async () => {
  registry.setLaunch(row.agentId, { state: 'ready' })
  await registry.flush()
  const store = new StoppedAgentStore(join(directory, 'dormant-archive')), send = vi.fn()
  const retain = createRetainExitedSession({ registry, stoppedAgents: store, send, publishStoppedAgent: async () => {}, announceSession: announce,
    invalidateTerminalControl: vi.fn(), forgetInput: vi.fn(), ended: vi.fn(), syncRecapPool: vi.fn(), warn: vi.fn() })
  const handlers = createDiscoveryHandlers({ registry, attach: vi.fn(), taken: vi.fn(),
    forgetSession: vi.fn(), announceSession: announce, bindObservedAgent: async () => {}, syncRecapPool: vi.fn(), attachSession: async () => true,
    invalidateTerminalControl: vi.fn(), input: { forget: vi.fn() }, deviceInput: { forget: vi.fn() }, questionWatcher: { stop: vi.fn() },
    stopHeartbeat: vi.fn(), retainExitedSession: retain, stoppedAgents: store, send, restoreDegraded: () => false,
    terminals: { backendFor: () => terminal } })
  vi.mocked(resolvePaneEngineProcess).mockResolvedValue(null)
  const held = holdImage(rows => rows.some(entry => entry.engine === 'terminal'))
  const pending = handlers.onDormant(structuredClone(row), 'engine exited')
  await held.entered
  vi.mocked(resolvePaneEngineProcess).mockResolvedValue(newProcess)
  held.release(); await pending
  expect(send).not.toHaveBeenCalled(); expect(announce).not.toHaveBeenCalled()
  expect(registry.byAgent(row.agentId)?.engine).toBe('claude')
})

it.each([false, true])('restore shell fallback revalidates engine absence after preparation (missing pane=%s)', async missingPane => {
  registry.setLaunch(row.agentId, { state: 'ready' })
  if (missingPane) registry.byAgent(row.agentId)!.terminalHost = true
  await registry.flush()
  let appeared = false
  const deps = restoreDeps(() => {})
  deps.livePane = async () => !missingPane
  deps.liveProcess = async () => appeared ? newProcess : null
  const held = holdImage(rows => rows.some(entry => entry.engine === 'terminal'))
  const restoring = restoreAgents(deps).catch(error => error)
  await held.entered
  appeared = true
  held.release(); await restoring
  expect(registry.byAgent(row.agentId)?.engine).toBe('claude')
  expect(releaseHold).not.toHaveBeenCalled()
})

it('restore keeps the probed process held until its publication completes', async () => {
  registry.clearProcessIdentity(row.agentId)
  registry.setLaunch(row.agentId, { state: 'starting', nativeToken: startingToken })
  await registry.flush()
  const held = holdImage(rows => rows.some(entry => entry.agentId === row.agentId && entry.processIdentity?.pid === newProcess.pid))
  const done = deferred()
  await restoreAgents(restoreDeps(done.resolve))
  await held.entered
  try { expect(releaseHold).not.toHaveBeenCalled() }
  finally { held.release(); await done.promise }
  expect(persisted().find(entry => entry.agentId === row.agentId)).toMatchObject({ processIdentity: newProcess, launch: { state: 'ready' } })
})

it('restore accepts the first native binding of the exact process its readiness probe observes', async () => {
  registry.clearProcessIdentity(row.agentId)
  registry.setLaunch(row.agentId, { state: 'starting', nativeToken: startingToken })
  await registry.flush()
  const done = deferred(), deps = restoreDeps(done.resolve)
  let hooked = false
  deps.probeProcess = async () => {
    if (hooked) return newProcess
    hooked = true
    const live = registry.byAgent(row.agentId)!
    live.sessionId = 'fixture-first-hook'; live.boundAt = Date.now(); live.processIdentity = newProcess
    await registry.flush()
    return newProcess
  }
  await restoreAgents(deps)
  await done.promise
  expect(releaseHold).toHaveBeenCalledOnce()
  expect(persisted().find(entry => entry.agentId === row.agentId)).toMatchObject({ sessionId: 'fixture-first-hook', launch: { state: 'ready' } })
})

it('restore journals the native dispatch before its backend may start the engine', async () => {
  row.sessionId = 'fixture-session'
  registry.clearProcessIdentity(row.agentId)
  registry.setLaunch(row.agentId, { state: 'held', service: 'native', detail: 'Waiting for native launch.', nativeToken: startingToken })
  await registry.flush()
  const held = holdImage(rows => rows.some(entry => entry.agentId === row.agentId && entry.launch?.state === 'starting' && entry.launch.nativeToken === replacementToken))
  const done = deferred(), deps = restoreDeps(done.resolve)
  deps.waitingPane = async () => true
  let dispatched = false
  deps.respawn = async (_runtime, _launch, control) => { await control?.onDispatch?.(); dispatched = true; return { ok: true } }
  const result = restoreAgents(deps)
  await held.entered
  try { expect(dispatched).toBe(false) }
  finally { held.release(); await result; await done.promise }
  expect(dispatched).toBe(true)
})

it.each(['none', 'during', 'after'] as const)('fresh native fallback durably releases the old binding and accepts its %s dispatch hook', async hook => {
  const freshId = '33333333-3333-4333-8333-333333333333'
  const home = join(directory, 'codex'), transcript = join(home, 'sessions', `rollout-${freshId}.jsonl`)
  mkdirSync(join(home, 'sessions'), { recursive: true })
  writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: freshId, cwd: directory, source: 'cli' } }) + '\n')
  Object.assign(row, { engine: 'codex', codexHome: home, sessionId: 'abandoned-conversation',
    transcriptPath: join(directory, 'abandoned.jsonl'), boundAt: 1, source: 'fixture', processIdentity: null,
    launch: { state: 'starting', nativeToken: startingToken } })
  await registry.flush()
  const done = deferred(), deps = restoreDeps(done.resolve)
  let dispatched = false, hooked = false, beforeDispatch: RegisteredSession | undefined
  const native = { ...newProcess, executable: '/fixture/codex' }
  const bind = async () => {
    hooked = true
    expect(await registry.register({ engine: 'codex', sessionId: freshId, transcriptPath: transcript,
      codexHome: home, cwd: directory, runtimes: [runtime], processIdentity: native })).not.toBeNull()
  }
  deps.probeProcess = async () => {
    if (!dispatched) return null
    if (hook === 'after' && !hooked) await bind()
    return native
  }
  deps.paneState = async () => ({ dead: !dispatched, engineExit: dispatched ? null : 1 })
  deps.respawn = async (_runtime, _launch, control) => {
    await control?.onDispatch?.()
    beforeDispatch = persisted().find(entry => entry.agentId === row.agentId)
    dispatched = true
    if (hook === 'during') await bind()
    return { ok: true }
  }
  await restoreAgents(deps); await done.promise
  expect(dispatched).toBe(true)
  expect(beforeDispatch).toMatchObject({ sessionId: '', transcriptPath: null, boundAt: null, source: null })
  expect(releaseHold).toHaveBeenCalledOnce()
  expect(persisted().find(entry => entry.agentId === row.agentId)).toMatchObject({
    sessionId: hook === 'none' ? '' : freshId, processIdentity: native, launch: { state: 'ready' },
  })
})

it.each(['unbind', 'journal'] as const)('fresh fallback retains the terminal when its %s publication is unconfirmed', async phase => {
  Object.assign(row, { sessionId: 'abandoned-conversation', transcriptPath: join(directory, 'abandoned.jsonl'),
    processIdentity: null, boundAt: 1, launch: { state: 'starting', nativeToken: startingToken } })
  await registry.flush()
  const held = holdImage(rows => rows.some(entry => entry.agentId === row.agentId && !entry.sessionId
    && (phase === 'unbind' || entry.launch?.state === 'starting' && entry.launch.nativeToken === replacementToken)))
  const done = deferred(), deps = restoreDeps(done.resolve)
  let dispatched = false
  deps.probeProcess = async () => null
  deps.paneState = async () => ({ dead: true, engineExit: 1 })
  deps.respawn = async (_runtime, _launch, control) => { await control?.onDispatch?.(); dispatched = true; return { ok: true } }
  await restoreAgents(deps); await held.entered
  expect(dispatched).toBe(false)
  expect(registry.byAgent(row.agentId)?.sessionId).toBe(phase === 'unbind' ? 'abandoned-conversation' : '')
  image.renamed = false; image.failSync = 1
  held.release(); await done.promise
  expect(dispatched).toBe(false)
  expect(releaseHold).not.toHaveBeenCalled()
  expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('registry publication unavailable'))
})

it('fresh fallback refuses a replacement binding during prepared readiness', async () => {
  Object.assign(row, { sessionId: 'abandoned-conversation', processIdentity: null,
    launch: { state: 'starting', nativeToken: startingToken } })
  await registry.flush()
  const held = holdImage(rows => rows.some(entry => entry.agentId === row.agentId && entry.launch?.state === 'ready'))
  const done = deferred(), deps = restoreDeps(done.resolve)
  let dispatched = false
  deps.probeProcess = async () => dispatched ? newProcess : null
  deps.paneState = async () => ({ dead: !dispatched, engineExit: dispatched ? null : 1 })
  deps.respawn = async (_runtime, _launch, control) => { await control?.onDispatch?.(); dispatched = true; return { ok: true } }
  await restoreAgents(deps); await held.entered
  registry.byAgent(row.agentId)!.sessionId = 'replacement-conversation'
  held.release(); await done.promise
  expect(releaseHold).not.toHaveBeenCalled()
  expect(registry.byAgent(row.agentId)?.sessionId).toBe('replacement-conversation')
})

it('restore publishes a recreated terminal before releasing its shell', async () => {
  ;(await releaseRegistryEngine(registry, row.agentId))
  await registry.flush()
  const held = holdImage(rows => rows.some(entry => entry.agentId === row.agentId && entry.engine === 'terminal' && entry.launch?.state === 'ready'))
  const deps = restoreDeps(() => {})
  deps.livePane = async () => false
  const result = restoreAgents(deps)
  await held.entered
  try { expect(releaseHold).not.toHaveBeenCalled() }
  finally { held.release(); await result }
  expect(await result).toMatchObject({ restored: [row.agentId] })
})

it('restore publishes an exited adopted engine as a shell before releasing its fallback', async () => {
  row.sessionId = 'fixture-session'; row.terminalHost = true
  registry.clearProcessIdentity(row.agentId)
  registry.setLaunch(row.agentId, { state: 'starting', nativeToken: startingToken })
  await registry.flush()
  const held = holdImage(rows => rows.some(entry => entry.agentId === row.agentId && entry.engine === 'terminal'))
  const done = deferred(), deps = restoreDeps(done.resolve)
  deps.probeProcess = async () => null
  paneState.mockResolvedValue({ dead: false, engineExit: 1 })
  deps.respawn = async () => { paneState.mockResolvedValue({ dead: false, engineExit: null }); return { ok: true } }
  await restoreAgents(deps)
  await held.entered
  try { expect(releaseHold).not.toHaveBeenCalled() }
  finally { held.release(); await done.promise }
  expect(persisted().find(entry => entry.agentId === row.agentId)).toMatchObject({ engine: 'terminal', launch: { state: 'ready' } })
})
