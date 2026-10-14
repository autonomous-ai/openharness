import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import { kernelBootId } from './nativeHookBoot.js'
import { nativeHookScope, type NativeHookScope } from './nativeHookScope.js'

const host = vi.hoisted(() => ({ exec: vi.fn(), type: 0xef53n, namespaceDevice: 4n, namespaceInode: 5n,
  self: '', status: '', mount: '17', mountText: undefined as string | undefined, root: '', reads: 0, openError: false }))
vi.mock('./nativeHookBoot.js', () => ({ kernelBootId: vi.fn() }))
vi.mock('./nativeEvidence.js', async importOriginal => ({ ...await importOriginal<typeof import('./nativeEvidence.js')>(),
  nativeBytes: async (path: string) => {
    if (path !== '/proc/self/status') throw Error('unexpected host read')
    return Buffer.from(host.status)
  },
}))
vi.mock('node:child_process', () => ({ execFile: host.exec }))
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs,
    readlinkSync: (path: string) => path === '/proc/self' ? host.self : fs.readlinkSync(path),
    statSync: (path: string, options: Parameters<typeof fs.statSync>[1]) => path === '/proc/self/ns/pid'
      ? { dev: host.namespaceDevice, ino: host.namespaceInode, isFile: () => true } : fs.statSync(path, options),
    statfsSync: (path: string) => {
      if (!path.startsWith('/proc/self/fd/') && path !== host.root) throw Error('unexpected host volume read')
      return { type: host.type }
    },
    openSync: (path: string, flags: number) => {
      if (host.openError && path === host.root) throw Object.assign(Error('fixture root denied'), { code: 'EACCES' })
      return path.startsWith('/proc/self/fdinfo/') ? 987654 : fs.openSync(path, flags)
    },
    closeSync: (fd: number) => { if (fd !== 987654) fs.closeSync(fd) },
    readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      if (fd !== 987654) return fs.readSync(fd, buffer, offset, length, position)
      host.reads++
      const value = Buffer.from(host.mountText ?? `pos:\t0\nflags:\t0\nmnt_id:\t${host.mount}\nino:\t1\n`)
      return value.copy(buffer, offset, position, Math.min(position + length, value.length))
    },
  }
})
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const boot = 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const helpers = { prepare: vi.fn(), invalidate: vi.fn() }
let scopes: NativeHookScope[] = [], moved: string[] = []
const inspect = async () => {
  const scope = await nativeHookScope(host.root, new NativeEvidenceBudget(), helpers)
  scopes.push(scope); return scope
}
beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  host.root = realpathSync(mkdtempSync(join(tmpdir(), 'native-hook-scope-')))
  host.type = 0xef53n; host.namespaceDevice = 4n; host.namespaceInode = 5n; host.self = String(process.pid)
  host.status = `Name:\tfixture\nNStgid:\t${process.pid}\nNSpid:\t${process.pid}\n`
  host.mount = '17'; host.mountText = undefined; host.reads = 0; host.openError = false
  scopes = []; moved = []
  vi.mocked(kernelBootId).mockResolvedValue(boot)
  helpers.prepare.mockResolvedValue({ path: '/fixture/verified-helper', key: 'fixture-artifact' })
})
afterEach(() => {
  for (const scope of scopes) scope.close()
  Object.defineProperty(process, 'platform', platform)
  for (const root of [host.root, ...moved]) rmSync(root, { recursive: true, force: true })
})

function replaceRoot() {
  const original = host.root + '.retired'
  renameSync(host.root, original); moved.push(original); mkdirSync(host.root, { mode: 0o700 })
}

it.each([0xef53n, 0x58465342n, 0x9123683en, 0x01021994n, 0x2fc12fc1n])('retains positive local filesystem evidence for type %s and the exact mount', async type => {
  host.type = type
  const saved = await inspect()
  expect(saved).toMatchObject({ boot, namespace: 'linux:4:5', storage: expect.stringMatching(/^linux:/) })
  saved.verify(host.root)
  expect(() => saved.verify('/another/root')).toThrow('another root')
  const reads = host.reads
  for (let i = 0; i < 10; i++) saved.verify(host.root)
  expect(host.reads).toBe(reads) // The retained FD pins the admitted filesystem.
  replaceRoot()
  expect(() => saved.verify(host.root)).toThrow('route changed')
  expect(helpers.prepare).not.toHaveBeenCalled()
})

