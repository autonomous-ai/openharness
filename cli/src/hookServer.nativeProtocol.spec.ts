/** Versioned ingress on private HTTP, Registry and catalog roots. Kernel identity
 * and fsync scheduling are injected; no daemon, real engine or tmux is contacted. */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nativeHookAcknowledgement } from './engines/kit/nativeHookClientProtocol.js'
import { nativeHookOutboxShard } from './engines/kit/nativeHookOutbox.js'
import { encodeNativeHookOriginHeader, inspectNativeHookOrigin } from './engines/kit/nativeHookOrigin.js'
import type { HookServerHandlers, HookServerOptions } from './hookServer.js'

const fault = vi.hoisted(() => ({ unavailable: false, afterRetain: undefined as (() => void) | undefined,
  afterFinish: undefined as (() => void) | undefined, beforeFinish: undefined as (() => Promise<void>) | undefined,
  beforeSnapshot: undefined as (() => void) | undefined, beforeRetain: undefined as (() => void) | undefined }))
vi.mock('node:fs', async original => ({ ...await original<object>(),
  fsync: (_fd: number, done: (error: Error | null) => void) => queueMicrotask(() => done(fault.unavailable ? Error('fixture confirmation unavailable') : null)),
}))
vi.mock('./engines/kit/nativeHookWriter.js', async original => ({ ...await original<object>(),
  nativeHookWriterDead: async () => false,
  captureNativeHookWriter: async (root: string) => (await import('./testing/nativeHookWriterFixture.js')).fixtureNativeHookWriter(root),
}))
vi.mock('./engines/kit/nativeHookJournal.js', async original => {
  const actual = await original<typeof import('./engines/kit/nativeHookJournal.js')>()
  return { ...actual, createNativeHookJournal: (...args: Parameters<typeof actual.createNativeHookJournal>) => {
    const journal = actual.createNativeHookJournal(...args)
    return { ...journal, snapshot: async (...input: Parameters<typeof journal.snapshot>) => {
      fault.beforeSnapshot?.(); return journal.snapshot(...input)
    },
      retain: async (...input: Parameters<typeof journal.retain>) => {
      fault.beforeRetain?.()
      const delivery = await journal.retain(...input); fault.afterRetain?.(); return delivery
    }, claim: async (...input: Parameters<typeof journal.claim>) => {
      const claim = await journal.claim(...input)
      return { ...claim, finish: async (...result: Parameters<typeof claim.finish>) => {
        await fault.beforeFinish?.(); await claim.finish(...result); fault.afterFinish?.()
      } }
    } }
  } }
})
vi.mock('./lib/bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))
vi.mock('./lib/processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))
const sessionId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', boot = 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const delivery = { id: 'fixture-versioned-delivery-01', firedAt: 1_000 }
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const origin = { version: 1, boot, callerPid: 5101, ancestry: [
  { pid: 5101, parentPid: 5100, birth: '12346', identityV1: digest('caller') },
  { pid: 5100, parentPid: 1, birth: '12345', identityV1: digest('engine') },
] }
const key = `${boot}\u0000codex\u00005100\u000012345`
let root: string, agentId: string, server: Server | undefined, live: boolean
let registry: typeof import('./lib/registry.js')['registry']
const directory = () => join(root, 'data', 'native-hook-deliveries')
const records = () => readdirSync(directory()).filter(name => /^\.native-hook-effects-\d{3}\.history$/.test(name))
  .flatMap(name => readdirSync(join(directory(), name)).sort().map(file => JSON.parse(readFileSync(join(directory(), name, file), 'utf8'))))
const body = (extra: Record<string, unknown> = {}) => ({ engine: 'codex', sessionId, tmuxPane: '%1', cwd: root,
  transcriptPath: join(root, 'codex', 'sessions', `rollout-${sessionId}.jsonl`), hookEvent: 'SessionStart', callerPid: 5101,
  nativeOrigin: structuredClone(origin), ...extra })
const receipt = (raw: string, outcome: 'owned' | 'complete') => nativeHookAcknowledgement(delivery,
  { name: 'registration', path: '/api/hook/session-start', body: raw }, outcome)
async function close() {
  if (server) await new Promise<void>((done, fail) => server!.close(error => error ? fail(error) : done()))
  server = undefined
}
beforeEach(async () => {
  live = true; fault.unavailable = false; fault.afterRetain = undefined; fault.afterFinish = undefined
  fault.beforeFinish = undefined; fault.beforeSnapshot = undefined; fault.beforeRetain = undefined
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-protocol-http-')))
  for (const [name, value] of Object.entries({ HOME: join(root, 'home'), ADAPTER_DATA_DIR: join(root, 'data'),
    ADAPTER_RUNTIME_DIR: join(root, 'runtime'), CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude') })) {
    mkdirSync(value, { recursive: true, mode: 0o700 }); vi.stubEnv(name, value)
  }
  mkdirSync(join(root, 'codex', 'sessions'), { mode: 0o700 })
  writeFileSync(body().transcriptPath, JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: root, source: 'cli' } }) + '\n')
  writeFileSync(join(root, 'data', 'engine-homes.json'), '{}')
  vi.resetModules()
  ;({ registry } = await import('./lib/registry.js'))
  agentId = registry.openProcessAgent({ engine: 'codex', tmuxPane: '%1', cwd: root,
    processIdentity: { pid: 5100, startMarker: 'fixture-start', executable: '<codex>' } })!.entry.agentId
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  fault.unavailable = false
  await close()
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.doUnmock('./engines/kit/nativeHookStorage.js'); vi.resetModules()
  rmSync(root, { recursive: true, force: true })
})
async function fixture(overrides: Partial<HookServerHandlers> = {}, capacity = 65_536, requestedPort = 0,
  options: Pick<HookServerOptions, 'nativeClientReplay'> = {}) {
  const { startHookServer } = await import('./hookServer.js'), { readHookCredential } = await import('./lib/hookAuth.js')
  const registered = vi.fn(), stopped = vi.fn(), capture = vi.fn(async () => { throw Error('live ancestry cannot replace original origin') })
  const resolved = vi.fn(async () => live ? registry.byAgent(agentId) ?? null : null)
  const started = await startHookServer(requestedPort, { onRegistered: registered, onSessionEnd() {}, onTurnStop: stopped,
    captureNativeHookCaller: capture, resolveHookAgent: resolved,
    readNativeHookOwner: async (_row, expected) => {
      if (!live || expected && expected.key !== key) throw Error('fixture original engine unavailable')
      return { key, evidence: 'fixture-precise-native-process', verify() { if (!live) throw Error('fixture process exited') } }
    }, ...overrides,
  }, { deferNativeRecovery: true, admissionReceiptCapacity: capacity, ...options })
  server = started.server
  const post = async (raw: string = JSON.stringify(body()), headers: Record<string, string | null> = {}, path = '/api/native-hook/v1/session-start') => {
    const sent: Record<string, string | null> = { 'content-type': 'application/json', 'x-harness-hook-token': readHookCredential(join(root, 'data'))!,
      'x-harness-hook-delivery-id': delivery.id, 'x-harness-hook-fired-at': String(delivery.firedAt), ...headers }
    const response = await fetch(`http://127.0.0.1:${started.port}${path}`, { method: 'POST',
      headers: Object.fromEntries(Object.entries(sent).filter((entry): entry is [string, string] => entry[1] !== null)), body: raw })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  const settle = async (raw = JSON.stringify(body())) => {
    let last: Awaited<ReturnType<typeof post>> | undefined
    await vi.waitFor(async () => {
      last = await post(raw)
      expect(last).toEqual({ status: 200, body: receipt(raw, 'complete') })
    }, { timeout: 8_000, interval: 100 })
    return last!
  }
  return { post, settle, registered, stopped, resolved, capture, started }
}

it('takes a legacy origin header after its caller exits while still requiring fresh native engine proof', async () => {
  const proof = vi.fn<NonNullable<HookServerHandlers['readNativeHookOwner']>>(async () =>
    ({ key, evidence: 'fixture-precise-native-process', verify() {} }))
  const f = await fixture({ readNativeHookOwner: proof })
  const { nativeOrigin: _origin, ...legacy } = body()
  const header = encodeNativeHookOriginHeader(inspectNativeHookOrigin(origin))
  await vi.waitFor(async () => {
    expect(await f.post(JSON.stringify(legacy), { 'x-harness-hook-origin': header }, '/api/hook/session-start'))
      .toEqual({ status: 200, body: { ok: true } })
  }, { timeout: 4_000 })
  expect(f.registered).toHaveBeenCalledOnce()
  expect(f.capture).not.toHaveBeenCalled()
  expect(proof).toHaveBeenCalled()
  expect(proof.mock.calls[0][1]).toEqual({ key, identityV1: digest('engine'), source: 'caller' })
  proof.mockRejectedValue(Error('fixture engine was replaced'))
  expect(await f.post(JSON.stringify(legacy), { 'x-harness-hook-origin': header,
    'x-harness-hook-delivery-id': 'fixture-header-new-delivery' }, '/api/hook/session-start'))
    .toMatchObject({ status: 202, body: { pending: false, retry: true, detail: expect.stringContaining('engine was replaced') } })
  expect(f.registered).toHaveBeenCalledOnce()
  expect(f.capture).not.toHaveBeenCalled()
}, 10_000)

it.each(['session-start', 'turn-stop', 'turn-start', 'tool-start', 'session-end'])('holds unavailable legacy origin on %s without retaining or recapturing it', async path => {
  const held = vi.fn(), prompt = vi.fn(), f = await fixture({ onAdmissionHeld: held, onPromptSubmitted: prompt })
  const { nativeOrigin: _origin, ...legacy } = body()
  expect(await f.post(JSON.stringify(legacy), { 'x-harness-hook-origin': 'unavailable-v1' }, `/api/hook/${path}`))
    .toMatchObject({ status: 202, body: { pending: false, retry: true, detail: expect.stringContaining('not retained') } })
  expect(f.capture).not.toHaveBeenCalled()
  expect(f.resolved).not.toHaveBeenCalled()
  expect(f.registered).not.toHaveBeenCalled()
  expect(f.stopped).not.toHaveBeenCalled()
  expect(held).not.toHaveBeenCalled()
  expect(prompt).not.toHaveBeenCalled()
  expect(readdirSync(join(root, 'data'))).not.toContain('native-hook-deliveries')
})

it.each(['malformed', 'conflicting body', 'different caller'])('rejects a %s legacy origin header before any owner resolution', async problem => {
  const f = await fixture(), input: Record<string, unknown> = body()
  if (problem !== 'conflicting body') delete input.nativeOrigin
  if (problem === 'different caller') input.callerPid = 5200
  const header = problem === 'malformed' ? 'invalid' : encodeNativeHookOriginHeader(inspectNativeHookOrigin(origin))
  expect(await f.post(JSON.stringify(input), { 'x-harness-hook-origin': header }, '/api/hook/session-start'))
    .toEqual({ status: 400, body: { error: 'invalid hook body' } })
  expect(f.capture).not.toHaveBeenCalled()
  expect(f.resolved).not.toHaveBeenCalled()
})

it('confirms exact retained wire identity and recovers a lost completed reply after engine exit and row removal', async () => {
  const f = await fixture(), raw = JSON.stringify(body())
  // This is a ready core. Its live-owner recovery repairs interrupted namespace
  // initialization; the receipt-only reader must never acquire that authority.
  f.started.startRecovery()
  await f.settle(raw)
  expect(f.registered).toHaveBeenCalledOnce(); expect(f.capture).not.toHaveBeenCalled()
  const retained = records().find(record => record.event.kind === 'intake').event.intake
  expect(retained.wire).toEqual({ version: 1, path: '/api/native-hook/v1/session-start', bodySha256: digest(raw) })
  await close(); registry.removeAgent(agentId); live = false
  const restarted = await fixture()
  expect(await restarted.post(raw)).toEqual({ status: 200, body: receipt(raw, 'complete') })
  expect(restarted.resolved).not.toHaveBeenCalled(); expect(restarted.capture).not.toHaveBeenCalled()
  expect(restarted.registered).not.toHaveBeenCalled()
  expect(await restarted.post(raw + ' ')).toMatchObject({ status: 409, body: { error: 'HOOK_DELIVERY_CONFLICT' } })
  expect(records().filter(record => record.event.kind === 'intake')).toHaveLength(1)
}, 20_000)

it('holds an interrupted namespace until live-owner recovery seals it, then completes the original delivery once', async () => {
  const f = await fixture(), raw = JSON.stringify(body())
  fault.beforeSnapshot = () => {
    fault.beforeSnapshot = undefined
    throw Error('fixture initialization interrupted after allocation')
  }
  expect(await f.post(raw)).toMatchObject({ status: 202, body: { retry: true,
    detail: expect.stringContaining('fixture initialization interrupted after allocation') } })
  const before = readdirSync(directory(), { recursive: true }).map(String).sort()
  expect(before.filter(name => /^\.native-hook-effects-\d{3}\.allocation\.witness$/.test(name))).toHaveLength(1)
  expect(before.filter(name => /^\.native-hook-effects-\d{3}\.seal(?:\.witness)?$/.test(name))).toEqual([])
  expect(await f.post(raw)).toMatchObject({ status: 202, body: { retry: true,
    detail: expect.stringContaining('the receipt namespace is not sealed') } })
  expect(readdirSync(directory(), { recursive: true }).map(String).sort()).toEqual(before)
  expect(f.registered).not.toHaveBeenCalled()
  f.started.startRecovery()
  await f.settle(raw)
  expect(f.registered).toHaveBeenCalledOnce()
  expect(records().filter(record => record.event.kind === 'intake')).toHaveLength(1)
  expect(f.capture).not.toHaveBeenCalled()
}, 20_000)

it.each(['snapshot', 'retain'] as const)('retries a locally held prompt after initial %s failure without another client request', async boundary => {
  const held = vi.fn(), prompt = vi.fn(), f = await fixture({ onAdmissionHeld: held, onPromptSubmitted: prompt })
  const raw = JSON.stringify(body({ hookEvent: 'UserPromptSubmit', prompt: 'retained original prompt' }))
  const unavailable = () => { throw Error('fixture initial intake unavailable') }
  if (boundary === 'snapshot') fault.beforeSnapshot = unavailable
  else fault.beforeRetain = unavailable
  expect(await f.post(raw, {}, '/api/hook/session-start')).toMatchObject({ status: 202,
    body: { pending: false, retry: true, detail: expect.stringContaining('fixture initial intake unavailable') } })
  expect(f.registered).not.toHaveBeenCalled()
  expect(held).toHaveBeenCalledWith(agentId, expect.stringContaining('fixture initial intake unavailable'))
  fault.beforeSnapshot = undefined; fault.beforeRetain = undefined
  f.started.startRecovery()
  // A legacy hook has exited after its response budget. No client retry is
  // available to reintroduce the prompt that this core already received.
  await vi.waitFor(() => expect(prompt).toHaveBeenCalledExactlyOnceWith(agentId, 'retained original prompt'), { timeout: 8_000 })
  await vi.waitFor(() => expect(f.started.recoveryReady(registry.byAgent(agentId)!)).toBe(true), { timeout: 8_000 })
  expect(f.registered).toHaveBeenCalledOnce()
  expect(records().filter(record => record.event.kind === 'intake')).toHaveLength(1)
  expect(f.capture).not.toHaveBeenCalled()
}, 20_000)

it('bounds locally held intake and preserves its first arrival order across later requests', async () => {
  const prompt = vi.fn(), f = await fixture({ onPromptSubmitted: prompt }, 2)
  fault.beforeRetain = () => { throw Error('fixture first intake unavailable') }
  const raw = (prompt: string) => JSON.stringify(body({ hookEvent: 'UserPromptSubmit', prompt }))
  expect(await f.post(raw('first'), {}, '/api/hook/session-start')).toMatchObject({ status: 202, body: { retry: true } })
  const second = { 'x-harness-hook-delivery-id': 'fixture-local-second-intake', 'x-harness-hook-fired-at': '2000' }
  expect(await f.post(raw('second'), second, '/api/hook/session-start')).toMatchObject({ status: 202, body: { retry: true } })
  expect(await f.post(raw('overflow'), { 'x-harness-hook-delivery-id': 'fixture-local-overflow-intake' }, '/api/hook/session-start'))
    .toMatchObject({ status: 429, body: { pending: false, error: 'HOOK_ADMISSION_BUSY' } })
  expect(f.started.recoveryReady(registry.byAgent(agentId)!)).toBe(false)
  fault.beforeRetain = undefined
  f.started.startRecovery()
  await vi.waitFor(() => expect(prompt.mock.calls.map(call => call[1])).toEqual(['first', 'second']), { timeout: 8_000 })
  await vi.waitFor(() => expect(f.started.recoveryReady(registry.byAgent(agentId)!)).toBe(true), { timeout: 8_000 })
  expect(records().filter(record => record.event.kind === 'intake').map(record => record.event.intake.id))
    .toEqual([delivery.id, second['x-harness-hook-delivery-id']])
}, 20_000)

it.each(['equal', 'absent'] as const)('recovers cold durable intake before a later local request with %s native time without another client request', async time => {
  const headers: Record<string, string | null> = time === 'absent' ? { 'x-harness-hook-fired-at': null } : {}
  const raw = (prompt: string) => JSON.stringify(body({ hookEvent: 'UserPromptSubmit', prompt }))
  const before = await fixture({ hookAdmissionBlocked: () => true })
  expect(await before.post(raw('retained first'), headers, '/api/hook/session-start'))
    .toMatchObject({ status: 200, body: { pending: true } })
  await close()
  const prompt = vi.fn(), after = await fixture({ onPromptSubmitted: prompt })
  expect(await after.post(raw('arrived after restart'), { ...headers,
    'x-harness-hook-delivery-id': 'fixture-after-restart-intake' }, '/api/hook/session-start'))
    .toMatchObject({ status: 200, body: { pending: true } })
  after.started.startRecovery()
  await vi.waitFor(() => expect(prompt.mock.calls.map(call => call[1])).toEqual(['retained first', 'arrived after restart']), { timeout: 8_000 })
  await vi.waitFor(() => expect(after.started.recoveryReady(registry.byAgent(agentId)!)).toBe(true), { timeout: 8_000 })
  expect(after.registered).toHaveBeenCalledTimes(2)
}, 20_000)

it('does not transfer unpersisted local intake to a replacement process', async () => {
  let currentKey = key
  const prompt = vi.fn(), f = await fixture({ onPromptSubmitted: prompt,
    readNativeHookOwner: async (_row, expected) => {
      if (expected && expected.key !== currentKey) throw Error('fixture original process changed')
      return { key: currentKey, evidence: 'fixture-precise-native-process', verify() {} }
    },
  })
  fault.beforeSnapshot = () => { throw Error('fixture initial snapshot unavailable') }
  expect(await f.post(JSON.stringify(body({ hookEvent: 'UserPromptSubmit', prompt: 'original' })), {}, '/api/hook/session-start'))
    .toMatchObject({ status: 202, body: { pending: false, retry: true } })
  currentKey = `${boot}\u0000codex\u00005100\u000067890`
  expect(registry.updateProcessIdentity(agentId, { pid: 5100, startMarker: 'fixture-replacement', executable: '<codex>' })).toBe(true)
  fault.beforeSnapshot = undefined
  f.started.startRecovery()
  await vi.waitFor(() => expect(f.started.recoveryReady(registry.byAgent(agentId)!)).toBe(true), { timeout: 8_000 })
  const replacement = structuredClone(origin); replacement.ancestry[1].birth = '67890'
  const raw = JSON.stringify(body({ hookEvent: 'UserPromptSubmit', prompt: 'replacement', nativeOrigin: replacement }))
  expect(await f.post(raw, { 'x-harness-hook-delivery-id': 'fixture-replacement-intake' }, '/api/hook/session-start'))
    .toMatchObject({ status: 200 })
  await vi.waitFor(() => expect(prompt.mock.calls.map(call => call[1])).toEqual(['replacement']), { timeout: 8_000 })
  expect(f.registered).toHaveBeenCalledOnce()
}, 20_000)

it('starts retained client replay only after readiness and recovers a held registration across core restart', async () => {
  const first = await fixture({ hookAdmissionBlocked: () => true }), raw = JSON.stringify(body())
  const { openNativeHookStorage } = await import('./engines/kit/nativeHookStorage.js')
  const helpers = { prepare: () => { throw Error('fixture cannot prepare a host binary') }, invalidate() {} }
  mkdirSync(directory(), { mode: 0o700, recursive: true })
  const client = await openNativeHookStorage(directory(), helpers), shard = nativeHookOutboxShard(delivery.id)
  try {
    await (await client.outbox(shard)).retain({ ...delivery, port: first.started.port,
      phases: [{ name: 'registration', path: '/api/hook/session-start', body: body() }] })
    expect(await first.post(raw)).toEqual({ status: 200, body: receipt(raw, 'owned') })
  } finally { await client.close() }
  const port = first.started.port
  await close()
  const transport = await import('./engines/kit/nativeHookTransport.js'), send = transport.sendNativeHookRequest
  const replies: { elapsed: number; result: unknown; budget: number | undefined }[] = [], requestedBudgets: number[] = []
  vi.spyOn(transport, 'sendNativeHookRequest').mockImplementation(async (...args) => {
    const began = performance.now(), result = await send(...args)
    replies.push({ elapsed: performance.now() - began, result, budget: args[3] }); return result
  })
  const replay = await import('./engines/kit/nativeHookReplay.js'), createReplay = replay.createNativeHookReplay
  let completed = false
  vi.spyOn(replay, 'createNativeHookReplay').mockImplementation(deps => createReplay({ ...deps, send(...args) {
    requestedBudgets.push(args[2]); return deps.send(...args)
  }, onHeld(...args) {
    deps.onHeld(...args)
    if (args[0] === shard && args[1] === delivery.id && args[2] === undefined) completed = true
  } }))
  const restarted = await fixture({}, 65_536, port, { nativeClientReplay: true }), observer = await openNativeHookStorage(directory(), helpers)
  const responses: unknown[] = []
  restarted.started.server.on('request', (request, response) => {
    const began = performance.now()
    response.once('finish', () => responses.push({ event: 'finish', elapsed: performance.now() - began, status: response.statusCode }))
    response.once('close', () => responses.push({ event: 'close', elapsed: performance.now() - began, status: response.statusCode }))
  })
  try {
    const snapshot = async () => {
      const read = (await observer.readOutbox(shard))!
      try { return await read.snapshot() } finally { await read.close() }
    }
    expect((await snapshot()).deliveries.get(delivery.id)!.phases[0].acknowledged).toBe(false)
    expect(restarted.registered).not.toHaveBeenCalled()
    restarted.started.startRecovery()
    await vi.waitFor(async () => {
      // Observe real replay completion without becoming a competing disk writer.
      // Presence alone would let the final observer confirm an ACK whose writer
      // expired; completion proves the retry itself confirmed it within budget.
      expect(completed, JSON.stringify({
        registrations: restarted.registered.mock.calls.length,
        holds: vi.mocked(console.warn).mock.calls.slice(-8),
        replies, responses,
      })).toBe(true)
      expect(restarted.registered).toHaveBeenCalledOnce()
    }, { timeout: 12_000, interval: 200 })
    expect(replies.map(reply => reply.budget)).toEqual(requestedBudgets)
    expect((await snapshot()).deliveries.get(delivery.id)!.phases[0].acknowledged).toBe(true)
    expect(records().filter(record => record.event.kind === 'intake')).toHaveLength(1)
    expect(restarted.capture).not.toHaveBeenCalled()
  } finally { await observer.close() }
}, 25_000)

it('recovers server intake while unavailable client outboxes remain inactive by default', async () => {
  const storage = await import('./engines/kit/nativeHookStorage.js'), open = storage.openNativeHookStorage
  const readOutbox = vi.fn(async () => { throw Error('fixture client outboxes unavailable') })
  vi.spyOn(storage, 'openNativeHookStorage').mockImplementation(async (...args) => ({ ...await open(...args), readOutbox }))
  const first = await fixture({ hookAdmissionBlocked: () => true }), raw = JSON.stringify(body())
  expect(await first.post(raw)).toEqual({ status: 200, body: receipt(raw, 'owned') })
  await close()
  const restarted = await fixture()
  restarted.started.startRecovery()
  await restarted.settle(raw)
  expect(restarted.registered).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(restarted.started.recoveryReady(registry.byAgent(agentId)!)).toBe(true), { timeout: 8_000 })
  // Cover more than two replay polling intervals: server recovery must not
  // start recurring scans for the durable client that has not been activated.
  await new Promise<void>(done => setTimeout(done, 1_100))
  expect(readOutbox).not.toHaveBeenCalled()
}, 20_000)

it('holds legacy mutations without competing confirmation while a local admission is unfinished', async () => {
  const f = await fixture(), raw = JSON.stringify(body()), snapshots = vi.fn()
  let release!: () => void, finishing = false
  const blocked = new Promise<void>(done => { release = done })
  fault.beforeFinish = async () => { finishing = true; await blocked }
  try {
    expect(await f.post(raw)).toEqual({ status: 200, body: receipt(raw, 'owned') })
    await vi.waitFor(() => expect(finishing).toBe(true))
    fault.beforeSnapshot = snapshots
    expect(await f.post(raw, {}, '/api/hook/turn-stop')).toMatchObject({ status: 202, body: { retry: true,
      detail: expect.stringContaining('an earlier native hook has no confirmed outcome') } })
    expect(snapshots).not.toHaveBeenCalled()
    expect(f.stopped).not.toHaveBeenCalled()
  } finally { fault.beforeFinish = undefined; release() }
  await f.settle(raw)
  f.started.startRecovery()
  await vi.waitFor(() => expect(f.started.recoveryReady(registry.byAgent(agentId)!)).toBe(true))
  snapshots.mockClear()
  expect(await f.post(raw, {}, '/api/hook/turn-stop')).toEqual({ status: 200, body: { ok: true } })
  expect(snapshots).toHaveBeenCalledOnce()
  expect(f.stopped).toHaveBeenCalledOnce()
}, 20_000)

it('does not let an old process pending receipt hold a freshly proved replacement mutation', async () => {
  let currentKey = key, release!: () => void, finishing = false
  const blocked = new Promise<void>(done => { release = done })
  const f = await fixture({
    readNativeHookOwner: async (_row, expected) => {
      if (expected && expected.key !== currentKey) throw Error('fixture original process changed')
      return { key: currentKey, evidence: 'fixture-precise-native-process', verify() {} }
    },
  }), raw = JSON.stringify(body())
  // Keep the old receipt pending through replacement allocation. A timer-driven
  // stale-job rejection must not remove the condition this assertion exercises.
  fault.beforeFinish = async () => { finishing = true; await blocked }
  try {
    expect(await f.post(raw)).toEqual({ status: 200, body: receipt(raw, 'owned') })
    await vi.waitFor(() => expect(finishing).toBe(true))
    currentKey = `${boot}\u0000codex\u00005100\u000067890`
    expect(registry.updateProcessIdentity(agentId, { pid: 5100, startMarker: 'fixture-replacement', executable: '<codex>' })).toBe(true)
    const replacement = structuredClone(origin)
    replacement.ancestry[1].birth = '67890'
    const snapshots = vi.fn(); fault.beforeSnapshot = snapshots
    expect(await f.post(JSON.stringify(body({ nativeOrigin: replacement })), {}, '/api/hook/turn-stop'))
      .toEqual({ status: 200, body: { ok: true } })
    expect(snapshots).toHaveBeenCalledOnce()
    expect(f.stopped).toHaveBeenCalledOnce()
  } finally {
    fault.beforeFinish = undefined; release()
    await new Promise<void>(done => setImmediate(done))
  }
}, 20_000)

it('completes four productive replay shards under the original bounded attempt deadlines', async () => {
  const first = await fixture({ hookAdmissionBlocked: () => true }), raw = JSON.stringify(body())
  const { openNativeHookStorage } = await import('./engines/kit/nativeHookStorage.js')
  const helpers = { prepare: () => { throw Error('fixture cannot prepare a host binary') }, invalidate() {} }
  const deliveries = new Map<number, { id: string; firedAt: number }>()
  for (let index = 0; deliveries.size < 4; index++) {
    const id = `fixture-four-shards-${index}`, shard = nativeHookOutboxShard(id)
    if (shard < 4 && !deliveries.has(shard)) deliveries.set(shard, { id, firedAt: 1000 + index })
  }
  mkdirSync(directory(), { mode: 0o700, recursive: true })
  const client = await openNativeHookStorage(directory(), helpers)
  try {
    for (const [shard, retained] of deliveries) {
      await (await client.outbox(shard)).retain({ ...retained, port: first.started.port,
        phases: [{ name: 'registration', path: '/api/hook/session-start', body: body() }] })
      expect(await first.post(raw, { 'x-harness-hook-delivery-id': retained.id, 'x-harness-hook-fired-at': String(retained.firedAt) }))
        .toEqual({ status: 200, body: nativeHookAcknowledgement(retained, { name: 'registration', path: '/api/hook/session-start', body: raw }, 'owned') })
    }
  } finally { await client.close() }
  const port = first.started.port
  await close()
  const replay = await import('./engines/kit/nativeHookReplay.js'), createReplay = replay.createNativeHookReplay
  const completed = new Set<number>(), holds: string[] = [], stages: { shard: number; step: string; elapsedMs: number }[] = []
  vi.spyOn(replay, 'createNativeHookReplay').mockImplementation(deps => createReplay({ ...deps, onHeld(...args) {
    deps.onHeld(...args)
    // A retry may confirm an ACK whose original writer expired just after
    // publication. A freshly confirmed outbox with no pending delivery is also
    // completion; the independent snapshot below verifies every expected ID.
    if (deliveries.has(args[0]) && args[2] === undefined) completed.add(args[0])
    if (args[2]) holds.push(args[2])
  }, async readOutbox(shard, current) {
    const began = performance.now(), outbox = await deps.readOutbox(shard, current)
    if (!outbox) return outbox
    stages.push({ shard, step: 'open', elapsedMs: Math.round(performance.now() - began) })
    return { ...outbox, async snapshot() {
      const began = performance.now()
      try { return await outbox.snapshot() }
      finally { stages.push({ shard, step: 'snapshot', elapsedMs: Math.round(performance.now() - began) }) }
    }, async acknowledge(...args) {
      const began = performance.now()
      try { return await outbox.acknowledge(...args) }
      finally { stages.push({ shard, step: 'acknowledge', elapsedMs: Math.round(performance.now() - began) }) }
    } }
  } }))
  const restarted = await fixture({}, 65_536, port, { nativeClientReplay: true })
  const began = performance.now(), cpu = process.cpuUsage(), rss = process.memoryUsage().rss
  let last = began, maxLoopDelayMs = 0
  const monitor = setInterval(() => { const now = performance.now(); maxLoopDelayMs = Math.max(maxLoopDelayMs, now - last - 50); last = now }, 50)
  try {
    restarted.started.startRecovery()
    await vi.waitFor(() => expect(completed.size, JSON.stringify({ completed: completed.size, holds: holds.slice(-12), stages })).toBe(4),
      { timeout: 35_000, interval: 100 })
    expect(restarted.registered).toHaveBeenCalledTimes(4)
  } finally {
    clearInterval(monitor)
    const usage = process.cpuUsage(cpu)
    console.info('[native replay workload]', JSON.stringify({ shards: 4, completed: completed.size,
      elapsedMs: Math.round(performance.now() - began), maxLoopDelayMs: Math.round(maxLoopDelayMs),
      userCpuMs: Math.round(usage.user / 1000), systemCpuMs: Math.round(usage.system / 1000),
      rssDeltaBytes: process.memoryUsage().rss - rss, holds: holds.length, stages }))
  }
  const observer = await openNativeHookStorage(directory(), helpers)
  try {
    for (const [shard, retained] of deliveries) {
      const read = (await observer.readOutbox(shard))!
      try { expect((await read.snapshot()).deliveries.get(retained.id)!.phases[0].acknowledged).toBe(true) }
      finally { await read.close() }
    }
  } finally { await observer.close() }
  expect(records().filter(record => record.event.kind === 'intake')).toHaveLength(4)
}, 65_000)

it('acknowledges owned pending intake at full memory capacity but rejects changed bytes before that shortcut', async () => {
  const f = await fixture({ hookAdmissionBlocked: () => true }), raw = JSON.stringify(body())
  expect(await f.post(raw)).toEqual({ status: 200, body: receipt(raw, 'owned') })
  await close()
  const full = await fixture({ hookAdmissionBlocked: () => true }, 0)
  expect(await full.post(raw)).toEqual({ status: 200, body: receipt(raw, 'owned') })
  expect(await full.post(JSON.stringify(body({ title: 'changed' })))).toMatchObject({ status: 409 })
  expect(full.registered).not.toHaveBeenCalled()
  expect(records().filter(record => record.event.kind === 'intake')).toHaveLength(1)
}, 20_000)

it('never upgrades a metadata-less legacy completion into a versioned receipt', async () => {
  const f = await fixture(), raw = JSON.stringify(body())
  await vi.waitFor(async () => expect(await f.post(raw, {}, '/api/hook/session-start')).toMatchObject({ status: 200, body: { ok: true } }), { timeout: 8_000 })
  await close(); live = false
  const restarted = await fixture()
  expect(await restarted.post(raw)).toMatchObject({ status: 409, body: { error: 'HOOK_DELIVERY_CONFLICT' } })
  expect(restarted.resolved).not.toHaveBeenCalled()
}, 20_000)

it.each(['id', 'time', 'origin', 'caller', 'metadata'])('refuses invalid %s without legacy fallback or durable intake', async invalid => {
  const f = await fixture(), input = body(), headers: Record<string, string | null> = {}
  if (invalid === 'id') headers['x-harness-hook-delivery-id'] = null
  if (invalid === 'time') headers['x-harness-hook-fired-at'] = '1e3'
  if (invalid === 'origin') delete (input as Partial<typeof input>).nativeOrigin
  if (invalid === 'caller') input.callerPid++
  if (invalid === 'metadata') Object.assign(input, { wire: { version: 1, bodySha256: digest('forged') } })
  expect(await f.post(JSON.stringify(input), headers)).toMatchObject({ status: 400 })
  expect(f.registered).not.toHaveBeenCalled(); expect(f.resolved).not.toHaveBeenCalled(); expect(f.capture).not.toHaveBeenCalled()
})

it('does not issue a receipt for an early ignored registration or unavailable disk confirmation', async () => {
  const f = await fixture()
  expect(await f.post(JSON.stringify(body({ tmuxPane: undefined })))).toMatchObject({ status: 202, body: { retry: true } })
  fault.unavailable = true
  expect(await f.post()).toMatchObject({ status: 202, body: { retry: true } })
  expect(f.registered).not.toHaveBeenCalled()
})

it('returns a conclusive receipt for a durably rejected registration, including after restart', async () => {
  const f = await fixture(), raw = JSON.stringify(body({ sessionId: undefined }))
  await f.settle(raw)
  expect(f.registered).not.toHaveBeenCalled()
  expect(records().find(record => record.event.kind === 'result').event.value).toMatchObject({ status: 400, accepted: false })
  await close(); live = false
  const restarted = await fixture()
  expect(await restarted.post(raw)).toEqual({ status: 200, body: receipt(raw, 'complete') })
}, 20_000)

it('acknowledges the first durable rejection without requiring another delivery attempt', async () => {
  vi.doMock('./engines/kit/nativeHookStorage.js', async original => ({ ...await original<object>(),
    openNativeHookStorage: (await import('./testing/nativeHookAdmissionStorageFixture.js')).fixtureNativeHookAdmissionStorage,
  }))
  const f = await fixture(), raw = JSON.stringify(body({ sessionId: undefined }))
  expect(await f.post(raw)).toEqual({ status: 200, body: receipt(raw, 'complete') })
  expect(f.registered).not.toHaveBeenCalled()
})

it('rejects a UTF-8 BOM rather than collapsing it into the plain body receipt', async () => {
  const f = await fixture()
  expect(await f.post('\ufeff' + JSON.stringify(body()))).toMatchObject({ status: 400 })
  expect(f.resolved).not.toHaveBeenCalled(); expect(f.registered).not.toHaveBeenCalled()
})

it.each(['intake', 'terminal'])('withholds an ACK when its confirmed %s disappears before the reply', async kind => {
  // Keep HTTP and the real immutable journal while making the publication point
  // deterministic and earlier than the pending-response timer. Catalog authority
  // and lost-seal lookup races are exercised above and by the catalog tests.
  vi.doMock('./engines/kit/nativeHookStorage.js', async original => ({ ...await original<object>(),
    openNativeHookStorage: (await import('./testing/nativeHookAdmissionStorageFixture.js')).fixtureNativeHookAdmissionStorage,
  }))
  const history = () => join(directory(), digest(key)), removed = vi.fn(() => {
    const names = readdirSync(history()).sort(), name = kind === 'intake' ? names[0] : names.at(-1)!
    unlinkSync(join(history(), name))
    // One surviving terminal witness can be repaired and confirmed legitimately.
    // Removing both outcome copies leaves an unconfirmed claim, never completion.
    if (kind === 'terminal') unlinkSync(join(history() + '.witnesses', name))
  })
  if (kind === 'intake') fault.afterRetain = removed
  else fault.afterFinish = removed
  const f = await fixture(kind === 'intake' ? { hookAdmissionBlocked: () => true } : {})
  expect(await f.post()).toMatchObject({ status: 202, body: { pending: false, retry: true } })
  expect(removed).toHaveBeenCalledOnce()
  expect(f.registered).toHaveBeenCalledTimes(kind === 'intake' ? 0 : 1)
})

it('refuses a legacy same-ID conflict before the full-memory retained-intake shortcut', async () => {
  const f = await fixture({ hookAdmissionBlocked: () => true }), raw = JSON.stringify(body()), path = '/api/hook/session-start'
  expect(await f.post(raw, {}, path)).toMatchObject({ status: 200, body: { pending: true } })
  await close()
  const full = await fixture({ hookAdmissionBlocked: () => true }, 0)
  expect(await full.post(JSON.stringify(body({ title: 'changed' })), {}, path))
    .toMatchObject({ status: 409, body: { error: 'HOOK_DELIVERY_CONFLICT' } })
  expect(full.registered).not.toHaveBeenCalled()
}, 20_000)

it('keeps unsupported Stop/event routes and linked registration free of effects', async () => {
  const f = await fixture()
  for (const endpoint of ['turn-stop', 'session-end', 'turn-start', 'tool-start']) {
    expect(await f.post(undefined, {}, '/api/native-hook/v1/' + endpoint)).toMatchObject({ status: 404 })
  }
  expect(await f.post(JSON.stringify(body({ engine: 'cursor', hookEvent: 'stop' })))).toMatchObject({ status: 202 })
  expect(f.resolved).not.toHaveBeenCalled(); expect(f.registered).not.toHaveBeenCalled(); expect(f.stopped).not.toHaveBeenCalled()
  expect(readdirSync(directory())).toEqual([])
})
