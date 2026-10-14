import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentCreationReceipts, creationFingerprint, type AgentCreationOutcome } from './agentCreationReceipt.js'
import type { NativeArchiveLink } from './nativeArchive.js'
import type { NativeTurnProcessReference } from './nativeTurnIntent.js'

const faults = vi.hoisted(() => ({ linked: false, failDirectory: false, beforeLink: undefined as (() => void) | undefined,
  inspect: undefined as ((path: string) => void) | undefined, captureResult: undefined as (() => void) | undefined,
  directorySync: undefined as (() => void) | undefined }))
vi.mock('../engines/kit/nativeHookFiles.js', async original => {
  const actual = await original<typeof import('../engines/kit/nativeHookFiles.js')>()
  return { ...actual, inspectHookFile: (...args: Parameters<typeof actual.inspectHookFile>) => {
    if (args[0].endsWith('.result')) faults.captureResult?.()
    return actual.inspectHookFile(...args)
  } }
})
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, linkSync: (...args: Parameters<typeof actual.linkSync>) => {
    if (/\.(confirmation|process)$/.test(String(args[1]))) { faults.beforeLink?.(); faults.linked = true }
    return actual.linkSync(...args)
  }, fsyncSync: (fd: number) => {
    if (actual.fstatSync(fd).isDirectory()) faults.directorySync?.()
    if (faults.linked && faults.failDirectory && actual.fstatSync(fd).isDirectory()) throw Error('fixture parent sync unavailable')
    actual.fsyncSync(fd)
  }, lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
    const value = actual.lstatSync(...args); faults.inspect?.(String(args[0])); return value
  } }
})
const roots: string[] = []
afterEach(() => { faults.linked = false; faults.failDirectory = false; faults.beforeLink = undefined; faults.inspect = undefined; faults.captureResult = undefined; faults.directorySync = undefined
  vi.useRealTimers(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const id = 'native-rearm-request-original'
const request = { kind: 'native-rearm', creationId: id, operation: 'resume', agentId: 'original-agent', launchToken: 'original-launch-token' }
const fingerprint = creationFingerprint({ operation: 'resume', agentId: request.agentId })
const outcome = { state: 'created' as const, agentId: request.agentId, resumed: true }
const held = { service: 'native', detail: 'Waiting for the original replacement.' }
const processOwner = { boot: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', pid: 234, birth: '123456' }
const allocatedProcess = () => ({ ...processOwner, namespace: 'linux:4:5', allocation: {
  pane: '%7', rootPid: 10, token: request.launchToken, owner: 'a'.repeat(16),
  root: { boot: processOwner.boot, namespace: 'linux:4:5', pid: 10, birth: '1000' },
  endpoint: { binary: '/fixture/tmux', socket: '/fixture/socket',
    server: { boot: processOwner.boot, namespace: 'linux:4:5', pid: 9, birth: '900' } },
} })
const fence = () => ({ verify: vi.fn(), current: vi.fn() })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-rearm-receipt-'))); roots.push(root)
  const directory = join(root, 'receipts'), receipts = new AgentCreationReceipts(directory)
  const file = (part = '') => join(directory, `${id}.json${part && '.' + part}`)
  const confirm = (authority = fence()) => receipts.confirmNativeRelaunch(id, { fingerprint, request, outcome }, authority)
  return { root, directory, receipts, file, confirm }
}
async function uncertain() {
  const value = fixture(), effect = vi.fn(async () => ({ state: 'unconfirmed' as const }))
  await value.receipts.runIntent(id, fingerprint, request, held, async () => effect)
  return { ...value, effect }
}

it('retains original allocation metadata through immutable process and confirmation receipts', async () => {
  const p = await uncertain(), source = allocatedProcess()
  let permit: ReturnType<AgentCreationReceipts['recordNativeRelaunchProcess']>
  expect(() => { permit = p.receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, source, fence()) }).not.toThrow()
  expect(permit!).not.toBeNull()
  source.allocation.endpoint.socket = '/changed/socket'
  const cold = new AgentCreationReceipts(p.directory), proof = cold.readNativeRelaunchProcess(id, { fingerprint, request })
  expect(proof.process).toEqual(allocatedProcess())
  for (const value of [proof.process.allocation, proof.process.allocation!.root,
    proof.process.allocation!.endpoint, proof.process.allocation!.endpoint.server]) expect(Object.isFrozen(value)).toBe(true)
  expect(cold.confirmNativeRelaunch(id, { fingerprint, request, outcome }, fence())).toEqual(outcome)
  expect(new AgentCreationReceipts(p.directory).readNativeRelaunchCompletion(id, { fingerprint, request }).outcome).toEqual(outcome)
})

it('keeps a former process witness readable without inventing allocation metadata', async () => {
  const p = await uncertain()
  p.receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, processOwner, fence())
  expect(new AgentCreationReceipts(p.directory).readNativeRelaunchProcess(id, { fingerprint, request }).process).toEqual(processOwner)
})

it.each(['token', 'root', 'namespace', 'extra', 'null'] as const)('refuses %s allocation metadata before process publication', async change => {
  const p = await uncertain(), process: any = allocatedProcess()
  if (change === 'token') process.allocation.token = 'another-launch-token'
  if (change === 'root') process.allocation.rootPid = 11
  if (change === 'namespace') delete process.namespace
  if (change === 'extra') process.allocation.extra = true
  if (change === 'null') process.allocation = null
  expect(() => p.receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, process, fence())).toThrow()
  expect(fs.existsSync(p.file('process'))).toBe(false)
})

