import { execFile } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NativeArchiveStopProof } from '../../lib/nativeArchive.js'
import type { NativeControlHelpers } from '../../lib/nativeProcessControlProbe.js'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import type { NativeHookScope } from './nativeHookScope.js'
import { closeNativeStopPane, createNativePhysicalStop, readNativeStopPane as readPaneImpl, type NativePhysicalStopOwner } from './nativePhysicalStop.js'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
const clock = vi.hoisted(() => ({ now: 0 }))
vi.mock('node:perf_hooks', () => ({ performance: { now: () => clock.now } }))
const boot = 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', namespace = 'linux:4:5'
const allocation = { pane: '%1', rootPid: 40, token: 'original-native-allocation', owner: 'a'.repeat(16),
  endpoint: { binary: '/fixture/tmux', socket: '/fixture/original-socket', server: { boot, namespace, pid: 30, birth: '1200' } } }
const engine = { boot, namespace, pid: 42, birth: '1234' }
const readNativeStopPane = (input: typeof allocation, budget: NativeEvidenceBudget, serverDead = async () => false) => readPaneImpl(input, budget, serverDead)
const helpers: NativeControlHelpers = { prepare: async () => null, invalidate: () => {} }
beforeEach(() => { clock.now = 0; vi.clearAllMocks() })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function fixture() {
  const scopes: Array<NativeHookScope> = []
  const scope = vi.fn(async (root: string) => {
    let closed = false
    const proof = { boot, namespace, storage: root,
      verify: vi.fn(() => { if (closed) throw Error('scope closed') }), close: vi.fn(() => { closed = true }) }
    scopes.push(proof); return proof
  })
  const dead = vi.fn(async () => true), readPane = vi.fn(async () => 'absent' as const)
  const closePane = vi.fn(async (_pane, _budget, verify: () => void) => { verify() })
  const owner: NativePhysicalStopOwner = { budget: new NativeEvidenceBudget(3000, 320), source: { target: 'b'.repeat(64), controlFingerprint: 'c'.repeat(64) },
    engines: [engine], allocations: [allocation], verify: vi.fn(), verifyAllocations: vi.fn(), current: vi.fn() }
  const stop = createNativePhysicalStop({ roots: ['/fixture/registry', '/fixture/receipts'], helpers, scope, dead, readPane, closePane })
  const consume = vi.fn((proof: NativeArchiveStopProof) => { proof.verifyStopped(); proof.current(); return 'retired' })
  return { owner, stop, scope, scopes, dead, readPane, closePane, consume }
}

it('retains independent receipt and scope proof through synchronous retirement, then revokes it', async () => {
  const f = fixture()
  f.consume.mockImplementation(proof => {
    expect(f.scopes.slice(0, 2).every(scope => vi.mocked(scope.close).mock.calls.length === 0)).toBe(true)
    vi.mocked(f.owner.verify).mockImplementation(() => { throw Error('Registry leaf intentionally consumed') })
    proof.verifyStopped(); proof.current()
    expect(proof.source).toEqual(f.owner.source)
    return 'retired'
  })
  const result = f.stop(f.owner, f.consume)
  await expect(result).resolves.toBe('retired'); await result.settled
  expect(f.dead).toHaveBeenCalledWith('/fixture/registry', engine, expect.any(NativeEvidenceBudget), expect.any(Function), helpers)
  expect(f.scopes).toHaveLength(4)
  f.scopes.forEach(scope => expect(scope.close).toHaveBeenCalledOnce())
  expect(f.owner.verifyAllocations).toHaveBeenCalled()
  expect(() => f.consume.mock.calls[0][0].verifyStopped()).toThrow()
  expect(() => f.consume.mock.calls[0][0].current()).toThrow()
})

it('closes the owned active allocation and requires a complete follow-up observation', async () => {
  const f = fixture()
  f.readPane.mockResolvedValueOnce('active' as never)
  await expect(f.stop(f.owner, f.consume)).resolves.toBe('retired')
  expect(f.closePane).toHaveBeenCalledOnce(); expect(f.readPane).toHaveBeenCalledTimes(2)
  expect(f.closePane.mock.invocationCallOrder[0]).toBeLessThan(f.dead.mock.invocationCallOrder[0])
})

it.each(['released', 'absent'] as const)('accounts a %s allocation without closing it, but still proves engine death', async state => {
  const f = fixture(); f.readPane.mockResolvedValue(state as never)
  await expect(f.stop(f.owner, f.consume)).resolves.toBe('retired')
  expect(f.closePane).not.toHaveBeenCalled(); expect(f.dead).toHaveBeenCalledOnce()
})

