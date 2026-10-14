import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentCreationReceipts } from '../../lib/agentCreationReceipt.js'
import { creationFingerprint } from '../../lib/agentCreationReceipt.js'
import { controlIdentity, type NativeControlRow } from '../../lib/nativeProcessControl.js'
import type { ProcessEvidence } from '../../lib/processEvidence.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { nativeTurnTarget } from '../../lib/nativeTurnIntent.js'
import { terminalRouteKey } from '../../lib/terminalRuntime.js'
import type { ProcessRow } from '../../lib/tmux.js'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import { createNativeRearmProof, findNativeRearmPane, inspectNativeRearmCandidate, inspectNativeRearmPane, nativeRearmEngine, readNativeRearmPane } from './nativeRearmProof.js'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
vi.mock('../../lib/engineBin.js', () => ({ enginePathOverride: () => undefined }))
const clock = vi.hoisted(() => ({ now: 0 }))
vi.mock('node:perf_hooks', () => ({ performance: { now: () => clock.now } }))
const bootId = 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const token = 'original-replacement-token', id = 'original-replacement-request', target = 'a'.repeat(64)
const owner = 'a'.repeat(16)
beforeEach(() => { clock.now = 0; vi.clearAllMocks() })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
function fixture() {
  const control = { version: 1, cancel: { processKey: 'old-owner', target, request: {
    requestId: 'original-cancel-request', nonce: 'original-cancel-nonce', agentId: 'fixture-agent', conversationId: 'fixture-session',
    frontier: { index: -1, digest: null },
  } }, rearm: { requestId: id, agentId: 'fixture-agent', operation: 'restart', launchToken: token, target } }
  const row = { schemaVersion: 3, agentId: 'fixture-agent', engine: 'cursor', active: true, sessionId: 'fixture-session', nativeControl: control,
    tmuxPane: '%1', primaryRuntimeKey: terminalRouteKey({ backend: 'tmux', paneId: '%1' }), runtimes: [{ backend: 'tmux', paneId: '%1' }],
    processIdentity: { pid: 42, executable: 'cursor-agent', startMarker: 'fixture-birth' } } as RegisteredSession
  const request = { fingerprint: 'b'.repeat(64), request: { kind: 'native-rearm', creationId: id, agentId: row.agentId,
    operation: 'restart', launchToken: token, target } }
  const root: NativeControlRow = { pid: 10, parentPid: 2, birth: '1000', command: 'bash', imagePath: '/bin/bash', argv: ['bash'], fds: [] }
  const engine: NativeControlRow = { pid: 42, parentPid: 10, birth: '4200', command: 'cursor-agent', imagePath: '/fixture/cursor-agent',
    argv: ['cursor-agent'], fds: [] }
  const rows = new Map([[10, root], [42, engine]])
  const witness = { boot: bootId, pid: 42, birth: '4200' }
  const retained = vi.fn(), local = vi.fn(), receiptProof = vi.fn(), confirmationProof = vi.fn()
  const receipts = { readNativeRelaunchProcess: vi.fn(() => ({ process: { ...witness }, verify: receiptProof,
    verifyConfirmation: confirmationProof })) } satisfies Pick<AgentCreationReceipts, 'readNativeRelaunchProcess'>
  const pane = vi.fn<typeof readNativeRearmPane>(async () => ({ rootPid: 10, command: 'original-command' }))
  const findPane = vi.fn<typeof findNativeRearmPane>(async () => '%2')
  const boot = vi.fn(async () => bootId)
  const probe = vi.fn<typeof import('../../lib/nativeProcessControl.js').nativeProcessControl>(async () => ({ parent: 0, children: [], rows: new Map([...rows].map(([pid, row]) => [pid, structuredClone(row)])) }))
  const inspect = vi.fn(async (): Promise<ProcessEvidence> => ({
    parent: { pid: 42, parentPid: 10, executable: 'cursor-agent', args: 'cursor-agent', startMarker: 'fixture-birth',
      imagePath: engine.imagePath, nativeBirth: engine.birth, evidence: controlIdentity(engine), controlIdentity: controlIdentity(engine) },
    children: [], verify: async () => {}, verifyDescriptors: async () => {},
  }))
  const read = createNativeRearmProof({ receipts, owner, pane, findPane, boot, inspect, probe })
  const fence = { verify: retained, current: local }
  return { row, request, root, engine, rows, witness, retained, local, receiptProof, confirmationProof, receipts, pane, findPane, boot, probe, inspect, read,
    fence, run: () => read(row, request, fence) }
}

