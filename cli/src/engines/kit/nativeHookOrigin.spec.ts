import { createHash } from 'node:crypto'
import { buildSync } from 'esbuild'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { controlIdentity, type NativeControlRow } from '../../lib/nativeProcessControlProbe.js'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import { kernelBootId } from './nativeHookBoot.js'
import { captureNativeHookOrigin, captureNativeHookClientOrigin, inspectNativeHookOrigin, nativeHookIdentityV1, nativeHookOriginCaller, nativeHookRouteV1,
  type NativeHookOrigin } from './nativeHookOrigin.js'

vi.mock('./nativeHookBoot.js', () => ({ kernelBootId: vi.fn() }))
const clock = vi.hoisted(() => ({ now: 0 }))
vi.mock('node:perf_hooks', () => ({ performance: { now: () => clock.now } }))
const boot = 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const row = () => ({ agentId: 'fixture-agent', engine: 'codex', active: true,
  processIdentity: { pid: 42, executable: 'codex', startMarker: 'fixture-start' },
  runtimes: [{ backend: 'tmux', paneId: '%1' }], primaryRuntimeKey: 'tmux\u0000%1' } as RegisteredSession)
const native = (pid = 42, parentPid = 77): NativeControlRow => ({ pid, parentPid, birth: String(pid * 100),
  command: 'fixture-engine', imagePath: '/fixture/engine', argv: ['engine', '--prompt', 'fixture prompt'], fds: [] })
let processes: Map<number, NativeControlRow>
const probe = vi.fn(async (pids: readonly number[], budget: NativeEvidenceBudget) => {
  budget.step()
  if (pids.some(pid => !processes.has(pid))) throw Error('fixture unreadable ancestor')
  return { parent: 0, children: [], rows: new Map(pids.map(pid => [pid, structuredClone(processes.get(pid)!)])) }
})
const capture = (candidate?: RegisteredSession) => captureNativeHookOrigin(43, new NativeEvidenceBudget(), probe, candidate)
beforeEach(() => {
  clock.now = 0; vi.clearAllMocks()
  vi.mocked(kernelBootId).mockResolvedValue(boot)
  processes = new Map([[43, native(43, 42)], [42, native()]])
})
afterEach(() => vi.restoreAllMocks())

it('captures a routed client only while it remains the original caller\'s exact child', async () => {
  processes.set(44, native(44, 43))
  const origin = await captureNativeHookClientOrigin(44, 43, new NativeEvidenceBudget(), probe)
  expect(origin.callerPid).toBe(43)
  expect(origin.ancestry.map(member => member.pid)).toEqual([43, 42])
  expect(probe.mock.calls[0][0]).toEqual([44])
  expect(probe.mock.calls.at(-1)![0]).toEqual([44])
})

it('holds a reused caller PID after routing reparented the client', async () => {
  processes.set(44, native(44, 1))
  processes.set(43, { ...native(43, 42), birth: '99999' })
  await expect(captureNativeHookClientOrigin(44, 43, new NativeEvidenceBudget(), probe)).rejects.toThrow('caller exited before capture')
  expect(probe).toHaveBeenCalledTimes(1)
})

it('freezes the original Cursor tuple before awaiting the first client self proof', async () => {
  processes.set(44, native(44, 43))
  const candidate = { ...row(), engine: 'cursor' } as RegisteredSession
  const saved = structuredClone(candidate)
  let release!: () => void
  const waiting = captureNativeHookClientOrigin(44, 43, new NativeEvidenceBudget(), async (pids, budget) => {
    if (!release) await new Promise<void>(done => { release = done })
    return await probe(pids, budget)
  }, candidate)
  candidate.agentId = 'replacement'; candidate.processIdentity!.pid = 99; candidate.runtimes[0].paneId = '%2'
  release()
  const captured = await waiting
  expect(captured.runtime).toMatchObject({ agentId: saved.agentId, routeV1: nativeHookRouteV1(saved), process: { pid: 42 } })
  expect(probe.mock.calls.some(([pids]) => pids.includes(99))).toBe(false)
})

it.each(['reparented', 'replaced', 'missing'])('holds a client %s while capturing the original prefix', async change => {
  processes.set(44, native(44, 43))
  let capturedSelf = false
  const changingProbe = async (pids: readonly number[], budget: NativeEvidenceBudget) => {
    if (pids[0] === 44 && capturedSelf) {
      if (change === 'reparented') processes.get(44)!.parentPid = 1
      if (change === 'replaced') processes.get(44)!.birth = '99999'
      if (change === 'missing') processes.delete(44)
      const value = processes.get(44)
      return { parent: 0, children: [], rows: new Map(value ? [[44, value]] : []) }
    }
    const found = await probe(pids, budget)
    if (pids[0] === 44) capturedSelf = true
    return found
  }
  await expect(captureNativeHookClientOrigin(44, 43, new NativeEvidenceBudget(), changingProbe)).rejects.toThrow('caller changed during capture')
})

it.each(['linux', 'darwin'])('keeps a serializable %s caller prefix after the short-lived shell exits', async platform => {
  vi.mocked(kernelBootId).mockResolvedValue(boot.replace('linux', platform))
  if (platform === 'darwin') for (const value of processes.values()) value.birth = `1791547140:${value.pid}`
  const original = await capture(), saved = JSON.parse(JSON.stringify(original))
  expect(probe.mock.calls.map(([pids]) => pids)).toEqual([[43], [43, 42], [42, 77]])
  expect(original.ancestry.map(member => member.pid)).toEqual([43, 42])
  expect(original.ancestry[1].identityV1).toBe(nativeHookIdentityV1(controlIdentity(processes.get(42)!)))
  processes.delete(43)
  const caller = nativeHookOriginCaller(saved), prior = caller.owner(row())
  saved.ancestry[1].identityV1 = 'b'.repeat(64)
  expect(caller.owner(row())).toEqual(prior)
  expect(prior).toMatchObject({ key: `${original.boot}\u0000codex\u000042\u0000${processes.get(42)!.birth}`, source: 'caller' })
  expect(probe).toHaveBeenCalledTimes(3)
})