it.each(['token', 'root', 'namespace', 'extra', 'null'] as const)('every cold receipt reader rejects coherently checksummed %s allocation damage', async change => {
  const p = await uncertain()
  p.receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, allocatedProcess(), fence())
  p.confirm()
  const part = JSON.parse(readFileSync(p.file('process'), 'utf8'))
  if (change === 'token') part.process.allocation.token = 'another-launch-token'
  if (change === 'root') part.process.allocation.rootPid = 11
  if (change === 'namespace') delete part.process.namespace
  if (change === 'extra') part.process.allocation.extra = true
  if (change === 'null') part.process.allocation = null
  part.checksum = creationFingerprint({ fingerprint: part.fingerprint, token: part.token, process: part.process })
  writeFileSync(p.file('process'), JSON.stringify(part), { mode: 0o600 })
  const confirmation = JSON.parse(readFileSync(p.file('confirmation'), 'utf8')); confirmation.process = part.checksum
  writeFileSync(p.file('confirmation'), JSON.stringify(confirmation), { mode: 0o600 })
  const cold = new AgentCreationReceipts(p.directory)
  for (const read of [() => cold.status(id), () => cold.readNativeRelaunchProcess(id, { fingerprint, request }),
    () => cold.readNativeRelaunchCompletion(id, { fingerprint, request }),
    () => cold.confirmNativeRelaunch(id, { fingerprint, request, outcome }, fence())]) expect(read).toThrow()
})

async function savedCompletion(kind: 'created' | 'cancelled' | 'not-dispatched' | 'pending' | 'uncertain' | 'generic-failure' | 'direct-success' | 'no-witness' = 'created', permissionMode?: 'full', sourceProcess?: NativeTurnProcessReference) {
  const p = fixture()
  const link: NativeArchiveLink = { version: 1, agentId: request.agentId, requestId: id, launchToken: request.launchToken, target: 'a'.repeat(64) }
  const value = { ...request, source: 'saved', target: link.target, ...(permissionMode ? { permissionMode } : {}),
    ...(sourceProcess === undefined ? {} : { sourceProcess }) }
  const fingerprint = creationFingerprint({ kind: 'native-rearm', agentId: link.agentId, operation: 'resume', source: 'saved',
    ...(permissionMode ? { permissionMode } : {}) })
  await p.receipts.runIntent(id, fingerprint, value, held, async () => kind === 'pending' || kind === 'cancelled' ? null : async () => {
    if (kind === 'created' || kind === 'direct-success') p.receipts.recordNativeRelaunchProcess(id, { fingerprint, request: value }, processOwner, fence())
    if (kind === 'not-dispatched') return { state: 'failed', error: 'NATIVE_REARM_NOT_DISPATCHED' }
    if (kind === 'generic-failure') return { state: 'failed', error: 'OTHER_FAILURE' }
    if (kind === 'direct-success') return outcome
    return { state: 'unconfirmed' }
  })
  if (kind === 'cancelled') p.receipts.cancelIntent(id)
  if (kind === 'created' || kind === 'no-witness') p.receipts.confirmNativeRelaunch(id, { fingerprint, request: value, outcome }, fence())
  return { ...p, link, request: value, fingerprint }
}

it.each(['created', 'cancelled', 'not-dispatched'] as const)('reads exact %s Resume cleanup without another dispatch or native process probe', async kind => {
  const p = await savedCompletion(kind, 'full'), cold = new AgentCreationReceipts(p.directory)
  const proof = cold.readNativeResumeCleanup(p.link)
  expect(proof.kind).toBe(kind === 'created' ? 'created' : 'not-dispatched')
  expect(proof.request).toEqual(p.request); expect(proof.link).toEqual(p.link)
  expect(() => proof.verify()).not.toThrow()
  expect(Object.isFrozen(proof.request)).toBe(true)
  expect(proof.outcome).toEqual(cold.status(id))
})

it.each(['created', 'cancelled', 'not-dispatched'] as const)('retains original engine provenance in %s cold Resume cleanup', async kind => {
  const sourceProcess = { processKey: `${processOwner.boot}\0cursor\0${42}\0${12345}`, namespace: 'linux:4:5' }
  const p = await savedCompletion(kind, 'full', sourceProcess), cold = new AgentCreationReceipts(p.directory)
  expect(() => cold.readNativeResumeCleanup(p.link)).not.toThrow()
  const proof = cold.readNativeResumeCleanup(p.link)
  expect(proof.request).toEqual(p.request); expect(proof.request.sourceProcess).toEqual(sourceProcess)
  expect(Object.isFrozen(proof.request.sourceProcess)).toBe(true)
  proof.verify()
})

it('keeps explicit unknown original-engine provenance distinct from a legacy omission', async () => {
  const unknown = await savedCompletion('cancelled', undefined, { processKey: null })
  expect(new AgentCreationReceipts(unknown.directory).readNativeResumeCleanup(unknown.link).request.sourceProcess).toEqual({ processKey: null })
  const legacy = await savedCompletion('cancelled')
  expect(new AgentCreationReceipts(legacy.directory).readNativeResumeCleanup(legacy.link).request).not.toHaveProperty('sourceProcess')
})

it.each([null, {}, { processKey: '' }, { processKey: null, namespace: 'linux:4:5' },
  { processKey: `${processOwner.boot}\0cursor\0${42}\0${12345}`, namespace: 'linux:04:5' },
])('refuses malformed original-engine provenance in a coherent cleanup receipt %#', async sourceProcess => {
  const p = await savedCompletion('cancelled'), raw = JSON.parse(readFileSync(p.file(), 'utf8'))
  raw.request.sourceProcess = sourceProcess
  raw.checksum = creationFingerprint({ fingerprint: raw.fingerprint, request: raw.request, held: raw.held })
  writeFileSync(p.file(), JSON.stringify(raw), { mode: 0o600 })
  expect(() => new AgentCreationReceipts(p.directory).readNativeResumeCleanup(p.link)).toThrow('CREATION_CONFLICT')
})

it.each(['pending', 'uncertain', 'generic-failure', 'direct-success', 'no-witness'] as const)('holds %s receipt evidence instead of inferring cleanup authority', async kind => {
  const p = await savedCompletion(kind)
  expect(() => p.receipts.readNativeResumeCleanup(p.link)).toThrow()
})

it.each(['agentId', 'requestId', 'launchToken', 'target'] as const)('binds Resume cleanup to the original link %s', async field => {
  const p = await savedCompletion()
  const changed = { ...p.link, [field]: field === 'target' ? 'b'.repeat(64) : 'different-identity-value' }
  expect(() => p.receipts.readNativeResumeCleanup(changed)).toThrow()
})