it('proves only the recorded Cursor incarnation and original direct pane placement', async () => {
  const p = fixture(), proof = await p.run()
  expect(proof).toMatchObject({ key: `${bootId}\0cursor\x0042\x004200`, evidence: controlIdentity(p.engine) })
  expect(p.receipts.readNativeRelaunchProcess).toHaveBeenCalledWith(id, p.request)
  expect(p.probe.mock.calls).toHaveLength(2)
  expect(p.pane.mock.calls).toHaveLength(2)
  expect(p.inspect).toHaveBeenCalledWith(42, expect.any(NativeEvidenceBudget), undefined, p.row.processIdentity)
  expect(p.receiptProof).toHaveBeenCalledOnce()
  proof.verify(); expect(p.receiptProof).toHaveBeenCalledTimes(2)
  p.receiptProof.mockImplementation(() => { throw Error('witness replaced') })
  expect(proof.verify).toThrow('witness replaced')
})

it('replacement proof retains the complete original process association independent of key order', async () => {
  const p = fixture(), sourceProcess = { processKey: `${bootId}\0cursor\0${41}\0${4100}`, namespace: 'linux:4:5' }
  p.row.nativeControl = { ...p.row.nativeControl!, rearm: { ...p.row.nativeControl!.rearm!, sourceProcess } }
  Object.assign(p.request.request, { sourceProcess: { namespace: sourceProcess.namespace, processKey: sourceProcess.processKey } })
  const proof = await p.run()
  expect(proof.source.requestFingerprint).toBe(creationFingerprint(p.request))
  proof.verify()
})

it.each(['omitted', 'null', 'key', 'namespace', 'enriched', 'legacy-null'])('replacement proof rejects %s original engine provenance before probing', async change => {
  const p = fixture(), sourceProcess = { processKey: `${bootId}\0cursor\0${41}\0${4100}`, namespace: 'linux:4:5' }
  p.row.nativeControl = { ...p.row.nativeControl!, rearm: { ...p.row.nativeControl!.rearm!, sourceProcess } }
  const request = p.request.request as Record<string, unknown>
  request.sourceProcess = sourceProcess
  if (change === 'omitted') delete request.sourceProcess
  if (change === 'null') request.sourceProcess = null
  if (change === 'key') request.sourceProcess = { ...sourceProcess, processKey: sourceProcess.processKey.replace(/4100$/, '4101') }
  if (change === 'namespace') request.sourceProcess = { ...sourceProcess, namespace: 'linux:4:6' }
  if (change === 'enriched' || change === 'legacy-null') {
    const { sourceProcess: _source, ...legacy } = p.row.nativeControl.rearm!
    p.row.nativeControl = { ...p.row.nativeControl, rearm: legacy }
    if (change === 'legacy-null') request.sourceProcess = null
  }
  await expect(p.run()).rejects.toThrow('reservation or current binding')
  expect(p.probe).not.toHaveBeenCalled(); expect(p.receipts.readNativeRelaunchProcess).not.toHaveBeenCalled()
})

function reserveRecovery(p: ReturnType<typeof fixture>, source: 'live' | 'saved') {
  p.row.processIdentity = { pid: 41, executable: '<original-cursor>', startMarker: 'old-birth' }
  p.row.active = source === 'live'
  const target = nativeTurnTarget(p.row)
  p.row.nativeControl = { ...p.row.nativeControl!, rearm: { ...p.row.nativeControl!.rearm!, source, target } }
  Object.assign(p.request.request, { source, target })
  return structuredClone(p.row)
}

function savedRecovery() {
  const p = fixture(); reserveRecovery(p, 'saved')
  p.row.nativeControl = { ...p.row.nativeControl!, rearm: { ...p.row.nativeControl!.rearm!, operation: 'resume' } }
  p.request.request.operation = 'resume'
  return { ...p, run: () => p.read.recoverSaved(p.row, p.request, p.fence) }
}