it.each(['active', 'released', 'absent'] as const)('holds a detached surviving engine after %s pane evidence', async state => {
  const f = fixture(); f.readPane.mockResolvedValueOnce(state as never); f.dead.mockResolvedValue(false)
  await expect(f.stop(f.owner, f.consume)).rejects.toThrow('engine is still running')
  expect(f.consume).not.toHaveBeenCalled()
})

it('an active pane after close is unknown and cannot retire', async () => {
  const f = fixture(); f.readPane.mockResolvedValue('active' as never)
  await expect(f.stop(f.owner, f.consume)).rejects.toThrow('allocation is still open')
  expect(f.dead).not.toHaveBeenCalled(); expect(f.consume).not.toHaveBeenCalled()
})
it('holds a lost close reply without retrying that effect in the same operation', async () => {
  const f = fixture(); f.readPane.mockResolvedValueOnce('active' as never); f.closePane.mockRejectedValue(Error('lost reply'))
  await expect(f.stop(f.owner, f.consume)).rejects.toThrow('lost reply')
  expect(f.closePane).toHaveBeenCalledOnce(); expect(f.consume).not.toHaveBeenCalled()
})
it('proves every original engine and never substitutes the new allocation for the old engine', async () => {
  const f = fixture(), old = { ...engine, pid: 41 }
  const owner = { ...f.owner, engines: [old, engine] }
  f.dead.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
  await expect(f.stop(owner, f.consume)).rejects.toThrow('engine is still running')
  expect(f.dead.mock.calls.map(call => (call as unknown[])[1])).toEqual([old, engine]); expect(f.consume).not.toHaveBeenCalled()
})

it.each([
  { engines: [] }, { engines: Array(7).fill(engine) }, { engines: [{ ...engine, namespace: 'foreign' }] },
  { allocations: Array(6).fill(allocation) }, { allocations: [allocation, allocation] },
  { allocations: [{ ...allocation, pane: 'invalid' }] }, { source: { target: 'invalid', controlFingerprint: 'c'.repeat(64) } },
])('rejects incomplete or ambiguous ownership before effects %#', async fields => {
  const f = fixture()
  await expect(f.stop({ ...f.owner, ...fields }, f.consume)).rejects.toThrow()
  expect(f.closePane).not.toHaveBeenCalled(); expect(f.dead).not.toHaveBeenCalled(); expect(f.consume).not.toHaveBeenCalled()
})
it.each([[], ['relative'], ['/a', '/a'], ['/a', '/b', '/c']])('rejects invalid storage roots %j', async (...roots) => {
  const f = fixture(), stop = createNativePhysicalStop({ roots, helpers, scope: f.scope, dead: f.dead })
  await expect(stop(f.owner, f.consume)).rejects.toThrow('ownership is incomplete')
  expect(f.scope).not.toHaveBeenCalled()
})

it.each(['verify', 'verifyAllocations', 'current'] as const)('checks %s before any physical work', async method => {
  const f = fixture(); vi.mocked(f.owner[method]).mockImplementation(() => { throw Error('owner changed') })
  await expect(f.stop(f.owner, f.consume)).rejects.toThrow('owner changed')
  expect(f.scope).not.toHaveBeenCalled(); expect(f.closePane).not.toHaveBeenCalled(); expect(f.consume).not.toHaveBeenCalled()
})
it('rechecks the original owner after a pane wait and before dispatch', async () => {
  const f = fixture(); f.readPane.mockImplementationOnce(async () => {
    vi.mocked(f.owner.verify).mockImplementation(() => { throw Error('successor') }); return 'active' as never
  })
  await expect(f.stop(f.owner, f.consume)).rejects.toThrow('successor')
  expect(f.closePane).not.toHaveBeenCalled(); expect(f.consume).not.toHaveBeenCalled()
})
it('retains the exact callback and identity snapshots while asynchronous work is pending', async () => {
  const f = fixture(), held = gate<'absent'>()
  f.readPane.mockReturnValueOnce(held.promise)
  const owner = { ...f.owner, engines: [{ ...engine }], allocations: [{ ...allocation }], source: { ...f.owner.source } }
  const result = f.stop(owner, f.consume)
  await vi.waitFor(() => expect(f.readPane).toHaveBeenCalledOnce())
  owner.engines[0].pid = 77; owner.allocations[0].token = 'foreign-native-allocation'; owner.source.target = 'd'.repeat(64)
  owner.verify = () => { throw Error('replaced callback') }
  held.resolve('absent')
  await expect(result).resolves.toBe('retired')
  expect((f.dead.mock.calls[0] as unknown[])[1]).toEqual(engine)
  expect(f.consume.mock.calls[0][0].source.target).toBe('b'.repeat(64))
})

