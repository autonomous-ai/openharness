import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { withPrivateImageDirectory, type PrivateImageReader } from './privateImage.js'
import * as custody from '../lib/secureState.js'

vi.mock('node:fs', async original => ({ ...await original<object>() }))
vi.mock('../lib/secureState.js', async original => ({ ...await original<object>() }))
let root: string, directory: string, file: string
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'private-image-page-'))
  directory = join(root, 'state'); fs.mkdirSync(directory, { mode: 0o700 })
  file = join(directory, 'image.json'); fs.writeFileSync(file, 'private fixture', { mode: 0o600 })
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })

it('owns one page descriptor and closes every actual image and directory descriptor', async () => {
  const open = vi.spyOn(fs, 'openSync')
  const result = await withPrivateImageDirectory(directory, async read => {
    const first = await read(file, 1024), second = await read(file, 1024)
    expect(first!.bytes.equals(second!.bytes)).toBe(true)
    return first!.bytes.toString()
  })
  expect(result).toBe('private fixture')
  if (process.platform !== 'win32') expect(open.mock.calls.filter(([path]) => path === directory)).toHaveLength(2)
  for (const result of open.mock.results) if (result.type === 'return') {
    expect(() => fs.fstatSync(result.value)).toThrow(expect.objectContaining({ code: 'EBADF' }))
  }
})

it('rejects foreign paths and a reader retained after its directory owner closes', async () => {
  let retained!: PrivateImageReader
  await withPrivateImageDirectory(directory, async read => {
    retained = read
    await expect(read(join(root, 'foreign.json'), 1024)).rejects.toMatchObject({ code: 'invalid' })
    expect((await read(file, 1024))!.bytes.toString()).toBe('private fixture')
  })
  await expect(retained(file, 1024)).rejects.toMatchObject({ code: 'invalid' })
})

it('keeps unrelated temporary and JSON entry writes compatible within a page', async () => {
  await withPrivateImageDirectory(directory, async read => {
    const before = (await read(file, 1024))!
    fs.writeFileSync(join(directory, 'unrelated.tmp'), '')
    fs.writeFileSync(join(directory, 'new.json'), '{}', { mode: 0o600 })
    fs.renameSync(join(directory, 'new.json'), join(directory, 'renamed.json'))
    fs.rmSync(join(directory, 'unrelated.tmp'))
    expect((await read(file, 1024))!.bytes.equals(before.bytes)).toBe(true)
  })
})

it.skipIf(process.platform === 'win32').each(['before-file', 'final'] as const)(
  'refuses a replaced directory at the %s fence', async phase => {
    await expect(withPrivateImageDirectory(directory, async read => {
      if (phase === 'final') await read(file, 1024)
      fs.renameSync(directory, directory + '-old'); fs.mkdirSync(directory, { mode: 0o700 })
      fs.writeFileSync(file, 'replacement fixture', { mode: 0o600 })
      if (phase === 'before-file') await read(file, 1024)
    })).rejects.toMatchObject({ code: 'changed' })
  })

it.skipIf(process.platform === 'win32').each(['before-file', 'final'] as const)(
  'tightens a safe mode change and rechecks both paths at the %s fence', async phase => {
    await withPrivateImageDirectory(directory, async read => {
      if (phase === 'final') await read(file, 1024)
      fs.chmodSync(directory, 0o750)
      if (phase === 'before-file') expect((await read(file, 1024))!.bytes.toString()).toBe('private fixture')
    })
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700)
  })

it.skipIf(process.platform === 'win32').each([0o720, 0o702, 0o777])(
  'refuses writable mode %i before a file and at final settlement without tightening it', async mode => {
    for (const phase of ['before-file', 'final']) {
      fs.chmodSync(directory, 0o700)
      await expect(withPrivateImageDirectory(directory, async read => {
        if (phase === 'final') await read(file, 1024)
        fs.chmodSync(directory, mode)
        if (phase === 'before-file') await read(file, 1024)
      })).rejects.toMatchObject({ code: 'unsafe' })
      expect(fs.statSync(directory).mode & 0o777).toBe(mode)
    }
  })

it.skipIf(process.platform === 'win32')('rechecks the path after tightening and refuses ineffective chmod', async () => {
  await expect(withPrivateImageDirectory(directory, async read => {
    fs.chmodSync(directory, 0o750)
    vi.spyOn(fs, 'fchmodSync').mockImplementation(() => {})
    await read(file, 1024)
  })).rejects.toMatchObject({ code: 'unsafe' })
  vi.restoreAllMocks(); fs.chmodSync(directory, 0o700)
  await expect(withPrivateImageDirectory(directory, async read => {
    fs.chmodSync(directory, 0o750)
    const chmod = fs.fchmodSync
    vi.spyOn(fs, 'fchmodSync').mockImplementation((fd, mode) => {
      chmod(fd, mode)
      fs.renameSync(directory, directory + '-old'); fs.mkdirSync(directory, { mode: 0o700 })
      fs.writeFileSync(file, 'replacement fixture', { mode: 0o600 })
    })
    await read(file, 1024)
  })).rejects.toMatchObject({ code: 'changed' })
})