it.each(['source', 'operation', 'permission', 'extra', 'fingerprint'])('refuses a coherent but different original %s request', async field => {
  const p = await savedCompletion('cancelled'), raw = JSON.parse(readFileSync(p.file(), 'utf8'))
  if (field === 'source') raw.request.source = 'live'
  if (field === 'operation') raw.request.operation = 'restart'
  if (field === 'permission') raw.request.permissionMode = 'unknown'
  if (field === 'extra') raw.request.extra = true
  if (field === 'fingerprint') raw.fingerprint = 'b'.repeat(64)
  raw.checksum = creationFingerprint({ fingerprint: raw.fingerprint, request: raw.request, held: raw.held })
  writeFileSync(p.file(), JSON.stringify(raw), { mode: 0o600 })
  expect(() => p.receipts.readNativeResumeCleanup(p.link)).toThrow()
})

it.each(['', 'claim', 'result', 'confirmation', 'process'])('pins original %s receipt evidence for metadata cleanup', async part => {
  const p = await savedCompletion(), proof = p.receipts.readNativeResumeCleanup(p.link), file = p.file(part)
  writeFileSync(`${file}.new`, readFileSync(file), { mode: 0o600 }); renameSync(`${file}.new`, file)
  expect(() => proof.verify()).toThrow()
  expect(() => new AgentCreationReceipts(p.directory).readNativeResumeCleanup(p.link).verify()).not.toThrow()
})

it.each(['confirmation', 'process'])('retains %s absence for early Cancel cleanup', async part => {
  const p = await savedCompletion('cancelled'), proof = p.receipts.readNativeResumeCleanup(p.link)
  writeFileSync(p.file(part), '{}', { mode: 0o600 })
  expect(() => proof.verify()).toThrow()
})

it('does not use an in-memory not-dispatched result when its durable result is missing', async () => {
  const p = await savedCompletion('not-dispatched')
  rmSync(p.file('result'))
  expect(p.receipts.status(id).state).toBe('unconfirmed')
  expect(() => p.receipts.readNativeResumeCleanup(p.link)).toThrow()
})

it('does not bind a request-less cancellation tombstone to a marker by ID alone', () => {
  const p = fixture(); p.receipts.cancelIntent(id)
  expect(() => p.receipts.readNativeResumeCleanup({ version: 1, agentId: request.agentId,
    requestId: id, launchToken: request.launchToken, target: 'a'.repeat(64) })).toThrow()
})

it('confirms the exact receipt files and parent before granting metadata cleanup', async () => {
  const p = await savedCompletion('cancelled')
  faults.linked = true; faults.failDirectory = true
  expect(() => p.receipts.readNativeResumeCleanup(p.link)).toThrow('sync unavailable')
})

it.each(['cancelled', 'not-dispatched'] as const)('accounts for an exact %s allocation without another dispatch', async kind => {
  const p = await savedCompletion(kind, 'full'), cold = new AgentCreationReceipts(p.directory)
  const proof = cold.readNativeRelaunchNotDispatched(id, { fingerprint: p.fingerprint, request: p.request })
  expect(proof.kind).toBe(kind === 'cancelled' ? 'cancelled-request' : 'not-dispatched')
  const sync = vi.spyOn(fs, 'fsyncSync')
  for (let n = 0; n < 3; n++) proof.verify()
  expect(sync).not.toHaveBeenCalled()
  for (const request of [{ ...p.request, launchToken: 'other-launch-token' }, { ...p.request, source: 'live' }]) {
    expect(() => cold.readNativeRelaunchNotDispatched(id, { fingerprint: p.fingerprint, request })).toThrow('CREATION_CONFLICT')
  }
  expect(() => cold.readNativeRelaunchNotDispatched(id, { fingerprint: 'b'.repeat(64), request: p.request })).toThrow('CREATION_CONFLICT')
})

it('accounts for a live Restart cancellation with its exact retained request', async () => {
  const p = fixture(), input = { fingerprint, request: { ...request, operation: 'restart', source: 'live', target: 'a'.repeat(64) } }
  await p.receipts.runIntent(id, fingerprint, input.request, held, async () => null)
  p.receipts.cancelIntent(id)
  expect(new AgentCreationReceipts(p.directory).readNativeRelaunchNotDispatched(id, input).kind).toBe('cancelled-request')
})

it('a pre-receipt tombstone vetoes an allocation ID without inventing stored request data', () => {
  const p = fixture(); p.receipts.cancelIntent(id)
  const cold = new AgentCreationReceipts(p.directory)
  expect(() => cold.readNativeRelaunchNotDispatched(id, { fingerprint, request })).not.toThrow()
  const proof = cold.readNativeRelaunchNotDispatched(id, { fingerprint, request })
  expect(proof.kind).toBe('cancelled-id'); expect(proof).not.toHaveProperty('request')
  expect(readFileSync(p.file(), 'utf8')).toBe('{"version":2,"cancelled":true}')
  expect(() => proof.verify()).not.toThrow()
  expect(() => cold.readNativeRelaunchNotDispatched(id, { fingerprint, request: { ...request, creationId: 'other-request-id' } })).toThrow()
})

it.each(['pending', 'uncertain', 'generic-failure', 'direct-success', 'no-witness', 'created'] as const)(
  'never treats %s as an undispatched allocation', async kind => {
    const p = await savedCompletion(kind)
    expect(() => p.receipts.readNativeRelaunchNotDispatched(id, { fingerprint: p.fingerprint, request: p.request })).toThrow()
  })

it('requires a durable not-dispatched result even when memory retained it', async () => {
  const p = await savedCompletion('not-dispatched'); rmSync(p.file('result'))
  expect(() => p.receipts.readNativeRelaunchNotDispatched(id, { fingerprint: p.fingerprint, request: p.request })).toThrow()
})

it.each(['', 'claim', 'result', 'confirmation', 'process'])(
  'retains the original %s presence or absence for allocation accounting', async part => {
    for (const mode of ['tombstone', 'cancelled', 'not-dispatched'] as const) {
      const p = mode === 'tombstone' ? { ...fixture(), fingerprint, request } : await savedCompletion(mode)
      if (mode === 'tombstone') p.receipts.cancelIntent(id)
      const proof = p.receipts.readNativeRelaunchNotDispatched(id, { fingerprint: p.fingerprint, request: p.request }), path = p.file(part)
      const bytes = fs.existsSync(path) ? readFileSync(path) : Buffer.from('{}')
      writeFileSync(path + '.new', bytes, { mode: 0o600 }); renameSync(path + '.new', path)
      expect(() => proof.verify(), mode + ':' + part).toThrow()
    }
  })