it.each(['boot', 'namespace', 'storage'] as const)('rejects a changed final local %s', async field => {
  const f = fixture(), base = f.scope.getMockImplementation()!
  f.scope.mockImplementation(async root => { const scope = await base(root); if (f.scopes.length === 3) scope[field] = 'changed'; return scope })
  await expect(f.stop(f.owner, f.consume)).rejects.toThrow('scope changed')
  expect(f.consume).not.toHaveBeenCalled(); f.scopes.forEach(scope => expect(scope.close).toHaveBeenCalledOnce())
})
it('rejects roots in different process namespaces before close', async () => {
  const f = fixture(), base = f.scope.getMockImplementation()!
  f.scope.mockImplementation(async root => { const scope = await base(root); if (f.scopes.length === 2) scope.namespace = 'linux:4:6'; return scope })
  await expect(f.stop(f.owner, f.consume)).rejects.toThrow('scope differs')
  expect(f.closePane).not.toHaveBeenCalled()
})
it('holds an unavailable death observation even after positive pane absence', async () => {
  const f = fixture(); f.dead.mockRejectedValue(Error('EPERM'))
  await expect(f.stop(f.owner, f.consume)).rejects.toThrow('EPERM')
  expect(f.consume).not.toHaveBeenCalled()
})
it('checks the original deadline after native death helper cleanup', async () => {
  const f = fixture(); f.dead.mockImplementation(async () => { clock.now = 3001; return true })
  await expect(f.stop(f.owner, f.consume)).rejects.toThrow('deadline')
  expect(f.consume).not.toHaveBeenCalled()
})
it('checks deadline after final scope cleanup before retirement', async () => {
  const f = fixture(), base = f.scope.getMockImplementation()!
  f.scope.mockImplementation(async root => { const scope = await base(root); if (f.scopes.length === 4) scope.close.mockImplementation(() => { clock.now = 3001 }); return scope })
  await expect(f.stop(f.owner, f.consume)).rejects.toThrow('deadline')
  expect(f.consume).not.toHaveBeenCalled()
})
it('attempts every retained close on a cleanup failure and rejects the response', async () => {
  const f = fixture(), base = f.scope.getMockImplementation()!
  f.scope.mockImplementation(async root => { const scope = await base(root); if (f.scopes.length === 1) scope.close.mockImplementation(() => { throw Error('close uncertain') }); return scope })
  await expect(f.stop(f.owner, f.consume)).rejects.toThrow('close uncertain')
  f.scopes.forEach(scope => expect(scope.close).toHaveBeenCalledOnce())
})
it('checks deadline again after retained descriptor cleanup', async () => {
  const f = fixture(), base = f.scope.getMockImplementation()!
  f.scope.mockImplementation(async root => { const scope = await base(root); if (f.scopes.length === 1) scope.close.mockImplementation(() => { clock.now = 3001 }); return scope })
  await expect(f.stop(f.owner, f.consume)).rejects.toThrow('deadline')
  expect(f.consume).toHaveBeenCalledOnce()
})
it('retains actual slots and settled promises after all bounded replies expire', async () => {
  vi.useFakeTimers()
  const f = fixture(), held = gate<'absent'>(); f.readPane.mockReturnValue(held.promise)
  const jobs = Array.from({ length: 4 }, () => f.stop(f.owner, f.consume))
  const rejected = jobs.map(job => expect(job).rejects.toThrow('deadline'))
  const settled = vi.fn(); jobs[0].settled.then(settled)
  await vi.advanceTimersByTimeAsync(3001); await Promise.all(rejected)
  expect(settled).not.toHaveBeenCalled()
  const overflow = f.stop(f.owner, f.consume), unavailable = expect(overflow).rejects.toThrow('slots are occupied')
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(f.readPane).toHaveBeenCalledTimes(4)
    await unavailable
  } finally { held.resolve('absent'); await Promise.all([...jobs, overflow].map(job => job.settled)) }
  expect(settled).toHaveBeenCalledOnce(); expect(f.consume).not.toHaveBeenCalled()
  f.readPane.mockResolvedValue('absent')
  await expect(f.stop(f.owner, f.consume)).resolves.toBe('retired')
})
it('shutdown revokes an outstanding operation before a late close or retirement', async () => {
  const f = fixture(), held = gate<'absent'>(); f.readPane.mockReturnValueOnce(held.promise)
  const result = f.stop(f.owner, f.consume)
  await vi.waitFor(() => expect(f.readPane).toHaveBeenCalledOnce())
  f.stop.close(); held.resolve('absent')
  await expect(result).rejects.toThrow('authority expired'); await result.settled
  expect(f.consume).not.toHaveBeenCalled(); expect(f.closePane).not.toHaveBeenCalled()
})
it('rejects malformed caller copies without leaving settled pending', async () => {
  const f = fixture(), result = f.stop({ ...f.owner, engines: [() => {}] as never }, f.consume)
  await expect(result).rejects.toThrow(); await expect(result.settled).resolves.toBeUndefined()
})

