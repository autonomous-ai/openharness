import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentCreationReceipts, creationFingerprint } from '../../lib/agentCreationReceipt.js'
import type { NativeControlRow } from '../../lib/nativeProcessControlProbe.js'
import { nativeRearmRequest, nativeTurnTarget, type NativeTurnIntent } from '../../lib/nativeTurnIntent.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { NativeLaunch } from '../nativeLaunch.js'
import { inspectNativeRearmWitness, prepareNativeRearmWitness, writeNativeRearmWitness, type NativeRearmWitnessRequest } from './nativeRearmWitness.js'
import { executableSnapshot, nativeVersionProbe } from './nativeVersion.js'
import { nativeLaunchProof } from './nativeLaunchGuard.js'
import { inspectHookFile, type HookPreparationProof } from './nativeHookFiles.js'
import { NativePaths } from './nativePaths.js'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import type { NativeHookScope } from './nativeHookScope.js'
import { appendNativeAllocation, type NativeAllocation } from '../../lib/nativeAllocation.js'
import type { readNativeStopPane } from './nativePhysicalStop.js'

const clock = vi.hoisted(() => ({ now: 0 }))
vi.mock('node:perf_hooks', () => ({ performance: { now: () => clock.now } }))
vi.mock('./nativeHookBoot.js', () => ({ kernelBootId: async () => 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' }))
let root: string
const id = 'original-native-rearm-request', agentId = 'fixture-agent', token = 'original-native-launch-token'
const row = (pid: number, parentPid: number): NativeControlRow => ({ pid, parentPid, birth: String(pid * 100),
  command: pid === 42 ? 'sh' : 'node', imagePath: pid === 42 ? realpathSync(process.platform === 'darwin' ? '/bin/bash' : '/bin/sh') : '/fixture/node', argv: ['fixture'], fds: [] })
beforeEach(() => { clock.now = 0; root = realpathSync(mkdtempSync(join(tmpdir(), 'rearm-writer-'))) })
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
async function fixture(source: 'live' | 'saved' = 'live', options?: Pick<NonNullable<NativeTurnIntent['rearm']>, 'permissionMode' | 'sourceProcess'>,
  nativeAllocation?: NativeAllocation) {
  const engine = join(root, 'engine'), settings = join(root, 'settings')
  writeFileSync(engine, '#!/bin/sh\nexit 0\n', { mode: 0o700 }); writeFileSync(settings, 'original hooks', { mode: 0o600 })
  const executable = executableSnapshot(nativeVersionProbe({ args: [], output: /^$/, timeoutMs: 100 }, () => engine))!
  const paths = new NativePaths(new NativeEvidenceBudget()); paths.resolveSync(settings)
  const retained = inspectHookFile(settings)
  const hook: HookPreparationProof = { files: [{ file: settings, target: settings, stamp: retained.stamp, facts: paths.snapshot() }],
    current: () => { try { retained.verify(); return true } catch { return false } } }
  const launch: NativeLaunch = { token, executable, opencodeMajor: null, environment: {}, proofs: [hook],
    current: () => true, ready: () => true, prepareHooks: async () => true, permission: async () => 'supported' }
  const session = { schemaVersion: 3, agentId, registeredAt: 1, engine: 'cursor', sessionId: 'fixture-session', boundAt: 2, active: source === 'live',
    processIdentity: { pid: 41, executable: '/fixture/cursor', startMarker: 'fixture-birth' }, runtimes: [{ backend: 'tmux', paneId: '%1' }],
    primaryRuntimeKey: 'tmux:%1', tmuxPane: '%1', cwd: '/fixture/project', transcriptPath: null } as RegisteredSession
  if (nativeAllocation) { session.schemaVersion = 4; session.nativeAllocation = nativeAllocation }
  const target = nativeTurnTarget(session)
  const control: NativeTurnIntent = { version: 1 as const, cancel: { processKey: null, target, request: {
    requestId: 'original-cancel-request', nonce: 'original-cancel-nonce', agentId, conversationId: 'fixture-session', frontier: { index: -1, digest: null },
  } }, rearm: { requestId: id, agentId, operation: source === 'live' ? 'restart' as const : 'resume' as const, launchToken: token, target,
    ...(options ? { source, ...options } : {}) } }
  const request = nativeRearmRequest(control) ?? { kind: 'native-rearm', creationId: id, operation: control.rearm!.operation, agentId, launchToken: token, target }
  const input: NativeRearmWitnessRequest = { version: 1, dataDir: root, source, id, fingerprint: creationFingerprint(request), request, control,
    dependencies: nativeLaunchProof(launch) }
  const receipts = new AgentCreationReceipts(join(root, 'agent-creations'))
  await receipts.runIntent(id, input.fingerprint, request, { service: 'native', detail: 'fixture' }, async () => async () => ({ state: 'unconfirmed' }))
  const saved = { ...session, nativeControl: control }
  if (source === 'saved') mkdirSync(join(root, 'stopped-agents'), { mode: 0o700 })
  const file = source === 'live' ? join(root, 'registry.json') : join(root, 'stopped-agents', `${agentId}.json`)
  writeFileSync(file, JSON.stringify(source === 'live' ? [saved] : { version: 1, session: saved }), { mode: 0o600 })
  const processes = new Map([[43, row(43, 42)], [42, row(42, 10)]])
  const probe = vi.fn(async (pids: readonly number[]) => ({ parent: 0, children: [],
    rows: new Map(pids.flatMap(pid => processes.has(pid) ? [[pid, structuredClone(processes.get(pid)!)] as const] : [])) }))
  const scopes: Array<NativeHookScope & { verify: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = []
  const scope = vi.fn(async (_location: string) => {
    const current = { boot: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', namespace: 'linux:4:123', storage: 'fixture-local-volume',
      verify: vi.fn(), close: vi.fn() }
    scopes.push(current); return current
  })
  const environment: Pick<NodeJS.ProcessEnv, 'TMUX' | 'TMUX_PANE'> = { TMUX: undefined, TMUX_PANE: undefined }
  const pane = vi.fn<typeof readNativeStopPane>(async (_input, _budget, serverDead) => { await serverDead(); return 'active' })
  const write = () => writeNativeRearmWitness(JSON.stringify(input), '42', { selfPid: 43, probe, scope, pane, environment })
  const witness = join(root, 'agent-creations', `${id}.json.process`)
  return { input, receipts, processes, probe, write, file, witness, engine, settings, launch, scope, scopes, pane, environment }
}

async function placed() {
  const p = await fixture(), binary = join(root, 'tmux')
  writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const executable = executableSnapshot(nativeVersionProbe({ args: [], output: /^$/, timeoutMs: 1 }, () => binary))!
  p.input.version = 2; p.input.placement = { binary, identity: executable.identity, owner: 'a'.repeat(16) }
  p.processes.set(10, row(10, 9)); p.processes.set(9, { ...row(9, 1), imagePath: binary })
  p.environment.TMUX = `${root}/original,socket,9,0`; p.environment.TMUX_PANE = '%7'
  return p
}

it('retains the original pane root and server before exec and after cold receipt recovery', async () => {
  const p = await placed()
  await expect(p.write()).resolves.toBe(true)
  const proof = new AgentCreationReceipts(join(root, 'agent-creations')).readNativeRelaunchProcess(id, p.input)
  expect(proof.process.allocation).toEqual({ pane: '%7', rootPid: 10, token, owner: 'a'.repeat(16),
    root: { boot: p.scopes[0].boot, namespace: p.scopes[0].namespace, pid: 10, birth: '1000' },
    endpoint: { binary: p.input.placement!.binary, socket: `${root}/original,socket`,
      server: { boot: p.scopes[0].boot, namespace: p.scopes[0].namespace, pid: 9, birth: '900' } } })
  expect(p.pane).toHaveBeenCalledTimes(2)
  expect(p.probe.mock.calls.at(-1)?.[0]).toEqual([43, 42, 10, 9])
  for (const value of [proof.process, proof.process.allocation, proof.process.allocation!.root,
    proof.process.allocation!.endpoint, proof.process.allocation!.endpoint.server]) expect(Object.isFrozen(value)).toBe(true)
  proof.verify()
})

it.each(['root-parent', 'root-missing', 'server-image', 'server-missing', 'caller', 'child', 'binary', 'socket', 'pane', 'duplicate-pid'] as const)(
  'refuses the initial %s pane candidate without writing a witness', async change => {
    const p = await placed()
    if (change === 'root-parent') p.processes.get(10)!.parentPid = 1
    if (change === 'root-missing') p.processes.delete(10)
    if (change === 'server-image') p.processes.get(9)!.imagePath = '/fixture/other'
    if (change === 'server-missing') p.processes.delete(9)
    if (change === 'binary') writeFileSync(p.input.placement!.binary, 'changed')
    if (change === 'socket') p.environment.TMUX = 'relative,9,0'
    if (change === 'pane') p.environment.TMUX_PANE = 'not-a-pane'
    if (change === 'duplicate-pid') p.environment.TMUX = `${root}/socket,10,0`
    if (change === 'caller' || change === 'child') {
      const original = p.probe.getMockImplementation()!
      p.probe.mockImplementation(async pids => {
        if (pids.length === 4) p.processes.get(change === 'caller' ? 42 : 43)!.birth = '9999'
        return original(pids)
      })
    }
    await expect(p.write()).rejects.toThrow()
    expect(existsSync(p.witness)).toBe(false)
  },
)

it.each(['released', 'absent'] as const)('never grants exec for an initially %s original allocation', async state => {
  const p = await placed(); p.pane.mockResolvedValue(state)
  await expect(p.write()).rejects.toThrow('no longer active')
  expect(existsSync(p.witness)).toBe(false)
})

it('refuses a replaced server during the initial pane query before publishing anything', async () => {
  const p = await placed(), original = p.pane.getMockImplementation()!
  p.pane.mockImplementation(async (...args) => { p.processes.get(9)!.birth = '9999'; return original(...args) })
  await expect(p.write()).rejects.toThrow('original tmux server changed')
  expect(existsSync(p.witness)).toBe(false)
})

it.each(['released', 'absent', 'owner', 'server', 'binary'] as const)('rechecks %s pane ownership after witness durability', async change => {
  const p = await placed(), original = p.pane.getMockImplementation()!
  p.pane.mockImplementation(async (...args) => {
    if (p.pane.mock.calls.length === 2) {
      expect(existsSync(p.witness)).toBe(true)
      if (change === 'released' || change === 'absent') return change
      if (change === 'owner') throw Error('pane belongs to another allocation')
      if (change === 'server') p.processes.get(9)!.birth = '9999'
      if (change === 'binary') writeFileSync(p.input.placement!.binary, 'changed')
    }
    return original(...args)
  })
  await expect(p.write()).rejects.toThrow()
  expect(existsSync(p.witness)).toBe(true)
})

it.each([9, 10] as const)('rechecks the original pane ancestry at final PID %i after the pane read', async pid => {
  const p = await placed(), original = p.pane.getMockImplementation()!
  p.pane.mockImplementation(async (...args) => {
    const state = await original(...args)
    if (p.pane.mock.calls.length === 2) p.processes.get(pid)!.birth = '9999'
    return state
  })
  await expect(p.write()).rejects.toThrow('ancestry changed before handoff')
  expect(existsSync(p.witness)).toBe(true)
})

it('rechecks the retained tmux executable after the final quartet wait', async () => {
  const p = await placed(), original = p.probe.getMockImplementation()!
  p.probe.mockImplementation(async pids => {
    if (pids.length === 4 && p.pane.mock.calls.length === 2) writeFileSync(p.input.placement!.binary, 'changed')
    return original(pids)
  })
  await expect(p.write()).rejects.toThrow('executable changed')
  expect(existsSync(p.witness)).toBe(true)
})

it.each(['live', 'saved'] as const)('proves a later %s reservation without erasing its permanent allocation history', async source => {
  const choice = { kind: 'native-rearm', agentId, operation: 'resume', source: 'saved' }
  const nativeAllocation = appendNativeAllocation(undefined, { fingerprint: creationFingerprint(choice), request: {
    ...choice, creationId: 'previous-creation-request', launchToken: 'previous-launch-token', target: 'a'.repeat(64), sourceProcess: { processKey: null },
  } })
  const p = await fixture(source, { sourceProcess: { processKey: null } }, nativeAllocation)
  await expect(p.write()).resolves.toBe(true)
  const stored = JSON.parse(readFileSync(p.file, 'utf8')), saved = source === 'live' ? stored[0] : stored.session
  expect(saved.nativeAllocation).toEqual(nativeAllocation)
  expect(p.receipts.readNativeRelaunchProcess(id, p.input).process.pid).toBe(42)
})

const originalProcess = () => ({ processKey: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa\0cursor\0' + '41\0' + '4100', namespace: 'linux:4:5' })

it('the witness joins the exact reserved original engine before authorizing a new exec', async () => {
  const p = await fixture('live', { sourceProcess: originalProcess() })
  expect(inspectNativeRearmWitness(JSON.stringify(p.input)).request.sourceProcess).toEqual(originalProcess())
  expect(await p.write()).toBe(true)
  expect(p.receipts.readNativeRelaunchProcess(id, p.input).process.pid).toBe(42)
})

it.each(['omitted', 'null', 'key', 'namespace', 'enriched'])('holds %s original engine provenance before the witness probes or writes', async change => {
  const p = await fixture('live', { sourceProcess: originalProcess() })
  p.input.request = { ...p.input.request }
  if (change === 'omitted') delete p.input.request.sourceProcess
  if (change === 'null') p.input.request.sourceProcess = null
  if (change === 'key') p.input.request.sourceProcess = { ...originalProcess(), processKey: originalProcess().processKey.replace(/4100$/, '4101') }
  if (change === 'namespace') p.input.request.sourceProcess = { ...originalProcess(), namespace: 'linux:4:6' }
  if (change === 'enriched') {
    const { sourceProcess: _source, ...legacy } = p.input.control.rearm!
    p.input.control = { ...p.input.control, rearm: legacy }
  }
  await expect(p.write()).rejects.toThrow('reservation is unavailable')
  expect(p.probe).not.toHaveBeenCalled(); expect(existsSync(p.witness)).toBe(false)
})

it.each(['live', 'saved'] as const)('hands only the original %s reservation and exact parent incarnation an exec permit', async source => {
  const p = await fixture(source)
  expect(await p.write()).toBe(true)
  expect(p.probe.mock.calls.map(([pids]) => pids)).toEqual([[43, 42], [43, 42]])
  const proof = p.receipts.readNativeRelaunchProcess(id, p.input)
  expect(proof.process).toEqual({ boot: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', namespace: 'linux:4:123', pid: 42, birth: '4200' }); proof.verify()
  expect(p.scope.mock.calls.map(([location]) => location)).toEqual([join(root, 'agent-creations'), join(root, 'agent-creations')])
  for (const scope of p.scopes) expect(scope.verify.mock.calls.every(([location]) => location === join(root, 'agent-creations'))).toBe(true)
  expect(p.scopes).toHaveLength(2); for (const scope of p.scopes) expect(scope.close).toHaveBeenCalledOnce()
  expect(await p.write()).toBe(false)
  expect(p.probe).toHaveBeenCalledTimes(3)
  expect(p.scopes).toHaveLength(3); expect(p.scopes[2].close).toHaveBeenCalledOnce()
})

it('cannot publish a witness without local storage and PID-view evidence', async () => {
  const p = await fixture(); p.scope.mockRejectedValueOnce(Error('Local scope unavailable'))
  await expect(p.write()).rejects.toThrow('Local scope unavailable')
  expect(p.probe).not.toHaveBeenCalled(); expect(existsSync(p.witness)).toBe(false)
})

it('holds when the witness directory is unavailable even though its parent is local', async () => {
  const p = await fixture(), scope = p.scope.getMockImplementation()!
  p.scope.mockImplementation(async location => {
    if (location === root) return scope(location)
    throw Error('Witness volume is unavailable')
  })
  await expect(p.write()).rejects.toThrow('Witness volume is unavailable')
  expect(p.probe).not.toHaveBeenCalled(); expect(existsSync(p.witness)).toBe(false)
})

it.each(['boot', 'namespace', 'storage', 'root', 'deadline'])('holds a changed %s scope after witness publication and before the final paired probe', async change => {
  const p = await fixture(), scope = p.scope.getMockImplementation()!
  p.scope.mockImplementation(async location => {
    const result = await scope(location)
    if (p.scopes.length === 2) {
      if (change === 'boot') result.boot = 'linux:bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
      if (change === 'namespace') result.namespace = 'linux:4:456'
      if (change === 'storage') result.storage = 'other-local-volume'
      if (change === 'root') p.scopes[0].verify.mockImplementation(() => { throw Error('Original root changed') })
      if (change === 'deadline') clock.now = 4000
    }
    return result
  })
  await expect(p.write()).rejects.toThrow()
  expect(p.probe).toHaveBeenCalledOnce(); expect(existsSync(p.witness)).toBe(true)
  for (const scope of p.scopes) expect(scope.close).toHaveBeenCalledOnce()
})

it.each(['first', 'final'])('retains the %s scope through the final paired process observation', async which => {
  const p = await fixture(), probe = p.probe.getMockImplementation()!
  p.probe.mockImplementation(async pids => {
    if (p.probe.mock.calls.length === 2) p.scopes[which === 'first' ? 0 : 1].verify.mockImplementation(() => { throw Error('Original scope changed') })
    return probe(pids)
  })
  await expect(p.write()).rejects.toThrow('Original scope changed')
  for (const scope of p.scopes) expect(scope.close).toHaveBeenCalledOnce()
})

it('closes the original scope after an unavailable final scope read', async () => {
  const p = await fixture(), scope = p.scope.getMockImplementation()!
  p.scope.mockImplementation(async location => { if (p.scopes.length) throw Error('Scope read unavailable'); return scope(location) })
  await expect(p.write()).rejects.toThrow('Scope read unavailable')
  expect(p.scopes[0].close).toHaveBeenCalledOnce()
})

it('a final descriptor close failure still closes the original scope and refuses exec', async () => {
  const p = await fixture(), scope = p.scope.getMockImplementation()!
  p.scope.mockImplementation(async location => {
    const result = await scope(location)
    if (p.scopes.length === 2) result.close.mockImplementation(() => { throw Error('Scope close failed') })
    return result
  })
  await expect(p.write()).rejects.toThrow('Scope close failed')
  for (const scope of p.scopes) expect(scope.close).toHaveBeenCalledOnce()
})

it.each(['first', 'final'])('refuses exec when the %s descriptor close crosses the deadline', async which => {
  const p = await fixture(), scope = p.scope.getMockImplementation()!
  p.scope.mockImplementation(async location => {
    const result = await scope(location)
    if (p.scopes.length === (which === 'first' ? 1 : 2)) result.close.mockImplementation(() => { clock.now = 4000 })
    return result
  })
  await expect(p.write()).rejects.toThrow('deadline')
  expect(existsSync(p.witness)).toBe(true)
  for (const scope of p.scopes) expect(scope.close).toHaveBeenCalledOnce()
})

it.each([undefined, 'ask', 'auto', 'plan', 'full'] as const)('retains a saved permission override %s without rewriting original control before exec', async permissionMode => {
  const p = await fixture('saved', permissionMode === undefined ? {} : { permissionMode })
  const original = readFileSync(p.file, 'utf8')
  expect(await p.write()).toBe(true)
  expect(readFileSync(p.file, 'utf8')).toBe(original)
  expect(p.input.request).toEqual(nativeRearmRequest(p.input.control))
})

it('the next saved Resume can execute while retaining the previous closed visit receipt', async () => {
  const p = await fixture('saved', { permissionMode: 'full' }), value = JSON.parse(readFileSync(p.file, 'utf8'))
  const nativeReturn = { version: 1, phase: 'saved', link: { version: 1, agentId, requestId: 'previous-resume-request',
    launchToken: 'previous-launch-token', target: 'a'.repeat(64) }, sourceTarget: 'b'.repeat(64),
    controlFingerprint: 'c'.repeat(64), checkpoint: 'd'.repeat(64), savedTarget: 'e'.repeat(64) }
  writeFileSync(p.file, JSON.stringify({ version: 3, session: value.session, nativeReturn }), { mode: 0o600 })
  const before = readFileSync(p.file, 'utf8')
  expect(await p.write()).toBe(true)
  expect(readFileSync(p.file, 'utf8')).toBe(before)
  expect(p.receipts.readNativeRelaunchProcess(id, p.input).process.pid).toBe(42)
})

it.each(['returning', 'transferred', 'legacy-return', 'legacy-transfer', 'extra', 'malformed', 'foreign', 'active', 'live-link', 'retirement'])('the saved witness refuses %s ownership before any process probe', async change => {
  const p = await fixture('saved'), value = JSON.parse(readFileSync(p.file, 'utf8'))
  const link = { version: 1, agentId, requestId: 'previous-resume-request', launchToken: 'previous-launch-token', target: 'a'.repeat(64) }
  const record: Record<string, any> = { version: 3, session: value.session, nativeReturn: { version: 1, phase: 'saved', link,
    sourceTarget: 'b'.repeat(64), controlFingerprint: 'c'.repeat(64), checkpoint: 'd'.repeat(64), savedTarget: 'e'.repeat(64) } }
  if (change === 'returning') record.nativeReturn.phase = 'returning'
  if (change === 'transferred' || change === 'legacy-transfer') {
    record.version = change === 'transferred' ? 2 : 1
    record.nativeTransfer = { version: 1, link, pendingTarget: 'b'.repeat(64), processKey: 'original-process', pane: '%1' }
    delete record.nativeReturn
  }
  if (change === 'legacy-return') record.version = 1
  if (change === 'extra') record.extra = true
  if (change === 'malformed') record.nativeReturn.checkpoint = 'bad'
  if (change === 'foreign') record.nativeReturn.link.agentId = 'another-agent'
  if (change === 'active') record.session.active = true
  if (change === 'live-link') { record.version = 1; delete record.nativeReturn; record.session.nativeArchive = link }
  if (change === 'retirement') record.session.nativeRetirement = record.nativeReturn
  writeFileSync(p.file, JSON.stringify(record), { mode: 0o600 })
  await expect(p.write()).rejects.toThrow('saved control is incomplete')
  expect(p.probe).not.toHaveBeenCalled(); expect(existsSync(p.witness)).toBe(false)
})

it.each(['source', 'outer-source', 'permission', 'omission', 'saved-mode', 'saved-bypass'] as const)('holds a %s change to the original reserved launch options', async change => {
  const p = await fixture('saved', { permissionMode: 'full' })
  p.input.request = { ...p.input.request }
  if (change === 'source') p.input.request.source = 'live'
  if (change === 'outer-source') p.input.source = 'live'
  if (change === 'permission') p.input.request.permissionMode = 'ask'
  if (change === 'omission') delete p.input.request.permissionMode
  if (change === 'saved-mode' || change === 'saved-bypass') {
    const value = JSON.parse(readFileSync(p.file, 'utf8'))
    if (change === 'saved-mode') value.session.permissionMode = 'full'
    else value.session.bypassPermission = true
    writeFileSync(p.file, JSON.stringify(value), { mode: 0o600 })
  }
  await expect(p.write()).rejects.toThrow()
  expect(p.probe).not.toHaveBeenCalled()
  expect(existsSync(p.witness)).toBe(false)
})

it.each(['reparent', 'child', 'parent', 'image', 'missing', 'control', 'witness', 'deadline', 'executable', 'settings'] as const)(
  'holds %s changes during the final paired proof after publication', async change => {
    const p = await fixture(), original = p.probe.getMockImplementation()!
    p.probe.mockImplementation(async pids => {
      if (p.probe.mock.calls.length === 2) {
        if (change === 'reparent') p.processes.get(43)!.parentPid = 1
        if (change === 'child') p.processes.get(43)!.birth = '9999'
        if (change === 'parent') p.processes.get(42)!.birth = '9999'
        if (change === 'image') p.processes.get(42)!.imagePath = '/fixture/replacement'
        if (change === 'missing') p.processes.delete(42)
        if (change === 'control') writeFileSync(p.file, '[]')
        if (change === 'executable') writeFileSync(p.engine, '#!/bin/sh\nexit 1\n')
        if (change === 'settings') writeFileSync(p.settings, 'changed hooks')
        if (change === 'deadline') clock.now = 4000
        if (change === 'witness') {
          const bytes = readFileSync(p.witness)
          renameSync(p.witness, `${p.witness}.previous`); writeFileSync(p.witness, bytes, { mode: 0o600 })
        }
      }
      return original(pids)
    })
    await expect(p.write()).rejects.toThrow()
    expect(existsSync(p.witness)).toBe(true)
  },
)

it.each(['reparent', 'image', 'missing'] as const)('does not publish for an initially %s parent shell', async change => {
  const p = await fixture()
  if (change === 'reparent') p.processes.get(43)!.parentPid = 1
  if (change === 'image') p.processes.get(42)!.imagePath = '/fixture/cursor-agent'
  if (change === 'missing') p.processes.delete(42)
  await expect(p.write()).rejects.toThrow('original')
  expect(existsSync(p.witness)).toBe(false)
})

it.each(['revoked', 'different', 'duplicate', 'engine', 'pane', 'process', 'binding'] as const)('holds %s persisted control before probing or writing', async change => {
  const p = await fixture(), saved = JSON.parse(readFileSync(p.file, 'utf8'))
  if (change === 'revoked') saved[0].nativeControl.rearm.revoked = true
  if (change === 'different') saved[0].nativeControl.rearm.launchToken = 'different-launch-token'
  if (change === 'duplicate') saved.push(structuredClone(saved[0]))
  if (change === 'engine') saved[0].engine = 'codex'
  if (change === 'pane') saved[0].runtimes[0].paneId = '%2'
  if (change === 'process') saved[0].processIdentity.pid = 999
  if (change === 'binding') saved[0].sessionId = 'successor-session'
  writeFileSync(p.file, JSON.stringify(saved))
  await expect(p.write()).rejects.toThrow('saved reservation changed')
  expect(p.probe).not.toHaveBeenCalled(); expect(existsSync(p.witness)).toBe(false)
})

it('requires the explicit writer capability and captures immutable arguments as prepared dependencies', async () => {
  const p = await fixture(), artifact = join(root, 'notify.mjs'), module = pathToFileURL(join(root, 'cli.js')).href
  const header = '#!/usr/bin/env node\n// harness-native-hook-protocol:1\n// harness-native-hook-darwin:1\n'
  writeFileSync(artifact, header + '// old client\n', { mode: 0o600 })
  const retained: HookPreparationProof[] = [...p.launch.proofs]
  const launch: NativeLaunch = { ...p.launch, get proofs() { return retained },
    current: () => retained.every(proof => proof.current()), retain: proof => {
    retained.push(proof); return true
  } }
  expect(() => prepareNativeRearmWitness(launch, p.input, '/fixture/node', module)).toThrow('required relaunch witness')
  writeFileSync(artifact, header + '// harness-native-rearm-witness:1\n')
  expect(() => prepareNativeRearmWitness(launch, p.input, '/fixture/node', module)).toThrow('required pane witness')
  writeFileSync(artifact, header + '// harness-native-rearm-witness:1\n// harness-native-pane-witness:1\n')
  const command = prepareNativeRearmWitness(launch, p.input, '/fixture/node', module)
  expect(command).toEqual(launch.rearmWitness); expect(Object.isFrozen(command)).toBe(true)
  expect(JSON.parse(command.request).dependencies.files.some((file: { target: string }) => file.target === artifact)).toBe(true)
  p.input.request.launchToken = 'later-mutation'
  expect(JSON.parse(command.request).request.launchToken).toBe(token)
  writeFileSync(artifact, header)
  expect(launch.current()).toBe(false)
})

it.each(['json', 'large', 'version', 'path', 'target', 'revoked', 'replacement', 'source', 'source-array', 'extra'] as const)('refuses %s writer input before any effect', async problem => {
  const p = await fixture(), input = structuredClone(p.input) as any
  if (problem === 'version') input.version = 2
  if (problem === 'path') input.dataDir = 'relative'
  if (problem === 'target') input.request.target = 'b'.repeat(64)
  if (problem === 'revoked') input.control.rearm.revoked = true
  if (problem === 'replacement') input.control.rearm.replacement = { processKey: 'replacement', sessionId: 'fixture-session' }
  if (problem === 'source') input.source = 'unknown'
  if (problem === 'source-array') input.source = ['live']
  if (problem === 'extra') input.extra = true
  expect(() => inspectNativeRearmWitness(problem === 'json' ? '{' : problem === 'large' ? ' '.repeat(129 * 1024) : JSON.stringify(input))).toThrow()
})