it('finds a saved Resume only through the retained witness parent in one observation', async () => {
  const p = savedRecovery(), before = structuredClone(p.row), observation = p.run()
  const proof = await observation
  await observation.settled
  expect(proof.pane).toBe('%2'); expect(proof.processIdentity.pid).toBe(42)
  expect(p.row).toEqual(before)
  expect(p.probe.mock.calls.map(call => call[0])).toEqual([[42], [10, 42], [10, 42], [10, 42]])
  expect(p.findPane).toHaveBeenCalledOnce()
  expect(p.findPane).toHaveBeenCalledWith(10, expect.any(NativeEvidenceBudget))
  const budget = p.findPane.mock.calls[0]![1]
  for (const call of p.probe.mock.calls) expect(call[2]).toBe(budget)
  for (const call of p.pane.mock.calls) expect(call[2]).toBe(budget)
  expect(p.pane.mock.calls.map(call => call[0])).toEqual(['%2', '%2'])
})

it.each(['live', 'restart', 'active', 'admitted', 'linked'])('refuses %s sources before saved pane lookup', async change => {
  const p = savedRecovery()
  if (change === 'live') p.row.nativeControl = { ...p.row.nativeControl!, rearm: { ...p.row.nativeControl!.rearm!, source: 'live' } }
  if (change === 'restart') p.row.nativeControl = { ...p.row.nativeControl!, rearm: { ...p.row.nativeControl!.rearm!, operation: 'restart' } }
  if (change === 'active') p.row.active = true
  if (change === 'admitted') p.row.nativeControl = { ...p.row.nativeControl!, rearm: { ...p.row.nativeControl!.rearm!,
    replacement: { processKey: 'older-process', sessionId: p.row.sessionId } } }
  if (change === 'linked') p.row.nativeArchive = { version: 1, agentId: p.row.agentId, requestId: id, launchToken: token, target }
  await expect(p.run()).rejects.toThrow('reservation or current binding')
  expect(p.findPane).not.toHaveBeenCalled(); expect(p.probe).not.toHaveBeenCalled()
})

it.each(['missing', 'birth', 'orphan', 'self-parent'])('refuses %s witnesses before discovering any pane', async change => {
  const p = savedRecovery()
  if (change === 'missing') p.rows.delete(42)
  if (change === 'birth') p.engine.birth = '4201'
  if (change === 'orphan') p.engine.parentPid = 1
  if (change === 'self-parent') p.engine.parentPid = 42
  await expect(p.run()).rejects.toThrow('witness parent is unavailable')
  expect(p.findPane).not.toHaveBeenCalled(); expect(p.pane).not.toHaveBeenCalled()
})

it.each(['root', 'engine', 'birth', 'entry'])('holds a changed %s before saved pane lookup', async change => {
  const p = savedRecovery(), probe = p.probe.getMockImplementation()!
  p.probe.mockImplementation(async (...args) => {
    if (p.probe.mock.calls.length === 2) {
      if (change === 'root') p.rows.delete(10)
      if (change === 'engine') p.rows.delete(42)
      if (change === 'birth') p.engine.birth = '4201'
      if (change === 'entry') p.engine.directEntryDigest = 'a'.repeat(64)
    }
    return probe(...args)
  })
  await expect(p.run()).rejects.toThrow('witness parent changed before pane lookup')
  expect(p.findPane).not.toHaveBeenCalled()
})

it.each(['root', 'engine', 'entry'])('holds the original %s across saved pane lookup', async change => {
  const p = savedRecovery()
  p.findPane.mockImplementationOnce(async () => {
    if (change === 'root') p.root.birth = '1001'
    if (change === 'engine') p.engine.command = 'different-command'
    if (change === 'entry') p.engine.directEntryDigest = 'b'.repeat(64)
    return '%2'
  })
  await expect(p.run()).rejects.toThrow('original witness parent changed during pane lookup')
  expect(p.inspect).not.toHaveBeenCalled()
})

it('does not refresh the deadline after saved candidate lookup', async () => {
  const p = savedRecovery()
  p.findPane.mockImplementationOnce(async () => { clock.now = 4000; return '%2' })
  await expect(p.run()).rejects.toThrow('deadline was reached')
  expect(p.pane).not.toHaveBeenCalled()
})