it.each(['claim', 'result', 'confirmation', 'process'])('refuses an orphan %s beside a bare tombstone', part => {
  const p = fixture(); p.receipts.cancelIntent(id)
  writeFileSync(p.file(part), '{}', { mode: 0o600 })
  expect(() => p.receipts.readNativeRelaunchNotDispatched(id, { fingerprint, request })).toThrow()
})

it.each(['tombstone', 'cancelled', 'not-dispatched'] as const)('confirms %s durability before allocation accounting', async kind => {
  const p = kind === 'tombstone' ? { ...fixture(), fingerprint, request } : await savedCompletion(kind)
  if (kind === 'tombstone') p.receipts.cancelIntent(id)
  faults.linked = true; faults.failDirectory = true
  expect(() => p.receipts.readNativeRelaunchNotDispatched(id, { fingerprint: p.fingerprint, request: p.request })).toThrow('sync unavailable')
})

it.each(['created', 'cancelled', 'not-dispatched'] as const)('verifies retained %s cleanup without fsync', async kind => {
  const p = await savedCompletion(kind), proof = p.receipts.readNativeResumeCleanup(p.link), sync = vi.spyOn(fs, 'fsyncSync')
  for (let n = 0; n < 3; n++) proof.verify()
  expect(sync).not.toHaveBeenCalled()
})

it('revokes an undispatched proof when a late contradictory outcome exists only in memory', async () => {
  const p = fixture()
  let finish!: (value: AgentCreationOutcome) => void
  const running = p.receipts.runIntent(id, fingerprint, request, held, async () => () => new Promise(resolve => { finish = resolve }))
  const rejected = expect(running).rejects.toThrow('CREATION_STORAGE_FAILED')
  await vi.waitFor(() => expect(finish).toBeDefined())
  const claim = JSON.parse(readFileSync(p.file('claim'), 'utf8'))
  writeFileSync(p.file('result'), JSON.stringify({ fingerprint, token: claim.token,
    outcome: { state: 'failed', error: 'NATIVE_REARM_NOT_DISPATCHED' } }), { mode: 0o600 })
  const proof = p.receipts.readNativeRelaunchNotDispatched(id, { fingerprint, request })
  expect(proof.kind).toBe('not-dispatched'); expect(() => proof.verify()).not.toThrow()
  finish(outcome)
  await rejected
  expect(JSON.parse(readFileSync(p.file('result'), 'utf8')).outcome.state).toBe('failed')
  expect(() => proof.verify()).toThrow('CREATION_STORAGE_FAILED')
})

it('reads only the exact confirmed relaunch as successful without inspecting the engine', async () => {
  const p = await savedCompletion('created', 'full'), cold = new AgentCreationReceipts(p.directory)
  const proof = cold.readNativeRelaunchCompletion(id, { fingerprint: p.fingerprint, request: p.request })
  expect(proof.outcome).toEqual(outcome); expect(Object.isFrozen(proof.outcome)).toBe(true)
  expect(() => proof.verify()).not.toThrow()
  expect(() => cold.readNativeRelaunchCompletion(id, { fingerprint: p.fingerprint,
    request: { ...p.request, permissionMode: 'ask' } })).toThrow()
})

it.each(['uncertain', 'direct-success', 'no-witness'] as const)('does not use %s as durable relaunch completion', async kind => {
  const p = await savedCompletion(kind)
  expect(() => p.receipts.readNativeRelaunchCompletion(id, { fingerprint: p.fingerprint, request: p.request })).toThrow()
})

it.each(['', 'claim', 'result', 'confirmation', 'process'])('retains the original %s part of confirmed relaunch completion', async part => {
  const p = await savedCompletion(), proof = p.receipts.readNativeRelaunchCompletion(id, { fingerprint: p.fingerprint, request: p.request }), file = p.file(part)
  writeFileSync(`${file}.new`, readFileSync(file), { mode: 0o600 }); renameSync(`${file}.new`, file)
  expect(() => proof.verify()).toThrow()
})

it('confirms relaunch completion durability before answering created', async () => {
  const p = await savedCompletion()
  faults.linked = true; faults.failDirectory = true
  expect(() => p.receipts.readNativeRelaunchCompletion(id, { fingerprint: p.fingerprint, request: p.request })).toThrow('sync unavailable')
})

it('checks retained completion without recursively reconfirming durability', async () => {
  const p = await savedCompletion(), sync = vi.spyOn(fs, 'fsyncSync')
  const proof = p.receipts.readNativeRelaunchCompletion(id, { fingerprint: p.fingerprint, request: p.request })
  expect(sync).toHaveBeenCalled()
  sync.mockClear()
  for (let n = 0; n < 10; n++) proof.verify()
  expect(sync).not.toHaveBeenCalled()
})

it('rejects a receipt part replaced during completion durability confirmation', async () => {
  const p = await savedCompletion()
  faults.directorySync = () => {
    faults.directorySync = undefined
    const file = p.file('claim')
    writeFileSync(`${file}.new`, readFileSync(file), { mode: 0o600 }); renameSync(`${file}.new`, file)
  }
  expect(() => p.receipts.readNativeRelaunchCompletion(id, { fingerprint: p.fingerprint, request: p.request })).toThrow()
})

it.each(['failed', 'different-success'] as const)('revokes completion after a contradictory late %s cannot be persisted', async kind => {
  const p = fixture()
  let finish!: (value: AgentCreationOutcome) => void
  const running = p.receipts.runIntent(id, fingerprint, request, held, async () => () => {
    p.receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, processOwner, fence())
    return new Promise(resolve => { finish = resolve })
  })
  const rejected = expect(running).rejects.toThrow('CREATION_STORAGE_FAILED')
  await vi.waitFor(() => expect(finish).toBeDefined())
  p.confirm()
  const proof = p.receipts.readNativeRelaunchCompletion(id, { fingerprint, request })
  expect(proof.outcome).toEqual(outcome); expect(() => proof.verify()).not.toThrow()
  vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => { throw Error('Result storage unavailable') })
  finish(kind === 'failed' ? { state: 'failed', error: 'KNOWN_NOT_DISPATCHED' } : { ...outcome, agentId: 'different-agent' })
  await rejected
  expect(fs.existsSync(p.file('result'))).toBe(false)
  expect(() => p.receipts.status(id)).toThrow('CREATION_STORAGE_FAILED')
  expect(() => proof.verify()).toThrow('CREATION_STORAGE_FAILED')
})

