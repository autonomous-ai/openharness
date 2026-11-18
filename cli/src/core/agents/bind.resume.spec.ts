import { removeRegistryAgent } from '../../testing/registryFixtures.js'
/** A same-conversation terminal confirmation must follow the identity that supersedes Resume's in-flight attach. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAttach, type AttachDeps } from '../transcripts/attach.js'
import { createBinding } from './bind.js'
import { createHermesTerminal } from './hermesTerminal.js'
import { createSessionNormalizers } from '../transcripts/normalizers.js'
import { createStoreOf } from '../transcripts/stores.js'
import { paneReadIdentity } from '../transcripts/readIdentity.js'
import { createOtherStreams } from '../engines/otherStreams.js'
import { createOtherStreams as createWorkerStreams } from '../../engines/others/streams.js'
import { otherStreamRequests } from '../../engines/others/streamRequests.js'
import { STREAM_OPEN, STREAM_VERSION } from '../../engines/worker/otherStreamProtocol.js'
import { OTHER_ENGINE_STATES } from '../../engines/otherEngines.js'
import type { LiveEvent } from '../../engines/kit/events.js'
import type { registry as Registry } from '../../lib/registry.js'
import { StoppedAgentStore } from '../../lib/stoppedAgents.js'
import { createRelaunchMarks } from '../transcripts/relaunch.js'

const source = ts.createSourceFile('main.ts', readFileSync(join(import.meta.dirname, '../main.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
let initializer: ts.Expression | undefined
const visit = (node: ts.Node): void => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'storeOf') initializer = node.initializer
  ts.forEachChild(node, visit)
}
visit(source)
if (!initializer) throw new Error('missing actual store composition')
const composition = ts.transpileModule(`(${initializer.getText(source)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const sessionId = '20261116_100000_abcdef', agentId = 'resume-hermes'
const firstProcess = { pid: 1041, executable: '/fixture/hermes', startMarker: '2026-11-16T10:00:00Z' }
const nextProcess = { ...firstProcess, pid: 1042, startMarker: '2026-11-16T10:01:00Z' }
let directory: string, registry: typeof Registry
const cleanups: (() => Promise<void>)[] = []
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { run(...params: string[]): void }; close(): void }
}
function writeTurn(text: string, completed = true): void {
  const db = new DatabaseSync(join(directory, 'state.db'))
  try {
    db.prepare('INSERT INTO messages(session_id, role, content) VALUES (?, ?, ?)').run(sessionId, 'user', text)
    if (completed) db.prepare('INSERT INTO messages(session_id, role, content, finish_reason) VALUES (?, ?, ?, ?)').run(sessionId, 'assistant', 'fixture answer', 'stop')
  } finally { db.close() }
}
function finishTurn(): void {
  const db = new DatabaseSync(join(directory, 'state.db'))
  try {
    db.prepare('INSERT INTO messages(session_id, role, content, finish_reason) VALUES (?, ?, ?, ?)').run(sessionId, 'assistant', 'fixture answer', 'stop')
  } finally { db.close() }
}
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'confirm-race-'))
  for (const name of ['ADAPTER_DATA_DIR', 'CLAUDE_PROJECTS_DIR', 'CODEX_HOME', 'CURSOR_HOME', 'HERMES_HOME']) vi.stubEnv(name, directory)
  vi.resetModules()
  registry = (await import('../../lib/registry.js')).registry
  await registry.load()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  ;(await import('../../lib/sqliteBuiltin.js')).closeSqliteHandles()
  vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true })
})

async function setup(boundary: 'terminal' | 'store' | 'open' | 'config' | 'none', pauseConfirmation = false, readerHolds = false, retryMs?: number) {
  ;(await registry.openProcessAgent({ engine: 'hermes', agentId, tmuxPane: '%41', cwd: directory, processIdentity: firstProcess }))
  const saved = { ...(await registry.register({ engine: 'hermes', sessionId, tmuxPane: '%41', cwd: directory, processIdentity: firstProcess }))!.entry }
  await removeRegistryAgent(registry, agentId)
  // The exact registry sequence used by Resume after its new process is confirmed, with no hook.
  ;(await registry.resumePendingAgent(saved, [{ backend: 'tmux', paneId: '%42' }]))
  registry.updateProcessIdentity(agentId, nextProcess)
  const resumed = registry.setLaunch(agentId, { state: 'ready' })!
  expect(resumed.boundAt).toBeNull(); expect(resumed.lastHookAt).toBe(0)
  const entered = deferred(), release = deferred()
  const recordEntered = deferred(), recordRelease = deferred()
  let suspended = false
  const barrier = async (at: string) => {
    if (at === boundary && !suspended) { suspended = true; entered.resolve(); await release.promise }
  }
  const db = new DatabaseSync(join(directory, 'state.db'))
  try {
    db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT,'
      + ' tool_calls TEXT, tool_name TEXT, finish_reason TEXT, reasoning TEXT); CREATE INDEX session_messages ON messages(session_id, id);')
  } finally { db.close() }
  writeTurn('retained history must not replay')
  const events: LiveEvent[] = [], ended = deferred(), closed = new AbortController()
  const worker = createWorkerStreams({ dataDir: directory, watcher: { on: vi.fn(), addSession: vi.fn(), removeSession: vi.fn(), pollSession: vi.fn() } as never })
  const requests = otherStreamRequests({ streams: worker })
  const openRequest = requests[STREAM_OPEN]
  const workerOpen = vi.spyOn(requests, STREAM_OPEN)
  const calls = new Set<Promise<Record<string, unknown>>>()
  const log = vi.fn()
  const others = createOtherStreams({
    bySession: id => registry.bySession(id), reattach: session => { void requestAttach(session, true) }, log, retryMs,
    held: readerHolds ? (session, held, rewritten) => {
      const reasons: readonly string[] = Object.values(OTHER_ENGINE_STATES)
      const latest = registry.byAgent(session.agentId)
      if (!latest || latest.sessionId !== session.sessionId || (latest.identityHold && !reasons.includes(latest.identityHold))) return
      const reason = rewritten === 'lost' ? OTHER_ENGINE_STATES.lost : rewritten ? OTHER_ENGINE_STATES.rewritten : OTHER_ENGINE_STATES.unavailable
      registry.setIdentityHold(session.agentId, held ? reason : undefined)
    } : undefined,
    frame: (_row, frame) => { events.push(...frame.events); if (frame.events.some(event => event.type === 'turn_ended')) ended.resolve() },
    call: async (type, payload) => {
      if (type === STREAM_OPEN) await barrier('open')
      const call = Promise.resolve(requests[type](JSON.parse(JSON.stringify(payload)), { owner: true, local: true }, closed.signal))
      calls.add(call)
      try { return JSON.parse(JSON.stringify(await call)) } finally { calls.delete(call) }
    },
  })
  cleanups.push(async () => { others.stop(); closed.abort(); worker.clear(); await Promise.allSettled(calls) })
  let installed: string | undefined
  vi.spyOn(others, 'forget')
  const open = others.open
  vi.spyOn(others, 'open').mockImplementation(async (row, options) => {
    const result = await open(row, options)
    if (result) installed = paneReadIdentity(row)
    return result
  })
  const locateStore = vi.fn(async () => { await barrier('store'); return { store: join(directory, 'state.db'), home: directory } })
  const storeOf = runInNewContext(composition, { createStoreOf, otherStreams: { locateStore },
    OPENCODE_DB: '/fixture/opencode.db', KILO_DB: '/fixture/kilo.db', DEVIN_DB: '/fixture/devin.db' }, { timeout: 1000 }) as AttachDeps['storeOf']
  const runtimeProfiles = { transcriptFields: () => [], beginHydrate: vi.fn(), hydrate: vi.fn(), hydrateEvidence: vi.fn(),
    ingest: vi.fn(() => false), ingestConfig: vi.fn(async () => { await barrier('config'); return false }), ingestPane: vi.fn(async () => false), capturePane: vi.fn(async () => null) } as AttachDeps['runtimeProfiles']
  const terminalGone = vi.fn(async () => { await barrier('terminal'); return false })
  const relaunchMarks = createRelaunchMarks()
  const normalizers = createSessionNormalizers(others, { held: () => false, closed: vi.fn(), forget: vi.fn() })
  const attach = createAttach({ liveFor: () => undefined, resolve: id => registry.resolve(id),
    terminalGone, normalizers, others, relaunchMarks,
    watcher: { addSession: vi.fn(async () => {}), removeSession: vi.fn(async () => {}), pollSession: vi.fn(async () => {}),
      hold: vi.fn(async () => null), tails: () => false },
    setInterpretationHold: registry.setInterpretationHold.bind(registry), announceSession: vi.fn(),
    cursorDiscovery: { add: vi.fn(async () => {}) },  runtimeProfiles,
    captureTerminal: vi.fn(async () => null), emit: vi.fn(), tokenUsage: { changed: vi.fn() }, questionWatcher: { start: vi.fn() },
    terminalLabel: () => 'fixture', storeOf, concurrency: 1,
  })
  const attempts: Promise<boolean>[] = []
  const requestAttach = vi.fn((...args: Parameters<typeof attach.attachSession>) => {
    const attempt = attach.attachSession(...args); attempts.push(attempt); return attempt
  })
  const readRecord = vi.fn(async () => {
      if (pauseConfirmation) { recordEntered.resolve(); await recordRelease.promise }
      return { state: 'record' as const, sessionId, at: Date.now() }
  })
  const hermesTerminal = createHermesTerminal({ platform: 'darwin', defaultHome: directory, registry,
    paneInfo: async () => ({ tty: '/dev/fixture' } as never), names: () => ['fixture-terminal'], stamp: async () => 'record-1',
    read: readRecord, kind: async () => 'own', endedSince: async () => false,
    storeStamp: async () => 'store-1', recordSeen: vi.fn(), now: Date.now,
  })
  const send = vi.fn()
  const stoppedAgents = new StoppedAgentStore(join(directory, 'stopped-agents'))
  stoppedAgents.save(saved)
  vi.spyOn(stoppedAgents, 'save'); vi.spyOn(stoppedAgents, 'finishResume')
  const forget = (id: string) => { normalizers.forget(id); attach.forget(id) }
  const binding = createBinding({ registry, attachSession: requestAttach, captureReader: attach.captureReader, hermesTerminal,
    followsLive: id => others.follows(id),
    mirror: { inheritSummary: vi.fn() }, forgetSession: async id => { forget(id) }, clients: { send }, announceSession: vi.fn(),
    stoppedAgents, syncRecapPool: vi.fn(),
    input: { forget: vi.fn(), awaitingConfirmation: () => false }, submitAgent: vi.fn(),
    homes: { copilot: directory, grok: directory, agy: directory }, capturePane: async () => null,
    openclawPaneRead: () => false, openclawPaneDue: () => false, openclawStateDir: async () => null,
  })
  const observed = { engine: 'hermes' as const, processIdentity: nextProcess, runtimes: resumed.runtimes,
    primaryRuntimeKey: resumed.primaryRuntimeKey, cwd: directory, args: `hermes --resume ${sessionId}`, resumeSessionId: sessionId }
  const confirm = () => binding.bindObservedAgent(observed)
  const liveTurn = async () => {
    expect(events).toEqual([])
    writeTurn('fresh turn after native confirmation')
    await others.drain(sessionId); await ended.promise
    expect(events.filter(event => event.type === 'turn_started')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ userMessage: 'fresh turn after native confirmation' }) }),
    ])
    expect(events.filter(event => event.type === 'turn_ended')).toHaveLength(1)
    await others.drain(sessionId)
    expect(events.filter(event => event.type === 'turn_started')).toHaveLength(1)
    expect(events.filter(event => event.type === 'turn_ended')).toHaveLength(1)
  }
  return { resumed, attach, requestAttach, confirm, attempts, entered, release, recordEntered, recordRelease, others, locateStore, send, liveTurn, stoppedAgents, terminalGone, relaunchMarks, observed, workerOpen, forget,
    events, readRecord, log, openRequest, pauseRecord: () => { pauseConfirmation = true },
    activeStreams: () => worker.all().length,
    disconnect: () => { others.disconnected(); worker.clear() },
    pauseOpen: () => { boundary = 'open'; suspended = false },
    pause: () => { boundary = 'terminal'; suspended = false },
    installed: () => others.has(sessionId) && worker.all().length === 1 ? installed : undefined }
}

it.each(['terminal', 'store', 'open'] as const)('follows the confirmed same conversation after native evidence supersedes its %s read', async boundary => {
  const t = await setup(boundary), before = paneReadIdentity(t.resumed)
  const first = t.requestAttach(t.resumed)
  await t.entered.promise
  await t.confirm()
  const confirmed = registry.byAgent(agentId)!
  expect(confirmed.sessionId).toBe(sessionId)
  expect(confirmed.hermesHome).toBeNull()
  expect(confirmed.boundAt).not.toBeNull()
  expect(confirmed.lastHookAt).toBeGreaterThan(0)
  expect(paneReadIdentity(confirmed)).not.toBe(before)
  t.release.resolve()
  expect(await first).toBe(false) // The stale attach must still be revoked.
  await Promise.all(t.attempts)
  // The native confirmation that changed authority must ask for a successor; an optional failed read cannot heal itself.
  expect(t.requestAttach).toHaveBeenCalledTimes(2)
  expect(t.installed()).toBe(paneReadIdentity(confirmed))
  expect(t.send).not.toHaveBeenCalled() // Same conversation: no reset or session_synced frame.
  await t.confirm() // The terminal follower settles; ordinary passes must not keep attaching.
  expect(t.requestAttach).toHaveBeenCalledTimes(2)
  expect(t.send).not.toHaveBeenCalled()
  await t.liveTurn()
})

it('can attach when native confirmation precedes the request', async () => {
  const t = await setup('none')
  await t.confirm()
  expect(await t.requestAttach(registry.byAgent(agentId)!)).toBe(true)
  expect(t.installed()).toBe(paneReadIdentity(registry.byAgent(agentId)))
  expect(t.send).not.toHaveBeenCalled()
  await t.liveTurn()
})

it('keeps a completed stream without repeating its saved record or terminal probe on native confirmation', async () => {
  const t = await setup('none')
  expect(await t.requestAttach(t.resumed)).toBe(true)
  expect(t.installed()).toBeDefined()
  t.terminalGone.mockClear()
  await t.confirm()
  await Promise.all(t.attempts)
  expect({ saves: vi.mocked(t.stoppedAgents.save).mock.calls.length, finishes: vi.mocked(t.stoppedAgents.finishResume).mock.calls.length,
    probes: t.terminalGone.mock.calls.length, attachments: t.requestAttach.mock.calls.length }).toEqual({ saves: 0, finishes: 0, probes: 0, attachments: 1 })
  expect(t.installed()).toBeDefined()
  expect(t.others.open).toHaveBeenCalledTimes(1)
  expect(t.others.forget).not.toHaveBeenCalled()
  expect(t.send).not.toHaveBeenCalled()
  await t.confirm()
  expect(t.requestAttach).toHaveBeenCalledTimes(1)
  await t.liveTurn()
})

it('follows a reader installed while its attachment has not completed', async () => {
  const t = await setup('config'), first = t.requestAttach(t.resumed)
  await t.entered.promise
  expect(t.others.ready(sessionId)).toBe(true)
  await t.confirm(); t.release.resolve()
  expect(await first).toBe(false)
  await Promise.all(t.attempts)
  expect(t.requestAttach).toHaveBeenCalledTimes(2)
  expect(t.others.open).toHaveBeenCalledTimes(1)
  await t.liveTurn()
})

it('keeps the current successor behind queued work even with a prior reader', async () => {
  const t = await setup('none')
  expect(await t.requestAttach(t.resumed)).toBe(true)
  t.pause()
  const running = t.requestAttach(t.resumed, true); await t.entered.promise
  const queued = t.requestAttach(t.resumed, true)
  await t.confirm(); t.release.resolve()
  expect(await running).toBe(false); expect(await queued).toBe(false)
  await Promise.all(t.attempts)
  expect(t.requestAttach).toHaveBeenCalledTimes(4)
  await t.liveTurn()
})

it.each(['missing', 'disconnected'] as const)('follows a %s reader instead of trusting its retained state', async state => {
  const t = await setup('none')
  expect(await t.requestAttach(t.resumed)).toBe(true)
  if (state === 'missing') t.others.forget(sessionId)
  else t.others.disconnected()
  expect(t.others.ready(sessionId)).toBe(false)
  await t.confirm(); await Promise.all(t.attempts)
  expect(t.requestAttach).toHaveBeenCalledTimes(2)
  expect(t.stoppedAgents.save).toHaveBeenCalledTimes(1)
  if (state === 'disconnected') {
    t.others.connected()
    await vi.waitFor(() => expect(t.others.ready(sessionId)).toBe(true))
  }
  await t.liveTurn()
})

it.each(['disconnected', 'recovering'] as const)('leaves native confirmation to the next pass while its reader is %s', async state => {
  const t = await setup('none', false, true)
  expect(await t.requestAttach(t.resumed)).toBe(true)
  t.disconnect()
  expect(t.others.follows(sessionId)).toBe(true)
  expect(t.others.ready(sessionId)).toBe(false)
  expect(registry.byAgent(agentId)?.identityHold).toBe(OTHER_ENGINE_STATES.unavailable)
  const reader = t.others.get(sessionId)
  if (state === 'recovering') {
    t.pauseOpen(); t.others.connected()
    await t.entered.promise
  }
  await t.confirm()
  expect(registry.byAgent(agentId)?.boundAt).toBeNull()
  expect(t.requestAttach).toHaveBeenCalledTimes(1)
  if (state === 'disconnected') t.others.connected()
  t.release.resolve()
  await Promise.all(t.attempts)
  await vi.waitFor(() => expect(t.others.ready(sessionId)).toBe(true))
  expect(t.installed()).toBeDefined()
  expect(registry.byAgent(agentId)?.identityHold).toBeUndefined()
  expect(t.send).not.toHaveBeenCalled()
  await t.confirm()
  expect(registry.byAgent(agentId)?.boundAt).not.toBeNull()
  expect(t.others.get(sessionId)).toBe(reader)
  expect(t.requestAttach).toHaveBeenCalledTimes(1)
  expect(t.workerOpen).toHaveBeenCalledTimes(2)
  expect(t.workerOpen.mock.calls[1][0]).toHaveProperty('resume')
  await t.liveTurn()
})

it.each(['gone', 'new hold'] as const)('does not clear a recovered reader hold after committed ownership is %s', async change => {
  const t = await setup('none', false, true)
  expect(await t.requestAttach(t.resumed)).toBe(true)
  t.disconnect()
  t.workerOpen.mockResolvedValueOnce({ version: STREAM_VERSION, error: 'ENGINE_TRANSCRIPT_TOO_LARGE' })
  t.others.connected()
  await vi.waitFor(() => expect(t.others.follows(sessionId)).toBe(false))
  const commit = registry.register.bind(registry)
  vi.spyOn(registry, 'register').mockImplementationOnce(async (...args) => {
    const result = await commit(...args)
    if (change === 'gone') await removeRegistryAgent(registry, agentId)
    else registry.setIdentityHold(agentId, 'independent newer authority')
    return result
  })
  await t.confirm(); await Promise.all(t.attempts)
  expect(t.requestAttach).toHaveBeenCalledTimes(1)
  expect(t.others.ready(sessionId)).toBe(false)
  if (change === 'gone') expect(registry.byAgent(agentId)).toBeUndefined()
  else expect(registry.byAgent(agentId)?.identityHold).toBe('independent newer authority')
})

it.each([false, true])('replaces a given-up reader on native confirmation while its worker stays connected (already confirmed: %s)', async confirmed => {
  const t = await setup('none', false, true)
  expect(await t.requestAttach(t.resumed)).toBe(true)
  if (confirmed) {
    await t.confirm(); await t.confirm()
    expect(registry.byAgent(agentId)?.lastHookAt).toBeGreaterThan(0)
    expect(t.readRecord).toHaveBeenCalledTimes(1)
  }
  t.disconnect()
  t.workerOpen.mockResolvedValueOnce({ version: STREAM_VERSION, error: 'ENGINE_TRANSCRIPT_TOO_LARGE' })
  t.others.connected()
  await vi.waitFor(() => expect(t.others.follows(sessionId)).toBe(false))
  expect(t.others.has(sessionId)).toBe(true)
  expect(t.others.ready(sessionId)).toBe(false)
  const abandoned = t.others.get(sessionId)
  await t.confirm(); await Promise.all(t.attempts)
  await vi.waitFor(() => expect(t.others.ready(sessionId)).toBe(true))
  expect(t.installed()).toBeDefined()
  expect(registry.byAgent(agentId)?.identityHold).toBeUndefined()
  expect(t.others.get(sessionId)).not.toBe(abandoned)
  expect(t.requestAttach).toHaveBeenCalledTimes(2)
  expect(t.workerOpen).toHaveBeenCalledTimes(3)
  expect(t.send).not.toHaveBeenCalled()
  await t.confirm()
  expect(t.workerOpen).toHaveBeenCalledTimes(3)
  if (confirmed) expect(t.readRecord).toHaveBeenCalledTimes(2)
  await t.liveTurn()
})

it.each(['new', 'already working', 'completed offline'] as const)('reconciles only the current Hermes turn after worker loss: %s', async state => {
  const t = await setup('none', false, true)
  if (state === 'already working') writeTurn('acknowledged working turn', false)
  expect(await t.requestAttach(t.resumed)).toBe(true)
  await t.confirm(); await t.confirm()
  expect(t.events).toEqual([]) // Ordinary hydration is silent, including a currently open turn.
  t.disconnect()
  if (state === 'new') writeTurn('turn begun while worker was down', false)
  if (state === 'completed offline') writeTurn('offline completed turn')
  t.others.connected()
  await vi.waitFor(() => expect(t.others.ready(sessionId)).toBe(true))
  await t.others.drain(sessionId)
  const started = state === 'new'
    ? [{ type: 'turn_started', payload: { userMessage: 'turn begun while worker was down' } }]
    : []
  expect(t.events).toEqual(started)
  // A second reconnect sees the acknowledged state; no event is repeated.
  t.disconnect(); t.others.connected()
  await vi.waitFor(() => expect(t.others.ready(sessionId)).toBe(true))
  await t.others.drain(sessionId)
  expect(t.events).toEqual(started)
  expect(t.activeStreams()).toBe(1)
  expect(t.send).not.toHaveBeenCalled()
  if (state !== 'completed offline') {
    finishTurn(); await t.others.drain(sessionId)
    await vi.waitFor(() => expect(t.events.filter(event => event.type === 'turn_ended')).toHaveLength(1))
    await t.others.drain(sessionId)
    expect(t.events.filter(event => event.type === 'turn_ended')).toHaveLength(1)
  }
})

it('rescues a confirmed Hermes after all five connected recovery retries are exhausted', async () => {
  const t = await setup('none', false, true, 1)
  expect(await t.requestAttach(t.resumed)).toBe(true)
  await t.confirm(); await t.confirm()
  t.disconnect()
  // The reconnect's first open and all five bounded retries answer unavailable.
  for (let attempt = 0; attempt < 6; attempt++) t.workerOpen.mockResolvedValueOnce({ version: STREAM_VERSION, error: 'ENGINE_UNAVAILABLE' })
  t.others.connected()
  await vi.waitFor(() => expect(t.log).toHaveBeenCalledWith(expect.stringContaining('after 5 retries')))
  await Promise.all(t.attempts)
  expect(t.others.follows(sessionId)).toBe(false)
  expect(t.activeStreams()).toBe(0)
  await t.confirm(); await Promise.all(t.attempts)
  expect(t.others.ready(sessionId)).toBe(true)
  expect(t.activeStreams()).toBe(1)
  expect(registry.byAgent(agentId)?.identityHold).toBeUndefined()
  expect(t.readRecord).toHaveBeenCalledTimes(2)
  await t.liveTurn()
})

it('refuses a stale native record while rescuing an already confirmed Hermes reader', async () => {
  const t = await setup('none', false, true)
  expect(await t.requestAttach(t.resumed)).toBe(true)
  await t.confirm(); await t.confirm()
  t.disconnect()
  t.workerOpen.mockResolvedValueOnce({ version: STREAM_VERSION, error: 'ENGINE_TRANSCRIPT_TOO_LARGE' })
  t.others.connected()
  await vi.waitFor(() => expect(t.others.follows(sessionId)).toBe(false))
  t.pauseRecord()
  const confirmation = t.confirm()
  await t.recordEntered.promise
  registry.updateProcessIdentity(agentId, { ...nextProcess, startMarker: 'replacement-process' })
  t.recordRelease.resolve(); await confirmation
  expect(t.activeStreams()).toBe(0)
  expect(t.others.ready(sessionId)).toBe(false)
  expect(t.requestAttach).toHaveBeenCalledTimes(1)
  expect(registry.byAgent(agentId)?.identityHold).toBe(OTHER_ENGINE_STATES.unavailable)
})

it('discards a recovered current-turn snapshot when its owner leaves before the reader reply', async () => {
  const t = await setup('none', false, true)
  expect(await t.requestAttach(t.resumed)).toBe(true)
  await t.confirm(); await t.confirm()
  t.disconnect(); writeTurn('new turn for the former owner', false)
  const entered = deferred(), release = deferred()
  t.workerOpen.mockImplementationOnce(async (...args) => {
    const result = await t.openRequest(...args)
    entered.resolve(); await release.promise
    return result
  })
  t.others.connected(); await entered.promise
  t.forget(sessionId); await removeRegistryAgent(registry, agentId)
  release.resolve()
  await t.workerOpen.mock.results[1].value
  await vi.waitFor(() => expect(t.activeStreams()).toBe(0))
  expect(t.events).toEqual([])
  expect(t.others.ready(sessionId)).toBe(false)
  expect(t.requestAttach).toHaveBeenCalledTimes(1)
})

it('does not release unrelated identity evidence when a confirmed reader has given up', async () => {
  const t = await setup('none', false, true)
  expect(await t.requestAttach(t.resumed)).toBe(true)
  await t.confirm(); await t.confirm()
  t.disconnect()
  t.workerOpen.mockResolvedValueOnce({ version: STREAM_VERSION, error: 'ENGINE_TRANSCRIPT_TOO_LARGE' })
  t.others.connected()
  await vi.waitFor(() => expect(t.others.follows(sessionId)).toBe(false))
  registry.setIdentityHold(agentId, 'private native evidence hold')
  await t.confirm(); await Promise.all(t.attempts)
  expect(registry.byAgent(agentId)?.identityHold).toBe('private native evidence hold')
  expect(t.others.ready(sessionId)).toBe(false)
  expect(t.requestAttach).toHaveBeenCalledTimes(1)
  expect(t.activeStreams()).toBe(0)
})

it.each(['forgotten', 'different conversation'] as const)('discards a recovering reader after its owner is %s', async change => {
  const t = await setup('none', false, true)
  expect(await t.requestAttach(t.resumed)).toBe(true)
  t.disconnect(); t.pauseOpen(); t.others.connected()
  await t.entered.promise
  await t.confirm()
  t.forget(sessionId); await removeRegistryAgent(registry, agentId)
  if (change === 'different conversation') {
    ;(await registry.openProcessAgent({ engine: 'hermes', agentId, tmuxPane: '%42', cwd: directory, processIdentity: nextProcess }))
    ;(await registry.register({ engine: 'hermes', sessionId: '20261116_100001_abcdef', tmuxPane: '%42', cwd: directory, processIdentity: nextProcess }))
  }
  t.release.resolve()
  await vi.waitFor(() => expect(t.workerOpen).toHaveBeenCalledTimes(2))
  await t.workerOpen.mock.results[1].value
  await vi.waitFor(() => expect(t.activeStreams()).toBe(0))
  expect(t.others.ready(sessionId)).toBe(false)
  expect(t.others.follows(sessionId)).toBe(false)
  expect(t.requestAttach).toHaveBeenCalledTimes(1)
  expect(registry.byAgent(agentId)?.sessionId).toBe(change === 'forgotten' ? undefined : '20261116_100001_abcdef')
})

it('follows native confirmation that also changes its route', async () => {
  const t = await setup('none')
  expect(await t.requestAttach(t.resumed)).toBe(true)
  t.observed.runtimes = [{ backend: 'tmux', paneId: '%43' }]; t.observed.primaryRuntimeKey = 'tmux:%43'
  await t.confirm(); await Promise.all(t.attempts)
  expect(t.requestAttach).toHaveBeenCalledTimes(2)
  await t.liveTurn()
})

it.each(['home', 'process', 'cwd', 'evidence', 'forgotten lifetime', 'retained turn', 'relaunch', 'identity hold', 'interpretation hold'] as const)(
  'revokes a captured completed reader after %s changes', async change => {
    const t = await setup('none')
    expect(await t.requestAttach(t.resumed)).toBe(true)
    const keep = t.attach.captureReader(registry.byAgent(agentId)!)
    if (change === 'home') registry.setHermesHome(agentId, join(directory, 'profile'))
    else if (change === 'process') registry.updateProcessIdentity(agentId, { ...nextProcess, pid: 1043 })
    else if (change === 'cwd') registry.setCwd(agentId, join(directory, 'other'))
    else if (change === 'forgotten lifetime') t.attach.forget(sessionId)
    else if (change === 'retained turn') t.attach.afterStop(registry.byAgent(agentId)!)
    else if (change === 'relaunch') t.relaunchMarks.note(sessionId, 0, true)
    else {
      const row = registry.byAgent(agentId)!
      if (change === 'identity hold') registry.setIdentityHold(agentId, 'private fixture hold')
      else if (change === 'interpretation hold') registry.setInterpretationHold(agentId, row.evidenceRevision, 'private fixture hold', true)
      else row.evidenceRevision = (row.evidenceRevision ?? 0) + 1
    }
    const row = registry.byAgent(agentId)!
    const confirmed = (await registry.register({ engine: 'hermes', sessionId, runtimes: row.runtimes,
      primaryRuntimeKey: row.primaryRuntimeKey, cwd: row.cwd ?? undefined, processIdentity: row.processIdentity!, hookEvent: 'HermesTerminal' }))!.entry
    expect(keep(confirmed)).toBe(false)
  },
)

it.each(['forgotten', 'different conversation'] as const)('does not follow stale native confirmation after the row is %s', async change => {
  const t = await setup('store', true)
  const first = t.requestAttach(t.resumed); await t.entered.promise
  const confirming = t.confirm(); await t.recordEntered.promise
  t.attach.forget(sessionId); await removeRegistryAgent(registry, agentId)
  if (change === 'different conversation') {
    ;(await registry.openProcessAgent({ engine: 'hermes', agentId, tmuxPane: '%42', cwd: directory, processIdentity: nextProcess }))
    ;(await registry.register({ engine: 'hermes', sessionId: '20261116_100001_abcdef', tmuxPane: '%42', cwd: directory, processIdentity: nextProcess }))
  }
  t.recordRelease.resolve(); await confirming
  t.release.resolve()
  expect(await first).toBe(false)
  expect(t.requestAttach).toHaveBeenCalledTimes(1)
  expect(t.installed()).toBeUndefined()
  expect(registry.byAgent(agentId)?.sessionId).toBe(change === 'forgotten' ? undefined : '20261116_100001_abcdef')
})
