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
import { STREAM_OPEN } from '../../engines/worker/otherStreamProtocol.js'
import type { LiveEvent } from '../../engines/kit/events.js'
import type { registry as Registry } from '../../lib/registry.js'
import { StoppedAgentStore } from '../../lib/stoppedAgents.js'

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
function writeTurn(text: string): void {
  const db = new DatabaseSync(join(directory, 'state.db'))
  try {
    db.prepare('INSERT INTO messages(session_id, role, content) VALUES (?, ?, ?)').run(sessionId, 'user', text)
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
  registry.load()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  ;(await import('../../lib/sqliteBuiltin.js')).closeSqliteHandles()
  vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true })
})

function setup(boundary: 'terminal' | 'store' | 'open' | 'none', pauseConfirmation = false) {
  registry.openProcessAgent({ engine: 'hermes', agentId, tmuxPane: '%41', cwd: directory, processIdentity: firstProcess })
  const saved = { ...registry.register({ engine: 'hermes', sessionId, tmuxPane: '%41', cwd: directory, processIdentity: firstProcess })!.entry }
  registry.removeAgent(agentId)
  // The exact registry sequence used by Resume after its new process is confirmed, with no hook.
  registry.resumePendingAgent(saved, [{ backend: 'tmux', paneId: '%42' }])
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
  const calls = new Set<Promise<Record<string, unknown>>>()
  const others = createOtherStreams({
    bySession: id => registry.bySession(id), reattach: vi.fn(), log: vi.fn(),
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
    ingest: vi.fn(() => false), ingestConfig: vi.fn(async () => false), ingestPane: vi.fn(async () => false), capturePane: vi.fn(async () => null) } as AttachDeps['runtimeProfiles']
  const terminalGone = vi.fn(async () => { await barrier('terminal'); return false })
  const attach = createAttach({ liveFor: () => undefined, resolve: id => registry.resolve(id),
    terminalGone, normalizers: createSessionNormalizers(others), others,
    watcher: { addSession: vi.fn(async () => {}), removeSession: vi.fn(async () => {}), pollSession: vi.fn(async () => {}),
      hold: vi.fn(async () => null), tails: () => false },
    setInterpretationHold: registry.setInterpretationHold.bind(registry), announceSession: vi.fn(),
    cursorDiscovery: { add: vi.fn(async () => {}) }, device: () => undefined, runtimeProfiles,
    captureTerminal: vi.fn(async () => null), emit: vi.fn(), tokenUsage: { changed: vi.fn() }, questionWatcher: { start: vi.fn() },
    terminalLabel: () => 'fixture', storeOf, concurrency: 1,
  })
  const attempts: Promise<boolean>[] = []
  const requestAttach = vi.fn((...args: Parameters<typeof attach.attachSession>) => {
    const attempt = attach.attachSession(...args); attempts.push(attempt); return attempt
  })
  const hermesTerminal = createHermesTerminal({ platform: 'darwin', defaultHome: directory, registry,
    paneInfo: async () => ({ tty: '/dev/fixture' } as never), names: () => ['fixture-terminal'], stamp: async () => 'record-1',
    read: async () => {
      if (pauseConfirmation) { recordEntered.resolve(); await recordRelease.promise }
      return { state: 'record', sessionId, at: Date.now() }
    }, kind: async () => 'own', endedSince: async () => false,
    storeStamp: async () => 'store-1', recordSeen: vi.fn(), now: Date.now,
  })
  const send = vi.fn()
  const stoppedAgents = new StoppedAgentStore(join(directory, 'stopped-agents'))
  stoppedAgents.save(saved)
  vi.spyOn(stoppedAgents, 'save'); vi.spyOn(stoppedAgents, 'finishResume')
  const binding = createBinding({ registry, attachSession: requestAttach, hermesTerminal,
    mirror: { inheritSummary: vi.fn() }, forgetSession: id => attach.forget(id), clients: { send }, announceSession: vi.fn(),
    stoppedAgents, syncRecapPool: vi.fn(),
    input: { forget: vi.fn(), awaitingConfirmation: () => false }, submitAgent: vi.fn(), deviceInput: { forget: vi.fn() },
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
  return { resumed, attach, requestAttach, confirm, attempts, entered, release, recordEntered, recordRelease, others, locateStore, send, liveTurn, stoppedAgents, terminalGone,
    installed: () => others.has(sessionId) && worker.all().length === 1 ? installed : undefined }
}

it.each(['terminal', 'store', 'open'] as const)('follows the confirmed same conversation after native evidence supersedes its %s read', async boundary => {
  const t = setup(boundary), before = paneReadIdentity(t.resumed)
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
  const t = setup('none')
  await t.confirm()
  expect(await t.requestAttach(registry.byAgent(agentId)!)).toBe(true)
  expect(t.installed()).toBe(paneReadIdentity(registry.byAgent(agentId)))
  expect(t.send).not.toHaveBeenCalled()
  await t.liveTurn()
})

it('keeps a completed stream without repeating its saved record or terminal probe on native confirmation', async () => {
  const t = setup('none')
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
  await t.liveTurn()
})

it.each(['forgotten', 'different conversation'] as const)('does not follow stale native confirmation after the row is %s', async change => {
  const t = setup('store', true)
  const first = t.requestAttach(t.resumed); await t.entered.promise
  const confirming = t.confirm(); await t.recordEntered.promise
  t.attach.forget(sessionId); registry.removeAgent(agentId)
  if (change === 'different conversation') {
    registry.openProcessAgent({ engine: 'hermes', agentId, tmuxPane: '%42', cwd: directory, processIdentity: nextProcess })
    registry.register({ engine: 'hermes', sessionId: '20261116_100001_abcdef', tmuxPane: '%42', cwd: directory, processIdentity: nextProcess })
  }
  t.recordRelease.resolve(); await confirming
  t.release.resolve()
  expect(await first).toBe(false)
  expect(t.requestAttach).toHaveBeenCalledTimes(1)
  expect(t.installed()).toBeUndefined()
  expect(registry.byAgent(agentId)?.sessionId).toBe(change === 'forgotten' ? undefined : '20261116_100001_abcdef')
})
