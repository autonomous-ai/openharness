import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as nativeReads from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { liveFor } from '../../engines/live.js'
import { CopilotNormalizer } from '../../engines/copilot/normalizer.js'
import { engineLiveRequests } from '../../engines/worker/liveRequests.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { Watcher } from '../../watcher/watcher.js'
import { createLiveTransport } from '../engines/liveTransport.js'
import { createLiveWatcher } from '../engines/liveWatcher.js'
import { createCancel } from '../turns/cancel.js'
import { createTurnHooks } from '../turns/turnHooks.js'
import { createAttach } from './attach.js'
import { createIngest } from './ingest.js'
import { createSessionNormalizers } from './normalizers.js'

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

const prompt = (text: string) => JSON.stringify({ type: 'user', uuid: text, message: { role: 'user', content: text } }) + '\n'
const continuation = JSON.stringify({ type: 'attachment', attachment: { type: 'goal_status', met: false, condition: 'finish' } }) + '\n'
const done = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [], stop_reason: 'end_turn' } }) + '\n'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean()
  vi.restoreAllMocks()
  vi.mocked(nativeReads.open).mockReset()
})
function setup(mode: 'inline' | 'worker', content = prompt('T1')) {
  const root = mkdtempSync(join(tmpdir(), 'attach-control-')), file = join(root, 'session.jsonl')
  writeFileSync(file, content)
  const row = { agentId: 'agent', sessionId: 'session', engine: 'claude', transcriptPath: file,
    cwd: root, model: null, cliVersion: null, evidenceRevision: 0 } as RegisteredSession
  const normalizers = createSessionNormalizers(), emit = vi.fn(), settled = vi.fn()
  let worker = engineLiveRequests('claude')
  const transport = createLiveTransport({ call: async (_service, type, payload) =>
    await worker[type](payload, { owner: true, local: true }) as Record<string, unknown> })
  transport.connected('engine-claude')
  const local = new Watcher()
  const { watcher, live } = createLiveWatcher(local, { handles: () => mode === 'worker', transport,
    bySession: () => row, frame: (session, frame) => ingest.acceptFrame(session.sessionId, session.engine, frame),
    reattach: session => attach.attachSession(session, true), hold: (session, reason) => attach.holdInterpretation(session, reason) })
  const profile = { ingest: vi.fn(), commit: vi.fn(), config: vi.fn(async () => {}) }
  const attach = createAttach({ liveFor, normalizers, remoteLive: live, watcher, resolve: () => row,
    setInterpretationHold: (_id, revision, reason, create) => {
      if (row.identityHold || row.evidenceRevision !== revision || (!row.interpretationHold && !(create && reason))) return false
      if (!row.interpretationHold) row.evidenceRevision = (row.evidenceRevision ?? 0) + 1
      if (reason) row.interpretationHold = reason; else delete row.interpretationHold
      return true
    }, announceSession: vi.fn(), terminalGone: async () => false,
    runtimeProfiles: { transcriptFields: () => [], beginHydrate: () => profile, hydrate: vi.fn(),
      ingestConfig: async () => false, ingestPane: () => false, capturePane: async () => null },
    cursorDiscovery: { add: async () => {} }, device: () => undefined, captureTerminal: async () => null,
    emit, settled, announceTurnAborted: vi.fn(), questionWatcher: { start: vi.fn() }, terminalLabel: () => 'private fixture',
    dbs: { opencode: join(root, 'o.db'), kilo: join(root, 'k.db'), devin: join(root, 'd.db') },
    devinHome: root, hermesDb: async () => join(root, 'h.db'), concurrency: 1 })
  const ingest = createIngest({ liveFor, has: () => true, bySession: () => row, normalizers,
    tokenUsage: { changed: vi.fn() }, device: () => undefined, runtimeProfiles: { ingest: () => false },
    announceTurnAborted: vi.fn(), emit, attachSession: attach.attachSession })
  ingest.wireWatcher(watcher)
  const cancel = createCancel({ resolve: () => row, beforeCancel: attach.beforeCancel, normalizers,
    cursorSubagents: { forget: vi.fn() }, input: { cancel: vi.fn(), cancelConfirmed: vi.fn(async () => true) },
    device: () => undefined, stopHeartbeat: vi.fn(), questionWatcher: { stop: vi.fn() }, mirror: { cancel: vi.fn() },
    turnActivity: { observe: vi.fn(), snapshot: vi.fn() }, turnStartedAt: new Map(), agentIdFor: () => row.agentId, clients: { send: vi.fn() } })
  const hooks = createTurnHooks({ resolve: () => row, normalizers, holdStop: attach.holdStop, afterStop: attach.afterStop,
    emit, drain: async () => watcher.pollSession(row.sessionId), onCursorTaskStart: vi.fn(),
    cursorTaskHooks: { wait: async () => {} }, cursorSubagents: { closeParent: vi.fn() }, announceTurnAborted: vi.fn(),
    armAgyIdleWatch: vi.fn(), clearAgyIdleWatch: vi.fn(), mirror: { noteEngineStopped: vi.fn() }, dataDir: root })
  const hold = () => { row.identityHold = 'native evidence unavailable'; row.evidenceRevision = (row.evidenceRevision ?? 0) + 1 }
  const recover = () => { delete row.identityHold; row.evidenceRevision = (row.evidenceRevision ?? 0) + 1; row.interpretationHold = 'recovering' }
  cleanups.push(async () => { attach.forget(row.sessionId); await watcher.stop(); rmSync(root, { recursive: true, force: true }) })
  return { row, file, normalizers, emit, settled, attach, cancel, hooks, profile, watcher, hold, recover,
    restartWorker: () => { worker = engineLiveRequests('claude') } }
}

