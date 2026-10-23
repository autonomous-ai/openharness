import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import type { ScreenReading } from '../../engines/facets/screen.js'
import { controlTranscriptEvidence } from '../../engines/transcriptBindings.js'
import { IdentityReadUnavailable } from '../../engines/kit/identityScan.js'
import { createStopAgentService, type StopAgentServiceDeps } from '../../lib/stopAgentService.js'
import { AgentRestartCoordinator } from '../../lib/restartAgent.js'
import { TmuxBackend } from '../../lib/tmuxBackend.js'
import { tmuxControlGate } from '../../lib/tmuxControlGate.js'
import { assumeTmuxVersion, resetTmuxVersionCache } from '../../lib/tmuxVersion.js'
import { createAgentCleanup, IDLE_CLOSE_MS } from '../../services/agentCleanup.js'
import { fakeCore } from '../../testing/fakeCore.js'
import { createAgentClosing, type ClosingDeps } from './close.js'

// Native identity readings and OS process I/O are fixtures. The actual close,
// Stop service, tmux backend and notification queue compose below unchanged.
const native = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }))
vi.mock('node:child_process', async original => ({ ...await original<object>(), ...native }))
vi.mock('child_process', async original => ({ ...await original<object>(), ...native }))
vi.mock('../../lib/captureResumeIdentity.js', () => ({ captureResumeIdentity: async (s: RegisteredSession) => structuredClone(s) }))
vi.mock('../../lib/deleteAgentFallback.js', () => ({ checkPidRuntime: vi.fn(), terminateDeletedAgent: async () => 'gone' }))
vi.mock('../../engines/transcriptBindings.js', async original => ({ ...await original<object>(),
  controlTranscriptEvidence: vi.fn(),
}))
const dispose: Array<() => void> = []
afterEach(() => { for (const stop of dispose.splice(0)) stop(); vi.restoreAllMocks(); resetTmuxVersionCache() })
const idleScreen = (): ScreenReading => ({ busy: false, activity: null, stoppedGoal: false,
  pane: { idle: true, plan: false, dialog: false, draft: false }, question: null, messageHold: null, teamHold: null })

// The first group exercises each close await; the physical group additionally
// installs the real Stop service and tmux queue before reaching the OS stub.
function setup(physical = false) {
  const dir = mkdtempSync(join(tmpdir(), 'native-cleanup-'))
  dispose.push(() => rmSync(dir, { recursive: true, force: true }))
  let now = Date.parse('2026-10-12T12:00:00Z'), ready = true
  let transcriptReady = true
  vi.mocked(controlTranscriptEvidence).mockReset().mockImplementation((_engine, _id, path) => ({ path,
    verify: () => { if (!transcriptReady) throw new IdentityReadUnavailable('the original transcript proof changed') },
  }))
  let session: RegisteredSession | undefined = {
    schemaVersion: 2, active: true, agentId: 'child', sessionId: 'conversation', engine: 'cursor', cwd: '/work/app',
    registeredAt: 0, boundAt: 0, runtimes: [{ backend: 'tmux', paneId: '%1' }], startedBy: 'agent', parentAgentId: 'parent',
    transcriptPath: '/work/app/transcript.jsonl', projectDir: '/work/app', primaryRuntimeKey: 'tmux:%1', tmuxPane: '%1',
    source: null, title: null, model: null, cliVersion: null, processIdentity: { pid: 42, executable: 'cursor', startMarker: 'fixture-birth' },
    touchedAt: 0, lastHookAt: 0, lastTranscriptAt: 0,
  }
  const registry = {
    byAgent: (id: string) => id === session?.agentId ? session : undefined,
    advertised: () => session ? [session] : [], list: () => session ? [session] : [],
    afterTransaction: async <T>(action: () => T): Promise<T> => action(),
    setClosePlan: vi.fn((_id: string, plan: RegisteredSession['closePlan'] | null) => { session!.closePlan = plan ?? undefined; return session }),
  } as unknown as ClosingDeps['registry']
  const stopped = vi.fn()
  const beforeSignal = vi.fn(async () => {})
  native.execFile.mockReset().mockImplementation((file: string, args: string[], _options: unknown, done: (error: null, out: string, err: string) => void) => {
    expect(file).toBe('tmux')
    expect(args).toEqual(['kill-pane', '-t', '%1'])
    queueMicrotask(() => done(null, '', ''))
    return { kill: vi.fn() }
  })
  native.spawn.mockReset().mockImplementation(() => { throw Error('No fixture may spawn a host process') })
  const stopDeps: StopAgentServiceDeps = {
    registry: { resolve: () => session },
    stoppedAgents: { save: vi.fn(), finishResume: vi.fn() } as unknown as StopAgentServiceDeps['stoppedAgents'],
    restartJobs: new AgentRestartCoordinator(), stopJobs: new Map(), backendFor: (() => { const tmux = new TmuxBackend(); return () => tmux })(),
    agentReconciler: { suppress: vi.fn(), holdRoute: vi.fn(), releaseRoute: vi.fn(), trigger: vi.fn(async () => {}) },
    forgetSession: vi.fn(() => { stopped(); session = undefined }), markDeleted: vi.fn(), clearDeleted: vi.fn(), stopNative: vi.fn(async () => {}),
  }
  const deps = {
    registry,
    cleanupTabs: { refresh: vi.fn(async () => {}), isHidden: () => true, assertHidden: vi.fn(async () => {}) },
    watcher: { pollSession: vi.fn(async () => {}) }, captureTerminal: vi.fn(async () => 'empty composer'),
    readScreen: vi.fn(async () => idleScreen()), sessionTurnState: vi.fn((): boolean | undefined => false),
    nativeRecoveryReady: () => ready,
    openQuestions: { has: vi.fn(() => false) }, engineReady: vi.fn(async () => {}),
    terminals: { captureRetained: vi.fn(async () => ({ state: 'succeeded' as const, value: 'empty composer' })) },
    sessionCheckpoints: { save: vi.fn(async () => {}) }, announceSession: vi.fn(),
    stopAgent: physical ? createStopAgentService(stopDeps) : vi.fn(async (_id, options) => {
      await options.checkpoint!(session!, 'before')
      await options.beforeStop!(session!)
      await beforeSignal()
      if (!options.current!()) throw Object.assign(new Error('The idle close was revoked.'), { code: 'STOP_UNCONFIRMED' })
      stopped()
    }),
  } satisfies ClosingDeps
  const closing = createAgentClosing(deps)
  dispose.push(() => closing.closeAgentService.dispose())
  const closeStarted = vi.fn(async (_id: string, mode: 'idle' | 'now') => closing.closeAgentService.request({
    agentId: 'child', sessionId: 'conversation', createdAt: new Date(0).toISOString(), mode,
  }))
  const cleanup = createAgentCleanup(fakeCore({
    dataDir: dir, agents: { live: registry.list, resolve: registry.byAgent, closeStarted, lastActivity: async () => 0 },
  }), { now: () => now, log: vi.fn(), every: () => () => {} })
  dispose.push(() => cleanup.port.stop())
  return { deps, stopDeps, closing, cleanup, closeStarted, stopped, beforeSignal, row: () => session!,
    replace: (value: RegisteredSession | undefined) => { session = value },
    ready: (value: boolean) => { ready = value },
    transcriptReady: (value: boolean) => { transcriptReady = value },
    clean: async () => { await cleanup.look(); now += IDLE_CLOSE_MS; await cleanup.look() },
  }
}