it('retains an occupied saved lookup after its reply expires until that lookup actually settles', async () => {
  vi.useFakeTimers()
  const p = savedRecovery()
  let release!: (value: string) => void
  p.findPane.mockImplementation(() => new Promise(resolve => { release = resolve }))
  const observation = p.run(), rejected = expect(observation).rejects.toThrow('evidence deadline expired')
  let settled = false; void observation.settled.then(() => { settled = true })
  await vi.advanceTimersByTimeAsync(3000); await rejected
  expect(settled).toBe(false)
  release('%2'); await observation.settled
  expect(settled).toBe(true); expect(p.pane).not.toHaveBeenCalled()
})

it.each(['live', 'saved'] as const)('recovers the original %s witness without first publishing a process or permission change', async source => {
  const p = fixture(), original = reserveRecovery(p, source), pane = source === 'live' ? '%1' : '%2'
  const recovered = p.read.recover(p.row, p.request, p.fence, pane)
  await expect(recovered).resolves.toMatchObject({ pane, processIdentity: { pid: 42, executable: 'cursor-agent', startMarker: 'fixture-birth' } })
  const proof = await recovered
  expect(p.inspect).toHaveBeenCalledWith(42, expect.any(NativeEvidenceBudget), undefined, undefined)
  expect(p.pane).toHaveBeenCalledWith(pane, token, expect.any(NativeEvidenceBudget), owner)
  expect(p.row).toEqual(original)
  expect(Object.isFrozen(proof.processIdentity)).toBe(true)
  expect(Object.isFrozen(proof.source)).toBe(true)
  expect(proof.source).toEqual({ target: nativeTurnTarget(original), controlFingerprint: creationFingerprint(original.nativeControl),
    requestFingerprint: creationFingerprint(p.request) })
  expect(proof.key).toContain('\0cursor\u000042\u00004200')
})

it.each(['target', 'source', 'pane', 'route', 'display-key', 'request', 'revoked'])('refuses %s drift before recovering an original reservation', async change => {
  const p = fixture(); reserveRecovery(p, 'live')
  let pane = '%1'
  if (change === 'target') p.row.permissionMode = 'full'
  if (change === 'source') {
    const { source: _, ...incomplete } = p.row.nativeControl!.rearm!
    p.row.nativeControl = { ...p.row.nativeControl!, rearm: incomplete }
    delete (p.request.request as Record<string, unknown>).source
  }
  if (change === 'pane') pane = '%2'
  if (change === 'route') p.row.primaryRuntimeKey = 'tmux:%2'
  if (change === 'display-key') p.row.primaryRuntimeKey = 'tmux:%1'
  if (change === 'request') p.request.request.launchToken = 'different-original-token'
  if (change === 'revoked') p.row.nativeControl = { ...p.row.nativeControl!, rearm: { ...p.row.nativeControl!.rearm!, revoked: true } }
  await expect(p.read.recover(p.row, p.request, p.fence, pane)).rejects.toThrow('reservation or current binding')
  expect(p.receipts.readNativeRelaunchProcess).not.toHaveBeenCalled(); expect(p.probe).not.toHaveBeenCalled()
})

it('separates the consumed source leaf from retained execution authority without extending its deadline', async () => {
  const p = fixture(); reserveRecovery(p, 'live')
  const proof = await p.read.recover(p.row, p.request, p.fence, '%1')
  p.retained.mockImplementation(() => { throw Error('source leaf intentionally replaced') })
  expect(proof.verify).toThrow('source leaf intentionally replaced')
  expect(proof.verifyExecution).not.toThrow()
  p.receiptProof.mockImplementation(() => { throw Error('original receipt changed') })
  expect(proof.verifyExecution).toThrow('original receipt changed')
  expect(proof.verifyConfirmation).not.toThrow()
  expect(p.confirmationProof).toHaveBeenCalledOnce()
  p.confirmationProof.mockImplementation(() => { throw Error('original witness changed') })
  expect(proof.verifyConfirmation).toThrow('original witness changed')
  p.confirmationProof.mockImplementation(() => {})
  p.receiptProof.mockImplementation(() => {})
  clock.now = 4000
  expect(proof.current).toThrow('deadline was reached')
  expect(proof.verifyExecution).toThrow('deadline was reached')
  expect(proof.verifyConfirmation).toThrow('deadline was reached')
})

