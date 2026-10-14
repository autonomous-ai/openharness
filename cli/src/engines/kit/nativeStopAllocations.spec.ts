import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentCreationReceipts, creationFingerprint, type NativeRelaunchProcess, type NativeRelaunchRequest } from '../../lib/agentCreationReceipt.js'
import { appendNativeAllocation } from '../../lib/nativeAllocation.js'
import { nativeCreateFingerprint, parseNativeCreateRequest } from '../../lib/nativeCreateRequest.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { NativeTurnIntent } from '../../lib/nativeTurnIntent.js'
import { readNativeStopAllocations } from './nativeStopAllocations.js'
import { createNativePhysicalStop } from './nativePhysicalStop.js'
import type { NativeHookScope } from './nativeHookScope.js'
import type { NativeEvidenceBudget } from './nativeEvidence.js'

const clock = vi.hoisted(() => ({ now: 0 }))
vi.mock('node:perf_hooks', () => ({ performance: { now: () => clock.now } }))
beforeEach(() => { clock.now = 0 })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
const boot = 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', namespace = 'linux:4:5', agentId = 'fixture-agent'
const engine = (pid: number) => ({ boot, namespace, pid, birth: String(1000 + pid) })
const reference = (pid: number) => ({ processKey: `${boot}\0cursor\0${pid}\0${1000 + pid}`, namespace })
const rearm = (receipt: NativeRelaunchRequest): NonNullable<NativeTurnIntent['rearm']> => ({
  requestId: receipt.request.creationId as string, agentId, operation: 'restart', source: 'live',
  launchToken: receipt.request.launchToken as string, target: receipt.request.target as string,
  sourceProcess: receipt.request.sourceProcess as ReturnType<typeof reference>, revoked: true,
})
function fixture(count = 1, pending = false) {
  const entries = Array.from({ length: count + Number(pending) }, (_, index) => {
    const request = { kind: 'native-rearm', creationId: `original-request-${index}`, agentId, operation: 'restart', source: 'live',
      launchToken: `original-launch-token-${index}`, target: 'a'.repeat(64), sourceProcess: reference(99 + index) }
    const receipt = { request, fingerprint: creationFingerprint({ kind: 'native-rearm', agentId, operation: 'restart', source: 'live' }) }
    const process: NativeRelaunchProcess = { ...engine(100 + index), allocation: { pane: `%${index}`, rootPid: 200 + index,
      token: request.launchToken, owner: 'c'.repeat(16), root: engine(200 + index), endpoint: {
        binary: '/fixture/tmux', socket: '/fixture/socket', server: engine(10),
      } } }
    return { receipt, process, verify: vi.fn() }
  })
  const row = { schemaVersion: count ? 4 : 3, agentId, registeredAt: 1, engine: 'cursor', sessionId: 'fixture-session', boundAt: 2,
    active: true, processIdentity: { pid: 99 + count, executable: '/fixture/cursor', startMarker: 'fixture-birth' },
    runtimes: [{ backend: 'tmux', paneId: '%0' }], primaryRuntimeKey: 'tmux\0%0', tmuxPane: '%0', cwd: '/fixture/project', transcriptPath: null,
    nativeControl: { version: 1, cancel: { ...reference(99 + count), target: 'b'.repeat(64), request: {
      requestId: 'original-cancel-request', nonce: 'original-cancel-nonce', agentId, conversationId: 'fixture-session', frontier: { index: -1, digest: null },
    } }, ...(pending ? { rearm: rearm(entries.at(-1)!.receipt) } : {}) },
  } as RegisteredSession
  for (const entry of entries.slice(0, count)) row.nativeAllocation = appendNativeAllocation(row.nativeAllocation, entry.receipt)
  const read = vi.fn<AgentCreationReceipts['readNativeRelaunchProcess']>((id, input) => {
    const entry = entries.find(value => value.receipt.request.creationId === id)!
    expect(input).toEqual(entry.receipt)
    return { process: structuredClone(entry.process), verify: entry.verify, verifyConfirmation: entry.verify }
  })
  const notDispatched = vi.fn<AgentCreationReceipts['readNativeRelaunchNotDispatched']>(() => { throw Error('original outcome is unknown') })
  const initialRead = vi.fn<AgentCreationReceipts['readNativeCreationProcess']>(() => { throw Error('not an initial launch') })
  const fence = { verify: vi.fn(), current: vi.fn() }
  const select = () => readNativeStopAllocations(row, { readNativeRelaunchProcess: read, readNativeRelaunchNotDispatched: notDispatched,
    readNativeCreationProcess: initialRead }, fence)
  return { entries, row, read, initialRead, notDispatched, fence, select }
}

