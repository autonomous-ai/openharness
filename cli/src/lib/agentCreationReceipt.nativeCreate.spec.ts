import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentCreationReceipts, creationFingerprint, type NativeCreationRequest, type NativeRelaunchProcess } from './agentCreationReceipt.js'
import { nativeCreateFingerprint, parseNativeCreateRequest } from './nativeCreateRequest.js'

const faults = vi.hoisted(() => ({ linked: false, failDirectory: false }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, linkSync: (...args: Parameters<typeof actual.linkSync>) => {
    if (/\.(confirmation|process)$/.test(String(args[1]))) faults.linked = true
    return actual.linkSync(...args)
  }, fsyncSync: (fd: number) => {
    if (faults.linked && faults.failDirectory && actual.fstatSync(fd).isDirectory()) throw Error('fixture parent sync unavailable')
    actual.fsyncSync(fd)
  } }
})
const roots: string[] = []
afterEach(() => { faults.linked = false; faults.failDirectory = false; vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const id = 'original-native-create-request', agentId = 'fixture-agent'
const request = parseNativeCreateRequest({ kind: 'native-create-v2', creationId: id, agentId, launchToken: 'original-create-token',
  input: { engine: 'cursor', cwd: '/fixture/project', prompt: 'Fixture prompt', grid: null },
  label: 'harness-cursor-original', selection: null, local: true,
})!
const fingerprint = nativeCreateFingerprint(request), input: NativeCreationRequest = { request, fingerprint }
const outcome = { state: 'created' as const, agentId }, held = { service: 'native', detail: 'Waiting for the original creation.' }
const boot = 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', namespace = 'linux:4:5'
const processOwner = (): NativeRelaunchProcess => ({ boot, namespace, pid: 42, birth: '12345', allocation: {
  pane: '%1', rootPid: 40, root: { boot, namespace, pid: 40, birth: '1200' }, owner: 'a'.repeat(16), token: request.launchToken,
  endpoint: { binary: '/fixture/tmux', socket: '/fixture/socket', server: { boot, namespace, pid: 30, birth: '1000' } },
} })
const fence = () => ({ verify: vi.fn(), current: vi.fn() })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-create-receipt-'))); roots.push(root)
  const directory = join(root, 'receipts'), receipts = new AgentCreationReceipts(directory)
  const file = (part = '') => join(directory, `${id}.json${part && '.' + part}`)
  const cold = () => new AgentCreationReceipts(directory)
  const record = () => receipts.recordNativeCreationProcess(id, input, processOwner(), fence())
  const confirm = () => receipts.confirmNativeCreation(id, { ...input, outcome }, fence())
  return { root, directory, receipts, file, cold, record, confirm }
}
async function uncertain() {
  const p = fixture(), effect = vi.fn(async () => ({ state: 'unconfirmed' as const }))
  await p.receipts.runIntent(id, fingerprint, request, held, async () => effect)
  return { ...p, effect }
}

it('confirms the exact initial allocation without claiming a resumed conversation', async () => {
  const p = await uncertain()
  let permit: ReturnType<typeof p.record>
  expect(() => { permit = p.record() }).not.toThrow()
  expect(permit!).not.toBeNull(); expect(permit!.verify).not.toThrow()
  expect(p.record()).toBeNull()
  expect(p.confirm()).toEqual(outcome)
  const cold = p.cold(), witness = cold.readNativeCreationProcess(id, input), completed = cold.readNativeCreationCompletion(id, input)
  expect(witness.process).toEqual(processOwner()); expect(completed.outcome).toEqual(outcome)
  expect(completed.outcome).not.toHaveProperty('resumed')
  expect(witness.verify).not.toThrow(); expect(completed.verify).not.toThrow()
  expect(Object.isFrozen(witness.process.allocation!.endpoint.server)).toBe(true)
  const replay = vi.fn(async () => p.effect)
  await expect(cold.runIntent(id, fingerprint, request, held, replay)).resolves.toEqual(outcome)
  expect(replay).not.toHaveBeenCalled(); expect(p.effect).toHaveBeenCalledOnce()
})

it('uses the first durable generated IDs and label across a cold retry with the same user choice', async () => {
  const p = fixture()
  await p.receipts.runIntent(id, fingerprint, request, held, async () => null)
  const later = { ...request, agentId: 'later-agent', launchToken: 'later-launch-token', label: 'harness-cursor-later', local: false }
  const prepared = vi.fn(async () => null)
  await p.cold().runIntent(id, fingerprint, later, held, prepared)
  expect(prepared).toHaveBeenCalledWith(request, expect.objectContaining({ id }))
  expect(JSON.parse(readFileSync(p.file(), 'utf8')).request).toEqual(request)
})

it.each(['agentId', 'launchToken', 'label', 'local'] as const)('refuses competing %s metadata as witness authority', async key => {
  const p = await uncertain(), changed = { ...request, [key]: key === 'local' ? false : key === 'label' ? 'harness-cursor-later' : 'different-original-identity' }
  expect(() => p.receipts.recordNativeCreationProcess(id, { fingerprint, request: changed }, processOwner(), fence())).toThrow('CREATION_CONFLICT')
  expect(existsSync(p.file('process'))).toBe(false)
})

it.each(['oversized', 'fingerprint', 'id', 'predecessor'] as const)('refuses %s initial intent before preparation or publication', async change => {
  const p = fixture(), prepare = vi.fn(async () => null), altered: any = structuredClone(request)
  if (change === 'oversized') altered.input.prompt = 'x'.repeat(32 * 1024)
  if (change === 'id') altered.creationId = 'different-original-request'
  if (change === 'predecessor') altered.sourceProcess = { processKey: null }
  const hash = change === 'fingerprint' ? 'f'.repeat(64) : change === 'oversized' ? nativeCreateFingerprint(altered) : fingerprint
  await expect(Promise.resolve().then(() => p.receipts.runIntent(id, hash, altered, held, prepare))).rejects.toThrow('CREATION_CONFLICT')
  expect(prepare).not.toHaveBeenCalled(); expect(existsSync(p.file())).toBe(false)
})

it.each(['namespace', 'allocation', 'token'] as const)('refuses incomplete %s before initial witness publication', async change => {
  const p = await uncertain(), owner = processOwner()
  if (change === 'token') owner.allocation = { ...owner.allocation!, token: 'foreign-launch-token' }
  else delete owner[change]
  expect(() => p.receipts.recordNativeCreationProcess(id, input, owner, fence())).toThrow()
  expect(existsSync(p.file('process'))).toBe(false)
})

it.each(['namespace', 'allocation', 'token', 'initial-kind', 'fingerprint', 'missing-witness', 'resumed-outcome'] as const)('holds coherently checksummed cold %s damage', async change => {
  const p = await uncertain(); p.record(); p.confirm()
  if (change === 'initial-kind' || change === 'fingerprint') {
    const primary = JSON.parse(readFileSync(p.file(), 'utf8'))
    if (change === 'initial-kind') primary.request.sourceProcess = { processKey: null }
    else primary.request.input.prompt = 'Changed choice'
    primary.checksum = creationFingerprint({ fingerprint: primary.fingerprint, request: primary.request, held: primary.held })
    writeFileSync(p.file(), JSON.stringify(primary), { mode: 0o600 })
  } else if (change === 'missing-witness' || change === 'resumed-outcome') {
    const confirmed = JSON.parse(readFileSync(p.file('confirmation'), 'utf8'))
    if (change === 'missing-witness') { rmSync(p.file('process')); confirmed.process = null }
    else confirmed.outcome.resumed = true
    writeFileSync(p.file('confirmation'), JSON.stringify(confirmed), { mode: 0o600 })
  } else {
    const part = JSON.parse(readFileSync(p.file('process'), 'utf8'))
    if (change === 'token') part.process.allocation.token = 'foreign-launch-token'
    else delete part.process[change]
    part.checksum = creationFingerprint({ fingerprint: part.fingerprint, token: part.token, process: part.process })
    writeFileSync(p.file('process'), JSON.stringify(part), { mode: 0o600 })
    const confirmed = JSON.parse(readFileSync(p.file('confirmation'), 'utf8')); confirmed.process = part.checksum
    writeFileSync(p.file('confirmation'), JSON.stringify(confirmed), { mode: 0o600 })
  }
  const cold = p.cold()
  expect(() => cold.status(id)).toThrow('CREATION_STORAGE_FAILED')
  expect(() => cold.readNativeCreationProcess(id, input)).toThrow()
  expect(() => cold.readNativeCreationCompletion(id, input)).toThrow()
})

it('does not treat an opened pane or missing witness as a completed initial creation', async () => {
  const p = fixture()
  await expect(p.receipts.runIntent(id, fingerprint, request, held, async () => async () => outcome)).resolves.toEqual({ state: 'unconfirmed' })
  expect(p.confirm).toThrow(); expect(existsSync(p.file('confirmation'))).toBe(false)
  expect(() => p.receipts.readNativeCreationNotDispatched(id, input)).toThrow()
  const claim = JSON.parse(readFileSync(p.file('claim'), 'utf8'))
  writeFileSync(p.file('result'), JSON.stringify({ fingerprint, token: claim.token, outcome }), { mode: 0o600 })
  expect(() => p.cold().status(id)).toThrow('CREATION_STORAGE_FAILED')
})

it.each([{ ...outcome, resumed: true }, { ...outcome, resumed: false }, { ...outcome, agentId: 'other-agent' }, { ...outcome, level: 'native' }])(
  'refuses a borrowed or mismatched initial confirmation %#', async value => {
    const p = await uncertain(); p.record()
    expect(() => p.receipts.confirmNativeCreation(id, { ...input, outcome: value }, fence())).toThrow('CREATION_CONFLICT')
    expect(existsSync(p.file('confirmation'))).toBe(false)
  },
)

it.each(['process', 'confirmation'] as const)('a failed %s directory sync cannot grant another exec', async part => {
  const p = await uncertain()
  if (part === 'confirmation') p.record()
  faults.linked = false; faults.failDirectory = true
  expect(part === 'process' ? p.record : p.confirm).toThrow('CREATION_STORAGE_FAILED')
  expect(existsSync(p.file(part))).toBe(true)
  faults.failDirectory = false
  if (part === 'process') expect(p.record()).toBeNull()
  else expect(p.record).toThrow('CREATION_CONFLICT')
  expect(p.confirm()).toEqual(outcome)
  expect(p.cold().readNativeCreationCompletion(id, input).outcome).toEqual(outcome)
})

it.each(['', 'claim', 'result', 'confirmation', 'process'])('retains the exact initial %s file across cold completion', async part => {
  const p = await uncertain(); p.record(); p.confirm()
  const proof = p.cold().readNativeCreationCompletion(id, input), witness = p.cold().readNativeCreationProcess(id, input)
  const file = p.file(part); writeFileSync(file + '.new', readFileSync(file), { mode: 0o600 }); renameSync(file + '.new', file)
  expect(proof.verify).toThrow(); expect(witness.verify).toThrow()
})

it.each(['cancelled-id', 'cancelled-request', 'not-dispatched'] as const)('accounts an initial %s without inventing an old engine', async mode => {
  const p = fixture()
  if (mode === 'cancelled-id') p.receipts.cancelIntent(id)
  else {
    await p.receipts.runIntent(id, fingerprint, request, held, async () => mode === 'cancelled-request' ? null
      : async () => ({ state: 'failed', error: 'NATIVE_CREATE_NOT_DISPATCHED' }))
    if (mode === 'cancelled-request') p.receipts.cancelIntent(id)
  }
  const proof = p.cold().readNativeCreationNotDispatched(id, input)
  expect(proof.kind).toBe(mode); expect(proof.verify).not.toThrow()
  const file = p.file('process'); writeFileSync(file, '{}', { mode: 0o600 })
  expect(proof.verify).toThrow()
})

it.each(['NATIVE_REARM_NOT_DISPATCHED', 'OTHER_FAILURE'])('does not borrow %s as initial non-dispatch evidence', async error => {
  const p = fixture()
  await p.receipts.runIntent(id, fingerprint, request, held, async () => async () => ({ state: 'failed', error }))
  expect(() => p.cold().readNativeCreationNotDispatched(id, input)).toThrow('CREATION_CONFLICT')
})

it('keeps first-create receipts separate from every rearm API', async () => {
  const p = await uncertain(); p.record(); p.confirm()
  const cold = p.cold()
  expect(() => cold.recordNativeRelaunchProcess(id, input, processOwner(), fence())).toThrow('CREATION_CONFLICT')
  expect(() => cold.readNativeRelaunchProcess(id, input)).toThrow('CREATION_CONFLICT')
  expect(() => cold.confirmNativeRelaunch(id, { ...input, outcome: { ...outcome, resumed: true } }, fence())).toThrow('CREATION_CONFLICT')
  expect(() => cold.readNativeRelaunchCompletion(id, input)).toThrow('CREATION_CONFLICT')
  expect(() => cold.readNativeRelaunchNotDispatched(id, input)).toThrow('CREATION_CONFLICT')
})

it('revokes initial exec after publication if the original owner expires', async () => {
  const p = await uncertain(), authority = fence()
  authority.current.mockImplementation(() => { if (existsSync(p.file('process'))) throw Error('original creation revoked') })
  expect(() => p.receipts.recordNativeCreationProcess(id, input, processOwner(), authority)).toThrow('original creation revoked')
  expect(existsSync(p.file('process'))).toBe(true)
  expect(p.record()).toBeNull()
})
