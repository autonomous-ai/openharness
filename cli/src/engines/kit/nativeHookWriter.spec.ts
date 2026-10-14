import { buildSync } from 'esbuild'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NativeControlRow } from '../../lib/nativeProcessControlProbe.js'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import { nativeHookScope } from './nativeHookScope.js'
import { captureNativeHookWriter, nativeHookWriterDead } from './nativeHookWriter.js'

vi.mock('./nativeHookScope.js', () => ({ nativeHookScope: vi.fn() }))
const clock = vi.hoisted(() => ({ now: 0 }))
vi.mock('node:perf_hooks', () => ({ performance: { now: () => clock.now } }))
const boot = 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', root = '/fixture/stages'
const writer = () => ({ boot, namespace: 'linux:4:5', pid: 8100, birth: '12345' })
const helpers = { prepare: vi.fn(), invalidate: vi.fn() }
const verify = vi.fn()
const scope = () => ({ boot, namespace: 'linux:4:5', storage: 'fixture-local-mount', verify, close: vi.fn() })
let birth: string
const probe = vi.fn(async (pids: readonly number[], budget: NativeEvidenceBudget) => {
  budget.step()
  return { parent: 0, children: [], rows: new Map(pids.map(pid => [pid, {
    pid, parentPid: 1, birth, command: 'fixture-hook', imagePath: '/fixture/node', argv: [], fds: [],
  } as NativeControlRow])) }
})
const dead = (input = writer()) => nativeHookWriterDead(root, input, new NativeEvidenceBudget(), probe, helpers)
const capture = () => captureNativeHookWriter(root, new NativeEvidenceBudget(), probe, helpers)
beforeEach(() => {
  clock.now = 0; birth = '12345'; vi.clearAllMocks()
  vi.mocked(nativeHookScope).mockResolvedValue(scope())
  // No test sends even signal zero to a real host process.
  vi.spyOn(process, 'kill').mockReturnValue(true)
})
afterEach(() => vi.restoreAllMocks())

it.each(['linux', 'darwin'])('captures the exact current %s writer and retains local-root authority', async platform => {
  const currentBoot = boot.replace('linux', platform), namespace = platform === 'darwin' ? 'darwin' : 'linux:4:5'
  vi.mocked(nativeHookScope).mockResolvedValue({ ...scope(), boot: currentBoot, namespace })
  if (platform === 'darwin') birth = '1791547140:123456'
  const saved = await capture()
  expect(saved.writer).toEqual({ boot: currentBoot, namespace, pid: process.pid, birth })
  expect(Object.isFrozen(saved.writer)).toBe(true)
  expect(probe.mock.calls.map(([pids]) => pids)).toEqual([[process.pid]])
  expect(process.kill).not.toHaveBeenCalled()
  saved.verifyWriter(root)
  expect(verify).toHaveBeenCalledWith(root)
})

it('keeps a live exact writer and proves a reused PID only from its different precise birth', async () => {
  expect(await dead()).toBe(false)
  expect(process.kill).toHaveBeenCalledWith(8100, 0)
  birth = '12346'
  expect(await dead()).toBe(true)
  expect(probe).toHaveBeenCalledTimes(2)
})

it('requires stable local-root evidence before treating a new boot as writer death', async () => {
  vi.mocked(nativeHookScope).mockResolvedValue({ ...scope(), boot: boot.replace('aaaaaaaa', 'bbbbbbbb') })
  expect(await dead()).toBe(true)
  expect(nativeHookScope).toHaveBeenCalledTimes(2)
  expect(process.kill).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled()
})

it.each(['linux:4:6', 'linux:6:5'])('holds a foreign PID namespace %s before inspecting an absent or reused local PID', async namespace => {
  vi.mocked(nativeHookScope).mockResolvedValue({ ...scope(), namespace })
  vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(Error('fixture absent'), { code: 'ESRCH' }) })
  await expect(dead()).rejects.toThrow('namespace differs')
  expect(process.kill).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled()
})

it('refuses writer admission and cleanup through an unavailable or remote storage scope', async () => {
  vi.mocked(nativeHookScope).mockRejectedValue(Error('fixture remote storage'))
  await expect(capture()).rejects.toThrow('remote storage')
  await expect(dead()).rejects.toThrow('remote storage')
  expect(process.kill).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled()
})

it('requires an explicit ESRCH when the old PID is absent', async () => {
  vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(Error('fixture absent process'), { code: 'ESRCH' }) })
  expect(await dead()).toBe(true)
  expect(nativeHookScope).toHaveBeenCalledTimes(2); expect(probe).not.toHaveBeenCalled()
})

it.each(['EPERM', 'EACCES', undefined])('does not convert a %s liveness failure into death', async code => {
  vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(Error('fixture unavailable process'), { code }) })
  await expect(dead()).rejects.toThrow('liveness is unavailable'); expect(probe).not.toHaveBeenCalled()
})