it('durably refines only the original native allocation and never hands recovery a dispatch callback', async () => {
  const { directory, receipts, file, confirm, effect } = await uncertain()
  const original = readFileSync(file('result'), 'utf8'), authority = fence()
  expect(confirm(authority)).toEqual(outcome)
  expect(authority.verify).toHaveBeenCalled(); expect(authority.current).toHaveBeenCalled()
  expect(readFileSync(file('result'), 'utf8')).toBe(original)
  const confirmation = readFileSync(file('confirmation'), 'utf8')
  expect(confirm()).toEqual(outcome)
  expect(readFileSync(file('confirmation'), 'utf8')).toBe(confirmation)
  const recovered = new AgentCreationReceipts(directory), prepare = vi.fn()
  expect(recovered.status(id)).toEqual(outcome)
  expect(await recovered.runIntent(id, fingerprint, request, held, prepare)).toEqual(outcome)
  expect(await recovered.run(id, fingerprint, effect)).toEqual(outcome)
  expect(recovered.cancelIntent(id)).toEqual(outcome)
  expect(recovered.pendingIntent(id)).toBeNull(); expect(prepare).not.toHaveBeenCalled(); expect(effect).toHaveBeenCalledOnce()
  expect(receipts.has(id, fingerprint)).toBe(true)
})

it('keeps a recovered success when the original live publisher later returns uncertainty', async () => {
  const { directory, receipts, confirm, file } = fixture()
  let finish!: (value: AgentCreationOutcome) => void
  const running = receipts.runIntent(id, fingerprint, request, held, async () => () => new Promise(resolve => { finish = resolve }))
  await vi.waitFor(() => expect(finish).toBeDefined())
  expect(confirm()).toEqual(outcome)
  finish({ state: 'unconfirmed' })
  await expect(running).resolves.toEqual(outcome)
  expect(fs.existsSync(file('result'))).toBe(false)
  expect(new AgentCreationReceipts(directory).status(id)).toEqual(outcome)
})

it.each(['confirmed', 'corrupt-confirmation', 'missing-claim', 'missing-intent'] as const)(
  'rechecks %s evidence after the reply deadline while the actual effect remains occupied', async kind => {
    vi.useFakeTimers()
    const { receipts, confirm, file } = fixture()
    let finish!: (value: AgentCreationOutcome) => void
    const effect = vi.fn(() => new Promise<AgentCreationOutcome>(resolve => { finish = resolve }))
    const prepare = vi.fn(async () => effect)
    const running = receipts.runIntent(id, fingerprint, request, held, prepare)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(running).resolves.toEqual({ state: 'pending' })
    expect(confirm()).toEqual(outcome)
    if (kind === 'corrupt-confirmation') writeFileSync(file('confirmation'), 'null', { mode: 0o600 })
    if (kind === 'missing-claim') rmSync(file('claim'))
    if (kind === 'missing-intent') rmSync(file())
    try {
      for (const retry of [() => receipts.runIntent(id, fingerprint, request, held, prepare), () => receipts.run(id, fingerprint, effect)]) {
        if (kind === 'confirmed') await expect(retry()).resolves.toEqual(outcome)
        else expect(retry).toThrow('CREATION_STORAGE_FAILED')
      }
      expect(prepare).toHaveBeenCalledOnce(); expect(effect).toHaveBeenCalledOnce()
    } finally { finish({ state: 'unconfirmed' }); await vi.advanceTimersByTimeAsync(0) }
  },
)

it.each(['failed', 'different-success'] as const)('retains a contradictory late %s as a storage hold', async kind => {
  const { directory, receipts, confirm } = fixture()
  let finish!: (value: AgentCreationOutcome) => void
  const running = receipts.runIntent(id, fingerprint, request, held, async () => () => new Promise(resolve => { finish = resolve }))
  const rejected = expect(running).rejects.toThrow('CREATION_STORAGE_FAILED')
  await vi.waitFor(() => expect(finish).toBeDefined())
  expect(confirm()).toEqual(outcome)
  finish(kind === 'failed' ? { state: 'failed', error: 'KNOWN_NOT_DISPATCHED' } : { ...outcome, agentId: 'different-agent' })
  await rejected
  expect(() => new AgentCreationReceipts(directory).status(id)).toThrow('CREATION_STORAGE_FAILED')
})

it('does not replace an occupied request with a coherent foreign receipt under the same ID', async () => {
  vi.useFakeTimers()
  const { receipts, file } = fixture(), foreign = fixture()
  let finish!: (value: AgentCreationOutcome) => void
  const effect = vi.fn(() => new Promise<AgentCreationOutcome>(resolve => { finish = resolve }))
  const prepare = vi.fn(async () => effect)
  const running = receipts.runIntent(id, fingerprint, request, held, prepare)
  await vi.advanceTimersByTimeAsync(5_000)
  await expect(running).resolves.toEqual({ state: 'pending' })
  const other = { ...request, agentId: 'foreign-agent' }, otherFingerprint = creationFingerprint(other)
  await foreign.receipts.runIntent(id, otherFingerprint, other, held, async () => async () => ({ ...outcome, agentId: other.agentId }))
  for (const part of ['', 'claim', 'result']) fs.copyFileSync(foreign.file(part), file(part))
  try {
    expect(() => receipts.runIntent(id, fingerprint, request, held, prepare)).toThrow('CREATION_CONFLICT')
    expect(() => receipts.run(id, fingerprint, effect)).toThrow('CREATION_CONFLICT')
    expect(prepare).toHaveBeenCalledOnce(); expect(effect).toHaveBeenCalledOnce()
  } finally { finish({ state: 'unconfirmed' }); await vi.advanceTimersByTimeAsync(0) }
})