it.each(['admissionHold', 'interpretationHold', 'identityHold', 'recovery'] as const)(
  'automatic cleanup keeps old idle work while %s is unresolved; explicit now still closes', async hold => {
    const t = setup()
    if (hold === 'recovery') t.ready(false)
    else t.row()[hold] = 'Waiting for original native evidence.'
    await t.clean()
    expect(t.closeStarted).toHaveBeenCalledWith('child', 'idle')
    expect(t.stopped).not.toHaveBeenCalled()
    expect(t.deps.sessionCheckpoints.save).not.toHaveBeenCalled()
    expect(t.deps.watcher.pollSession).not.toHaveBeenCalled()
    expect(await t.closeStarted('child', 'now')).toEqual({ closed: true })
    expect(t.stopped).toHaveBeenCalledOnce()
  })

it.each(['admission', 'recovery', 'working', 'evidence', 'transcript'] as const)(
  'the real Stop path cannot remove a pane after %s changes in the tmux queue', async change => {
    const t = setup(true)
    assumeTmuxVersion({ major: 3, minor: 4 })
    const release = await tmuxControlGate.enter('attach')
    const closing = t.closeStarted('child', 'idle')
    try {
      await vi.waitFor(() => expect(tmuxControlGate.state.waiting).toBe(1))
      expect(native.execFile).not.toHaveBeenCalled()
      if (change === 'admission') t.row().admissionHold = 'Waiting for original native admission.'
      if (change === 'recovery') t.ready(false)
      if (change === 'working') t.deps.sessionTurnState.mockReturnValue(true)
      if (change === 'evidence') t.row().evidenceRevision = 1
      if (change === 'transcript') t.transcriptReady(false)
    } finally { release() }
    expect(await closing).toMatchObject({ error: change === 'transcript' ? 'IDENTITY_UNAVAILABLE'
      : change === 'evidence' ? 'STOP_UNCONFIRMED' : 'SESSION_NOT_IDLE' })
    expect(native.execFile).not.toHaveBeenCalled()
    expect(t.stopped).not.toHaveBeenCalled()
    expect(t.stopDeps.stoppedAgents.finishResume).not.toHaveBeenCalled()
    expect(t.row()).toMatchObject({ agentId: 'child', sessionId: 'conversation' })
  })

it('the real Stop path retains its row when native recovery becomes unknown after pane dispatch', async () => {
  const t = setup(true)
  assumeTmuxVersion({ major: 3, minor: 7 })
  native.execFile.mockImplementationOnce((_file, _args, _options, done) => {
    t.ready(false)
    queueMicrotask(() => done(null, '', ''))
    return { kill: vi.fn() }
  })
  expect(await t.closeStarted('child', 'idle')).toMatchObject({ error: 'SESSION_NOT_IDLE' })
  expect(native.execFile).toHaveBeenCalledOnce()
  expect(t.stopped).not.toHaveBeenCalled()
  expect(t.stopDeps.stoppedAgents.finishResume).not.toHaveBeenCalled()
  expect(t.row()).toMatchObject({ agentId: 'child' })
})