it.each(['same', 'source', 'permission', 'omitted'] as const)('proves replacement only for %s reserved launch options', async change => {
  const p = fixture()
  p.row.nativeControl = { ...p.row.nativeControl!, rearm: { ...p.row.nativeControl!.rearm!,
    operation: 'resume', source: 'saved', permissionMode: 'full' } }
  const request: Record<string, unknown> = p.request.request
  Object.assign(request, { operation: 'resume', source: 'saved', permissionMode: 'full' })
  if (change === 'source') request.source = 'live'
  if (change === 'permission') request.permissionMode = 'ask'
  if (change === 'omitted') delete request.permissionMode
  if (change === 'same') expect((await p.run()).key).toContain('cursor')
  else {
    await expect(p.run()).rejects.toThrow('reservation or current binding')
    expect(p.probe).not.toHaveBeenCalled()
    expect(p.receipts.readNativeRelaunchProcess).not.toHaveBeenCalled()
  }
})

it.each(['engine', 'inactive', 'session', 'process', 'control', 'revoked', 'routes', 'backend', 'pane', 'primary',
  'agent', 'kind', 'id', 'operation', 'target', 'token'] as const)('holds %s reservation changes before reading process evidence', async change => {
  const p = fixture()
  if (change === 'engine') p.row.engine = 'codex'
  if (change === 'inactive') p.row.active = false
  if (change === 'session') p.row.sessionId = ''
  if (change === 'process') p.row.processIdentity = null
  if (change === 'control') delete p.row.nativeControl
  if (change === 'revoked') p.row.nativeControl = { ...p.row.nativeControl!, rearm: { ...p.row.nativeControl!.rearm!, revoked: true } }
  if (change === 'routes') p.row.runtimes.push({ backend: 'tmux', paneId: '%2' })
  if (change === 'backend') (p.row.runtimes[0] as any).backend = 'unknown'
  if (change === 'pane') p.row.tmuxPane = '%2'
  if (change === 'primary') p.row.primaryRuntimeKey = 'tmux:%2'
  if (change === 'agent') p.row.agentId = 'another-agent'
  if (change === 'kind') p.request.request.kind = 'create'
  if (change === 'id') p.request.request.creationId = 'another-creation-request'
  if (change === 'operation') p.request.request.operation = 'resume'
  if (change === 'target') p.request.request.target = 'c'.repeat(64)
  if (change === 'token') p.request.request.launchToken = 'another-launch-token'
  await expect(p.run()).rejects.toThrow('reservation or current binding')
  expect(p.probe).not.toHaveBeenCalled(); expect(p.receipts.readNativeRelaunchProcess).not.toHaveBeenCalled()
})

it.each(['pid', 'boot', 'birth', 'parent', 'root-missing', 'engine-missing', 'same-pid', 'image', 'launcher', 'unknown'] as const)(
  'holds %s evidence instead of adopting another engine', async change => {
    const p = fixture()
    if (change === 'pid') p.witness.pid = 43
    if (change === 'boot') p.witness.boot = bootId.replace('aaaa', 'bbbb')
    if (change === 'birth') p.witness.birth = '4201'
    if (change === 'parent') p.engine.parentPid = 11
    if (change === 'root-missing') p.rows.delete(10)
    if (change === 'engine-missing') p.rows.delete(42)
    if (change === 'same-pid') p.pane.mockResolvedValue({ rootPid: 42, command: 'original-command' })
    if (change === 'image') p.engine.imagePath = '/bin/bash'
    if (change === 'launcher') p.engine.imagePath = '/fixture/ori'
    if (change === 'unknown') p.engine.imagePath = '/fixture/unknown'
    await expect(p.run()).rejects.toThrow('original native replacement')
  },
)

