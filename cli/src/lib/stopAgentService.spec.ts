import { removeRegistryAgent } from '../testing/registryFixtures.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { captureResumeIdentity } from './captureResumeIdentity.js'
import { createStopAgentService, type StopAgentServiceDeps } from './stopAgentService.js'
import { CloseAgentService } from './closeAgentService.js'
import { createOtherStreams } from '../core/engines/otherStreams.js'
import { OTHER_ENGINE_STATES } from '../engines/otherEngines.js'
import { STREAM_OPEN, STREAM_OP, STREAMS_WAIT, STREAM_VERSION } from '../engines/worker/otherStreamProtocol.js'
import { registry, type RegisteredSession } from './registry.js'
import { setAgentSignaller } from './processSignals.js'
import { stoppedAgents } from './stoppedAgents.js'
import { AgentRestartCoordinator } from './restartAgent.js'
import { checkPidRuntime, terminateDeletedAgent } from './deleteAgentFallback.js'
import { createForgetSession } from '../core/agents/forget.js'
import { env } from '../config/env.js'
import { controlTranscriptEvidence } from '../engines/transcriptBindings.js'
import { IdentityReadUnavailable, ObservedConversationUnavailable } from '../engines/kit/identityScan.js'
vi.mock('./databaseCheckpoint.js', () => ({ databaseCheckpointEvidence: vi.fn(async () => undefined) }))
vi.mock('./captureResumeIdentity.js', () => ({ captureResumeIdentity: vi.fn(async session => session) }))
vi.mock('../engines/transcriptBindings.js', async original => ({ ...await original<object>(),
  controlTranscriptEvidence: vi.fn(),
}))
vi.mock('./deleteAgentFallback.js', () => ({ checkPidRuntime: vi.fn(), terminateDeletedAgent: vi.fn() }))
vi.mock('../core/engines/cursorTasks.js', () => ({ removePendingCursorTasks: vi.fn(async () => {}) }))
let row: RegisteredSession
let deps: StopAgentServiceDeps
// The tmux pane's backend; a pty host's is only there when a case adds it (`withPtyHost`).
const tmuxKill = vi.fn<NonNullable<ReturnType<StopAgentServiceDeps['backendFor']>>['kill']>()
const ptyKill = vi.fn<NonNullable<ReturnType<StopAgentServiceDeps['backendFor']>>['kill']>()
const withPtyHost = () => { deps.backendFor = runtime => ({ kill: runtime.backend === 'tmux' ? tmuxKill : ptyKill }) }
const pty = { backend: 'ptyhost' as const, instance: 'p1', paneId: '%1' }
beforeEach(async () => {
  vi.clearAllMocks()
  vi.mocked(controlTranscriptEvidence).mockReset().mockImplementation((_engine, _id, path) => ({ path, verify: vi.fn() }))
  vi.mocked(captureResumeIdentity).mockReset().mockImplementation(async session => session)
  row = (await registry.openPendingAgent({ engine: 'codex', runtimes: [{ backend: 'tmux', paneId: '%44' }], cwd: '/tmp' }))!
  row = registry.byAgent(row.agentId)!
  Object.assign(row, { sessionId: 'saved', processIdentity: { pid: 77, executable: 'codex', startMarker: 'fixture' } })
  deps = { registry, stoppedAgents, restartJobs: new AgentRestartCoordinator(), stopJobs: new Map(),
    backendFor: runtime => runtime.backend === 'tmux' ? { kill: tmuxKill } : undefined,
    agentReconciler: { suppress: vi.fn(), holdRoute: vi.fn(), releaseRoute: vi.fn(), trigger: vi.fn(async () => {}) },
    forgetSession: vi.fn(async (id, options) => { await registry.confirmEngineExit(id, 'remove', options.authority) }), markDeleted: vi.fn(), clearDeleted: vi.fn(),
    stopNative: vi.fn(async () => {}),
  }
  vi.mocked(checkPidRuntime).mockReset().mockResolvedValue({ state: 'gone', reason: 'fixture' })
  vi.mocked(terminateDeletedAgent).mockResolvedValue('gone')
  tmuxKill.mockReset().mockResolvedValue({ state: 'succeeded', dispatch: 'executed' })
  ptyKill.mockReset().mockResolvedValue({ state: 'succeeded', dispatch: 'executed' })
})
afterEach(async () => { vi.restoreAllMocks(); for (const entry of registry.list()) (await removeRegistryAgent(registry, entry.agentId)); await registry.flush() })