function replies(...answers: Array<{ output?: string; error?: object; stderr?: string }>) {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const answer = answers.shift()!
    ;(args.at(-1) as Function)(answer.error ?? null, Buffer.from(answer.output ?? ''), Buffer.from(answer.stderr ?? ''))
    return {} as never
  })
}
const paneOutput = (marker = `active:${allocation.token}:${allocation.rootPid}`) =>
  `${allocation.endpoint.server.pid}\n${allocation.pane}\n${allocation.rootPid}\n${allocation.owner}\n${marker}\n/usr/bin/env HARNESS_NATIVE_LAUNCH_TOKEN=${allocation.token} /bin/sh -c fixture\n`
it.each(['active', 'released'] as const)('reads the complete exact %s allocation', async state => {
  replies({ output: '30\t%0\n30\t%1\n' }, { output: paneOutput(`${state}:${allocation.token}:${allocation.rootPid}`) })
  await expect(readNativeStopPane(allocation, new NativeEvidenceBudget())).resolves.toBe(state)
})
it('accepts the exact older-tmux owner prefix', async () => {
  replies({ output: '30\t%1\n' }, { output: paneOutput().replace('/usr/bin/env HARNESS_NATIVE', `/usr/bin/env HARNESS_DAEMON=${allocation.owner} /usr/bin/env HARNESS_NATIVE`) })
  await expect(readNativeStopPane(allocation, new NativeEvidenceBudget())).resolves.toBe('active')
})
it('requires complete positive inventory for pane absence', async () => {
  replies({ output: '30\t%2\n30\t%3\n' })
  await expect(readNativeStopPane(allocation, new NativeEvidenceBudget())).resolves.toBe('absent')
  expect(execFile).toHaveBeenCalledOnce()
})
it.each(['', '%2', '%2\n%2\n', '%2\ninvalid\n', Array(8193).fill('%2').join('\n') + '\n'])('rejects an incomplete pane inventory %#', async output => {
  replies({ output }); await expect(readNativeStopPane(allocation, new NativeEvidenceBudget())).rejects.toThrow('inventory is incomplete')
})
it.each([
  paneOutput().replace('%1', '%2'), paneOutput().replace('\n40\n', '\n41\n'), paneOutput().replace('a'.repeat(16), 'd'.repeat(16)),
  paneOutput('released:foreign-token:40'), paneOutput().replace('HARNESS_NATIVE_LAUNCH_TOKEN=', 'UNRELATED='),
  paneOutput().slice(0, -1), paneOutput() + '\0',
])('holds mismatched or incomplete allocation identity %#', async output => {
  replies({ output: '30\t%1\n' }, { output }); await expect(readNativeStopPane(allocation, new NativeEvidenceBudget())).rejects.toThrow()
})
it.each(['no server running on /fixture/socket\n', 'error connecting to /fixture/socket (No such file or directory)\n'])('accepts explicit completed no-server evidence %s', async stderr => {
  replies({ error: { code: 1, killed: false, signal: null }, stderr })
  await expect(readNativeStopPane(allocation, new NativeEvidenceBudget(), vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true))).resolves.toBe('absent')
})
it.each([
  { error: { code: 1, killed: true } }, { error: { code: 1, signal: 'SIGKILL' } }, { error: { code: 'ENOENT' } },
  { error: { code: 1 }, output: '%1\n' }, { error: { code: 1 }, stderr: 'error connecting to /fixture/socket (Permission denied)\n' },
  { error: undefined },
])('unavailable tmux does not become an absent server %#', async fields => {
  replies({ stderr: 'no server running on /fixture/socket\n', ...fields })
  await expect(readNativeStopPane(allocation, new NativeEvidenceBudget())).rejects.toThrow()
})
it('accepts a server that exits between the complete inventory and pane read', async () => {
  replies({ output: '30\t%1\n' }, { error: { code: 1 }, stderr: 'no server running on /fixture/socket\n' })
  await expect(readNativeStopPane(allocation, new NativeEvidenceBudget(), vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true))).resolves.toBe('absent')
})
it('dispatches only the guarded command after the final synchronous fence', async () => {
  replies({ output: '' }); const verify = vi.fn()
  await expect(closeNativeStopPane(allocation, new NativeEvidenceBudget(), verify)).resolves.toBeUndefined()
  expect(verify.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(execFile).mock.invocationCallOrder[0])
  expect(vi.mocked(execFile).mock.calls[0][1]).toEqual(expect.arrayContaining(['if-shell', '-F']))
  expect(vi.mocked(execFile).mock.calls[0][1]?.join(' ')).toContain('@harness_native_allocation')
})
it('never starts a close after owner revocation', async () => {
  const verify = () => { throw Error('revoked') }
  await expect(closeNativeStopPane(allocation, new NativeEvidenceBudget(), verify)).rejects.toThrow('revoked')
  expect(execFile).not.toHaveBeenCalled()
})