it.each(['pane-root', 'pane-command', 'root-birth', 'engine-birth', 'engine-image', 'engine-parent', 'root-missing',
  'engine-missing', 'entry-digest', 'inspection', 'receipt', 'control', 'deadline', 'local'] as const)('holds a final %s change before returning authority', async change => {
  const p = fixture(), original = p.probe.getMockImplementation()!
  p.pane.mockImplementation(async () => ({ rootPid: change === 'pane-root' && p.pane.mock.calls.length === 2 ? 11 : 10,
    command: change === 'pane-command' && p.pane.mock.calls.length === 2 ? 'replaced-command' : 'original-command' }))
  if (change === 'inspection') p.inspect.mockImplementation(async () => ({ parent: null, children: [], verify: async () => {}, verifyDescriptors: async () => {} }))
  p.probe.mockImplementation(async (...args) => {
    if (p.probe.mock.calls.length === 2) {
      if (change === 'root-birth') p.root.birth = '1001'
      if (change === 'engine-birth') p.engine.birth = '4201'
      if (change === 'engine-image') p.engine.imagePath = '/fixture/another-engine'
      if (change === 'engine-parent') p.engine.parentPid = 11
      if (change === 'entry-digest') p.engine.directEntryDigest = 'e'.repeat(64)
      if (change === 'root-missing') p.rows.delete(10)
      if (change === 'engine-missing') p.rows.delete(42)
      if (change === 'receipt') p.receiptProof.mockImplementation(() => { throw Error('changed receipt') })
      if (change === 'control') p.retained.mockImplementation(() => { throw Error('changed control') })
      if (change === 'deadline') clock.now = 4000
      if (change === 'local') p.local.mockImplementation(() => { throw Error('revoked') })
    }
    return original(...args)
  })
  await expect(p.run()).rejects.toThrow()
})

it('retains copied inputs and actual read capacity until stalled reads settle', async () => {
  const p = fixture()
  // One shared unresolved observation keeps all eight actual operations alive.
  let resolve!: (value: string) => void
  const gate = new Promise<string>(done => { resolve = done })
  p.boot.mockReturnValue(gate)
  const pending = Array.from({ length: 8 }, () => p.run())
  p.row.processIdentity!.pid = 999; p.request.request.launchToken = 'mutated-caller-token'
  await expect(p.run()).rejects.toThrow('slots are occupied')
  resolve(bootId)
  expect((await Promise.all(pending)).every(proof => proof.key === `${bootId}\0cursor\x0042\x004200`)).toBe(true)
  p.row.processIdentity!.pid = 42; p.request.request.launchToken = token
  expect((await p.run()).key).toContain('cursor')
})

it.each(['boot', 'pane', 'probe', 'inspect'] as const)('bounds a stalled %s reply without freeing its actual read slots', async dependency => {
  vi.useFakeTimers()
  const p = fixture(), original = p[dependency].getMockImplementation()!
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  p[dependency].mockImplementation((async (...args: unknown[]) => { await gate; return Reflect.apply(original, undefined, args) }) as never)
  const answers: string[] = []
  const pending = Array.from({ length: 8 }, () => p.run().then(() => 'unexpected authority', error => error.message)
    .then(answer => { answers.push(answer); return answer }))
  await vi.advanceTimersByTimeAsync(3000)
  expect(answers).toEqual(Array(8).fill(expect.stringContaining('evidence deadline expired')))
  await Promise.all(pending)
  let overflow: string | undefined
  const extra = p.run().then(() => { overflow = 'unexpected authority' }, error => { overflow = error.message })
  await vi.advanceTimersByTimeAsync(0)
  expect(overflow).toContain('slots are occupied')
  await extra
  release(); await vi.advanceTimersByTimeAsync(0)
  if (dependency === 'boot') expect(p.pane).not.toHaveBeenCalled()
  if (dependency === 'pane') expect(p.probe).not.toHaveBeenCalled()
  if (dependency === 'probe') expect(p.inspect).not.toHaveBeenCalled()
  p[dependency].mockImplementation(original as never)
  expect((await p.run()).key).toContain('cursor')
})

it('captures original fence callbacks across waits and in the returned proof', async () => {
  const p = fixture(), original = p.boot.getMockImplementation()!
  p.boot.mockImplementation(async () => {
    p.fence.verify = vi.fn(); p.fence.current = vi.fn()
    return original()
  })
  const proof = await p.run()
  expect(p.fence.verify).not.toHaveBeenCalled(); expect(p.fence.current).not.toHaveBeenCalled()
  p.retained.mockImplementation(() => { throw Error('original authority revoked') })
  expect(proof.verify).toThrow('original authority revoked')
})

it('does not reserve an actual read slot when synchronous setup exhausts the deadline', async () => {
  const p = fixture(), late = { verify: p.retained, get current() { clock.now = 4000; return p.local } }
  await expect(p.read(p.row, p.request, late)).rejects.toThrow('deadline')
  expect(p.boot).not.toHaveBeenCalled()
  clock.now = 0
  let release!: (boot: string) => void
  p.boot.mockReturnValue(new Promise<string>(resolve => { release = resolve }))
  const active = Array.from({ length: 8 }, () => p.run().catch(() => undefined))
  expect(p.boot).toHaveBeenCalledTimes(8)
  release(bootId)
  expect((await Promise.all(active)).every(Boolean)).toBe(true)
})

