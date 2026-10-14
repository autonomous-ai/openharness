import { execFile } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { readProcessEvidence } from '../../lib/processEvidence.js'
import { controlIdentity, nativeProcessControl, type NativeControlRow } from '../../lib/nativeProcessControl.js'
import { nativeBytes } from './nativeEvidence.js'
import { createNativeHookOwnerReader } from './nativeHookOwner.js'
import { nativeHookIdentityV1 } from './nativeHookOrigin.js'
import type { nativeHookScope, NativeHookScope } from './nativeHookScope.js'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
vi.mock('../../lib/processEvidence.js', () => ({ readProcessEvidence: vi.fn() }))
vi.mock('../../lib/nativeProcessControl.js', async original => ({ ...await original<object>(), nativeProcessControl: vi.fn() }))
vi.mock('./nativeEvidence.js', async original => ({ ...await original<object>(), nativeBytes: vi.fn() }))
const clock = vi.hoisted(() => ({ now: 0 }))
vi.mock('node:perf_hooks', () => ({ performance: { now: () => clock.now } }))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const BOOT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const row = () => ({ agentId: 'fixture-agent', active: true, engine: 'codex', processIdentity: {
  pid: 42, executable: 'codex', startMarker: 'Fri Oct  9 11:59:00 2026',
} } as RegisteredSession)
let native: NativeControlRow
beforeEach(() => {
  clock.now = 0; vi.resetAllMocks()
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  native = { pid: 42, parentPid: 1, birth: '12345', command: 'codex', imagePath: '/fixture/codex', argv: ['codex'], fds: [] }
  vi.mocked(nativeBytes).mockResolvedValue(Buffer.from(BOOT + '\n'))
  vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
    (callback as (error: Error | null, out: string, err: string) => void)(null, BOOT + '\n', '')
    return {} as never
  })
  vi.mocked(readProcessEvidence).mockImplementation(async () => ({ parent: { nativeBirth: native.birth, controlIdentity: controlIdentity(native) } } as never))
  vi.mocked(nativeProcessControl).mockImplementation(async () => ({ parent: 0, children: [], rows: new Map([[42, native]]) }))
})
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.restoreAllMocks() })

it.each(['linux', 'darwin'])('keeps precise %s birth across core reconstruction and rechecks after disk waits', async os => {
  Object.defineProperty(process, 'platform', { ...platform, value: os })
  if (os === 'darwin') native.birth = '1791547140:123456'
  const read = createNativeHookOwnerReader(), first = await read(row())
  expect(first.key).toBe(`${os}:${BOOT}\u0000codex\u000042\u0000${native.birth}`)
  expect((await createNativeHookOwnerReader()(row())).key).toBe(first.key)
  clock.now = 10_000
  expect(() => first.verify()).toThrow('deadline')
  const fresh = await read(row(), first)
  fresh.verify()
  expect(fresh.key).toBe(first.key)
  native.birth = os === 'darwin' ? '1791547140:123457' : '12346'
  await expect(read(row(), first)).rejects.toThrow('incarnation changed')
})

it('holds an exited or changed image instead of trusting the saved registry row', async () => {
  const read = createNativeHookOwnerReader(), first = await read(row())
  native.imagePath = '/fixture/replacement'
  await expect(read(row(), first)).rejects.toThrow('incarnation changed')
  vi.mocked(readProcessEvidence).mockResolvedValue({ parent: null } as never)
  await expect(read(row(), first)).rejects.toThrow('exited')
  await expect(read({ ...row(), processIdentity: null })).rejects.toThrow('owner is unavailable')
  vi.mocked(readProcessEvidence).mockResolvedValue({ parent: null } as never)
  await expect(read(row())).rejects.toThrow('precise')
})

it('reproves a saved v1 digest against complete native identity and the Registry executable', async () => {
  const read = createNativeHookOwnerReader(), first = await read(row())
  const expected = { key: first.key, identityV1: nativeHookIdentityV1(first.evidence) }
  expect(await read(row(), expected)).toMatchObject({ key: first.key, evidence: first.evidence })
  expect(vi.mocked(readProcessEvidence).mock.calls.at(-1)?.[3]).toEqual(row().processIdentity)
  native.argv = ['codex', '--replacement']
  await expect(read(row(), expected)).rejects.toThrow('incarnation changed')
  native.argv = ['codex']
  native.birth = '12346'
  await expect(read(row(), expected)).rejects.toThrow('incarnation changed')
})

it('holds an incomplete boot UUID and retries it without inventing a time identity', async () => {
  const read = createNativeHookOwnerReader()
  vi.mocked(nativeBytes).mockResolvedValueOnce(Buffer.from('truncated'))
  await expect(read(row())).rejects.toThrow('boot identity is incomplete')
  expect((await read(row())).key).toContain(BOOT)
})