it('saves history before removing the runtime, joins concurrent stops, and clears confirmed reservations', async () => {
  const token = stoppedAgents.beginResume(row.agentId); expect(token).toBeTruthy()
  const original = row.agentId
  vi.mocked(deps.forgetSession).mockImplementation(async (id, options) => { expect(stoppedAgents.get(id)?.sessionId).toBe('saved'); await registry.confirmEngineExit(id, 'remove', options.authority) })
  const stop = createStopAgentService(deps); const one = stop(original); expect(stop(original)).toBe(one); await one
  expect(stoppedAgents.get(original)).toMatchObject({ active: false, sessionId: 'saved' })
  expect(registry.byAgent(original)).toBeUndefined(); expect(deps.stopJobs.size).toBe(0)
  expect(stoppedAgents.beginResume(original)).not.toBeNull(); expect(deps.agentReconciler.suppress).toHaveBeenCalledWith(row)
})
it('saves a captured Hermes home with its own mark, never the live row\'s', async () => {
  Object.assign(row, { engine: 'hermes', hermesHome: '/sandbox/agent/.hermes', hermesHomeDerived: true,
    processIdentity: { pid: 77, executable: 'hermes', startMarker: 'fixture' } })
  vi.mocked(captureResumeIdentity).mockImplementation(async ({ hermesHomeDerived: _mark, ...session }) => ({ ...session,
    hermesHome: '/home/u/.hermes/profiles/work', source: 'stop-repair' }))
  await createStopAgentService(deps)(row.agentId)
  const saved = stoppedAgents.get(row.agentId)
  expect(saved?.hermesHome).toBe('/home/u/.hermes/profiles/work')
  expect(saved?.hermesHomeDerived).toBeUndefined()
})
it('missing identities are harmless and never allocate or signal anything', async () => {
  await createStopAgentService(deps)('missing'); expect(deps.forgetSession).not.toHaveBeenCalled(); expect(terminateDeletedAgent).not.toHaveBeenCalled()
})
it.each(['forget', 'checkpoint'] as const)('retains a captured Pi resume path through a pathless %s save', async stage => {
  Object.assign(row, { engine: 'pi', transcriptPath: null,
    processIdentity: { pid: 77, executable: 'pi', startMarker: 'fixture' } })
  vi.mocked(captureResumeIdentity).mockImplementation(async session => ({ ...session,
    transcriptPath: '/fixture/native.jsonl', source: 'stop-repair' }))
  deps.forgetSession = createForgetSession({
    registry, stoppedAgents, syncRecapPool: vi.fn(), normalizers: { forget: vi.fn() },
    forgetAttach: vi.fn(), turnStartedAt: new Map(), prompts: new Map(), neverFoldedHistory: new Set(), replayedFirstTurn: new Set(),
    clearAgyIdleWatch: vi.fn(), cursorDiscovery: { remove: vi.fn() },
    runtimeProfiles: { forget: vi.fn() }, watcher: { removeSession: vi.fn(async () => {}) },
    stopHeartbeat: vi.fn(), input: { forget: vi.fn() },
    ended: vi.fn(), mirror: { forget: vi.fn() }, clients: { send: vi.fn(), sendCommander: vi.fn() },
  })
  await createStopAgentService(deps)(row.agentId, { checkpoint: async (_session, phase) => {
    if (stage === 'checkpoint' && phase === 'before') {
      // A hook can save the same live row while Close awaits its checkpoint, before tombstones exist.
      expect(row.transcriptPath).toBeNull()
      stoppedAgents.save({ ...row, title: 'Hook arrived' })
      expect(stoppedAgents.get(row.agentId)?.transcriptPath).toBe('/fixture/native.jsonl')
    }
  } })
  expect(registry.byAgent(row.agentId)).toBeUndefined()
  expect(stoppedAgents.get(row.agentId)).toMatchObject({ sessionId: row.sessionId,
    transcriptPath: '/fixture/native.jsonl', active: false })
})
it('cancels immediately, then joins the core pane commit before capturing the runtime to stop', async () => {
  let committed!: () => void
  deps.settlePane = vi.fn(() => new Promise<void>(done => { committed = done }))
  const stopping = createStopAgentService(deps)(row.agentId)
  expect(deps.stopJobs.has(row.agentId)).toBe(true)
  await vi.waitFor(() => expect(deps.settlePane).toHaveBeenCalledWith(row.agentId))
  expect(captureResumeIdentity).not.toHaveBeenCalled()
  row.runtimes = [{ backend: 'tmux', paneId: '%90' }]
  committed()
  await stopping
  expect(tmuxKill).toHaveBeenCalledWith({ backend: 'tmux', paneId: '%90' }, expect.any(Function))
})
it('storage failure leaves the live process and registry untouched', async () => {
  vi.spyOn(stoppedAgents, 'save').mockImplementation(() => { throw new Error('disk full') })
  await expect(createStopAgentService(deps)(row.agentId)).rejects.toThrow('disk full')
  expect(registry.byAgent(row.agentId)).toBe(row); expect(tmuxKill).not.toHaveBeenCalled(); expect(deps.markDeleted).not.toHaveBeenCalled()
})
it.each(['process alive', 'storage', 'row retained'] as const)('keeps Stop unconfirmed when final retirement finds %s', async failure => {
  const token = stoppedAgents.beginResume(row.agentId)
  expect(token).toBeTruthy()
  const forget = vi.mocked(deps.forgetSession).getMockImplementation()!
  vi.mocked(deps.forgetSession).mockImplementationOnce(async (id, options) => {
    expect(options.authority?.current?.()).toBe(true)
    if (failure === 'row retained') return
    if (failure === 'process alive') vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'alive' })
    if (failure === 'storage') throw new Error('retirement storage unavailable')
    await forget(id, options)
  })
  await expect(createStopAgentService(deps)(row.agentId)).rejects.toMatchObject({ code: 'STOP_UNCONFIRMED' })
  expect(registry.byAgent(row.agentId)).toBe(row)
  expect(stoppedAgents.get(row.agentId)?.sessionId).toBe('saved')
  expect(stoppedAgents.resumeReservedAt(row.agentId)).not.toBeNull()
})
it('preserves an unexpected evidence failure without signalling or hiding its cause', async () => {
  row.transcriptPath = '/fixture/history.jsonl'
  vi.mocked(controlTranscriptEvidence).mockReturnValue({ path: row.transcriptPath,
    verify: () => { throw new Error('Evidence implementation unavailable') } })
  await expect(createStopAgentService(deps)(row.agentId)).rejects.toThrow('Evidence implementation unavailable')
  expect(terminateDeletedAgent).not.toHaveBeenCalled()
  expect(deps.forgetSession).not.toHaveBeenCalled()
})
// A guest's harness runs as the guest's own OS user: the owner's daemon can neither read its process's descriptors
// (the native control probe) nor signal it (EPERM). Measured on a Mac sharing with a guest, 2026-10-22: closing the
// owner's tmux pane ended the guest's process.
it('stops a guest harness by closing its pane, without the native probe or a signal, once its process has left', async () => {
  Object.assign(row, { guest: 'kim@example.com' })
  vi.mocked(captureResumeIdentity).mockRejectedValue(new IdentityReadUnavailable('the native control probe did not complete'))
  vi.mocked(checkPidRuntime).mockResolvedValueOnce({ state: 'alive' }).mockResolvedValue({ state: 'gone', reason: 'saved process identity is no longer running' })
  deps.wait = vi.fn(async () => {})
  await createStopAgentService(deps)(row.agentId)
  expect(captureResumeIdentity).not.toHaveBeenCalled()
  expect(deps.stopNative).not.toHaveBeenCalled()
  expect(terminateDeletedAgent).not.toHaveBeenCalled()
  expect(tmuxKill).toHaveBeenCalledOnce()
  // Guest exit is checked before retirement and again after the durable image is prepared.
  expect(checkPidRuntime).toHaveBeenCalledTimes(3)
  expect(stoppedAgents.get(row.agentId)).toMatchObject({ active: false, sessionId: 'saved' })
  expect(registry.byAgent(row.agentId)).toBeUndefined()
})
it('keeps a guest harness whose process is still running after its pane closed', async () => {
  Object.assign(row, { guest: 'kim@example.com' })
  vi.mocked(checkPidRuntime).mockResolvedValue({ state: 'alive' })
  deps.wait = vi.fn(async () => {})
  await expect(createStopAgentService(deps)(row.agentId)).rejects.toThrow('Could not confirm that the harness stopped')
  expect(tmuxKill).toHaveBeenCalledOnce()
  expect(deps.forgetSession).not.toHaveBeenCalled()
  expect(registry.byAgent(row.agentId)).toBe(row)
})

