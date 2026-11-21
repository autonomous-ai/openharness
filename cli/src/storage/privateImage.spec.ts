import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, type BigIntStats } from 'node:fs'
import * as nativeFs from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readPrivateImage } from './privateImage.js'
import { sameSessionFileIdentity, sessionFileIdentity } from '../lib/sessionStorageWire.js'
import * as custody from '../lib/secureState.js'

vi.mock('node:fs/promises', async original => ({ ...await original<object>() }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, constants: { ...actual.constants } }
})
vi.mock('../lib/secureState.js', async original => ({ ...await original<object>() }))

vi.mock('../lib/sessionStorageWire.js', async original => {
  const actual = await original<typeof import('../lib/sessionStorageWire.js')>()
  return { ...actual, sessionFileIdentity: vi.fn(actual.sessionFileIdentity) }
})
let root: string, file: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'private-image-'))
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  file = join(root, 'state', 'image.json')
  writeFileSync(file, '[{"title":"fixture"}]', { mode: 0o600 })
  vi.mocked(sessionFileIdentity).mockClear()
})
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

it('checks the exact read metadata without repeatedly serializing proof identities', async () => {
  const image = await readPrivateImage(file, 1024)
  expect(image?.bytes.toString()).toBe('[{"title":"fixture"}]')
  expect(sessionFileIdentity).toHaveBeenCalledTimes(0)
})

it('reads a private image inside its owning process without per-operation libuv round trips', async () => {
  const open = vi.spyOn(fs, 'open')
  const image = await readPrivateImage(file, 1024)
  expect(image?.bytes.toString()).toBe('[{"title":"fixture"}]')
  expect(open).toHaveBeenCalledTimes(0)
})

const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs', 'mode', 'uid', 'gid', 'nlink'] as const
const change = (stat: BigIntStats, field: typeof fields[number]): BigIntStats => {
  const result = Object.create(Object.getPrototypeOf(stat), Object.getOwnPropertyDescriptors(stat)) as BigIntStats
  result[field] += 1n
  return result
}

it.each(fields)('preserves the canonical proof equality for changed %s in every before/after/path ordering', field => {
  const before = lstatSync(file, { bigint: true }), changed = change(before, field)
  for (const [left, right] of [[before, before], [before, changed], [changed, before], [changed, changed]]) {
    expect(sameSessionFileIdentity(left, right)).toBe(sessionFileIdentity(left) === sessionFileIdentity(right))
  }
})

it('does not promote atime into an identity field', () => {
  const before = lstatSync(file, { bigint: true }), after = { ...before, atimeNs: before.atimeNs + 1n } as BigIntStats
  expect(sameSessionFileIdentity(before, after)).toBe(true)
  expect(sessionFileIdentity(before)).toBe(sessionFileIdentity(after))
})

it.each(fields.flatMap(field => ['after', 'path'].map(phase => ({ field, phase }))))(
  'refuses the actual read when $phase metadata changes $field', async ({ field, phase }) => {
    let closed = false
    const stat = nativeFs.fstatSync, close = nativeFs.closeSync
    let count = 0
    vi.spyOn(nativeFs, 'fstatSync').mockImplementation(((...args: Parameters<typeof stat>) => {
      const result = stat(...args)
      return phase === 'after' && args[1]?.bigint && ++count === 2 ? change(result as BigIntStats, field) : result
    }) as typeof stat)
    vi.spyOn(nativeFs, 'closeSync').mockImplementation(fd => { if (stat(fd).isFile()) closed = true; close(fd) })
    const lstat = nativeFs.lstatSync
    vi.spyOn(nativeFs, 'lstatSync').mockImplementation(((...args: Parameters<typeof lstat>) => {
      const result = lstat(...args)
      return phase === 'path' ? change(result as BigIntStats, field) : result
    }) as typeof lstat)
    await expect(readPrivateImage(file, 1024)).rejects.toMatchObject({ code: 'changed' })
    expect(closed).toBe(true)
  })

it('reads through short system reads and proves actual file growth or truncation', async () => {
  const read = nativeFs.readSync
  vi.spyOn(nativeFs, 'readSync').mockImplementation(((fd: number, bytes: Buffer, offset: number, length: number, position: number) =>
    read(fd, bytes, offset, Math.min(length, 2), position)) as typeof read)
  expect((await readPrivateImage(file, 1024))?.bytes.toString()).toBe('[{"title":"fixture"}]')
  vi.restoreAllMocks()
  const grow = vi.spyOn(nativeFs, 'readSync').mockImplementationOnce(((...args: Parameters<typeof read>) => {
    nativeFs.appendFileSync(file, 'x'.repeat(2048))
    return read(...args)
  }) as typeof read)
  await expect(readPrivateImage(file, 1024)).rejects.toMatchObject({ code: 'unsafe' })
  grow.mockRestore()
  vi.spyOn(nativeFs, 'readSync').mockImplementationOnce(((...args: Parameters<typeof read>) => {
    nativeFs.truncateSync(file, 2)
    return read(...args)
  }) as typeof read)
  await expect(readPrivateImage(file, 4096)).rejects.toMatchObject({ code: 'changed' })
})

it('preserves the unlimited Registry-image path and refuses an oversized bounded archive', async () => {
  expect((await readPrivateImage(file, Number.MAX_SAFE_INTEGER))?.bytes.toString()).toBe('[{"title":"fixture"}]')
  await expect(readPrivateImage(file, 2)).rejects.toMatchObject({ code: 'unsafe' })
})