it('retains actual probe slots while a read is stalled and captures caller inputs before yielding', async () => {
  const read = createNativeHookOwnerReader(), input = row()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.mocked(nativeBytes).mockImplementation(async () => { await gate; return Buffer.from(BOOT) })
  const pending = Array.from({ length: 8 }, () => read(input))
  input.processIdentity!.pid = 99
  await expect(read(row())).rejects.toThrow('slots are occupied')
  release()
  const proofs = await Promise.all(pending)
  expect(proofs.every(proof => proof.key.includes('\u000042\u0000'))).toBe(true)
  await expect(read(row(), proofs[0])).resolves.toHaveProperty('key', proofs[0]!.key)
})

it.each(['linux', 'darwin'])('retains the %s caller ancestry before registration exists and needs only the engine after waiting', async os => {
  Object.defineProperty(process, 'platform', { ...platform, value: os })
  if (os === 'darwin') native.birth = '1791547140:123456'
  native.parentPid = 77
  const shell = { ...native, pid: 43, parentPid: 42, birth: 'shell-generation', command: 'sh' }
  const processes = new Map([[42, native], [43, shell]])
  vi.mocked(nativeProcessControl).mockImplementation(async (pids, _parent, _budget, descriptors) => {
    expect(descriptors).toBe(false)
    if (pids.some(pid => !processes.has(pid))) throw Error('unreadable ancestor above engine')
    return { parent: 0, children: [], rows: new Map(pids.map(pid => [pid, processes.get(pid)!])) }
  })
  const read = createNativeHookOwnerReader(), caller = await read.captureCaller(43, [])
  processes.delete(43); clock.now = 10_000
  const proof = await read(row(), caller.owner(row()))
  expect(proof.evidence).toBe(controlIdentity(native))
  native.birth = os === 'darwin' ? '1791547140:123457' : '12346'
  await expect(read(row(), caller.owner(row()))).rejects.toThrow('incarnation changed')
})

it('does not include an ancestor when its child changes before their native edge is proved', async () => {
  const child = { ...native, pid: 43, parentPid: 42 }
  vi.mocked(nativeProcessControl).mockImplementation(async pids => ({ parent: 0, children: [],
    rows: new Map([[43, { ...child, birth: pids.length === 1 ? 'original' : 'replacement' }], [42, native]]) }))
  const caller = await createNativeHookOwnerReader().captureCaller(43, [])
  expect(() => caller.owner(row())).toThrow('original native hook caller ancestry')
})

it('keeps the Cursor runtime exception in its unique arrival route and never fills a missing arrival owner later', async () => {
  const cursor = { ...row(), engine: 'cursor', runtimes: [{ backend: 'tmux', paneId: '%1' }], primaryRuntimeKey: 'tmux:%1' } as RegisteredSession
  vi.mocked(nativeProcessControl).mockImplementation(async pids => ({ parent: 0, children: [],
    rows: new Map(pids.map(pid => [pid, { ...native, pid, parentPid: 1 }])) }))
  const read = createNativeHookOwnerReader(), caller = await read.captureCaller(43, [cursor])
  expect((await read(cursor, caller.owner(cursor))).evidence).toBe(controlIdentity(native))
  expect(() => caller.owner({ ...cursor, runtimes: [{ backend: 'tmux', paneId: '%2' }] })).toThrow('original native hook')
  const absent = await read.captureCaller(43, [])
  expect(() => absent.owner(cursor)).toThrow('original native hook')
  const ambiguous = await read.captureCaller(43, [cursor, { ...cursor, agentId: 'another-cursor' }])
  expect(() => ambiguous.owner(cursor)).toThrow('original native hook')
  native.birth = 'replacement'
  await expect(read(cursor, caller.owner(cursor))).rejects.toThrow('incarnation changed')
})

it('keeps caller ancestry available while the independent Cursor runtime probe is stalled or fails', async () => {
  let fail!: () => void, captured = false
  vi.mocked(readProcessEvidence).mockImplementation(() => new Promise((_resolve, reject) => { fail = () => reject(Error('runtime unavailable')) }))
  vi.mocked(nativeProcessControl).mockImplementation(async pids => {
    captured = true
    return { parent: 0, children: [], rows: new Map(pids.map(pid => [pid, { ...native, pid, parentPid: pid === 43 ? 42 : 1 }])) }
  })
  const read = createNativeHookOwnerReader(), pending = read.captureCaller(43, [{ ...row(), engine: 'cursor' }])
  await vi.waitFor(() => expect(captured).toBe(true))
  fail()
  const caller = await pending
  expect(caller.owner(row())).toMatchObject({ source: 'caller', evidence: controlIdentity(native) })
})