it('the real Stop path honors explicit now despite pending admission', async () => {
  const t = setup(true)
  assumeTmuxVersion({ major: 3, minor: 7 })
  t.row().admissionHold = 'Waiting for original native admission.'
  expect(await t.closeStarted('child', 'now')).toEqual({ closed: true })
  expect(native.execFile).toHaveBeenCalledOnce()
  expect(t.stopped).toHaveBeenCalledOnce()
})

it.each(['drain', 'capture', 'screen', 'checkpoint'] as const)(
  'native admission starting during %s prevents automatic Stop', async phase => {
    const t = setup()
    const held = async () => { t.row().admissionHold = 'Waiting for native admission.' }
    if (phase === 'drain') t.deps.watcher.pollSession.mockImplementationOnce(held)
    if (phase === 'capture') t.deps.captureTerminal.mockImplementationOnce(async () => { await held(); return 'empty composer' })
    if (phase === 'screen') t.deps.readScreen.mockImplementationOnce(async () => { await held(); return idleScreen() })
    if (phase === 'checkpoint') t.deps.sessionCheckpoints.save.mockImplementationOnce(held)
    await t.clean()
    expect(t.stopped).not.toHaveBeenCalled()
    if (phase !== 'checkpoint') expect(t.deps.sessionCheckpoints.save).not.toHaveBeenCalled()
    expect(await t.closeStarted.mock.results[0].value).toEqual({ error: 'SESSION_NOT_IDLE', activity: 'unknown' })
  })

it('requires known turn state after recovery, and closes once current work is confirmed idle', async () => {
  const t = setup()
  t.deps.sessionTurnState.mockReturnValueOnce(undefined)
  await t.clean()
  expect(t.stopped).not.toHaveBeenCalled()
  expect(await t.closeStarted('child', 'idle')).toEqual({ closed: true })
  expect(t.stopped).toHaveBeenCalledOnce()
})

it.each(['replaced', 'gone', 'evidence', 'recovery'] as const)(
  'an idle screen from before native %s cannot authorize close', async change => {
    const t = setup()
    t.deps.readScreen.mockImplementationOnce(async () => {
      if (change === 'replaced') t.replace({ ...t.row(), boundAt: 1 })
      if (change === 'gone') t.replace(undefined)
      if (change === 'evidence') t.row().evidenceRevision = 1
      if (change === 'recovery') t.ready(false)
      return idleScreen()
    })
    await t.clean()
    expect(t.stopped).not.toHaveBeenCalled()
    expect(t.deps.sessionCheckpoints.save).not.toHaveBeenCalled()
  })

it.each(['admissionHold', 'interpretationHold', 'identityHold', 'recovery', 'running', 'unknown', 'question'] as const)(
  'automatic Stop remains revocable at dispatch after %s changes', async change => {
    const t = setup()
    t.beforeSignal.mockImplementationOnce(async () => {
      if (change === 'recovery') t.ready(false)
      else if (change === 'running') t.deps.sessionTurnState.mockReturnValue(true)
      else if (change === 'unknown') t.deps.sessionTurnState.mockReturnValue(undefined)
      else if (change === 'question') t.deps.openQuestions.has.mockReturnValue(true)
      else t.row()[change] = 'Waiting for original native evidence.'
    })
    await t.clean()
    expect(t.stopped).not.toHaveBeenCalled()
    expect(await t.closeStarted.mock.results[0].value).toMatchObject({ error: 'SESSION_NOT_IDLE' })
    expect(await t.closeStarted('child', 'now')).toEqual({ closed: true })
    expect(t.stopped).toHaveBeenCalledOnce()
  })

it('keeps the same after-task intent waiting when a late recovery hold revokes Stop, then completes it', async () => {
  let now = Date.parse('2026-10-12T12:00:00Z')
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const t = setup(true)
  assumeTmuxVersion({ major: 3, minor: 4 })
  expect(await t.closing.closeAgentService.request({ agentId: 'child', sessionId: 'conversation',
    createdAt: new Date(0).toISOString(), mode: 'after_task' })).toEqual({ deferred: true })
  const plan = t.row().closePlan!
  await t.closing.closeAgentService.tick()
  now += 5_000
  const release = await tmuxControlGate.enter('attach')
  const tick = t.closing.closeAgentService.tick()
  try {
    await vi.waitFor(() => expect(tmuxControlGate.state.waiting).toBe(1))
    t.ready(false)
  } finally { release() }
  await tick
  expect(native.execFile).not.toHaveBeenCalled()
  expect(t.row().closePlan).toEqual(plan)
  expect(t.row().closePlan?.state).toBe('waiting')
  t.ready(true)
  now += 5_000
  await t.closing.closeAgentService.tick()
  expect(native.execFile).toHaveBeenCalledOnce()
  expect(t.stopped).toHaveBeenCalledOnce()
})