it.each(['missing', 'unclaimed', 'cancelled', 'legacy', 'failed'] as const)('does not confirm a %s request', async kind => {
  const { receipts, confirm, file } = fixture()
  if (kind === 'legacy') await receipts.run(id, fingerprint, async () => outcome)
  else if (kind === 'cancelled') receipts.cancelIntent(id)
  else if (kind === 'unclaimed') await receipts.runIntent(id, fingerprint, request, held, async () => null)
  else if (kind === 'failed') await receipts.runIntent(id, fingerprint, request, held, async () => async () => ({ state: 'failed', error: 'KNOWN_NOT_DISPATCHED' }))
  expect(confirm).toThrow('CREATION_CONFLICT')
  expect(fs.existsSync(file('confirmation'))).toBe(false)
})

it.each(['kind', 'request', 'fingerprint', 'agent', 'outcome', 'token'] as const)('rejects mismatched %s confirmation authority', async kind => {
  const { receipts, file } = await uncertain()
  const value = { fingerprint, request: { ...request }, outcome: { ...outcome } }
  if (kind === 'kind') value.request.kind = 'model-create'
  if (kind === 'request') value.request.operation = 'restart'
  if (kind === 'fingerprint') value.fingerprint = '0'.repeat(64)
  if (kind === 'agent') value.outcome.agentId = 'different-agent'
  if (kind === 'outcome') Object.assign(value.outcome, { level: 'native' })
  if (kind === 'token') value.request.launchToken = 'short'
  expect(() => receipts.confirmNativeRelaunch(id, value, fence())).toThrow('CREATION_CONFLICT')
  expect(fs.existsSync(file('confirmation'))).toBe(false)
})

it.each(['intent', 'claim', 'cancel', 'legacy', 'result', 'confirmation'] as const)('holds changed %s evidence in status, retry, cancel and pending paths', async kind => {
  const { directory, receipts, file, confirm } = await uncertain()
  confirm()
  if (kind === 'intent') rmSync(file())
  if (kind === 'claim') rmSync(file('claim'))
  if (kind === 'cancel') writeFileSync(file(), JSON.stringify({ version: 2, cancelled: true }), { mode: 0o600 })
  if (kind === 'legacy') writeFileSync(file(), JSON.stringify({ version: 1, fingerprint, outcome }), { mode: 0o600 })
  if (kind === 'result') {
    const value = JSON.parse(readFileSync(file('result'), 'utf8')); value.outcome = { state: 'failed', error: 'CONFLICT' }
    writeFileSync(file('result'), JSON.stringify(value), { mode: 0o600 })
  }
  if (kind === 'confirmation') {
    const value = JSON.parse(readFileSync(file('confirmation'), 'utf8')); value.token = 'another-dispatch-token'
    writeFileSync(file('confirmation'), JSON.stringify(value), { mode: 0o600 })
  }
  for (const value of [receipts, new AgentCreationReceipts(directory)]) {
    expect(() => value.status(id)).toThrow('CREATION_STORAGE_FAILED')
    expect(() => value.has(id, fingerprint)).toThrow('CREATION_STORAGE_FAILED')
    expect(() => value.cancelIntent(id)).toThrow('CREATION_STORAGE_FAILED')
    expect(() => value.pendingIntent(id)).toThrow('CREATION_STORAGE_FAILED')
    expect(() => value.runIntent(id, fingerprint, request, held, vi.fn())).toThrow('CREATION_STORAGE_FAILED')
  }
})

it('confirms an identical immutable part after failed parent sync without rewriting it', async () => {
  const { receipts, file, confirm } = await uncertain()
  faults.failDirectory = true
  expect(confirm).toThrow('CREATION_STORAGE_FAILED')
  const bytes = readFileSync(file('confirmation'), 'utf8')
  expect(() => receipts.status(id)).toThrow()
  faults.failDirectory = false
  expect(confirm()).toEqual(outcome)
  expect(readFileSync(file('confirmation'), 'utf8')).toBe(bytes)
})

it('finishes the file proof with local authority before publishing confirmation', async () => {
  const { confirm, file } = await uncertain()
  let revoked = false, calls = 0
  const authority = fence()
  authority.verify.mockImplementation(() => { if (++calls >= 3) faults.inspect = () => { revoked = true } })
  authority.current.mockImplementation(() => { if (revoked) throw Error('original owner revoked') })
  expect(() => confirm(authority)).toThrow()
  expect(faults.linked).toBe(false)
  expect(fs.existsSync(file('confirmation'))).toBe(false)
})

it.each(['failed', 'different-success', 'claim', 'invalid'] as const)('does not adopt a peer %s published while capturing the original result proof', async kind => {
  const { file, confirm } = await uncertain()
  faults.captureResult = () => {
    faults.captureResult = undefined
    const value = JSON.parse(readFileSync(file('result'), 'utf8'))
    if (kind === 'failed') value.outcome = { state: 'failed', error: 'KNOWN_NOT_DISPATCHED' }
    if (kind === 'different-success') value.outcome = { ...outcome, agentId: 'another-agent' }
    if (kind === 'claim') value.token = 'different-dispatch-token'
    writeFileSync(file('result'), kind === 'invalid' ? 'null' : JSON.stringify(value), { mode: 0o600 })
  }
  expect(confirm).toThrow('CREATION_STORAGE_FAILED')
  expect(fs.existsSync(file('confirmation'))).toBe(false)
})

it('preserves the original receipt route when an ancestor is replaced during publication', async () => {
  const { root, directory, confirm } = await uncertain(), moved = `${root}-previous`
  faults.beforeLink = () => {
    renameSync(root, moved); mkdirSync(root, { mode: 0o700 }); renameSync(join(moved, 'receipts'), directory)
  }
  try { expect(confirm).toThrow() }
  finally { rmSync(moved, { recursive: true, force: true }) }
})