it.skipIf(process.platform === 'win32').each(['descriptor-owner', 'path-owner', 'path-type', 'descriptor-device'] as const)(
  'refuses changed %s security evidence before admitting file bytes', async fault => {
    await expect(withPrivateImageDirectory(directory, async read => {
      const stat = fs.fstatSync, path = fs.lstatSync
      const change = (value: fs.BigIntStats) => {
        const copy = Object.create(Object.getPrototypeOf(value), Object.getOwnPropertyDescriptors(value)) as fs.BigIntStats
        if (fault.endsWith('owner')) copy.uid++
        if (fault === 'descriptor-device') copy.dev++
        if (fault === 'path-type') copy.isDirectory = () => false
        return copy
      }
      if (fault.startsWith('descriptor')) vi.spyOn(fs, 'fstatSync').mockImplementation(((...args: Parameters<typeof stat>) => {
        const result = stat(...args)
        return result.isDirectory() && args[1]?.bigint ? change(result as fs.BigIntStats) : result
      }) as typeof stat)
      else vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: Parameters<typeof path>) => {
        const result = path(...args)
        return args[0] === directory && args[1]?.bigint ? change(result as fs.BigIntStats) : result
      }) as typeof path)
      const bytes = vi.spyOn(fs, 'readSync')
      try { await read(file, 1024) } finally { expect(bytes).not.toHaveBeenCalled() }
    })).rejects.toMatchObject({ code: fault === 'descriptor-device' ? 'changed' : 'unsafe' })
  })

it('keeps cleanup uncertainty sticky and closes other already-owned descriptors', async () => {
  const open = vi.spyOn(fs, 'openSync')
  const health = vi.spyOn(custody, 'stateFileCustodyHealthy').mockImplementation(() => { throw new custody.StateFileCleanupUnconfirmed() })
  await expect(withPrivateImageDirectory(directory, async () => undefined)).rejects.toMatchObject({ code: 'cleanup-unconfirmed' })
  expect(open).not.toHaveBeenCalled(); health.mockRestore()
  await expect(withPrivateImageDirectory(directory, async read => {
    let checks = 0
    const unhealthy = vi.spyOn(custody, 'stateFileCustodyHealthy').mockImplementation(() => {
      if (++checks === 2) throw new custody.StateFileCleanupUnconfirmed()
    })
    await expect(read(file, 1024)).rejects.toMatchObject({ code: 'cleanup-unconfirmed' })
    unhealthy.mockRestore()
  })).rejects.toMatchObject({ code: 'cleanup-unconfirmed' })
  if (process.platform === 'win32') return
  const close = custody.closeStateFileDescriptor
  let imageClosed = false, pageClosed = false
  await expect(withPrivateImageDirectory(directory, async read => {
    vi.spyOn(custody, 'closeStateFileDescriptor').mockImplementation(fd => {
      const image = fs.fstatSync(fd).isFile()
      close(fd) // Actual pre-close failure/reap is covered by the real storage-child fixture.
      if (image) { imageClosed = true; throw new custody.StateFileCleanupUnconfirmed() }
      pageClosed = true
    })
    await read(file, 1024)
  })).rejects.toMatchObject({ code: 'cleanup-unconfirmed' })
  expect(imageClosed && pageClosed).toBe(true)
  vi.restoreAllMocks()
  await expect(withPrivateImageDirectory(directory, async read => {
    await read(file, 1024)
    vi.spyOn(custody, 'closeStateFileDescriptor').mockImplementation(fd => { close(fd); throw new custody.StateFileCleanupUnconfirmed() })
  })).rejects.toMatchObject({ code: 'cleanup-unconfirmed' })
})

it('retains per-file Windows authority and permits an unavailable POSIX uid', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!, uid = Object.getOwnPropertyDescriptor(process, 'getuid')
  Object.defineProperty(process, 'getuid', { configurable: true, value: undefined })
  try {
    expect(await withPrivateImageDirectory(directory, async read => (await read(file, 1024))!.bytes.toString())).toBe('private fixture')
    const check = vi.spyOn(custody, 'secureStateDirectory').mockImplementation(() => {})
    const fileCheck = vi.spyOn(custody, 'requireWindowsStateFile').mockImplementation(() => {})
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    await withPrivateImageDirectory(directory, async read => { await read(file, 1024); await read(file, 1024) })
    expect(check).toHaveBeenCalledTimes(3); expect(fileCheck).toHaveBeenCalledTimes(2)
  } finally {
    Object.defineProperty(process, 'platform', platform)
    if (uid) Object.defineProperty(process, 'getuid', uid); else delete (process as { getuid?: unknown }).getuid
  }
})
