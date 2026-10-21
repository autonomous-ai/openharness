import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseDescriptors } from '../engines/kit/nativeDescriptors.js'
import { NativeEvidenceBudget } from '../engines/kit/nativeEvidence.js'
import { controlDescriptors, nativeProcessControl, parseNativeProcessControl } from './nativeProcessControl.js'
import { env } from '../config/env.js'

const host = vi.hoisted(() => ({ root: '', exec: vi.fn(), helper: vi.fn(), before: undefined as undefined | ((operation: string, path: string) => void),
  // A filesystem lists a directory in its own order (a tmpfs, ext4's hash): CI listed task 99 before 42.
  listDescending: false }))
vi.mock('node:os', async original => ({ ...await original<object>(), platform: () => process.platform }))
vi.mock('node:child_process', async original => ({ ...await original<object>(), execFile: host.exec }))
vi.mock('./nativeProcessImages.js', async original => ({ ...await original<object>(), bundledProcessImageHelper: host.helper }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  const mapped = (path: unknown) => String(path).startsWith('/proc/') ? join(host.root, String(path).slice(1)) : path
  const result = { ...fs }
  for (const method of ['openSync', 'opendirSync', 'readlinkSync', 'statSync'] as const) {
    result[method] = ((path: unknown, ...args: unknown[]) => {
      host.before?.(method, String(path))
      return Reflect.apply(fs[method], fs, [mapped(path), ...args])
    }) as never
  }
  const opendir = result.opendirSync
  result.opendirSync = ((path: unknown, ...args: unknown[]) => {
    const directory = Reflect.apply(opendir, fs, [path, ...args]) as import('node:fs').Dir
    if (!host.listDescending) return directory
    const listed: import('node:fs').Dirent[] = []
    for (let next = directory.readSync(); next; next = directory.readSync()) listed.push(next)
    directory.closeSync()
    listed.sort((a, b) => Number(b.name) - Number(a.name))
    return { readSync: () => listed.shift() ?? null, closeSync: () => {} }
  }) as never
  return result
})
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const originalRuntime = env.ADAPTER_RUNTIME_DIR
const budget = () => new NativeEvidenceBudget()
const hex = (text: string) => Buffer.from(text).toString('hex')
const regular = { fd: 3, type: 1, mode: 0o100000, device: '17', inode: '9007199254740993' }
const record = (pid = 42) => ({ pid, parentPid: 1, startSeconds: 1_790_000_000, startMicros: 123456,
  commandHex: hex('codex'), imageHex: hex('/fixture/codex'), commandDigest: 'a'.repeat(64), fds: [regular] })