it('only the original witness publisher may continue to exec, while recovery gets read-only process proof', async () => {
  const { receipts, directory, file } = await uncertain(), expected = { fingerprint, request }
  expect(receipts.recordNativeRelaunchProcess(id, expected, processOwner, fence())).not.toBeNull()
  const bytes = readFileSync(file('process'), 'utf8')
  for (const recovered of [receipts, new AgentCreationReceipts(directory)]) {
    const proof = recovered.readNativeRelaunchProcess(id, expected)
    expect(proof.process).toEqual(processOwner); proof.verify()
    expect(recovered.status(id)).toEqual({ state: 'unconfirmed' })
    expect(recovered.recordNativeRelaunchProcess(id, expected, processOwner, fence())).toBeNull()
    expect(recovered.recordNativeRelaunchProcess(id, expected, { ...processOwner, pid: 235 }, fence())).toBeNull()
  }
  expect(readFileSync(file('process'), 'utf8')).toBe(bytes)
  expect(() => receipts.readNativeRelaunchProcess(id, { fingerprint: 'b'.repeat(64), request })).toThrow('CREATION_CONFLICT')
})

it('confirms its original witnessed execution without treating its own confirmation as foreign storage', async () => {
  const { receipts } = await uncertain()
  receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, processOwner, fence())
  const original = receipts.readNativeRelaunchProcess(id, { fingerprint, request })
  original.verify()
  let retained: { verify(): void } | undefined
  expect(receipts.confirmNativeRelaunch(id, { fingerprint, request, outcome },
    { verify: original.verifyConfirmation, current() {} }, proof => { retained = proof })).toEqual(outcome)
  expect(original.verify).toThrow()
  expect(retained!.verify).not.toThrow()
  expect(receipts.confirmNativeRelaunch(id, { fingerprint, request, outcome },
    { verify: original.verifyConfirmation, current() {} })).toEqual(outcome)
})

it.each(['intent', 'claim', 'result', 'process', 'confirmation'])('retains the original %s inode through the confirmation handoff', async kind => {
  const { receipts, file } = await uncertain()
  receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, processOwner, fence())
  const original = receipts.readNativeRelaunchProcess(id, { fingerprint, request })
  let retained: { verify(): void } | undefined
  receipts.confirmNativeRelaunch(id, { fingerprint, request, outcome },
    { verify: original.verifyConfirmation, current() {} }, proof => { retained = proof })
  const path = file(kind === 'intent' ? '' : kind), bytes = readFileSync(path)
  renameSync(path, `${path}.previous`); writeFileSync(path, bytes, { mode: 0o600 })
  if (kind !== 'confirmation') expect(original.verifyConfirmation).toThrow()
  expect(retained!.verify).toThrow()
})

it.each(['linux', 'darwin'] as const)('retains the exact %s PID view of a new witness', async platform => {
  const p = await uncertain(), process = { ...processOwner, boot: processOwner.boot.replace('linux:', platform + ':'),
    birth: platform === 'linux' ? '123456' : '123456:1', namespace: platform === 'linux' ? 'linux:4:123' : 'darwin' }
  expect(p.receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, process, fence())).not.toBeNull()
  const proof = p.receipts.readNativeRelaunchProcess(id, { fingerprint, request })
  expect(proof.process).toEqual(process)
  const original = JSON.parse(readFileSync(p.file('process'), 'utf8'))
  original.process.namespace = platform === 'linux' ? 'linux:4:124' : 'linux:4:123'
  original.checksum = creationFingerprint({ fingerprint: original.fingerprint, token: original.token, process: original.process })
  writeFileSync(p.file('process'), JSON.stringify(original), { mode: 0o600 })
  expect(() => proof.verify()).toThrow()
})

it.each([
  { birth: '123456:000001', boot: 'darwin:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' },
  { birth: '9007199254740992' }, { birth: '123456:1000000', boot: 'darwin:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' },
  { namespace: undefined }, { namespace: 'darwin' }, { namespace: 'linux:04:123' },
  { namespace: 'linux:4:0' }, { namespace: 'linux:4:18446744073709551616' },
])('rejects noncanonical birth or namespace evidence: %j', async fields => {
  const p = await uncertain()
  expect(() => p.receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, { ...processOwner, ...fields }, fence())).toThrow()
  expect(fs.existsSync(p.file('process'))).toBe(false)
})

it('retains its own actual confirmation inode before directory durability', async () => {
  const { receipts, file } = await uncertain()
  receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, processOwner, fence())
  const original = receipts.readNativeRelaunchProcess(id, { fingerprint, request })
  faults.linked = false
  faults.directorySync = () => {
    if (!faults.linked) return
    faults.directorySync = undefined
    const path = file('confirmation'), bytes = readFileSync(path)
    renameSync(path, file('previous')); writeFileSync(path, bytes, { mode: 0o600 })
  }
  expect(() => receipts.confirmNativeRelaunch(id, { fingerprint, request, outcome },
    { verify: original.verifyConfirmation, current() {} })).toThrow()
})

it('a failed witness sync cannot become execution authority even for the exact original process', async () => {
  const { receipts, file } = await uncertain(), expected = { fingerprint, request }
  faults.failDirectory = true
  expect(() => receipts.recordNativeRelaunchProcess(id, expected, processOwner, fence())).toThrow('CREATION_STORAGE_FAILED')
  const bytes = readFileSync(file('process'), 'utf8')
  expect(receipts.recordNativeRelaunchProcess(id, expected, processOwner, fence())).toBeNull()
  expect(() => receipts.readNativeRelaunchProcess(id, expected)).toThrow()
  faults.failDirectory = false
  expect(receipts.readNativeRelaunchProcess(id, expected).process).toEqual(processOwner)
  expect(receipts.recordNativeRelaunchProcess(id, expected, processOwner, fence())).toBeNull()
  expect(readFileSync(file('process'), 'utf8')).toBe(bytes)
})

it.each(['boot', 'pid', 'birth', 'extra'] as const)('refuses malformed %s process witnesses', async kind => {
  const { receipts, file } = await uncertain(), owner = { ...processOwner }
  if (kind === 'boot') owner.boot = 'approximate-boot'
  if (kind === 'pid') owner.pid = 1
  if (kind === 'birth') owner.birth = 'rounded time'
  if (kind === 'extra') Object.assign(owner, { argv: [] })
  expect(() => receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, owner, fence())).toThrow('CREATION_CONFLICT')
  expect(fs.existsSync(file('process'))).toBe(false)
})