function scoped() {
  const root = '/fixture/private-registry'
  const scopes: Array<NativeHookScope & { verify: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = []
  const scope = vi.fn<typeof nativeHookScope>(async () => {
    const result = { boot: `linux:${BOOT}`, namespace: 'linux:4:5', storage: 'fixture-local-volume', verify: vi.fn(), close: vi.fn() }
    scopes.push(result); return result
  })
  const reader = createNativeHookOwnerReader({ root, scope })
  const cursor: RegisteredSession = { ...row(), engine: 'cursor' }
  return { reader, cursor, root, scope, scopes }
}

it('captures a historical PID view only in the final generation path without changing ordinary owner evidence', async () => {
  const f = scoped(), original = await f.reader(f.cursor)
  await f.reader.captureCaller(43, [f.cursor])
  expect(f.scope).not.toHaveBeenCalled()
  vi.mocked(readProcessEvidence).mockClear()
  const result = await f.reader.generation(f.cursor, original)
  expect(result).toMatchObject({ key: original.key, evidence: original.evidence, namespace: 'linux:4:5' })
  expect(Object.isFrozen(result)).toBe(true)
  expect(f.scope).toHaveBeenCalledTimes(2)
  expect(f.scope.mock.calls.every(([root]) => root === f.root)).toBe(true)
  expect(readProcessEvidence).toHaveBeenCalledTimes(2)
  for (const scope of f.scopes) {
    expect(scope.verify).toHaveBeenCalledWith(f.root); expect(scope.close).toHaveBeenCalledOnce()
  }
  clock.now = 4000
  expect(() => result.verify()).toThrow('deadline')
  expect(result.namespace).toBe('linux:4:5')
})

it.each(['root', 'engine', 'inactive', 'identity'])('holds generation capture without %s authority', async change => {
  const f = scoped(), cursor = f.cursor
  if (change === 'engine') cursor.engine = 'codex'
  if (change === 'inactive') cursor.active = false
  if (change === 'identity') cursor.processIdentity = null
  await expect((change === 'root' ? createNativeHookOwnerReader() : f.reader).generation(cursor)).rejects.toThrow('scope is unavailable')
  expect(f.scope).not.toHaveBeenCalled()
})

it.each(['boot', 'namespace', 'storage', 'original-root', 'final-root', 'pid', 'image', 'deadline', 'birth'])('holds %s changes across generation scope capture', async change => {
  const f = scoped(), scope = f.scope.getMockImplementation()!
  f.scope.mockImplementation(async (...args) => {
    const result = await scope(...args)
    if (f.scopes.length === 2) {
      if (change === 'boot') result.boot = `linux:${BOOT.replace('aaaa', 'bbbb')}`
      if (change === 'namespace') result.namespace = 'linux:4:6'
      if (change === 'storage') result.storage = 'different-volume'
      if (change === 'original-root') f.scopes[0].verify.mockImplementation(() => { throw Error('original root changed') })
      if (change === 'final-root') vi.mocked(result.verify).mockImplementation(() => { throw Error('final root changed') })
      if (change === 'pid') native.birth = '12346'
      if (change === 'image') native.imagePath = '/fixture/successor'
      if (change === 'deadline') clock.now = 4000
    }
    return result
  })
  if (change === 'birth') native.birth = '0012345'
  await expect(f.reader.generation(f.cursor)).rejects.toThrow()
  for (const scope of f.scopes) expect(scope.close).toHaveBeenCalledOnce()
})

it.each(['boot', 'namespace'])('refuses a foreign initial %s scope before a native read', async change => {
  const f = scoped(), scope = f.scope.getMockImplementation()!
  f.scope.mockImplementation(async (...args) => {
    const result = await scope(...args)
    if (change === 'boot') result.boot = `linux:${BOOT.replace('aaaa', 'bbbb')}`
    return result
  })
  const original = { ...await f.reader(f.cursor), namespace: change === 'namespace' ? 'linux:4:6' : 'linux:4:5' }
  vi.mocked(readProcessEvidence).mockClear()
  await expect(f.reader.generation(f.cursor, original)).rejects.toThrow('scope changed')
  expect(readProcessEvidence).not.toHaveBeenCalled()
  expect(f.scopes[0].close).toHaveBeenCalledOnce()
})

it.each(['first-close', 'final-close', 'close-error', 'final-read'])('holds %s failure while closing every acquired generation scope', async change => {
  const f = scoped(), scope = f.scope.getMockImplementation()!
  f.scope.mockImplementation(async (...args) => {
    if (change === 'final-read' && f.scopes.length) throw Error('final scope unavailable')
    const result = await scope(...args)
    if (f.scopes.length === (change === 'first-close' ? 1 : 2)) vi.mocked(result.close).mockImplementation(() => {
      if (change === 'close-error') throw Error('scope close failed')
      clock.now = 4000
    })
    return result
  })
  await expect(f.reader.generation(f.cursor)).rejects.toThrow()
  for (const scope of f.scopes) expect(scope.close).toHaveBeenCalledOnce()
})