it('waits through the bounded default guest-exit interval before publishing Stop', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    Object.assign(row, { guest: 'guest@example.test' })
    let first!: () => void
    const checked = new Promise<void>(resolve => { first = resolve })
    vi.mocked(checkPidRuntime).mockImplementationOnce(async () => { first(); return { state: 'alive' } })
    const stopping = createStopAgentService(deps)(row.agentId)
    await checked
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.forgetSession).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)
    await stopping
    expect(registry.byAgent(row.agentId)).toBeUndefined()
    expect(checkPidRuntime).toHaveBeenCalledTimes(3)
  } finally { vi.useRealTimers() }
})
it('checks the saved guest process after its pane removes the registry row, without claiming the changed stop completed', async () => {
  Object.assign(row, { guest: 'kim@example.com' })
  const identity = { ...row.processIdentity! }
  deps.wait = vi.fn(async () => {})
  tmuxKill.mockImplementationOnce(async () => {
    ;(await removeRegistryAgent(registry, row.agentId))
    return { state: 'succeeded', dispatch: 'executed' }
  })
  vi.mocked(checkPidRuntime).mockResolvedValueOnce({ state: 'alive' })
    .mockResolvedValue({ state: 'gone', reason: 'guest exited after its pane closed' })
  await expect(createStopAgentService(deps)(row.agentId)).rejects.toThrow('The harness changed while pausing')
  expect(deps.wait).toHaveBeenCalledExactlyOnceWith(250)
  expect(checkPidRuntime).toHaveBeenCalledTimes(2)
  for (const [session] of vi.mocked(checkPidRuntime).mock.calls) expect(session.processIdentity).toEqual(identity)
  expect(deps.forgetSession).not.toHaveBeenCalled()
  expect(terminateDeletedAgent).not.toHaveBeenCalled()
  expect(stoppedAgents.get(row.agentId)?.sessionId).toBe('saved')
})
it('waits for the process a starting guest harness gained while it was saved', async () => {
  // Stopped before its engine was seen, which the pane's watcher binds while the screen is saved: an older copy of the
  // row has no process, which reads as gone at once.
  Object.assign(row, { guest: 'kim@example.com', processIdentity: undefined })
  const engine = { pid: 91, executable: 'claude', startMarker: 'guest' }
  vi.mocked(checkPidRuntime).mockImplementation(async s => s.processIdentity ? { state: 'alive' } : { state: 'gone', reason: 'none' })
  deps.wait = vi.fn(async () => {})
  await expect(createStopAgentService(deps)(row.agentId, { checkpoint: async (_s, phase) => {
    if (phase === 'before') row.processIdentity = engine
  } })).rejects.toThrow('Could not confirm that the harness stopped')
  expect(vi.mocked(checkPidRuntime).mock.calls.every(([s]) => s.processIdentity?.pid === 91)).toBe(true)
  expect(registry.byAgent(row.agentId)).toBe(row)
})
// A close of a harness still starting that waited in vain for its first conversation (closeAgentService.ts).
it('stops a harness that never bound a conversation without one, only when its close asks', async () => {
  Object.assign(row, { sessionId: '', transcriptPath: null, boundAt: null })
  vi.mocked(captureResumeIdentity).mockRejectedValue(new IdentityReadUnavailable('the native control descriptor type is unavailable'))
  await expect(createStopAgentService(deps)(row.agentId)).rejects.toThrow('descriptor type is unavailable')
  expect(registry.byAgent(row.agentId)).toBe(row)
  const unkept = vi.fn()
  await createStopAgentService(deps)(row.agentId, { withoutConversation: unkept })
  expect(unkept).toHaveBeenCalledOnce()
  expect(stoppedAgents.get(row.agentId)).toMatchObject({ active: false, sessionId: '' })
  expect(registry.byAgent(row.agentId)).toBeUndefined()
})
it.each(['a bound conversation', 'a known transcript', 'a bind time', 'a conversation seen live', 'another failure'] as const)('never lets go of %s that cannot be read', async kind => {
  Object.assign(row, { sessionId: kind === 'a bound conversation' ? 'saved' : '', transcriptPath: kind === 'a known transcript' ? '/fixture/t.jsonl' : null,
    boundAt: kind === 'a bind time' ? 1 : null })
  vi.mocked(captureResumeIdentity).mockRejectedValue(kind === 'another failure' ? new Error('disk gone')
    : kind === 'a conversation seen live' ? new ObservedConversationUnavailable('Conversation identity is held: the observed conversation file is unavailable.')
    : new IdentityReadUnavailable('the transcript is unreadable'))
  const unkept = vi.fn()
  await expect(createStopAgentService(deps)(row.agentId, { withoutConversation: unkept })).rejects.toThrow()
  expect(unkept).not.toHaveBeenCalled()
  expect(registry.byAgent(row.agentId)).toBe(row)
})
it.each(['before', 'after'] as const)('honors cancellation at the %s checkpoint before retiring the terminal', async phase => {
  let current = true
  await expect(createStopAgentService(deps)(row.agentId, {
    current: () => current,
    checkpoint: async (_, at) => { if (at === phase) current = false },
  })).rejects.toThrow('changed')
  expect(tmuxKill).not.toHaveBeenCalled()
  expect(deps.forgetSession).not.toHaveBeenCalled()
  if (phase === 'before') expect(terminateDeletedAgent).not.toHaveBeenCalled()
})
it('backs up final flushed history after graceful exit and before closing the pane', async () => {
  const order: string[] = []
  vi.mocked(terminateDeletedAgent).mockImplementation(async () => { order.push('exit'); return 'terminated' })
  tmuxKill.mockImplementation(async () => { order.push('pane'); return { state: 'succeeded', dispatch: 'executed' } })
  await createStopAgentService(deps)(row.agentId, { checkpoint: async (_, phase) => { order.push(phase) } })
  expect(order).toEqual(['before', 'exit', 'after', 'pane'])
})
it.each(['terminal', 'without tmux', 'failed process', 'failed tmux'] as const)('retains work when stopping %s', async mode => {
  stoppedAgents.beginResume(row.agentId)
  if (mode === 'terminal') Object.assign(row, { engine: 'terminal', sessionId: '', processIdentity: null })
  if (mode === 'without tmux') { deps.backendFor = () => undefined; Object.assign(row, { runtimes: [{ backend: 'ptyhost', instance: 'p1', paneId: '%1' }], tmuxPane: '%1', primaryRuntimeKey: 'ptyhost\u0000p1\u0000%1' }) }
  if (mode === 'failed process') vi.mocked(terminateDeletedAgent).mockResolvedValue('failed')
  if (mode === 'failed tmux') tmuxKill.mockResolvedValue({ state: 'unknown', dispatch: 'possibly_executed', reason: 'fixture' })
  const stopping = createStopAgentService(deps)(row.agentId)
  if (mode === 'failed process' || mode === 'failed tmux') {
    await expect(stopping).rejects.toThrow('Could not confirm')
    expect(registry.byAgent(row.agentId)).toBe(row)
    expect(deps.forgetSession).not.toHaveBeenCalled()
    expect(deps.agentReconciler.suppress).not.toHaveBeenCalled()
  } else await stopping
  expect(stoppedAgents.get(row.agentId)).not.toBeNull(); expect(deps.agentReconciler.trigger).toHaveBeenCalledOnce()
  expect(stoppedAgents.beginResume(row.agentId) === null).toBe(mode === 'failed process' || mode === 'failed tmux')
})