it.each(['intent', 'claim', 'result', 'process', 'birth', 'version'] as const)('retains a process witness hold after its %s evidence changes', async kind => {
  const { receipts, directory, file } = await uncertain(), expected = { fingerprint, request }
  receipts.recordNativeRelaunchProcess(id, expected, processOwner, fence())
  const proof = receipts.readNativeRelaunchProcess(id, expected)
  if (kind === 'intent') rmSync(file())
  if (kind === 'claim') rmSync(file('claim'))
  if (kind === 'result') {
    const value = JSON.parse(readFileSync(file('result'), 'utf8')); value.outcome = { state: 'failed', error: 'NATIVE_REARM_NOT_DISPATCHED' }
    writeFileSync(file('result'), JSON.stringify(value))
  }
  if (kind === 'process') {
    const value = JSON.parse(readFileSync(file('process'), 'utf8')); value.token = 'foreign-claim'
    writeFileSync(file('process'), JSON.stringify(value))
  }
  if (kind === 'birth' || kind === 'version') {
    const value = JSON.parse(readFileSync(file('process'), 'utf8'))
    if (kind === 'birth') value.process.birth = '123457'
    else value.version = 2
    writeFileSync(file('process'), JSON.stringify(value))
  }
  expect(proof.verify).toThrow()
  for (const recovered of [receipts, new AgentCreationReceipts(directory)]) {
    expect(() => recovered.status(id)).toThrow('CREATION_STORAGE_FAILED')
    expect(() => recovered.cancelIntent(id)).toThrow('CREATION_STORAGE_FAILED')
    expect(() => recovered.runIntent(id, fingerprint, request, held, vi.fn())).toThrow('CREATION_STORAGE_FAILED')
    expect(() => recovered.readNativeRelaunchProcess(id, expected)).toThrow()
  }
})

it('an orphan process witness prevents a fresh request even after its other parts disappear', async () => {
  const { receipts, directory, file } = await uncertain()
  receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, processOwner, fence())
  for (const part of ['', 'claim', 'result']) rmSync(file(part))
  const recovered = new AgentCreationReceipts(directory)
  expect(() => recovered.status(id)).toThrow('CREATION_STORAGE_FAILED')
  expect(() => recovered.runIntent(id, fingerprint, request, held, vi.fn())).toThrow('CREATION_STORAGE_FAILED')
  expect(fs.existsSync(file())).toBe(false)
  expect(() => recovered.run(id, fingerprint, vi.fn())).toThrow('CREATION_STORAGE_FAILED')
  expect(fs.existsSync(file())).toBe(false)
})

it('never adopts a replacement of its own process witness during publication sync', async () => {
  const { receipts, file } = await uncertain()
  faults.directorySync = () => {
    if (!faults.linked) return
    faults.directorySync = undefined
    const bytes = readFileSync(file('process'))
    renameSync(file('process'), file('previous'))
    writeFileSync(file('process'), bytes, { mode: 0o600 })
  }
  expect(() => receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, processOwner, fence())).toThrow()
  expect(readFileSync(file('process'), 'utf8')).toBe(readFileSync(file('previous'), 'utf8'))
  expect(receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, processOwner, fence())).toBeNull()
})

it('keeps the original publication proof when the writer reproves its parent after durability', async () => {
  const { receipts, file } = await uncertain()
  const permit = receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, processOwner, fence())!
  permit.verify()
  const bytes = readFileSync(file('process'))
  renameSync(file('process'), file('previous')); writeFileSync(file('process'), bytes, { mode: 0o600 })
  expect(permit.verify).toThrow()
  expect(receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, processOwner, fence())).toBeNull()
})

it.each(['remove', 'replace', 'corrupt'] as const)('holds a %s process witness during confirmation sync', async kind => {
  const { receipts, file, confirm } = await uncertain()
  receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, processOwner, fence())
  faults.linked = false
  faults.directorySync = () => {
    if (!faults.linked) return
    faults.directorySync = undefined
    const bytes = readFileSync(file('process'))
    renameSync(file('process'), file('previous'))
    if (kind !== 'remove') writeFileSync(file('process'), kind === 'replace' ? bytes : 'null', { mode: 0o600 })
  }
  expect(confirm).toThrow()
})

it.each(['status', 'cancel', 'run'] as const)('retains the process witness through confirmed %s durability checks', async operation => {
  const { receipts, file, confirm } = await uncertain()
  receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, processOwner, fence())
  confirm()
  faults.directorySync = () => {
    faults.directorySync = undefined
    const bytes = readFileSync(file('process'))
    renameSync(file('process'), file('previous'))
    writeFileSync(file('process'), bytes, { mode: 0o600 })
  }
  const call = operation === 'status' ? () => receipts.status(id) : operation === 'cancel' ? () => receipts.cancelIntent(id)
    : () => receipts.runIntent(id, fingerprint, request, held, vi.fn())
  expect(call).toThrow()
})

it.each(['remove', 'change', 'insert'] as const)('a later %s cannot change which process a success confirmed', async kind => {
  const { receipts, directory, file, confirm } = await uncertain()
  receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, processOwner, fence())
  const original = readFileSync(file('process'), 'utf8')
  if (kind === 'insert') rmSync(file('process'))
  confirm()
  if (kind === 'remove') rmSync(file('process'))
  else {
    const value = JSON.parse(original)
    if (kind === 'change') {
      value.process.pid++
      value.checksum = creationFingerprint({ fingerprint: value.fingerprint, token: value.token, process: value.process })
    }
    writeFileSync(file('process'), JSON.stringify(value), { mode: 0o600 })
  }
  expect(() => new AgentCreationReceipts(directory).status(id)).toThrow('CREATION_STORAGE_FAILED')
})

it('checks local revocation after the final file proof before the pre-exec witness publication', async () => {
  const { receipts, file } = await uncertain(), authority = fence()
  let revoked = false
  authority.verify.mockImplementation(() => { faults.inspect = () => { revoked = true } })
  authority.current.mockImplementation(() => { if (revoked) throw Error('original launch revoked') })
  expect(() => receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, processOwner, authority)).toThrow()
  expect(faults.linked).toBe(false); expect(fs.existsSync(file('process'))).toBe(false)
})