const output = (row: unknown = record(), header: unknown = { schema: 2, mode: 'control', parent: 0, children: [] }) => `${JSON.stringify(header)}\n${JSON.stringify(row)}\n`
const parse = (text: string) => parseNativeProcessControl(text, [42], 0, budget())
function file(path: string, text: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
function processRow(pid = 42, parent = 1, command = 'codex', ticks = 100) {
  const root = join(host.root, 'proc', String(pid))
  mkdirSync(join(root, 'fd'), { recursive: true })
  file(join(root, 'stat'), `${pid} (${command}) S ${parent} ${Array(17).fill(0).join(' ')} ${ticks}\n`)
  file(join(root, 'cmdline'), command + '\0')
  rmSync(join(root, 'exe'), { force: true }); symlinkSync('/fixture/' + command, join(root, 'exe'))
  file(join(root, 'task', String(pid), 'children'), '')
}
beforeEach(() => {
  host.root = realpathSync(mkdtempSync(join(tmpdir(), 'native-control-')))
  host.before = undefined; host.exec.mockReset(); host.helper.mockReset().mockResolvedValue({ path: '/fixture/native-helper', key: 'fixture' })
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  host.exec.mockImplementation((_path, _args, _options, callback) => callback(null, Buffer.from(output()), Buffer.alloc(0)))
})
afterEach(() => { Object.defineProperty(process, 'platform', platform); env.ADAPTER_RUNTIME_DIR = originalRuntime; vi.restoreAllMocks(); vi.unstubAllGlobals(); rmSync(host.root, { recursive: true, force: true }) })

describe('strict Darwin control protocol', () => {
  it('retains exact birth, image, command digest and lossless file keys without argv/environment text', () => {
    const snapshot = parse(output()), row = snapshot.rows.get(42)!
    expect(row).toMatchObject({ pid: 42, birth: '1790000000:123456', command: 'codex', imagePath: '/fixture/codex', commandDigest: 'a'.repeat(64) })
    expect(row.argv).toBeUndefined()
    expect(row.fds[0].inode).toBe(9007199254740993n)
  })
  it.each([
    output().slice(0, -1), output() + '{}\n', '{}\n', output(record(43)), output(null),
    output(record(), { schema: 1, mode: 'control', parent: 0, children: [] }),
    output(record(), { schema: 2, mode: 'control', parent: 0, children: [43] }),
    output({ ...record(), startMicros: 1_000_000 }), output({ ...record(), commandDigest: 'bad' }),
    output({ ...record(), imageHex: hex('relative') }), output({ ...record(), imageHex: '2fff' }),
    output({ ...record(), commandHex: hex('co\0dex') }), output({ ...record(), imageHex: 'x' }),
    output({ ...record(), fds: [regular, regular] }),
    output({ ...record(), fds: [{ ...regular, inode: '18446744073709551616' }] }),
    output({ ...record(), fds: [{ ...regular, device: '4294967296' }] }),
    output({ ...record(), fds: [{ ...regular, type: 8 }] }),
    output({ ...record(), fds: [{ ...regular, mode: 0 }] }),
    output({ ...record(), fds: [{ ...regular, type: 2 }] }),
    output({ ...record(), fds: [{ fd: 33, type: 9, mode: 1, device: '0', inode: '0' }] }),
    output({ ...record(), fds: [{ fd: 33, type: 9, mode: 0, device: '1', inode: '0' }] }),
    output({ ...record(), fds: [{ fd: 33, type: 9, mode: 0, device: '0', inode: '5' }] }),
  ])('holds incomplete or invalid native output', text => { expect(() => parse(text)).toThrow('identity is held') })
  it('requires the entire requested pool, including unique child enumeration and all descriptor slots', () => {
    const text = output(record(), { schema: 2, mode: 'control', parent: 42, children: [43, 43] })
    expect(() => parseNativeProcessControl(text, [42], 42, budget())).toThrow('child pool')
    expect(() => parseNativeProcessControl(output() + JSON.stringify(record()) + '\n', [42, 43], 0, budget())).toThrow('invalid process')
    expect(() => parse(output({ ...record(), fds: Array(4097).fill(regular) }))).toThrow('invalid process')
  })
  it.each(['unix', 'IPv4', 'IPv6', 'systm', 'NDRV', 'LINK'])('matches the proven lsof socket family %s', kind => {
    expect(controlDescriptors([{ fd: '7', path: 'irrelevant', kind }])).toBe(controlDescriptors([{ fd: '7', path: '', kind: 'SOCKET' }]))
  })
  it('accepts the network-policy descriptor every native Codex holds and joins it with the lsof pool', () => {
    const netpolicy = { fd: 33, type: 9, mode: 0, device: '0', inode: '0' }
    const row = parse(output({ ...record(), fds: [regular, netpolicy] })).rows.get(42)!
    expect(row.fds[1]).toEqual({ fd: '33', path: '', kind: 'NPOLICY' })
    const lsof = parseDescriptors('p42\0\nf3\0tREG\0D0x11\0i9007199254740993\0n/x\0\nf33\0tNPOLICY\0n\0\n', 42, budget())
    expect(controlDescriptors(lsof.filter(d => d.fd === '33'))).toBe(controlDescriptors([row.fds[1]]))
    expect(controlDescriptors(row.fds.filter(d => d.fd === '3'))).toBe(controlDescriptors([{ ...lsof[0], path: '' }]))
  })
  it('rejects error or stderr even when the helper returned a complete plausible reply', async () => {
    for (const failure of ['exit', 'stderr']) {
      host.exec.mockImplementationOnce((_path, _args, _options, callback) => callback(failure === 'exit' ? Error('failed') : null,
        Buffer.from(output()), Buffer.from(failure === 'stderr' ? 'partial' : '')))
      await expect(nativeProcessControl([42], 0, budget())).rejects.toThrow('probe did not complete')
    }
  })
  it('names a live process whose program was replaced on disk, and only that, when the probe fails', async () => {
    const live = process.pid, gone = 2_000_000_000
    const paths = (pid: number) => `${JSON.stringify({ schema: 1, mode: 'paths' })}\n${JSON.stringify({ pid, unavailable: true })}\n`
    for (const [pid, expected] of [[live, 'replaced on disk'], [gone, 'probe did not complete']] as const) {
      host.exec.mockImplementation((_path, args, _options, callback) => args[0] === '--paths'
        ? callback(null, paths(pid), '')
        : callback(Object.assign(Error('exit 75'), { code: 75 }), Buffer.alloc(0), Buffer.alloc(0)))
      await expect(nativeProcessControl([pid], 0, budget())).rejects.toThrow(expected)
      expect(host.exec.mock.calls.at(-1)?.[1]).toEqual(['--paths', String(pid)])
    }
    host.exec.mockClear().mockImplementation((_path, _args, _options, callback) => callback(null, Buffer.from(output({ ...record(), imageHex: 'zz' })), Buffer.alloc(0)))
    await expect(nativeProcessControl([42], 0, budget())).rejects.toThrow()
    expect(host.exec.mock.calls.map(call => call[1][0])).toEqual(['--control']) // A parse failure is not a failed probe.
  })
  it('uses the remaining deadline and stops a missing, late or failed helper without accepting an empty pool', async () => {
    await expect(nativeProcessControl([42], 0, budget())).resolves.toMatchObject({ parent: 0 })
    expect(host.exec.mock.calls[0][1]).toEqual(['--control', expect.any(String), '0', '42'])
    expect(host.exec.mock.calls[0][2]).toMatchObject({ killSignal: 'SIGKILL', timeout: expect.any(Number), maxBuffer: 5 * 1024 * 1024 })
    host.helper.mockResolvedValueOnce(null)
    await expect(nativeProcessControl([42], 0, budget())).rejects.toThrow('helper is unavailable')
    host.helper.mockImplementationOnce(() => new Promise(() => {}))
    await expect(nativeProcessControl([42], 0, new NativeEvidenceBudget(10))).rejects.toThrow('unavailable')
    host.exec.mockImplementationOnce(() => { throw Error('spawn denied') })
    await expect(nativeProcessControl([42], 0, budget())).rejects.toThrow('could not start')
  })
  it('recovers an evicted helper from pinned bytes using only control calls', async () => {
    const bytes = Buffer.alloc(64, 7)
    env.ADAPTER_RUNTIME_DIR = host.root
    vi.stubGlobal('__DARWIN_PROCESS_IMAGES__', JSON.stringify({ schema: 1, size: bytes.length, base64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }))
    const actual = await vi.importActual<typeof import('./nativeProcessImages.js')>('./nativeProcessImages.js')
    host.helper.mockImplementation(actual.bundledProcessImageHelper)
    host.exec.mockImplementation((path, _args, _options, callback) => existsSync(path)
      ? callback(null, Buffer.from(output()), Buffer.alloc(0))
      : callback(Object.assign(Error('fixture executable removed'), { code: 'ENOENT' }), Buffer.alloc(0), Buffer.alloc(0)))
    await nativeProcessControl([42], 0, budget())
    const path = host.exec.mock.calls[0][0]
    unlinkSync(path)
    await expect(nativeProcessControl([42], 0, budget())).rejects.toThrow('probe did not complete')
    await expect(nativeProcessControl([42], 0, budget())).resolves.toMatchObject({ parent: 0 })
    expect(existsSync(path)).toBe(true)
  })
  it.each(['query timeout', 'missing executable', 'preparation failure'])('does not let optional discovery %s delay a healthy control request', async failure => {
    const bytes = Buffer.alloc(64, 7), sha256 = createHash('sha256').update(bytes).digest('hex')
    env.ADAPTER_RUNTIME_DIR = host.root
    vi.stubGlobal('__DARWIN_PROCESS_IMAGES__', JSON.stringify({ schema: 1, size: bytes.length, base64: bytes.toString('base64'), sha256 }))
    const actual = await vi.importActual<typeof import('./nativeProcessImages.js')>('./nativeProcessImages.js')
    host.helper.mockImplementation(actual.bundledProcessImageHelper)
    const path = join(host.root, 'process-images', sha256)
    if (failure === 'preparation failure') {
      mkdirSync(dirname(path), { mode: 0o700 })
      writeFileSync(path, 'fixture unavailable bytes', { mode: 0o500 })
    }
    host.exec.mockImplementation((_path, args, _options, callback) => args[0] === '--paths'
      ? callback(Object.assign(Error('fixture discovery failure'), { code: failure === 'query timeout' ? 'ETIMEDOUT' : 'ENOENT' }), '')
      : callback(null, Buffer.from(output()), Buffer.alloc(0)))
    expect((await actual.nativeProcessImages([42], 500)).images.size).toBe(0)
    const discoveryCalls = host.exec.mock.calls.length
    expect((await actual.nativeProcessImages([42], 500)).images.size).toBe(0)
    expect(host.exec).toHaveBeenCalledTimes(discoveryCalls) // Optional discovery still backs off.
    if (failure === 'preparation failure') {
      await expect(nativeProcessControl([42], 0, budget())).rejects.toThrow('helper is unavailable')
      expect(host.exec).not.toHaveBeenCalled()
      unlinkSync(path) // Recovery affects only this test's private file.
    }
    await expect(nativeProcessControl([42], 0, budget())).resolves.toMatchObject({ parent: 0 })
    expect(host.exec.mock.calls.at(-1)?.[1][0]).toBe('--control')
    expect(existsSync(path)).toBe(true)
  })
  it.each([[], [0], [42, 42], Array(34).fill(42)].map(pids => ({ pids })))('rejects invalid request pools before a probe', async ({ pids }) => {
    await expect(nativeProcessControl(pids, 0, budget())).rejects.toThrow('request is invalid')
    expect(host.exec).not.toHaveBeenCalled()
  })
})

describe('joined Linux control proof', () => {
  beforeEach(() => { Object.defineProperty(process, 'platform', { ...platform, value: 'linux' }); processRow() })
  it('reads only bounded proc records, preserving argv boundaries and every numeric descriptor', async () => {
    const rollout = join(host.root, 'rollout.jsonl'); file(rollout, '{}\n')
    symlinkSync(rollout, join(host.root, 'proc/42/fd/3'))
    file(join(host.root, 'proc/42/cmdline'), 'codex\0--prompt\0quote\ntext\0')
    const proof = await nativeProcessControl([42], 0, budget())
    expect(proof.rows.get(42)).toMatchObject({ argv: ['codex', '--prompt', 'quote\ntext'], birth: '100', fds: [{ fd: '3', path: rollout, kind: 'REG' }] })
    expect(host.exec).not.toHaveBeenCalled()
  })
  it('enumerates children of every thread and excludes proven zombies', async () => {
    processRow(43, 42); processRow(44, 42); processRow(45, 42)
    file(join(host.root, 'proc/42/task/42/children'), '43 ')
    file(join(host.root, 'proc/42/task/99/children'), '44 45 ')
    file(join(host.root, 'proc/45/stat'), `45 (exited) Z 42 ${Array(17).fill(0).join(' ')} 100\n`)
    expect((await nativeProcessControl([42, 43, 44], 42, budget())).children).toEqual([43, 44])
  })
  it('gives the children in thread order, however the directory lists its threads', async () => {
    processRow(43, 42); processRow(44, 42)
    file(join(host.root, 'proc/42/task/42/children'), '43 ')
    file(join(host.root, 'proc/42/task/99/children'), '44 ')
    host.listDescending = true
    try {
      expect((await nativeProcessControl([42, 43, 44], 42, budget())).children).toEqual([43, 44])
    } finally { host.listDescending = false }
  })
  it.each(['descriptor', 'generation', 'image', 'child', 'task'])('holds a changing %s in the joined observation', async mode => {
    let calls = 0
    host.before = (operation, path) => {
      if (operation !== 'opendirSync' || path !== '/proc/42/fd' || ++calls !== 2) return
      if (mode === 'descriptor') symlinkSync('pipe:[3]', join(host.root, 'proc/42/fd/3'))
      if (mode === 'generation') file(join(host.root, 'proc/42/stat'), `42 (codex) S 1 ${Array(17).fill(0).join(' ')} 101\n`)
      if (mode === 'image') { rmSync(join(host.root, 'proc/42/exe')); symlinkSync('/different', join(host.root, 'proc/42/exe')) }
      if (mode === 'child') { processRow(43, 42); file(join(host.root, 'proc/42/task/42/children'), '43 ') }
      if (mode === 'task') file(join(host.root, 'proc/42/task/99/children'), 'bogus')
    }
    await expect(nativeProcessControl([42], 42, budget())).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  })
  it('holds a denied, truncated or oversized record and oversized task/descriptor pools', async () => {
    rmSync(join(host.root, 'proc/42/cmdline'))
    await expect(nativeProcessControl([42], 0, budget())).rejects.toThrow('could not be read completely')
    file(join(host.root, 'proc/42/cmdline'), 'codex')
    await expect(nativeProcessControl([42], 0, budget())).rejects.toThrow('command is incomplete')
    file(join(host.root, 'proc/42/cmdline'), 'c'.repeat(65_537))
    await expect(nativeProcessControl([42], 0, budget())).rejects.toThrow('byte limit')
    file(join(host.root, 'proc/42/cmdline'), 'codex\0')
    for (let i = 100; i < 228; i++) file(join(host.root, 'proc/42/task', String(i), 'children'), '')
    await expect(nativeProcessControl([42], 42, budget())).rejects.toThrow('directory pool')
    for (let i = 0; i < 4097; i++) symlinkSync('pipe:[1]', join(host.root, 'proc/42/fd', String(i)))
    await expect(nativeProcessControl([42], 0, budget())).rejects.toThrow('directory pool')
  })
})