it('does not publish a stopped row until the exact process and terminal have both stopped', async () => {
  let finishProcess!: () => void
  let finishPane!: () => void
  vi.mocked(terminateDeletedAgent).mockImplementation(() => new Promise(resolve => { finishProcess = () => resolve('terminated') }))
  tmuxKill.mockImplementation(() => new Promise(resolve => { finishPane = () => resolve({ state: 'succeeded', dispatch: 'executed' }) }))
  const stop = createStopAgentService(deps)
  const stopping = stop(row.agentId)
  await vi.waitFor(() => expect(finishProcess).toBeTypeOf('function'))
  expect(registry.byAgent(row.agentId)).toBe(row)
  expect(deps.forgetSession).not.toHaveBeenCalled()
  expect(tmuxKill).not.toHaveBeenCalled()
  finishProcess()
  await vi.waitFor(() => expect(finishPane).toBeTypeOf('function'))
  expect(deps.forgetSession).not.toHaveBeenCalled()
  expect(stop(row.agentId)).toBe(stopping)
  finishPane()
  await stopping
  expect(deps.forgetSession).toHaveBeenCalledOnce()
  expect(deps.agentReconciler.holdRoute).toHaveBeenCalledOnce()
  expect(deps.agentReconciler.releaseRoute).toHaveBeenCalledOnce()
})