it.each(['inline', 'worker'] as const)('%s preserves Cancel → failed recovery → later prompt ordering', async mode => {
  const t = setup(mode)
  await t.attach.attachSession(t.row)
  t.hold(); await t.cancel(t.row.agentId); t.recover()
  t.profile.config.mockRejectedValueOnce(new Error('configuration unavailable'))
  await t.attach.attachSession(t.row)
  expect(t.row.interpretationHold).toBeTruthy()
  appendFileSync(t.file, prompt('T2'))
  await t.attach.attachSession(t.row)
  expect(t.row.interpretationHold).toBeUndefined()
  expect(t.normalizers.sessionTurnOpen(t.row.sessionId)).toBe(true)
  t.restartWorker(); await t.watcher.pollSession(t.row.sessionId)
  expect(t.normalizers.sessionTurnOpen(t.row.sessionId)).toBe(true)
})
it.each(['inline', 'worker'] as const)('%s applies repeated cancellation before each goal continuation, including worker reconstruction', async mode => {
  const t = setup(mode)
  await t.attach.attachSession(t.row)
  t.hold(); await t.cancel(t.row.agentId)
  appendFileSync(t.file, continuation)
  await t.cancel(t.row.agentId)
  appendFileSync(t.file, continuation)
  t.recover(); await t.attach.attachSession(t.row)
  expect(t.row.interpretationHold).toBeUndefined()
  expect(t.normalizers.liveParsers.get(t.row.sessionId)?.snapshot()).toMatchObject({ turnOpen: true, continued: true })
  t.restartWorker(); await t.watcher.pollSession(t.row.sessionId)
  appendFileSync(t.file, done); await t.watcher.pollSession(t.row.sessionId)
  expect(t.normalizers.sessionTurnOpen(t.row.sessionId)).toBe(false)
})
it.each(['inline', 'worker'] as const)('%s keeps delayed and cold Stop intent held even with empty or older closed history', async mode => {
  const t = setup(mode, '')
  t.hold(); t.hooks.onTurnStop({ sessionId: t.row.sessionId, firedAt: 100 })
  t.recover(); await t.attach.attachSession(t.row)
  expect(t.row.interpretationHold).toContain('Stop could not be matched')
  appendFileSync(t.file, prompt('T1') + done + prompt('T2'))
  t.hooks.onPromptHook(t.row.sessionId, 200) // Its delayed arrival cannot authorize the old Stop.
  await t.attach.attachSession(t.row)
  expect(t.row.interpretationHold).toContain('Stop could not be matched')
  expect(t.emit).not.toHaveBeenCalled()
  await t.cancel(t.row.agentId) // Explicit current control safely supersedes the unknown completion.
  await t.attach.attachSession(t.row)
  expect(t.row.interpretationHold).toBeUndefined()
  expect(t.normalizers.sessionTurnOpen(t.row.sessionId)).toBe(false)
})
it.each(['inline', 'worker'] as const)('%s holds a replaced file rather than moving its cancellation cutoff', async mode => {
  const t = setup(mode)
  t.hold(); await t.cancel(t.row.agentId)
  renameSync(t.file, t.file + '.old'); writeFileSync(t.file, prompt('T2'))
  t.recover(); await t.attach.attachSession(t.row)
  expect(t.row.interpretationHold).toContain('control boundary')
  expect(t.emit).not.toHaveBeenCalled()
})