it('accounts for the first creation without inventing an earlier engine', async () => {
  const p = fixture(), root = realpathSync(mkdtempSync(join(tmpdir(), 'native-first-stop-')))
  try {
    const request = parseNativeCreateRequest({ kind: 'native-create-v2', creationId: 'initial-creation-request', agentId,
      launchToken: p.entries[0].process.allocation!.token, label: 'harness-cursor-first', local: true,
      input: { engine: 'cursor', cwd: '/fixture/project' }, selection: null })!
    const initial = { request, fingerprint: nativeCreateFingerprint(request) }, receipts = new AgentCreationReceipts(root)
    await receipts.runIntent(request.creationId, initial.fingerprint, request, { service: 'native', detail: 'fixture' }, async () => async () => {
      receipts.recordNativeCreationProcess(request.creationId, initial, p.entries[0].process, p.fence)
      return { state: 'unconfirmed' }
    })
    receipts.confirmNativeCreation(request.creationId, { ...initial, outcome: { state: 'created', agentId } }, p.fence)
    p.row.nativeAllocation = appendNativeAllocation(undefined, initial)
    p.row.nativeControl = { ...p.row.nativeControl!, cancel: { ...p.row.nativeControl!.cancel, processKey: null } }
    delete (p.row.nativeControl.cancel as { namespace?: string }).namespace
    const cold = new AgentCreationReceipts(root), read = vi.spyOn(cold, 'readNativeCreationProcess')
    const rearmRead = vi.spyOn(cold, 'readNativeRelaunchProcess'), absence = vi.spyOn(cold, 'readNativeRelaunchNotDispatched')
    let owner!: ReturnType<typeof readNativeStopAllocations>
    expect(() => { owner = readNativeStopAllocations(p.row, cold, p.fence) }).not.toThrow()
    expect(owner.engines).toEqual([engine(100)])
    expect(owner.allocations).toEqual([p.entries[0].process.allocation])
    expect(read).toHaveBeenCalledWith(request.creationId, initial)
    expect(rearmRead).not.toHaveBeenCalled(); expect(absence).not.toHaveBeenCalled()
    owner.verifyAllocations()
    rmSync(join(root, `${request.creationId}.json.process`))
    expect(() => owner.verifyAllocations()).toThrow()
    expect(() => readNativeStopAllocations(p.row, cold, p.fence)).toThrow('admitted original witness')
    expect(absence).not.toHaveBeenCalled()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('cold Stop retains initial creation together with later admitted and pending rearm', async () => {
  const p = fixture(3, true), root = realpathSync(mkdtempSync(join(tmpdir(), 'native-mixed-stop-')))
  try {
    const request = parseNativeCreateRequest({ kind: 'native-create-v2', creationId: 'initial-creation-request', agentId,
      launchToken: p.entries[0].process.allocation!.token, label: 'harness-cursor-first', local: true,
      input: { engine: 'cursor', cwd: '/fixture/project' }, selection: null })!
    const first = { request, fingerprint: nativeCreateFingerprint(request) }, receipts = new AgentCreationReceipts(root)
    const create = async (entry: typeof first | NativeRelaunchRequest, process: NativeRelaunchProcess, initial: boolean) => {
      const id = entry.request.creationId as string
      await receipts.runIntent(id, entry.fingerprint, entry.request, { service: 'native', detail: 'fixture' }, async () => async () => {
        if (initial) receipts.recordNativeCreationProcess(request.creationId, first, process, p.fence)
        else receipts.recordNativeRelaunchProcess(id, entry, process, p.fence)
        return { state: 'unconfirmed' }
      })
    }
    await create(first, p.entries[0].process, true)
    receipts.confirmNativeCreation(request.creationId, { ...first, outcome: { state: 'created', agentId } }, p.fence)
    p.row.nativeAllocation = appendNativeAllocation(undefined, first)
    for (const entry of p.entries.slice(1, 3)) {
      await create(entry.receipt, entry.process, false)
      receipts.confirmNativeRelaunch(entry.receipt.request.creationId, { ...entry.receipt, outcome: { state: 'created', agentId, resumed: true } }, p.fence)
      p.row.nativeAllocation = appendNativeAllocation(p.row.nativeAllocation, entry.receipt)
    }
    const pending = p.entries[3]
    receipts.cancelIntent(pending.receipt.request.creationId)
    const cold = new AgentCreationReceipts(root)
    let owner!: ReturnType<typeof readNativeStopAllocations>
    expect(() => { owner = readNativeStopAllocations(p.row, cold, p.fence) }).not.toThrow()
    expect(owner.engines).toEqual([engine(102), engine(100), engine(101)])
    expect(owner.allocations.map(value => value.token)).toEqual(p.entries.slice(0, 3).map(value => value.process.allocation!.token))
    expect(owner.engines.some(value => value.pid === 99 || value.pid === 103)).toBe(false)
    owner.verifyAllocations()
    const originalFile = join(root, `${request.creationId}.json.process`)
    const replacement = `${originalFile}.replacement`
    writeFileSync(replacement, readFileSync(originalFile), { mode: 0o600 }); renameSync(replacement, originalFile)
    expect(() => owner.verifyAllocations()).toThrow()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

async function coldReceipts(root: string, p: ReturnType<typeof fixture>) {
  const receipts = new AgentCreationReceipts(root), first = p.entries[0], second = p.entries[1]
  await receipts.runIntent(first.receipt.request.creationId, first.receipt.fingerprint, first.receipt.request,
    { service: 'native', detail: 'fixture' }, async () => async () => {
      receipts.recordNativeRelaunchProcess(first.receipt.request.creationId, first.receipt, first.process, p.fence)
      return { state: 'unconfirmed' }
    })
  receipts.confirmNativeRelaunch(first.receipt.request.creationId, { ...first.receipt,
    outcome: { state: 'created', agentId, resumed: true } }, p.fence)
  receipts.cancelIntent(second.receipt.request.creationId)
  return new AgentCreationReceipts(root)
}

it('keeps the oldest engine, every confirmed allocation and the separate pending launch', () => {
  const p = fixture(4, true), owner = p.select()
  expect(owner.engines).toHaveLength(6); expect(owner.allocations).toHaveLength(5)
  expect(owner.engines.map(value => value.pid).sort()).toEqual([99, 100, 101, 102, 103, 104].sort())
  expect(owner.allocations.map(value => value.token)).toEqual(p.entries.map(value => value.receipt.request.launchToken))
  expect(p.read).toHaveBeenCalledTimes(5); expect(p.notDispatched).not.toHaveBeenCalled()
  expect(Object.isFrozen(owner)).toBe(true); expect(Object.isFrozen(owner.engines)).toBe(true); expect(Object.isFrozen(owner.allocations)).toBe(true)
})

it('does not read a confirmed request twice when revoked R retains that same admission', () => {
  const p = fixture(), control = structuredClone(p.row.nativeControl!)
  p.row.nativeControl = { ...control, rearm: { ...rearm(p.entries[0].receipt), replacement: { processKey: 'replacement', sessionId: 'fixture-session' } } }
  expect(p.select().allocations).toHaveLength(1)
  expect(p.read).toHaveBeenCalledOnce()
})

it('preserves same-numbered panes from separate original server incarnations', () => {
  const p = fixture(2), next = p.entries[1].process.allocation!
  p.entries[1].process.allocation = { ...next, pane: '%0', endpoint: { ...next.endpoint, server: { ...next.endpoint.server, birth: '9999' } } }
  let owner!: ReturnType<typeof p.select>
  expect(() => { owner = p.select() }).not.toThrow()
  expect(owner.allocations.map(value => value.endpoint.server.birth)).toEqual(['1010', '9999'])
})

it.each(['token', 'socket-alias', 'binary-alias'] as const)('holds conflicting %s lifetimes on one server/pane before physical work', change => {
  const p = fixture(2), second = p.entries[1].process.allocation!, endpoint = { ...second.endpoint }
  if (change === 'socket-alias') endpoint.socket = '/fixture/socket-alias'
  if (change === 'binary-alias') endpoint.binary = '/fixture/tmux-alias'
  p.entries[1].process.allocation = { ...second, pane: '%0', endpoint }
  expect(p.select).toThrow('lifetime transfer')
})

it('retains receipt authority after the source row is intentionally consumed', () => {
  const p = fixture(2), owner = p.select()
  p.fence.verify.mockImplementation(() => { throw Error('source row retired') })
  expect(owner.verifyAllocations).not.toThrow(); expect(owner.current).not.toThrow()
  expect(owner.verify).toThrow('source row retired')
  p.entries[0].verify.mockImplementation(() => { throw Error('original receipt changed') })
  expect(owner.verifyAllocations).toThrow('original receipt changed')
})

it('keeps the source fence separate from independent receipt verification', () => {
  const p = fixture(2), owner = p.select()
  p.entries.forEach(entry => entry.verify.mockClear())
  owner.verify()
  p.entries.forEach(entry => expect(entry.verify).not.toHaveBeenCalled())
  owner.verifyAllocations()
  p.entries.forEach(entry => expect(entry.verify).toHaveBeenCalledOnce())
})

it.each(['cancel', 'source'] as const)('does not silently discard a non-null %s without original namespace', change => {
  const p = fixture(), row: any = structuredClone(p.row)
  if (change === 'cancel') delete row.nativeControl.cancel.namespace
  else delete row.nativeAllocation.receipts[0].request.sourceProcess.namespace
  Object.assign(p.row, row)
  expect(p.select).toThrow('unknown original engine')
})

it.each(['missing', 'null', 'malformed'] as const)('holds a %s original source even when Cancel has a newer known engine', change => {
  const p = fixture(), row: any = structuredClone(p.row)
  if (change === 'missing') delete row.nativeAllocation.receipts[0].request.sourceProcess
  if (change === 'null') row.nativeAllocation.receipts[0].request.sourceProcess = { processKey: null }
  if (change === 'malformed') row.nativeAllocation.receipts[0].request.sourceProcess = { processKey: null, namespace }
  Object.assign(p.row, row)
  expect(p.select).toThrow()
})

it('null Cancel grants nothing and cannot discharge an unknown pending source', () => {
  const p = fixture(0, true), row: any = structuredClone(p.row)
  row.nativeControl.cancel.processKey = null; delete row.nativeControl.cancel.namespace
  row.nativeControl.rearm.sourceProcess = { processKey: null }
  Object.assign(p.row, row)
  expect(p.select).toThrow('unknown original engine')
  expect(p.read).not.toHaveBeenCalled(); expect(p.notDispatched).not.toHaveBeenCalled()
})

it('uses a complete known allocation history without inventing authority for null Cancel', () => {
  const p = fixture(), control: any = structuredClone(p.row.nativeControl)
  control.cancel.processKey = null; delete control.cancel.namespace; p.row.nativeControl = control
  expect(p.select().engines).toEqual([engine(99), engine(100)])
})

it('deduplicates only the entire scoped process incarnation', () => {
  const p = fixture(), control: any = structuredClone(p.row.nativeControl)
  control.cancel.namespace = 'linux:4:6'; p.row.nativeControl = control
  expect(p.select().engines).toEqual([{ ...engine(100), namespace: 'linux:4:6' }, engine(99), engine(100)])
})

it('gathers all distinct source obligations then refuses excess instead of truncating them', () => {
  const p = fixture(4, true), row: any = structuredClone(p.row)
  row.nativeAllocation.receipts.forEach((value: any, index: number) => {
    value.request.sourceProcess = reference(1000 + index); p.entries[index].receipt.request.sourceProcess = reference(1000 + index)
  })
  row.nativeControl.rearm.sourceProcess = reference(1004); p.entries[4].receipt.request.sourceProcess = reference(1004)
  Object.assign(p.row, row)
  expect(p.select).toThrow('bounded complete original ownership set')
  expect(p.read).toHaveBeenCalledTimes(5)
})

it.each(['allocation', 'scope', 'token'] as const)('holds %s damage in a witness instead of accepting an absence fallback', change => {
  const p = fixture(0, true), process: any = p.entries[0].process
  if (change === 'allocation') delete process.allocation
  if (change === 'scope') delete process.namespace
  if (change === 'token') process.allocation.token = 'another-launch-token'
  expect(p.select).toThrow('complete original pane witness')
  expect(p.notDispatched).not.toHaveBeenCalled()
})

it('does not treat an admitted missing witness as a never-dispatched allocation', () => {
  const p = fixture(); p.read.mockImplementation(() => { throw Error('missing witness') })
  expect(p.select).toThrow('admitted original witness')
  expect(p.notDispatched).not.toHaveBeenCalled()
})

it.each(['cancelled-id', 'cancelled-request', 'not-dispatched'] as const)('accounts only a pending %s request with its exact complete receipt', kind => {
  const p = fixture(1, true), original = p.read.getMockImplementation()!, verify = vi.fn()
  p.read.mockImplementation((id, input) => {
    if (id === p.entries[1].receipt.request.creationId) throw Error('no witness')
    return original(id, input)
  })
  p.notDispatched.mockReturnValue({ kind, verify })
  const owner = p.select()
  expect(p.notDispatched).toHaveBeenCalledWith(p.entries[1].receipt.request.creationId, p.entries[1].receipt)
  expect(owner.engines).toEqual([engine(100), engine(99)]); expect(owner.allocations).toHaveLength(1)
  verify.mockImplementation(() => { throw Error('absence lost') })
  expect(owner.verifyAllocations).toThrow('absence lost')
})

it('a claimed request without a witness and without absence proof stays held', () => {
  const p = fixture(0, true); p.read.mockImplementation(() => { throw Error('missing witness') })
  expect(p.select).toThrow('original outcome is unknown')
})

it('reads cold real receipts for a confirmed allocation and an explicitly cancelled pending launch', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-stop-selection-')))
  try {
    const p = fixture(1, true), receipts = await coldReceipts(root, p), first = p.entries[0], second = p.entries[1]
    const owner = readNativeStopAllocations(p.row, receipts, p.fence)
    expect(owner.engines).toEqual([engine(100), engine(99)])
    expect(owner.allocations).toEqual([first.process.allocation])
    expect(owner.verifyAllocations).not.toThrow()
    const file = join(root, `${second.receipt.request.creationId}.json`)
    writeFileSync(file + '.replacement', readFileSync(file), { mode: 0o600 }); renameSync(file + '.replacement', file)
    expect(owner.verifyAllocations).toThrow()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('composes cold receipt selection and physical Stop across intentional source retirement', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-stop-composed-')))
  try {
    const p = fixture(1, true), receipts = await coldReceipts(root, p)
    const owner = readNativeStopAllocations(p.row, receipts, p.fence), scopes: NativeHookScope[] = []
    const dead = vi.fn(async () => true), readPane = vi.fn(async () => 'released' as const), closePane = vi.fn()
    const stop = createNativePhysicalStop({ roots: [root], helpers: { prepare: async () => null, invalidate() {} }, dead, readPane, closePane,
      scope: async location => {
        let closed = false
        const proof = { boot, namespace, storage: location, verify: () => { if (closed) throw Error('scope closed') }, close: () => { closed = true } }
        scopes.push(proof); return proof
      },
    })
    let afterRetirement!: () => void
    const result = stop(owner, proof => {
      p.fence.verify.mockImplementation(() => { throw Error('source retired') })
      proof.verifyStopped(); proof.current(); scopes[0].verify(root)
      afterRetirement = proof.verifyStopped
      return 'retired'
    })
    await expect(result).resolves.toBe('retired'); await result.settled
    expect(dead.mock.calls.map(call => (call as unknown[])[1])).toEqual([engine(100), engine(99)])
    expect(readPane).toHaveBeenCalledOnce(); expect(closePane).not.toHaveBeenCalled()
    expect(afterRetirement).toThrow(); expect(owner.verifyAllocations).not.toThrow()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('funds the complete selected workload through the physical producer without replenishment', async () => {
  const p = fixture(4, true)
  let owner!: ReturnType<typeof p.select>
  expect(() => { owner = p.select() }).not.toThrow()
  let charged = 0
  const charge = (budget: NativeEvidenceBudget, count: number) => {
    expect(budget).toBe(owner.budget)
    for (let i = 0; i < count; i++) { budget.probe(); charged++ }
  }
  const calls = new Map<string, number>()
  const stop = createNativePhysicalStop({ roots: ['/fixture/registry', '/fixture/receipts'], helpers: { prepare: async () => null, invalidate() {} },
    scope: async (root, budget) => { charge(budget, 3); return { boot, namespace, storage: root, verify() {}, close() {} } },
    dead: async (_root, _writer, budget) => { charge(budget, 7); return true },
    readPane: async (pane, budget) => {
      charge(budget, 23)
      const seen = calls.has(pane.token); calls.set(pane.token, 1)
      return seen ? 'released' : 'active'
    },
    closePane: async (_pane, budget, verify) => { verify(); charge(budget, 1) },
  })
  await expect(stop(owner, proof => { proof.verifyStopped(); proof.current(); return 'retired' })).resolves.toBe('retired')
  expect(charged).toBe(289)
  expect(() => { for (let i = 0; i < 32; i++) owner.budget.probe() }).toThrow('probe limit')
})

it('expires a stalled first physical read at the original selection deadline while retaining actual slots', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-stop-deadline-')))
  let release!: (proof: NativeHookScope) => void
  const stalled = new Promise<NativeHookScope>(resolve => { release = resolve }), jobs: ReturnType<ReturnType<typeof createNativePhysicalStop>>[] = []
  try {
    const p = fixture(1, true), receipts = await coldReceipts(root, p)
    vi.useFakeTimers()
    p.fence.verify.mockImplementation(() => { clock.now = Math.max(clock.now, 2500) })
    const owner = readNativeStopAllocations(p.row, receipts, p.fence), consume = vi.fn(() => 'retired'), settled = vi.fn(), rejected = vi.fn()
    expect(owner.budget.remaining()).toBe(500)
    const scope = vi.fn((_root: string, budget: NativeEvidenceBudget) => {
      expect(budget).toBe(owner.budget); expect(budget.probe()).toBe(500); return stalled
    })
    const readPane = vi.fn(), closePane = vi.fn()
    const stop = createNativePhysicalStop({ roots: [root], helpers: { prepare: async () => null, invalidate() {} }, scope, readPane, closePane })
    for (let i = 0; i < 4; i++) jobs.push(stop(owner, consume))
    const replies = jobs.map(job => expect(job).rejects.toThrow('deadline'))
    jobs.forEach(job => { void job.catch(rejected) })
    jobs[0].settled.then(settled)
    await vi.advanceTimersByTimeAsync(499)
    expect(scope).toHaveBeenCalledTimes(4); expect(settled).not.toHaveBeenCalled()
    clock.now = 3000
    await vi.advanceTimersByTimeAsync(1)
    expect(rejected).toHaveBeenCalledTimes(4)
    await Promise.all(replies)
    expect(settled).not.toHaveBeenCalled()
    // Fresh selection grants another deadline, but cannot free the four old reads.
    const overflow = stop(readNativeStopAllocations(p.row, receipts, p.fence), consume)
    await expect(overflow).rejects.toThrow('slots are occupied'); await overflow.settled
    const expired = stop(owner, consume)
    await expect(expired).rejects.toThrow('deadline'); await expired.settled
    expect(consume).not.toHaveBeenCalled(); expect(readPane).not.toHaveBeenCalled(); expect(closePane).not.toHaveBeenCalled()
  } finally {
    release({ boot, namespace, storage: root, verify() {}, close() {} })
    await Promise.all(jobs.map(job => job.settled))
    rmSync(root, { recursive: true, force: true })
  }
})

it('rejects an earlier receipt replaced during a later receipt confirmation', () => {
  const p = fixture(2), original = p.read.getMockImplementation()!
  p.read.mockImplementation((id, input) => {
    if (id === p.entries[1].receipt.request.creationId) p.entries[0].verify.mockImplementation(() => { throw Error('earlier receipt replaced') })
    return original(id, input)
  })
  expect(p.select).toThrow('earlier receipt replaced')
})

it.each(['verify', 'current'] as const)('retains and checks original %s source ownership', key => {
  const p = fixture(); p.fence[key].mockImplementation(() => { throw Error('revoked') })
  expect(p.select).toThrow('revoked'); expect(p.read).not.toHaveBeenCalled()
})

it.each(['confirmation', 'source', 'later'] as const)('keeps one original deadline through %s work', stage => {
  const p = fixture()
  if (stage === 'confirmation') p.entries[0].verify.mockImplementation(() => { clock.now = 3001 })
  if (stage === 'source') p.fence.verify.mockImplementation(() => { clock.now = 3001 })
  if (stage !== 'later') expect(p.select).toThrow('deadline')
  else { const owner = p.select(); clock.now = 3001; expect(owner.current).toThrow('deadline'); expect(owner.verifyAllocations).toThrow('deadline') }
})

it.each(['unrevoked', 'missing-allocation', 'downgrade', 'missing-control', 'foreign-ref', 'reused-token', 'conflicting-id', 'missing-admission', 'legacy-request', 'empty', 'engine'] as const)(
  'rejects %s ownership before reading any receipt', change => {
    const p = fixture(1, true), row: any = structuredClone(p.row)
    if (change === 'unrevoked') delete row.nativeControl.rearm.revoked
    if (change === 'missing-allocation') delete row.nativeAllocation
    if (change === 'downgrade') row.schemaVersion = 3
    if (change === 'missing-control') delete row.nativeControl
    if (change === 'foreign-ref') row.agentId = 'another-agent'
    if (change === 'reused-token') row.nativeControl.rearm.launchToken = p.entries[0].receipt.request.launchToken
    if (change === 'conflicting-id') row.nativeControl.rearm.requestId = p.entries[0].receipt.request.creationId
    if (change === 'missing-admission') row.nativeControl.rearm.replacement = { processKey: 'replacement', sessionId: 'fixture-session' }
    if (change === 'legacy-request') delete row.nativeControl.rearm.source
    if (change === 'empty') { row.schemaVersion = 3; delete row.nativeAllocation; delete row.nativeControl.rearm }
    if (change === 'engine') row.engine = 'codex'
    Object.assign(p.row, row)
    if (change === 'missing-allocation' || change === 'empty') delete p.row.nativeAllocation
    if (change === 'missing-control') delete p.row.nativeControl
    expect(p.select).toThrow(); expect(p.read).not.toHaveBeenCalled(); expect(p.notDispatched).not.toHaveBeenCalled()
  },
)
