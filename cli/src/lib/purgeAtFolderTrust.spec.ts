import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IdentityReadUnavailable } from '../engines/kit/identityScan.js'
import { PurgeAgentService } from './purgeAgentService.js'
import { registry, type RegisteredSession } from './registry.js'
import { SessionCheckpointStore } from './sessionCheckpoint.js'
import { AgentRestartCoordinator } from './restartAgent.js'
import { createStopAgentService, type StopAgentServiceDeps } from './stopAgentService.js'
import { StoppedAgentStore } from './stoppedAgents.js'
import { captureResumeIdentity } from './captureResumeIdentity.js'
import { terminateDeletedAgent } from './deleteAgentFallback.js'

vi.mock('./captureResumeIdentity.js', () => ({ captureResumeIdentity: vi.fn() }))
vi.mock('./deleteAgentFallback.js', () => ({ checkPidRuntime: vi.fn(), terminateDeletedAgent: vi.fn() }))
vi.mock('../core/engines/cursorTasks.js', () => ({ removePendingCursorTasks: vi.fn(async () => {}) }))

/**
 * Monitor Delete of two Codex agents that a Super Tab started into a folder Codex did not trust (2026-10-22). They sat at
 * "Do you trust the contents of this directory?" with a delivery waiting, and Delete refused them. The step is the stop
 * Delete makes: a Codex with no bound conversation, on a machine where another Codex agent keeps the shared app-server
 * running, is only let go when the caller proves the chat unused (core/engines/nativeControls.ts: `unidentified`). Close
 * supplies that proof; Delete never did.
 */
let root: string, row: RegisteredSession, stopped: StoppedAgentStore, kill: ReturnType<typeof vi.fn<NonNullable<ReturnType<StopAgentServiceDeps['backendFor']>>['kill']>>
let atFolderTrust: ReturnType<typeof vi.fn<(session: RegisteredSession) => Promise<boolean>>>
let atEmptyComposer: typeof atFolderTrust
let stopNative: ReturnType<typeof vi.fn<StopAgentServiceDeps['stopNative']>>

const purge = () => new PurgeAgentService({
  live: id => registry.byAgent(id), sessions: () => [...registry.list(), ...stopped.list()], stopped,
  checkpoints: new SessionCheckpointStore(join(root, 'checkpoints')), restarting: () => false, deleted: vi.fn(), atFolderTrust, atEmptyComposer,
  stop: createStopAgentService({ registry, stoppedAgents: stopped, restartJobs: new AgentRestartCoordinator(), stopJobs: new Map(),
    backendFor: () => ({ kill }), agentReconciler: { suppress: vi.fn(), holdRoute: vi.fn(), releaseRoute: vi.fn(), trigger: vi.fn(async () => {}) },
    forgetSession: id => registry.removeAgent(id), markDeleted: vi.fn(), clearDeleted: vi.fn(), stopNative }),
})
const target = () => ({ agentId: row.agentId, sessionId: null, createdAt: row.registeredAt })
async function deleteIt(service: PurgeAgentService) {
  const review = await service.request({ ...target(), mode: 'inspect' })
  return service.request({ ...target(), mode: 'delete', reviewId: String(review.reviewId) })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'harness-purge-trust-'))
  stopped = new StoppedAgentStore(join(root, 'stopped'))
  row = registry.openPendingAgent({ engine: 'codex', cwd: join(root, 'worktree'), runtimes: [{ backend: 'tmux', paneId: '%44' }] })!
  Object.assign(row, { launch: { state: 'ready' }, processIdentity: { pid: 77, executable: 'codex', startMarker: 'fixture' } })
  kill = vi.fn(async () => ({ state: 'succeeded' as const, dispatch: 'executed' as const }))
  atFolderTrust = vi.fn(async () => true)
  atEmptyComposer = vi.fn(async () => true)
  // The contract of core/engines/nativeControls.ts for an unbound chat while the shared server runs.
  stopNative = vi.fn(async (session, _current, confirmUnused) => {
    if (!await confirmUnused?.(session)) throw new Error('Cannot confirm which conversation is open. Nothing was stopped.')
  })
  // This machine could not read the process (the native helper): the conversation is held, not absent.
  vi.mocked(captureResumeIdentity).mockReset().mockRejectedValue(new IdentityReadUnavailable('the native control helper is unavailable'))
  vi.mocked(terminateDeletedAgent).mockReset().mockResolvedValue('gone')
})
afterEach(() => { for (const entry of registry.list()) registry.removeAgent(entry.agentId); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })

it('deletes a Codex agent held at its folder-trust question, which has no conversation to keep', async () => {
  expect(await deleteIt(purge())).toMatchObject({ deleted: true })
  expect(kill).toHaveBeenCalledTimes(1)
  expect(registry.byAgent(row.agentId)).toBeUndefined()
  expect(atFolderTrust).toHaveBeenCalled()
})

it('deletes it on a machine that can read the process too, where only the shared server holds it', async () => {
  vi.mocked(captureResumeIdentity).mockImplementation(async session => session)
  expect(await deleteIt(purge())).toMatchObject({ deleted: true })
  expect(stopNative).toHaveBeenCalledTimes(1)
})

it('still refuses an agent that is not at the trust question, as before', async () => {
  atFolderTrust.mockResolvedValue(false)
  expect(await deleteIt(purge())).toMatchObject({ error: 'IDENTITY_UNAVAILABLE', retryable: true })
  expect(kill).not.toHaveBeenCalled()
  expect(registry.byAgent(row.agentId)).toBeDefined()
})

it('does not take a bound conversation for an unused chat, whatever the screen shows', async () => {
  Object.assign(row, { sessionId: 'bound' })
  const stop = vi.fn(async () => {})
  const service = new PurgeAgentService({ live: id => registry.byAgent(id), sessions: () => [], stopped,
    checkpoints: new SessionCheckpointStore(join(root, 'checkpoints')), restarting: () => false, deleted: vi.fn(), atFolderTrust,
    inspect: async () => ({ bytes: 0 }), stop })
  const review = await service.request({ agentId: row.agentId, sessionId: 'bound', createdAt: row.registeredAt, mode: 'inspect' })
  await service.request({ agentId: row.agentId, sessionId: 'bound', createdAt: row.registeredAt, mode: 'delete', reviewId: String(review.reviewId) })
  expect(atFolderTrust).not.toHaveBeenCalled()
  expect(stop).toHaveBeenCalledWith(row.agentId, { current: expect.any(Function) })
})

/**
 * "Devices" (Codex, dsh autonomous/devices), put back by a daemon restart (2026-10-22): no id, no transcript, never bound,
 * no hook since, `resumeOnly`, an empty composer. Delete refused it for the same two reasons as above.
 */
const restored = (over: Partial<RegisteredSession> = {}) =>
  Object.assign(row, { resumeOnly: true, lastHookAt: 0, boundAt: null, transcriptPath: null, sessionId: '', dsh: 'autonomous/devices', ...over })

it('deletes a restored (resumeOnly) agent that never bound a conversation, at an empty composer', async () => {
  restored(); atFolderTrust.mockResolvedValue(false)
  expect(await deleteIt(purge())).toMatchObject({ deleted: true })
  expect(kill).toHaveBeenCalledTimes(1)
  expect(registry.byAgent(row.agentId)).toBeUndefined()
})

it.each([
  ['a hook has reached it', { lastHookAt: 5 }],
  ['it was bound', { boundAt: 7 }],
  ['it has a transcript', { transcriptPath: '/codex/sessions/rollout.jsonl' }],
  ['a hook awaits admission', { admissionHold: 'pending native hook' }],
  ['an adoption is in flight', { externalResume: { phase: 'pending' } as never }],
  ['it is not a Claude Code or Codex row', { engine: 'opencode' as const }],
  ['it is not ready', { launch: { state: 'failed', error: 'RESUME_FAILED' } as never }],
])('still refuses a restored agent when %s', async (_why, over) => {
  restored(over); atFolderTrust.mockResolvedValue(false)
  expect(await deleteIt(purge())).toHaveProperty('error')
  expect(kill).not.toHaveBeenCalled()
  expect(registry.byAgent(row.agentId)).toBeDefined()
})

it('still refuses a restored agent whose pane is busy, asks something or holds a draft', async () => {
  restored(); atFolderTrust.mockResolvedValue(false); atEmptyComposer.mockResolvedValue(false)
  expect(await deleteIt(purge())).toMatchObject({ error: 'IDENTITY_UNAVAILABLE' })
  expect(kill).not.toHaveBeenCalled()
})

it('never reads the pane of a row that already holds evidence of a conversation', async () => {
  restored({ lastHookAt: 5 }); atFolderTrust.mockResolvedValue(false)
  await deleteIt(purge())
  expect(atEmptyComposer).not.toHaveBeenCalled()
})