it.each(['missing', 'wrong PID', 'invalid birth', 'unreadable'])('holds %s process evidence', async fault => {
  if (fault === 'unreadable') probe.mockRejectedValueOnce(Error('fixture native helper unavailable'))
  else if (fault === 'invalid birth') birth = 'rounded wall clock'
  else probe.mockResolvedValueOnce({ parent: 0, children: [], rows: fault === 'missing' ? new Map() : new Map([[8100, {
    pid: 8200, parentPid: 1, birth, command: 'fixture-hook', imagePath: '/fixture/node', fds: [],
  }]]) })
  await expect(dead()).rejects.toThrow()
})

it.each(['boot', 'namespace', 'storage'])('holds a changing %s during every positive death path and capture', async key => {
  for (const operation of ['capture', 'reused PID', 'absent PID', 'reboot']) {
    vi.mocked(nativeHookScope).mockReset()
    const initial = { ...scope(), ...(operation === 'reboot' ? { boot: boot.replace('aaaaaaaa', 'bbbbbbbb') } : {}) }
    vi.mocked(nativeHookScope).mockResolvedValueOnce(initial).mockResolvedValue({ ...initial, [key]: 'changed' })
    birth = '12346'
    vi.mocked(process.kill).mockImplementation(() => {
      if (operation === 'absent PID') throw Object.assign(Error('fixture absent'), { code: 'ESRCH' })
      return true
    })
    await expect(operation === 'capture' ? capture() : dead()).rejects.toThrow('scope changed')
  }
})

it('captures the saved writer fields before awaiting kernel evidence', async () => {
  const input = writer(), pending = dead(input)
  input.pid = 8200; input.birth = 'replacement'; input.boot = 'changed'; input.namespace = 'changed'
  expect(await pending).toBe(false); expect(process.kill).toHaveBeenCalledWith(8100, 0)
})

it('keeps the supplied deadline across every asynchronous probe', async () => {
  probe.mockImplementationOnce(async () => { clock.now = 4_000; return { parent: 0, children: [], rows: new Map() } })
  await expect(dead()).rejects.toThrow('deadline')
})

it('rejects invalid persisted identities before inspecting any host process', async () => {
  for (const invalid of [{ ...writer(), pid: 0 }, { ...writer(), birth: 'unknown' }, { ...writer(), boot: 'not a boot' },
    { ...writer(), namespace: 'linux:04:5' }, { ...writer(), namespace: 'linux:4:18446744073709551616' }]) {
    await expect(dead(invalid)).rejects.toThrow('identity is incomplete')
  }
  expect(process.kill).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled()
})

it.each([
  ['linux', '012345'], ['linux', '1e3'], ['linux', '+12345'], ['linux', '12345.0'],
  ['linux', '9007199254740992'], ['linux', '-0'], ['linux', ''],
  ['darwin', '01791547140:123456'], ['darwin', '1791547140:012345'],
  ['darwin', '1791547140:1000000'], ['darwin', '0:123456'], ['darwin', '9007199254740992:1'],
  ['darwin', '1791547140:1:0'], ['darwin', '1791547140:'],
])('holds noncanonical %s birth %s before any death proof', async (platform, invalid) => {
  const input = { ...writer(), boot: boot.replace('linux', platform), namespace: platform === 'darwin' ? 'darwin' : 'linux:4:5', birth: invalid }
  vi.mocked(nativeHookScope).mockResolvedValue({ ...scope(), boot: boot.replace('aaaaaaaa', 'bbbbbbbb') })
  vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(Error('fixture absent'), { code: 'ESRCH' }) })
  await expect(dead(input)).rejects.toThrow('identity is incomplete')
  expect(nativeHookScope).not.toHaveBeenCalled(); expect(process.kill).not.toHaveBeenCalled()
})

it.each([['linux', '012345'], ['darwin', '1791547140:1000000']])('holds malformed fresh %s birth evidence', async (platform, invalid) => {
  const currentBoot = boot.replace('linux', platform), namespace = platform === 'darwin' ? 'darwin' : 'linux:4:5'
  vi.mocked(nativeHookScope).mockResolvedValue({ ...scope(), boot: currentBoot, namespace })
  birth = invalid
  await expect(dead({ ...writer(), boot: currentBoot, namespace, birth: platform === 'linux' ? '12345' : '1791547140:123456' }))
    .rejects.toThrow('identity is incomplete')
  await expect(capture()).rejects.toThrow('identity is incomplete')
})

it('bundles writer proof without daemon configuration, staging state or services', () => {
  const built = buildSync({ entryPoints: ['src/engines/kit/nativeHookWriter.ts'], bundle: true, write: false,
    metafile: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  expect(Object.keys(built.metafile.inputs).sort()).toEqual([
    'src/engines/kit/identityScan.ts', 'src/engines/kit/nativeEvidence.ts', 'src/engines/kit/nativeHookBoot.ts',
    'src/engines/kit/nativeHookScope.ts', 'src/engines/kit/nativeHookWriter.ts', 'src/engines/kit/nativePaths.ts', 'src/lib/childLocale.ts',
  ])
})