it.each([0x6969n, 0x65735546n, 0x01021997n, 0x794c7630n, 0n])('rejects network, FUSE, 9p, overlay and unknown volume type %s', async type => {
  host.type = type
  await expect(inspect()).rejects.toThrow('supported local filesystem')
})

it.each(['missing', 'nested', 'coincident nested', 'duplicate', 'noncanonical', 'different link'])('holds an ambiguous %s proc PID view', async fault => {
  if (fault === 'missing') host.status = 'Name:\tfixture\n'
  if (fault === 'nested') host.status = `NStgid:\t8000\t${process.pid}\nNSpid:\t8000\t${process.pid}\n`
  if (fault === 'coincident nested') host.status = `NStgid:\t${process.pid}\t${process.pid}\nNSpid:\t${process.pid}\t${process.pid}\n`
  if (fault === 'duplicate') host.status += `NSpid:\t${process.pid}\n`
  if (fault === 'noncanonical') host.status = `NStgid:\t0${process.pid}\nNSpid:\t${process.pid}\n`
  if (fault === 'different link') host.self = '1'
  await expect(inspect()).rejects.toThrow('proc PID')
})

it.each(['', 'mnt_id:\t0\n', 'mnt_id:\t017\n', 'mnt_id:\t17\nmnt_id:\t18\n', 'x'.repeat(5000)])('requires complete canonical mount evidence', async value => {
  host.mountText = value
  await expect(inspect()).rejects.toThrow(/mount (identity|evidence)/)
  expect(host.reads).toBeLessThanOrEqual(2)
})

it('pins the admitted volume through its retained descriptor and holds a changed boot during capture', async () => {
  const saved = await inspect()
  replaceRoot()
  expect(() => saved.verify(host.root)).toThrow('route changed')
  vi.mocked(kernelBootId).mockResolvedValueOnce(boot).mockResolvedValue(boot.replace('aaaaaaaa', 'bbbbbbbb'))
  await expect(inspect()).rejects.toThrow('changed its boot')
})

function darwin(reply?: Record<string, unknown>) {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  vi.mocked(kernelBootId).mockResolvedValue(boot.replace('linux', 'darwin'))
  host.type = 17n
  const info = statSync(host.root, { bigint: true })
  host.exec.mockImplementation((_path, _args, _options, done) => done(null, Buffer.from(JSON.stringify({
    schema: 1, mode: 'scope', device: String(info.dev), inode: String(info.ino), filesystem: 'apfs', mount: '1:2', type: 17, ...reply,
  }) + '\n'), Buffer.alloc(0)))
}

it('uses only the verified Darwin helper and retains root/filesystem proof', async () => {
  darwin()
  const saved = await inspect()
  expect(saved.namespace).toBe('darwin')
  expect(host.exec.mock.calls[0].slice(0, 2)).toEqual(['/fixture/verified-helper', ['--scope', expect.any(String), host.root]])
  expect(host.exec.mock.calls[0][2]).toMatchObject({ maxBuffer: 1024, killSignal: 'SIGKILL' })
  saved.verify(host.root)
  replaceRoot()
  expect(() => saved.verify(host.root)).toThrow('route changed')
})

it('bounds retained descriptors and synchronously revokes a closed proof before descriptor reuse', async () => {
  host.openError = true
  await expect(inspect()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  host.openError = false
  for (let i = 0; i < 32; i++) await inspect()
  await expect(inspect()).rejects.toThrow('descriptor capacity')
  scopes[0].close(); scopes[0].close()
  const next = await inspect()
  expect(() => scopes[0].verify(host.root)).toThrow('was closed')
  next.verify(host.root)
  await expect(inspect()).rejects.toThrow('descriptor capacity')
})

it.each([{ filesystem: 'nfs' }, { device: '999999' }, { inode: '0' }, { mount: null }, { type: 0 }])('rejects incomplete or mismatched Darwin scope %j', async reply => {
  darwin(reply)
  await expect(inspect()).rejects.toThrow('reply is incomplete')
})

it('holds a missing helper or unsuccessful native probe', async () => {
  darwin(); helpers.prepare.mockResolvedValueOnce(null)
  await expect(inspect()).rejects.toThrow('helper is unavailable')
  expect(host.exec).not.toHaveBeenCalled()
  host.exec.mockImplementation((_path, _args, _options, done) => done(Object.assign(Error('fixture missing helper'), { code: 'ENOENT' }), Buffer.alloc(0), Buffer.alloc(0)))
  await expect(inspect()).rejects.toThrow('did not complete')
  expect(helpers.invalidate).toHaveBeenCalledExactlyOnceWith('fixture-artifact')
})