it.each(['inline', 'worker'] as const)('%s retains cancellation across repeated recovery and never settles cancelled history', async mode => {
  const t = setup(mode)
  await t.attach.attachSession(t.row)
  t.hold(); await t.cancel(t.row.agentId); t.recover()
  await t.attach.attachSession(t.row)
  expect(t.normalizers.sessionTurnOpen(t.row.sessionId)).toBe(false)
  t.hold(); t.recover(); await t.attach.attachSession(t.row)
  expect(t.row.interpretationHold).toBeUndefined()
  expect(t.normalizers.sessionTurnOpen(t.row.sessionId)).toBe(false)
  expect(t.settled).not.toHaveBeenCalled()
  await t.attach.attachSession(t.row, true) // Ordinary compact/reset must also keep the cancellation.
  expect(t.row.interpretationHold).toBeUndefined()
  expect(t.normalizers.sessionTurnOpen(t.row.sessionId)).toBe(false)
  expect(t.settled).not.toHaveBeenCalled()
  appendFileSync(t.file, prompt('T2') + done)
  t.hold(); t.recover(); await t.attach.attachSession(t.row)
  expect(t.settled).toHaveBeenCalledOnce()
})
it.each(['inline', 'worker'] as const)('%s preserves Stop and Cancel obligations across a repaired path', async mode => {
  const t = setup(mode)
  t.hold(); t.hooks.onTurnStop({ sessionId: t.row.sessionId })
  const repaired = t.file + '.repaired'; writeFileSync(repaired, prompt('T2'))
  t.row.transcriptPath = repaired
  t.recover(); await t.attach.attachSession(t.row)
  expect(t.row.interpretationHold).toContain('Stop could not be matched')
  await t.cancel(t.row.agentId)
  const again = t.file + '.again'; writeFileSync(again, prompt('T3'))
  t.row.transcriptPath = again
  await t.attach.attachSession(t.row)
  expect(t.row.interpretationHold).toContain('control boundary')
  expect(t.emit).not.toHaveBeenCalled()
})
it.each(['inline', 'worker'] as const)('%s retains a Stop whose drain outlasts a complete hold and recovery cycle', async mode => {
  const t = setup(mode)
  await t.attach.attachSession(t.row)
  let finish!: () => void
  vi.spyOn(t.watcher, 'pollSession').mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  t.hooks.onTurnStop({ sessionId: t.row.sessionId })
  t.hold(); t.recover(); await t.attach.attachSession(t.row)
  expect(t.row.interpretationHold).toBeUndefined()
  finish()
  await vi.waitFor(() => expect(t.row.interpretationHold).toContain('Stop could not be matched'))
})
it('holds rewritten worker evidence visibly and accepts a later explicit cancellation of the new incarnation', async () => {
  const t = setup('worker')
  t.hold(); await t.cancel(t.row.agentId); t.recover(); await t.attach.attachSession(t.row)
  // Recovery starts a detached tail read. Finish it before replacing the file so the assertion
  // below observes the restarted worker's request, not that earlier read during the rename.
  await t.watcher.pollSession(t.row.sessionId)
  expect(t.row.interpretationHold).toBeUndefined()
  expect(t.normalizers.sessionTurnOpen(t.row.sessionId)).toBe(false)
  renameSync(t.file, t.file + '.old'); writeFileSync(t.file, prompt('T2'))
  t.restartWorker()
  await expect(t.watcher.pollSession(t.row.sessionId)).rejects.toThrow('ENGINE_CONTROL_BOUNDARY_CHANGED')
  await vi.waitFor(() => expect(t.row.interpretationHold).toBeTruthy())
  await t.cancel(t.row.agentId)
  appendFileSync(t.file, prompt('T3'))
  await t.attach.attachSession(t.row)
  expect(t.row.interpretationHold).toBeUndefined()
  expect(t.normalizers.sessionTurnOpen(t.row.sessionId)).toBe(true)
})
it.each(['inline', 'worker'] as const)('%s refuses a different replay descriptor even when the path verifies before and after', async mode => {
  const t = setup(mode)
  t.hold(); await t.cancel(t.row.agentId); t.recover()
  const other = t.file + '.other'; writeFileSync(other, prompt('T2'))
  const { open } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const verifyFile = vi.spyOn(await import('../../lib/transcriptBoundary.js'), 'verifyTranscriptHandle')
  vi.spyOn(nativeReads, 'open').mockImplementation((path, flags, access) => open(path === t.file ? other : path, flags, access))
  await t.attach.attachSession(t.row)
  expect(t.row.interpretationHold).toBeTruthy()
  expect(t.emit).not.toHaveBeenCalled()
  expect(t.settled).not.toHaveBeenCalled()
  expect(verifyFile).toHaveBeenCalled()
  await expect(verifyFile.mock.results[0]?.value).rejects.toThrow('ENGINE_CONTROL_BOUNDARY_CHANGED')
})