it('never skips a changed child or fills its missing parent from later ancestry', async () => {
  probe.mockImplementationOnce(async () => ({ parent: 0, children: [], rows: new Map([[43, native(43, 42)]]) }))
  processes.get(43)!.birth = '99999'
  const origin = await capture()
  expect(origin.ancestry.map(member => member.pid)).toEqual([43])
  expect(() => nativeHookOriginCaller(origin).owner(row())).toThrow('absent from the original')
  expect(probe).toHaveBeenCalledTimes(2)
})

it('retains the unique original Cursor route and process without expanding the exception to other engines', async () => {
  const cursor = { ...row(), engine: 'cursor' } as RegisteredSession
  processes.delete(43)
  const pending = capture(cursor)
  cursor.runtimes[0].paneId = '%2'; cursor.processIdentity!.pid = 77
  const origin = await pending, original = { ...row(), engine: 'cursor' } as RegisteredSession
  expect(origin.ancestry).toEqual([])
  expect(origin.runtime).toMatchObject({ agentId: original.agentId, routeV1: nativeHookRouteV1(original), process: { pid: 42 } })
  const caller = nativeHookOriginCaller(origin)
  expect(caller.owner(original).source).toBe('runtime')
  for (const replacement of [cursor, { ...original, agentId: 'replacement' }, row(), { ...original, primaryRuntimeKey: 'tmux\u0000%2' }]) {
    expect(() => caller.owner(replacement)).toThrow('absent from the original')
  }
  await expect(capture(row())).rejects.toThrow('caller could not be retained')
})

it('keeps one shared capture deadline and refuses oversized identity instead of hashing a prefix', async () => {
  probe.mockImplementationOnce(async () => { clock.now = 4_000; throw Error('fixture deadline') })
  await expect(capture()).rejects.toThrow('deadline')
  clock.now = 0
  processes.get(43)!.argv = ['engine', 'x'.repeat(128 * 1024)]
  await expect(capture()).rejects.toThrow('caller could not be retained')
})

it('stops at the original 32-member prefix without probing or retaining another ancestor', async () => {
  processes = new Map(Array.from({ length: 34 }, (_, i) => [43 + i, native(43 + i, 44 + i)]))
  const origin = await capture()
  expect(origin.ancestry).toHaveLength(32)
  expect(probe).toHaveBeenCalledTimes(32)
  expect(origin.ancestry.at(-1)?.pid).toBe(74)
  expect(() => nativeHookOriginCaller(origin).owner({ ...row(), processIdentity: { ...row().processIdentity!, pid: 75 } })).toThrow('absent')
})

it.each([
  ['unsupported version', (value: any) => { value.version = 2 }],
  ['unreadable boot', (value: any) => { value.boot = 'time:12345' }],
  ['unknown field', (value: any) => { value.newProof = true }],
  ['missing first edge', (value: any) => { value.ancestry.shift() }],
  ['changed edge', (value: any) => { value.ancestry[0].parentPid = 99 }],
  ['cycle', (value: any) => { value.ancestry[1].parentPid = 43 }],
  ['missing digest', (value: any) => { delete value.ancestry[1].identityV1 }],
  ['inexact birth', (value: any) => { value.ancestry[1].birth = 'approximate' }],
  ['unknown member field', (value: any) => { value.ancestry[0].current = true }],
  ['missing prefix', (value: any) => { value.ancestry = [] }],
  ['missing runtime route', (value: any) => { value.runtime = { agentId: 'fixture', process: value.ancestry[0] } }],
  ['oversized runtime', (value: any) => { value.runtime = { agentId: 'fixture', routeV1: 'x'.repeat(8192), process: value.ancestry[0] } }],
] as const)('holds %s instead of recapturing an origin', async (_name, corrupt) => {
  const origin: NativeHookOrigin = await capture()
  corrupt(origin)
  expect(() => inspectNativeHookOrigin(origin)).toThrow()
  expect(probe).toHaveBeenCalledTimes(3)
})

it('pins the v1 identity serialization and rejects unknown native representations', () => {
  const evidence = '[42,77,"4200","fixture-engine","/fixture/engine",["engine","--prompt","fixture prompt"],null]'
  expect(controlIdentity(native())).toBe(evidence)
  expect(nativeHookIdentityV1(evidence)).toBe(createHash('sha256').update(evidence).digest('hex'))
  expect(nativeHookIdentityV1(controlIdentity({ ...native(), argv: ['engine --prompt', 'fixture prompt'] }))).not.toBe(nativeHookIdentityV1(evidence))
  for (const value of ['{', '[]', evidence.slice(0, -1) + ',"new shape"]', 'x'.repeat(128 * 1024 + 1)]) {
    expect(() => nativeHookIdentityV1(value)).toThrow()
  }
})

it('bundles origin capture without daemon configuration, Registry runtime or services', () => {
  const built = buildSync({ entryPoints: ['src/engines/kit/nativeHookOrigin.ts'], bundle: true, write: false,
    metafile: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  expect(Object.keys(built.metafile.inputs).sort()).toEqual([
    'src/engines/kit/identityScan.ts', 'src/engines/kit/nativeEvidence.ts', 'src/engines/kit/nativeHookBoot.ts',
    'src/engines/kit/nativeHookOrigin.ts', 'src/lib/childLocale.ts', 'src/lib/nativeProcessControlProbe.ts',
  ])
})