const paneText = (command = `/usr/bin/env HARNESS_NATIVE_LAUNCH_TOKEN=${token} /bin/sh -c fixture`) => `%1\n10\n0\n${command}\n`
it('accepts only the complete live pane and exact original argv prefix', () => {
  const proof = inspectNativeRearmPane(paneText(), '%1', token)
  expect(proof.rootPid).toBe(10); expect(proof.command).toMatch(/^[a-f0-9]{64}$/)
  expect(Object.isFrozen(proof)).toBe(true)
})
it('accepts only this daemon\'s one older-tmux owner wrapper', () => {
  const command = `/usr/bin/env HARNESS_DAEMON=${owner} /usr/bin/env HARNESS_NATIVE_LAUNCH_TOKEN=${token} /bin/sh -c fixture`
  expect(() => inspectNativeRearmPane(paneText(command), '%1', token, owner)).not.toThrow()
  expect(inspectNativeRearmPane(paneText(command), '%1', token, owner).rootPid).toBe(10)
  expect(() => inspectNativeRearmPane(paneText(command), '%1', token, 'b'.repeat(16))).toThrow()
  expect(() => inspectNativeRearmPane(paneText(command), '%1', token)).toThrow()
  expect(() => inspectNativeRearmPane(paneText(`/usr/bin/env HARNESS_DAEMON=${owner} ${command}`), '%1', token, owner)).toThrow()
})
it.each([
  '', '%1\n10\n0\n', paneText().trimEnd(), paneText().replace('%1', '%2'), paneText().replace('\n10\n', '\n0\n'),
  paneText().replace('\n10\n', '\n2147483648\n'), paneText().replace('\n0\n', '\n1\n'), paneText().replace(token, token + 'more'),
  paneText(`/bin/sh -c 'echo HARNESS_NATIVE_LAUNCH_TOKEN=${token} '`), paneText() + '\0', 'x'.repeat(512 * 1024 + 1),
])('rejects incomplete, dead or borrowed pane evidence %#', text => {
  expect(() => inspectNativeRearmPane(text, '%1', token)).toThrow()
})

it.each(['direct', 'declared', 'package', 'missing-digest', 'wrong-digest', 'unrelated-main', 'display-only', 'ori', 'shell'] as const)(
  'requires a positive executed entry for the %s process', kind => {
    const p = fixture(), vendor = '/fixture/cursor-agent/versions/1/index.js', script = '/fixture/declared.js'
    const observed = { args: `node ${vendor}`, nativeArgv: undefined } as unknown as ProcessRow
    if (kind !== 'direct' && kind !== 'ori' && kind !== 'shell') {
      p.engine.imagePath = '/fixture/node'; delete p.engine.argv
      p.engine.directEntryDigest = createHash('sha256').update(kind === 'declared' ? script : vendor).digest('hex')
    }
    if (kind === 'missing-digest') delete p.engine.directEntryDigest
    if (kind === 'wrong-digest') p.engine.directEntryDigest = 'f'.repeat(64)
    if (kind === 'unrelated-main') p.engine.directEntryDigest = createHash('sha256').update('/fixture/unrelated.js').digest('hex')
    if (kind === 'display-only') { delete p.engine.directEntryDigest; observed.args = `ori cursor ${vendor}` }
    if (kind === 'ori') p.engine.imagePath = '/fixture/ori'
    if (kind === 'shell') p.engine.imagePath = '/bin/bash'
    expect(nativeRearmEngine(p.engine, observed, kind === 'declared' ? script : undefined))
      .toBe(['direct', 'declared', 'package'].includes(kind))
  },
)

it('does not let a configured launcher or interpreter claim its still-waiting process', () => {
  const p = fixture(), observed = { args: '/fixture/cursor-agent' } as ProcessRow
  for (const path of ['/bin/bash', '/fixture/ori', '/fixture/node']) {
    p.engine.imagePath = path
    expect(nativeRearmEngine(p.engine, observed, path)).toBe(false)
  }
})