it.each(['inline', 'worker'] as const)('%s retains a later ordinary Cancel without replacing its live parser', async mode => {
  const t = setup(mode)
  t.hold(); await t.cancel(t.row.agentId); t.recover(); await t.attach.attachSession(t.row)
  appendFileSync(t.file, prompt('T2')); await t.watcher.pollSession(t.row.sessionId)
  expect(t.normalizers.sessionTurnOpen(t.row.sessionId)).toBe(true)
  const live = t.normalizers.liveParsers.get(t.row.sessionId)
  await t.cancel(t.row.agentId)
  expect(t.normalizers.liveParsers.get(t.row.sessionId)).toBe(live)
  expect(t.normalizers.sessionTurnOpen(t.row.sessionId)).toBe(false)
  t.hold(); t.recover(); await t.attach.attachSession(t.row)
  expect(t.row.interpretationHold).toBeUndefined()
  expect(t.normalizers.sessionTurnOpen(t.row.sessionId)).toBe(false)
  expect(t.settled).not.toHaveBeenCalled()
})
it.each(['inline', 'worker'] as const)('%s preserves positive stale Stop evidence while held', async mode => {
  const t = setup(mode)
  t.hold()
  t.hooks.onPromptHook(t.row.sessionId, 200)
  t.hooks.onTurnStop({ sessionId: t.row.sessionId, firedAt: 100 })
  t.recover(); await t.attach.attachSession(t.row)
  expect(t.row.interpretationHold).toBeUndefined()
  expect(t.normalizers.sessionTurnOpen(t.row.sessionId)).toBe(true)
})

it.each(['inline', 'worker'] as const)('%s holds a later ordinary cancellation whose file boundary is incomplete', async mode => {
  const t = setup(mode)
  t.hold(); await t.cancel(t.row.agentId); t.recover(); await t.attach.attachSession(t.row)
  appendFileSync(t.file, '{')
  await t.cancel(t.row.agentId)
  expect(t.row.interpretationHold).toBeTruthy()
  expect(t.normalizers.sessionTurnOpen(t.row.sessionId)).toBe(false)
  writeFileSync(t.file, prompt('T2'))
  await t.cancel(t.row.agentId)
  await t.attach.attachSession(t.row)
  expect(t.row.interpretationHold).toBeUndefined()
  expect(t.normalizers.sessionTurnOpen(t.row.sessionId)).toBe(false)
})