it('a different endpoint cannot establish absence while the original server lives', async () => {
  replies({ output: '31\t%99\n' })
  await expect(readNativeStopPane(allocation, new NativeEvidenceBudget())).rejects.toThrow('original server pane inventory')
  const [binary, args, options] = vi.mocked(execFile).mock.calls[0]
  expect(binary).toBe('/fixture/tmux'); expect(args?.slice(0, 2)).toEqual(['-S', '/fixture/original-socket'])
  expect(options).toMatchObject({ env: { TMUX: undefined, TMUX_PANE: undefined } })
})
it('an unavailable original socket does not mean its still-live server has no pane', async () => {
  replies({ error: { code: 1 }, stderr: 'no server running on /fixture/original-socket\n' })
  await expect(readNativeStopPane(allocation, new NativeEvidenceBudget())).rejects.toThrow('server is alive')
})
it('positive original server death accounts its panes without reading a later endpoint', async () => {
  await expect(readNativeStopPane(allocation, new NativeEvidenceBudget(), async () => true)).resolves.toBe('absent')
  expect(execFile).not.toHaveBeenCalled()
})
it('server PID reuse during the inventory is accounted by positive original-server death', async () => {
  replies({ output: '30\t%1\n' })
  await expect(readNativeStopPane(allocation, new NativeEvidenceBudget(), vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true))).resolves.toBe('absent')
  expect(execFile).toHaveBeenCalledOnce()
})
it.each([undefined, { ...allocation.endpoint, socket: 'relative' }, { ...allocation.endpoint, binary: 'tmux' },
  { ...allocation.endpoint, server: { ...allocation.endpoint.server, namespace: 'foreign' } }])('holds without durable endpoint authority %#', async endpoint => {
  const f = fixture()
  await expect(f.stop({ ...f.owner, allocations: [{ ...allocation, endpoint } as never] }, f.consume)).rejects.toThrow('endpoint')
  expect(f.closePane).not.toHaveBeenCalled(); expect(f.consume).not.toHaveBeenCalled()
})
it('checks local revocation caused by the last caller fence before starting tmux', async () => {
  const f = fixture(); f.readPane.mockResolvedValueOnce('active' as never)
  f.closePane.mockImplementation(async (pane, budget, verify) => {
    let fences = 0
    // The first cheap fence follows receipt verification; the second is the
    // final fence after original-owner verification, immediately before exec.
    vi.mocked(f.owner.current).mockImplementation(() => { if (++fences === 2) f.stop.close() })
    replies({ output: '' })
    await closeNativeStopPane(pane, budget, verify)
  })
  await expect(f.stop(f.owner, f.consume)).rejects.toThrow('expired')
  expect(execFile).not.toHaveBeenCalled(); expect(f.consume).not.toHaveBeenCalled()
})
it('rechecks the source after independent receipt verification at physical dispatch', async () => {
  const f = fixture(); f.readPane.mockResolvedValueOnce('active' as never)
  let changed = false
  vi.mocked(f.owner.verify).mockImplementation(() => { if (changed) throw Error('changed source') })
  f.closePane.mockImplementation(async (pane, budget, verify) => {
    vi.mocked(f.owner.verifyAllocations).mockImplementation(() => { changed = true })
    await closeNativeStopPane(pane, budget, verify)
  })
  await expect(f.stop(f.owner, f.consume)).rejects.toThrow('changed source')
  expect(execFile).not.toHaveBeenCalled(); expect(f.consume).not.toHaveBeenCalled()
})
it('rejects a Promise retirement consumer and revokes the escaped proof', async () => {
  const f = fixture(), pending = gate<void>(); let escaped!: NativeArchiveStopProof
  const consume = ((proof: NativeArchiveStopProof) => { escaped = proof; return pending.promise }) as never
  const result = f.stop(f.owner, consume)
  await expect(result).rejects.toThrow('must be synchronous'); await result.settled
  expect(() => escaped.current()).toThrow(); pending.resolve()
})
it('contains a rejected async retirement continuation after revoking its proof', async () => {
  const f = fixture(), pending = gate<void>(), unhandled = vi.fn()
  process.on('unhandledRejection', unhandled)
  try {
    const consume = (async (proof: NativeArchiveStopProof) => { await pending.promise; proof.current() }) as never
    const result = f.stop(f.owner, consume)
    await expect(result).rejects.toThrow('must be synchronous'); await result.settled
    pending.resolve(); await new Promise(done => setTimeout(done, 0))
    expect(unhandled).not.toHaveBeenCalled()
  } finally { process.off('unhandledRejection', unhandled) }
})
it('covers confirmed and pending allocations with all six engines within one bounded Darwin probe budget', async () => {
  let charged = 0
  const charge = (budget: NativeEvidenceBudget, count: number) => { for (let i = 0; i < count; i++) { budget.probe(); charged++ } }
  const calls = new Map<string, number>()
  const stop = createNativePhysicalStop({ roots: ['/fixture/registry', '/fixture/receipts'], helpers,
    scope: async (root, budget) => { charge(budget, 3); return { boot, namespace, storage: root, verify() {}, close() {} } },
    dead: async (_root, writer, budget) => { charge(budget, 7); return writer.pid !== allocation.endpoint.server.pid },
    readPane: async (pane, budget, serverDead) => {
      charge(budget, 2)
      for (let i = 0; i < 3; i++) expect(await serverDead()).toBe(false)
      const count = calls.get(pane.pane) ?? 0; calls.set(pane.pane, count + 1)
      return count ? 'released' : 'active'
    },
    closePane: async (_pane, budget, verify) => { verify(); charge(budget, 1) },
  })
  const f = fixture(), owner = { ...f.owner, engines: Array.from({ length: 6 }, (_, i) => ({ ...engine, pid: 42 + i })),
    allocations: Array.from({ length: 5 }, (_, i) => ({ ...allocation, pane: `%${i}` })) }
  await expect(stop(owner, f.consume)).resolves.toBe('retired')
  expect(charged).toBe(289); expect(f.consume).toHaveBeenCalledOnce()
})

it('accounts identical pane numbers separately on different original server incarnations', async () => {
  const f = fixture(), another = { ...allocation, endpoint: { ...allocation.endpoint,
    server: { ...allocation.endpoint.server, birth: '1300' } } }
  await expect(f.stop({ ...f.owner, allocations: [allocation, another] }, f.consume)).resolves.toBe('retired')
  expect(f.readPane.mock.calls.map(call => (call as unknown[])[0])).toEqual([allocation, another])
})

it('refuses aliases of the same server and pane before any physical work', async () => {
  const f = fixture(), alias = { ...allocation, endpoint: { ...allocation.endpoint, socket: '/fixture/socket-alias' } }
  await expect(f.stop({ ...f.owner, allocations: [allocation, alias] }, f.consume)).rejects.toThrow('pane ownership is ambiguous')
  expect(f.scope).not.toHaveBeenCalled(); expect(f.closePane).not.toHaveBeenCalled(); expect(f.consume).not.toHaveBeenCalled()
})

it('refuses an already resolved async consumer instead of silently accepting its result', async () => {
  const f = fixture()
  await expect(f.stop(f.owner, (async () => 'retired') as never)).rejects.toThrow('must be synchronous')
})