it.each(['process', 'pane'] as const)('a rejected %s check retains history, releases its route and permits a safe retry', async side => {
  if (side === 'process') vi.mocked(terminateDeletedAgent).mockRejectedValueOnce(new Error('probe failed'))
  else tmuxKill.mockRejectedValueOnce(new Error('transport failed'))
  const stop = createStopAgentService(deps)
  await expect(stop(row.agentId)).rejects.toThrow('Could not confirm')
  expect(deps.stopJobs.size).toBe(0)
  expect(registry.byAgent(row.agentId)).toBe(row)
  expect(deps.agentReconciler.releaseRoute).toHaveBeenCalledOnce()
  expect(deps.clearDeleted).toHaveBeenCalledWith(row.agentId)
  await stop(row.agentId)
  expect(registry.byAgent(row.agentId)).toBeUndefined()
})

it.each(['no backend', 'no tmux route'] as const)('cannot confirm stopping a shell with %s', async mode => {
  row.engine = 'terminal'
  if (mode === 'no backend') deps.backendFor = () => undefined
  else row.runtimes = [{ backend: 'ptyhost', instance: 'p1', paneId: '%1' }]
  await expect(createStopAgentService(deps)(row.agentId)).rejects.toThrow('Could not confirm')
  expect(deps.forgetSession).not.toHaveBeenCalled()
})

// A pty host pane is closed by its own backend, as a tmux pane is by tmux: the host's kill ends the pane's whole
// process group (a Job object on Windows), which is what leaves nothing of the stopped harness running.
it.each(['codex', 'terminal'] as const)('stops a pty host %s through its own backend, never asking tmux', async engine => {
  withPtyHost()
  Object.assign(row, { runtimes: [pty], tmuxPane: '%1', primaryRuntimeKey: 'ptyhost\u0000p1\u0000%1',
    ...(engine === 'terminal' ? { engine, sessionId: '', processIdentity: null } : {}) })
  await createStopAgentService(deps)(row.agentId)
  expect(ptyKill).toHaveBeenCalledExactlyOnceWith(pty, expect.any(Function))
  expect(tmuxKill).not.toHaveBeenCalled()
  expect(registry.byAgent(row.agentId)).toBeUndefined()
  expect(stoppedAgents.get(row.agentId)).toMatchObject({ active: false })
})
it('closes each pane of a mixed row on its own backend, the tmux one as before', async () => {
  withPtyHost()
  const tmux = { backend: 'tmux' as const, paneId: '%44' }
  row.runtimes = [pty, tmux]
  await createStopAgentService(deps)(row.agentId)
  expect(tmuxKill).toHaveBeenCalledExactlyOnceWith(tmux, expect.any(Function))
  expect(ptyKill).toHaveBeenCalledExactlyOnceWith(pty, expect.any(Function))
  expect(registry.byAgent(row.agentId)).toBeUndefined()
})
it.each(['failed', 'changed'] as const)('keeps a pty host harness whose pane close %s', async mode => {
  withPtyHost()
  row.runtimes = [pty]
  ptyKill.mockImplementation(async (_runtime, current) => {
    if (mode === 'changed') row.sessionId = 'different-conversation'
    // The original Close permission travels to the host's kill, as it does to tmux's.
    return current?.() === false ? { state: 'failed', dispatch: 'not_started', reason: 'changed' } : { state: 'unknown', dispatch: 'possibly_executed', reason: 'fixture' }
  })
  await expect(createStopAgentService(deps)(row.agentId)).rejects.toThrow('Could not confirm')
  expect(registry.byAgent(row.agentId)).toBe(row)
  expect(deps.forgetSession).not.toHaveBeenCalled()
})