it.each(['inline', 'worker'] as const)('%s preserves an ordinary Cancel through the first later binding recovery', async mode => {
  const t = setup(mode)
  await t.attach.attachSession(t.row)
  const live = t.normalizers.liveParsers.get(t.row.sessionId)
  await t.cancel(t.row.agentId)
  expect(t.normalizers.liveParsers.get(t.row.sessionId)).toBe(live)
  expect(t.normalizers.sessionTurnOpen(t.row.sessionId)).toBe(false)
  t.hold(); t.recover(); await t.attach.attachSession(t.row)
  expect(t.row.interpretationHold).toBeUndefined()
  expect(t.normalizers.sessionTurnOpen(t.row.sessionId)).toBe(false)
  expect(t.settled).not.toHaveBeenCalled()
})

it.each([
  ['inline', false], ['worker', false], ['inline', true], ['worker', true],
] as const)('%s retains an ordinary successful Stop through first recovery (later turn=%s)', async (mode, later) => {
  const t = setup(mode)
  await t.attach.attachSession(t.row)
  const live = t.normalizers.liveParsers.get(t.row.sessionId)
  t.hooks.onTurnStop({ sessionId: t.row.sessionId })
  await vi.waitFor(() => expect(t.normalizers.sessionTurnOpen(t.row.sessionId)).toBe(false), { timeout: 3_000 })
  expect(t.normalizers.liveParsers.get(t.row.sessionId)).toBe(live)
  expect(t.row.interpretationHold).toBeUndefined()
  if (later) {
    appendFileSync(t.file, prompt('T2'))
    await t.watcher.pollSession(t.row.sessionId)
    expect(t.normalizers.sessionTurnOpen(t.row.sessionId)).toBe(true)
  }
  const sent = t.emit.mock.calls.length
  t.hold(); t.recover(); await t.attach.attachSession(t.row)
  expect(t.row.interpretationHold).toContain('Stop could not be matched')
  expect(t.normalizers.sessionTurnOpen(t.row.sessionId)).toBe(later)
  expect(t.emit).toHaveBeenCalledTimes(sent)
  await t.cancel(t.row.agentId)
  appendFileSync(t.file, prompt('T3'))
  await t.attach.attachSession(t.row)
  expect(t.row.interpretationHold).toBeUndefined()
  expect(t.normalizers.sessionTurnOpen(t.row.sessionId)).toBe(true)
})


it.each([false, true])('preserves the known legacy open turn through a held Stop and recovery (retained=%s)', async retained => {
  const record = (text: string) => JSON.stringify({ type: 'user.message', data: { content: text }, id: text, parentId: '' })
  const t = setup('inline', record('T1') + '\n')
  t.row.engine = 'copilot'
  const normalizer = new CopilotNormalizer()
  normalizer.ingest(record('T1'))
  t.normalizers.copilotNormalizers.set(t.row.sessionId, normalizer)
  if (retained) {
    t.hooks.onTurnStop({ sessionId: t.row.sessionId })
    await vi.waitFor(() => expect(normalizer.turnOpen).toBe(false), { timeout: 3_000 })
    appendFileSync(t.file, record('T2') + '\n')
    normalizer.ingest(record('T2'))
  }
  expect(t.normalizers.sessionTurnOpen(t.row.sessionId)).toBe(true)
  const sent = t.emit.mock.calls.length
  t.hold(); t.hooks.onTurnStop({ sessionId: t.row.sessionId })
  expect(t.normalizers.sessionTurnOpen(t.row.sessionId)).toBe(true)
  expect(normalizer.turnOpen).toBe(true)
  t.recover(); await t.attach.attachSession(t.row)
  expect(t.row.interpretationHold).toContain('Stop could not be matched')
  expect(t.normalizers.sessionTurnOpen(t.row.sessionId)).toBe(true)
  expect(normalizer.turnOpen).toBe(true)
  expect(t.emit).toHaveBeenCalledTimes(sent)
  expect(t.settled).not.toHaveBeenCalled()
})