it('handles missing files and rejects non-file or symlink input without following it', async () => {
  expect(await readPrivateImage(join(root, 'state', 'missing'), 1024)).toBeNull()
  await expect(readPrivateImage(join(root, 'state'), 1024)).rejects.toMatchObject({ code: 'unsafe' })
  if (process.platform !== 'win32') {
    const link = join(root, 'state', 'link.json')
    nativeFs.symlinkSync(file, link)
    await expect(readPrivateImage(link, 1024)).rejects.toMatchObject({ code: 'unsafe' })
  }
})

it('tightens owner-readable modes but refuses writable containers and images', async () => {
  if (process.platform === 'win32') return
  nativeFs.chmodSync(file, 0o644)
  const image = await readPrivateImage(file, 1024)
  expect(image!.stat.mode & 0o777n).toBe(0o600n)
  nativeFs.chmodSync(file, 0o644)
  const chmod = vi.spyOn(nativeFs, 'fchmodSync').mockImplementation(() => {})
  await expect(readPrivateImage(file, 1024)).rejects.toMatchObject({ code: 'unsafe' })
  chmod.mockRestore()
  nativeFs.chmodSync(file, 0o666)
  await expect(readPrivateImage(file, 1024)).rejects.toMatchObject({ code: 'unsafe' })
  expect(nativeFs.statSync(file).mode & 0o777).toBe(0o666)
  nativeFs.chmodSync(file, 0o600); nativeFs.chmodSync(join(root, 'state'), 0o777)
  await expect(readPrivateImage(file, 1024)).rejects.toMatchObject({ code: 'unsafe' })
})

it('refuses a foreign image owner and closes the opened file', async () => {
  if (typeof process.getuid !== 'function') return
  const stat = nativeFs.fstatSync, close = vi.spyOn(nativeFs, 'closeSync')
  vi.spyOn(nativeFs, 'fstatSync').mockImplementation(((...args: Parameters<typeof stat>) => {
    const result = stat(...args)
    return args[1]?.bigint ? change(result as BigIntStats, 'uid') : result
  }) as typeof stat)
  await expect(readPrivateImage(file, 1024)).rejects.toMatchObject({ code: 'unsafe' })
  expect(close).toHaveBeenCalledTimes(1)
})

it('uses Windows root authority when POSIX ownership and open flags are unavailable', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const uid = Object.getOwnPropertyDescriptor(process, 'getuid')
  const flags = nativeFs.constants as { O_NOFOLLOW?: number; O_NONBLOCK?: number }
  const follow = flags.O_NOFOLLOW, nonblock = flags.O_NONBLOCK
  const directory = vi.spyOn(custody, 'secureStateDirectory').mockImplementation(() => {})
  const rootCheck = vi.spyOn(custody, 'requireWindowsStateFile').mockImplementation(() => {})
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  Object.defineProperty(process, 'getuid', { configurable: true, value: undefined })
  delete flags.O_NOFOLLOW; delete flags.O_NONBLOCK
  try {
    expect((await readPrivateImage(file, 1024))?.bytes.toString()).toBe('[{"title":"fixture"}]')
    expect(directory).toHaveBeenCalledWith(join(root, 'state'), false)
    expect(rootCheck).toHaveBeenCalledWith(file)
    rootCheck.mockImplementation(() => { throw new Error('fixture root refused') })
    await expect(readPrivateImage(file, 1024)).rejects.toMatchObject({ code: 'unsafe' })
  } finally {
    Object.defineProperty(process, 'platform', platform)
    if (uid) Object.defineProperty(process, 'getuid', uid); else delete (process as { getuid?: unknown }).getuid
    flags.O_NOFOLLOW = follow; flags.O_NONBLOCK = nonblock
  }
})

it('refuses new handles under shared cleanup uncertainty and preserves failed-close identity', async () => {
  const open = vi.spyOn(nativeFs, 'openSync')
  const healthy = vi.spyOn(custody, 'stateFileCustodyHealthy').mockImplementation(() => { throw new custody.StateFileCleanupUnconfirmed() })
  await expect(readPrivateImage(file, 1024)).rejects.toMatchObject({ code: 'cleanup-unconfirmed' })
  expect(open).not.toHaveBeenCalled()
  healthy.mockRestore()
  const close = custody.closeStateFileDescriptor
  vi.spyOn(custody, 'closeStateFileDescriptor').mockImplementation(fd => {
    close(fd) // Physically settle this unit fixture; real before-close uncertainty is covered through actual child reap.
    throw new custody.StateFileCleanupUnconfirmed()
  })
  await expect(readPrivateImage(file, 1024)).rejects.toMatchObject({ code: 'cleanup-unconfirmed' })
})

it.each(['ENOSPC', 'EDQUOT', 'EROFS', 'EACCES', 'EPERM'])('preserves %s from an actual file read without carrying private error text', async code => {
  const close = vi.spyOn(nativeFs, 'closeSync')
  vi.spyOn(nativeFs, 'readSync').mockImplementationOnce(() => { throw Object.assign(new Error('fixture private read'), { code }) })
  await expect(readPrivateImage(file, 1024)).rejects.toMatchObject({ code, message: `Session storage unavailable: ${code}` })
  expect(close).toHaveBeenCalledTimes(1) // The image descriptor settles; private-directory admission uses metadata.
})