it('holds a conversation whose evidence fails at the pane close, as at every earlier boundary', async () => {
  row.transcriptPath = '/fixture/history.jsonl'
  let closing = false
  vi.mocked(controlTranscriptEvidence).mockReturnValue({ path: row.transcriptPath, verify: () => {
    if (closing) throw new IdentityReadUnavailable('the transcript changed while closing')
  } })
  tmuxKill.mockImplementation(async (_runtime, current) => { closing = true; current?.(); return { state: 'succeeded', dispatch: 'executed' } })
  await expect(createStopAgentService(deps)(row.agentId)).rejects.toBeInstanceOf(IdentityReadUnavailable)
  expect(registry.byAgent(row.agentId)).toBe(row)
  expect(deps.forgetSession).not.toHaveBeenCalled()
})
it.each(['removed', 'replaced', 'conversation', 'route', 'native hold'] as const)('does not remove a target %s during termination', async mode => {
  vi.mocked(terminateDeletedAgent).mockImplementation(async () => {
    if (mode === 'removed') (await removeRegistryAgent(registry, row.agentId))
    else if (mode === 'conversation') row.sessionId = 'different-conversation'
    else if (mode === 'route') row.runtimes = [{ backend: 'tmux', paneId: '%88' }]
    else if (mode === 'native hold') registry.setIdentityHold(row.agentId, 'The native process evidence changed.')
    else row.processIdentity = { ...row.processIdentity!, pid: 88 }
    return 'terminated'
  })
  await expect(createStopAgentService(deps)(row.agentId)).rejects.toThrow('changed while pausing')
  expect(tmuxKill).not.toHaveBeenCalled()
  expect(deps.forgetSession).not.toHaveBeenCalled()
})
it('completes Close when the lost live reader recovers while the original process exits', async () => {
  vi.useFakeTimers()
  Object.assign(row, { engine: 'hermes', processIdentity: { pid: 77, executable: 'hermes', startMarker: 'fixture' } })
  const target = () => JSON.stringify([row.agentId, row.sessionId, row.engine, row.registeredAt, row.boundAt,
    row.transcriptPath, row.cwd, row.hermesHome, row.processIdentity, row.runtimes])
  const original = target()
  let token = '', answerWait: ((answer: Record<string, unknown>) => void) | undefined
  const readerDeps = {
    call: async (type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (type === STREAM_OPEN) {
        token = payload.token as string
        return { version: STREAM_VERSION, answer: { turn: { identity: 'turn', turnOpen: false },
          historyTurnOpen: false, lastStarted: null, lastEnded: null, initial: [], lines: 0,
          evidence: [], abandoned: false, frames: [] } }
      }
      if (type === STREAM_OP) return { version: STREAM_VERSION, answer: {} }
      expect(type).toBe(STREAMS_WAIT)
      return new Promise(resolve => { answerWait = resolve })
    },
    bySession: (id: string) => {
      const current = registry.byAgent(row.agentId)
      return current?.sessionId === id ? current : undefined
    },
    frame: vi.fn(), reattach: vi.fn(), log: vi.fn(), retryMs: 10,
    // The lifecycle already owns this promise; discovery observes the same reservation in main.ts.
    stopping: (session: RegisteredSession) => deps.stopJobs.get(session.agentId),
    held: (session: RegisteredSession, held: boolean, rewritten?: boolean | 'lost') => {
      const latest = registry.byAgent(session.agentId)
      const reasons: readonly string[] = Object.values(OTHER_ENGINE_STATES)
      if (!latest || latest.sessionId !== session.sessionId || (latest.identityHold && !reasons.includes(latest.identityHold))) return
      registry.setIdentityHold(session.agentId, held
        ? rewritten === 'lost' ? OTHER_ENGINE_STATES.lost : rewritten ? OTHER_ENGINE_STATES.rewritten : OTHER_ENGINE_STATES.unavailable
        : undefined)
    },
  }
  const streams = createOtherStreams(readerDeps)
  const checkpoint = vi.fn(async () => {})
  const close = new CloseAgentService({ registry, activity: async () => 'idle', checkpoint,
    changed: vi.fn(), stop: createStopAgentService(deps) })
  const signal = vi.fn()
  setAgentSignaller(signal)
  try {
    await streams.open(row, { live: false, abandon: false, held: false, store: '/fixture/history.db' })
    expect(answerWait).toBeDefined()
    answerWait!({ version: STREAM_VERSION, answer: { pages: [], lost: [token] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(row.identityHold).toBe(OTHER_ENGINE_STATES.lost)
    const beforeRevision = row.evidenceRevision
    let duringRecovery: { revision?: number; held: boolean } | undefined
    vi.mocked(terminateDeletedAgent).mockImplementation(async (session, actions) => {
      actions.kill(session.processIdentity!.pid, 'SIGTERM')
      await vi.advanceTimersByTimeAsync(10)
      duringRecovery = { revision: row.evidenceRevision, held: !!row.identityHold }
      expect(target()).toBe(original)
      return 'terminated'
    })
    vi.mocked(deps.forgetSession).mockImplementation(async (id, options) => {
      await registry.confirmEngineExit(id, 'remove', options.authority)
      streams.forget(row.sessionId)
    })
    const result = await close.request({ agentId: row.agentId, sessionId: row.sessionId,
      createdAt: new Date(row.registeredAt).toISOString(), mode: 'now' })
    expect(signal).toHaveBeenCalledExactlyOnceWith(77, 'SIGTERM')
    expect(result, JSON.stringify({ beforeRevision, duringRecovery, targetUnchanged: target() === original })).toEqual({ closed: true })
    expect(checkpoint.mock.calls.map((call: unknown[]) => call[1])).toEqual(['before', 'after'])
    expect(tmuxKill).toHaveBeenCalledOnce()
    expect(registry.byAgent(row.agentId)).toBeUndefined()
  } finally {
    close.dispose(); streams.stop(); setAgentSignaller(null); vi.useRealTimers()
  }
})
it.each(['capture', 'termination'] as const)('stops an agent still starting when its engine is identified during %s', async stage => {
  // Created, not yet bound to a process: the stop's snapshot has none.
  row.processIdentity = null
  const launched = { pid: 91, executable: 'codex', startMarker: 'launched' }
  if (stage === 'capture') vi.mocked(captureResumeIdentity).mockImplementation(async session => { row.processIdentity = launched; return session })
  else vi.mocked(terminateDeletedAgent).mockImplementation(async () => { row.processIdentity = launched; return 'terminated' })
  await createStopAgentService(deps)(row.agentId)
  expect(registry.byAgent(row.agentId)).toBeUndefined()
  expect(tmuxKill).toHaveBeenCalledOnce()
  // Identified before termination: that exact process is the one checked and signalled.
  if (stage === 'capture') expect(vi.mocked(terminateDeletedAgent).mock.calls[0][0].processIdentity).toEqual(launched)
})
it('still refuses a starting agent whose pane or conversation changed under the stop', async () => {
  row.processIdentity = null
  vi.mocked(terminateDeletedAgent).mockImplementation(async () => { row.runtimes = [{ backend: 'tmux', paneId: '%89' }]; return 'gone' })
  await expect(createStopAgentService(deps)(row.agentId)).rejects.toThrow('changed while pausing')
  expect(tmuxKill).not.toHaveBeenCalled()
})
it.each(['capture', 'termination'] as const)('accepts a hook rebuilding the same process during %s', async stage => {
  const replacement = { ...row, title: 'Updated title',
    processIdentity: { startMarker: 'fixture', executable: 'codex', pid: 77 },
    runtimes: row.runtimes.map(runtime => ({ ...runtime })),
  }
  const resolve = registry.resolve.bind(registry)
  const rebuild = () => { vi.spyOn(registry, 'resolve').mockImplementation(id => resolve(id) ? replacement : undefined) }
  if (stage === 'capture') vi.mocked(captureResumeIdentity).mockImplementation(async session => { rebuild(); return session })
  else vi.mocked(terminateDeletedAgent).mockImplementation(async () => { rebuild(); return 'terminated' })
  await createStopAgentService(deps)(row.agentId)
  expect(deps.forgetSession).toHaveBeenCalledExactlyOnceWith(row.agentId, { force: true, captured: expect.objectContaining({ sessionId: 'saved' }), authority: expect.objectContaining({ current: expect.any(Function), refresh: expect.any(Function) }) })
  expect(registry.byAgent(row.agentId)).toBeUndefined()
  expect(stoppedAgents.get(row.agentId)?.sessionId).toBe('saved')
})
it('routes the stop signal through the agent signaller', async () => {
  const injected = vi.fn(); setAgentSignaller(injected)
  vi.mocked(terminateDeletedAgent).mockImplementation(async (entry, actions) => { actions.kill(78, 'SIGKILL'); return 'terminated' })
  try { await createStopAgentService(deps)(row.agentId) } finally { setAgentSignaller(null) }
  expect(injected).toHaveBeenCalledExactlyOnceWith(78, 'SIGKILL')
})
// A tool an engine spawned `detached` leaves its group and session: the stop lists the engine's tree and signals it,
// through the same signaller as the engine (#4173). The real termination runs here, with no grace to wait out.
const { terminateDeletedAgent: realTerminate } = await vi.importActual<typeof import('./deleteAgentFallback.js')>('./deleteAgentFallback.js')
it("a stop hands the engine's tree to the termination", async () => {
  const injected = vi.fn(); setAgentSignaller(injected)
  vi.mocked(terminateDeletedAgent).mockImplementation((entry, actions) => realTerminate(entry, actions, 0, 0))
  vi.mocked(checkPidRuntime).mockResolvedValueOnce({ state: 'alive' }).mockResolvedValue({ state: 'gone', reason: 'exited' })
  const descendants = vi.fn(async () => [{ pid: 90, pgid: 90, startMarker: 'tool' }])
  deps.processTree = { descendants, survivors: vi.fn(async () => []) }
  try { await createStopAgentService(deps)(row.agentId) } finally { setAgentSignaller(null) }
  expect(descendants).toHaveBeenCalledExactlyOnceWith({ pid: 77, executable: 'codex', startMarker: 'fixture' })
  expect(injected).toHaveBeenCalledWith(77, 'SIGTERM')
  expect(injected).toHaveBeenCalledWith(-90, 'SIGTERM')
  expect(registry.byAgent(row.agentId)).toBeUndefined()
})
it("a terminal and a guest's harness list no tree", async () => {
  vi.mocked(terminateDeletedAgent).mockImplementation((entry, actions) => realTerminate(entry, actions, 0, 0))
  vi.mocked(checkPidRuntime).mockResolvedValueOnce({ state: 'alive' }).mockResolvedValue({ state: 'gone', reason: 'exited' })
  const descendants = vi.fn(async () => [])
  deps.processTree = { descendants, survivors: vi.fn(async () => []) }
  deps.wait = vi.fn(async () => {})
  Object.assign(row, { engine: 'terminal', sessionId: '' })
  await createStopAgentService(deps)(row.agentId)
  const guest = (await registry.openPendingAgent({ engine: 'codex', runtimes: [{ backend: 'tmux', paneId: '%45' }], cwd: '/tmp' }))!
  Object.assign(registry.byAgent(guest.agentId)!, { guest: 'kim@example.com', sessionId: 'saved', processIdentity: { pid: 78, executable: 'codex', startMarker: 'fixture' } })
  await createStopAgentService(deps)(guest.agentId)
  expect(registry.byAgent(row.agentId)).toBeUndefined()
  expect(registry.byAgent(guest.agentId)).toBeUndefined()
  expect(descendants).not.toHaveBeenCalled()
})
it('only signals through the validated process deleter and does not erase a newer stop job', async () => {
  const signal = vi.spyOn(process, 'kill').mockReturnValue(true)
  vi.mocked(terminateDeletedAgent).mockImplementation(async (entry, actions) => {
    await actions.checkRuntime(entry); actions.kill(77, 'SIGTERM'); await actions.sleep(1); actions.log('fixture stop')
    deps.stopJobs.set(row.agentId, Promise.resolve()); return 'terminated'
  })
  row.runtimes.push({ backend: 'ptyhost', instance: 'p1', paneId: '%2' })
  await createStopAgentService(deps)(row.agentId)
  expect(signal).toHaveBeenCalledExactlyOnceWith(77, 'SIGTERM'); expect(deps.stopJobs.has(row.agentId)).toBe(true)
  expect(tmuxKill).toHaveBeenCalledExactlyOnceWith({ backend: 'tmux', paneId: '%44' }, expect.any(Function))
})

it.each(['claude', 'codex'] as const)('captures an unbound %s conversation before deleting its process', async engine => {
  Object.assign(row, { engine, sessionId: '', transcriptPath: null })
  vi.mocked(captureResumeIdentity).mockImplementation(async session => {
    expect(registry.byAgent(row.agentId)).toBe(row)
    expect(tmuxKill).not.toHaveBeenCalled()
    return { ...session, sessionId: 'recovered', transcriptPath: '/history.jsonl', boundAt: 1, source: 'stop-repair' }
  })
  await createStopAgentService(deps)(row.agentId)
  expect(stoppedAgents.get(row.agentId)).toMatchObject({ engine, sessionId: 'recovered', transcriptPath: '/history.jsonl' })
  expect(deps.markDeleted).toHaveBeenCalledWith('recovered')
})
it.each(['removed', 'replaced'] as const)('does not stop a process that was %s during identity capture', async mode => {
  vi.mocked(captureResumeIdentity).mockImplementation(async session => {
    if (mode === 'removed') (await removeRegistryAgent(registry, row.agentId))
    else row.processIdentity = { ...row.processIdentity!, pid: 88 }
    return session
  })
  await expect(createStopAgentService(deps)(row.agentId)).rejects.toThrow('Harness changed')
  expect(tmuxKill).not.toHaveBeenCalled()
  expect(terminateDeletedAgent).not.toHaveBeenCalled()
  expect(stoppedAgents.get(row.agentId)).toBeNull()
})
it('keeps the newer hook binding that arrives during capture', async () => {
  row.sessionId = ''
  vi.mocked(captureResumeIdentity).mockImplementation(async session => {
    row.sessionId = 'latest'
    return { ...session, sessionId: 'older' }
  })
  await createStopAgentService(deps)(row.agentId)
  expect(stoppedAgents.get(row.agentId)?.sessionId).toBe('latest')
})

it('checks cancellation at the shared-server boundary and never signals after a failure there', async () => {
  let current = true
  vi.mocked(deps.stopNative).mockImplementationOnce(async (_row, guard) => {
    expect(guard()).toBe(true); current = false; expect(guard()).toBe(false)
    throw new Error('shared server could not stop')
  })
  await expect(createStopAgentService(deps)(row.agentId, { current: () => current })).rejects.toThrow('shared server')
  expect(terminateDeletedAgent).not.toHaveBeenCalled()
  expect(tmuxKill).not.toHaveBeenCalled()
  expect(deps.clearDeleted).toHaveBeenCalledWith(row.agentId)
})
it('does not signal a process replaced at the actual kill boundary', async () => {
  vi.mocked(terminateDeletedAgent).mockImplementationOnce(async (_row, actions) => {
    row.processIdentity!.startMarker = 'replacement'
    actions.kill(77, 'SIGTERM')
    return 'gone'
  })
  await expect(createStopAgentService(deps)(row.agentId)).rejects.toThrow('Could not confirm')
  expect(tmuxKill).not.toHaveBeenCalled()
})
it('does not forget a new agent published while its old pane was being retired', async () => {
  tmuxKill.mockImplementationOnce(async () => {
    row.processIdentity!.startMarker = 'replacement'
    return { state: 'succeeded', dispatch: 'executed' }
  })
  await expect(createStopAgentService(deps)(row.agentId)).rejects.toThrow('changed while pausing')
  expect(deps.forgetSession).not.toHaveBeenCalled()
})

it('cancels an external intent through core without archiving, signalling or waiting for search', async () => {
  Object.assign(row, { sessionId: '', processIdentity: null, launch: { state: 'held', service: 'search', detail: 'Reader unavailable' },
    externalResume: { token: '12345678-1234-1234-1234-123456789012', request: { engine: 'codex', sessionId: 'external' },
      takeOver: null, phase: 'waiting' } })
  deps.cancelExternal = vi.fn(async (entry, current) => { expect(entry).toBe(row); expect(current()).toBe(true); return true })
  const save = vi.spyOn(stoppedAgents, 'save')
  await createStopAgentService(deps)(row.agentId)
  expect(deps.cancelExternal).toHaveBeenCalledOnce()
  expect(save).not.toHaveBeenCalled()
  expect(captureResumeIdentity).not.toHaveBeenCalled()
  expect(terminateDeletedAgent).not.toHaveBeenCalled()
  expect(deps.stopNative).not.toHaveBeenCalled()
  expect(tmuxKill).not.toHaveBeenCalled()
  expect(deps.forgetSession).not.toHaveBeenCalled()
})

it.each(['missing', 'refused', 'error', 'unknown', 'cancelled'] as const)('keeps an external intent intact when cancellation is %s', async failure => {
  Object.assign(row, { sessionId: '', processIdentity: null, launch: { state: 'held', service: 'search', detail: 'Reader unavailable' },
    externalResume: { token: '12345678-1234-1234-1234-123456789012', request: { engine: 'codex', sessionId: 'external' },
      takeOver: null, phase: 'waiting' } })
  if (failure !== 'missing') deps.cancelExternal = vi.fn(async (_entry, current) => {
    if (failure === 'error') throw new Error('Journal is unavailable')
    if (failure === 'unknown') throw 'unavailable'
    if (failure === 'cancelled') { expect(current()).toBe(false); return current() }
    return false
  })
  const save = vi.spyOn(stoppedAgents, 'save')
  await expect(createStopAgentService(deps)(row.agentId, { current: () => failure !== 'cancelled' }))
    .rejects.toMatchObject({ code: 'STOP_UNCONFIRMED', message: failure === 'error' ? 'Journal is unavailable'
      : failure === 'unknown' ? 'Adoption could not be cancelled.' : 'Adoption cancellation is unavailable.' })
  expect(registry.byAgent(row.agentId)).toBe(row)
  expect(deps.stopJobs.size).toBe(0)
  expect(save).not.toHaveBeenCalled()
  expect(captureResumeIdentity).not.toHaveBeenCalled()
  expect(terminateDeletedAgent).not.toHaveBeenCalled()
  expect(deps.stopNative).not.toHaveBeenCalled()
  expect(tmuxKill).not.toHaveBeenCalled()
  expect(deps.forgetSession).not.toHaveBeenCalled()
})