it('digest-checks complete vendor candidates containing spaces without trusting display boundaries', () => {
  const p = fixture(), entry = '/fixture/home with spaces/cursor-agent/versions/version with spaces/index.js'
  p.engine.imagePath = '/fixture/node'; delete p.engine.argv
  p.engine.directEntryDigest = createHash('sha256').update(entry).digest('hex')
  expect(nativeRearmEngine(p.engine, { args: `/fixture/agent ${entry} --resume session` } as ProcessRow)).toBe(true)
  p.engine.directEntryDigest = createHash('sha256').update('/fixture/unrelated.js').digest('hex')
  expect(nativeRearmEngine(p.engine, { args: `/fixture/agent ${entry} --resume session` } as ProcessRow)).toBe(false)
})
it.each(['invalid', 'error', 'stderr', 'utf8', 'deadline', 'valid'] as const)('keeps the tmux %s result bounded and explicit', async scenario => {
  vi.mocked(execFile).mockImplementation((_file, _argv, _options, callback) => {
    if (scenario === 'deadline') clock.now = 4000
    ;(callback as Function)(scenario === 'error' ? Error('unavailable') : null,
      scenario === 'utf8' ? Buffer.from([255]) : Buffer.from(paneText()), Buffer.from(scenario === 'stderr' ? 'uncertain' : ''))
    return {} as never
  })
  const run = () => readNativeRearmPane(scenario === 'invalid' ? 'bad' : '%1', token, new NativeEvidenceBudget())
  if (scenario === 'valid') {
    expect((await run()).rootPid).toBe(10)
    expect(vi.mocked(execFile).mock.calls[0][2]).toMatchObject({ timeout: 3000, maxBuffer: 512 * 1024, killSignal: 'SIGKILL' })
  } else await expect(run()).rejects.toThrow()
  if (scenario === 'invalid') expect(execFile).not.toHaveBeenCalled()
})

it('selects one exact numeric pane parent from the complete listing', () => {
  expect(inspectNativeRearmCandidate('%1\t11\n%2\t10\n%3\t12\n', 10)).toBe('%2')
})
it.each(['', '%1\t10', '%1\t100', '%1\t10\npartial', '%1 10\n', '%1\t010\n', '%1\t1\n', '%1\t2147483648\n',
  '%1\t9007199254740992\n', '%1\t10\0\n', '%1\t10\r\n', '%1\t10\n%2\t10\n', '%1\t10\n%1\t11\n', '%1\t11\n',
  'x'.repeat(512 * 1024) + '\n', Array.from({ length: 8193 }, (_, n) => `%${n}\t10\n`).join('')])(
  'refuses incomplete, invalid, ambiguous or excessive pane candidates (%#)', output => {
    expect(() => inspectNativeRearmCandidate(output, 10)).toThrow()
  })
it.each([0, 1, -1, 1.5, 0x80000000, Number.NaN])('refuses invalid parent PID %s before pane lookup', async pid => {
  expect(() => inspectNativeRearmCandidate('%1\t10\n', pid)).toThrow()
  await expect(findNativeRearmPane(pid, new NativeEvidenceBudget())).rejects.toThrow('pane parent is invalid')
  expect(execFile).not.toHaveBeenCalled()
})
it.each(['error', 'stderr', 'utf8', 'deadline', 'valid'] as const)('keeps saved pane lookup %s bounded and explicit', async scenario => {
  vi.mocked(execFile).mockImplementation((_file, _argv, _options, callback) => {
    if (scenario === 'deadline') clock.now = 4000
    ;(callback as Function)(scenario === 'error' ? Error('unavailable') : null,
      scenario === 'utf8' ? Buffer.from([255]) : Buffer.from('%2\t10\n'), Buffer.from(scenario === 'stderr' ? 'uncertain' : ''))
    return {} as never
  })
  const run = () => findNativeRearmPane(10, new NativeEvidenceBudget())
  if (scenario === 'valid') {
    expect(await run()).toBe('%2')
    expect(vi.mocked(execFile).mock.calls[0].slice(0, 3)).toEqual(['tmux', ['list-panes', '-a', '-F', '#{pane_id}\t#{pane_pid}'],
      { encoding: 'buffer', timeout: 3000, maxBuffer: 512 * 1024, killSignal: 'SIGKILL' }])
  } else await expect(run()).rejects.toThrow()
})
