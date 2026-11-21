import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async original => ({ ...await original<object>() }))
let root: string
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const realUid = Object.getOwnPropertyDescriptor(process, 'getuid')
beforeEach(() => {
  vi.resetModules()
  root = fs.mkdtempSync(join(tmpdir(), 'private-directory-probe-'))
  fs.chmodSync(root, 0o700)
})
afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform)
  if (realUid) Object.defineProperty(process, 'getuid', realUid)
  else delete process.getuid
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('existing POSIX private directories', () => {
  it('checks current metadata at every fence without acquiring a descriptor', async () => {
    const { secureStateDirectory } = await import('./secureState.js')
    const opened = vi.spyOn(fs, 'openSync'), read = vi.spyOn(fs, 'lstatSync'), closed = vi.spyOn(fs, 'closeSync')
    secureStateDirectory(root, false); secureStateDirectory(root, false)
    expect(opened).not.toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledTimes(2)
    fs.chmodSync(root, 0o770)
    expect(() => secureStateDirectory(root, false)).toThrow('group/world writable')
  })

  it.each(['EMFILE', 'EACCES'])('does not require read-open access for a metadata-only check: %s', async code => {
    const { secureStateDirectory } = await import('./secureState.js')
    vi.spyOn(fs, 'openSync').mockImplementation(() => { throw Object.assign(new Error('fixture open denial'), { code }) })
    expect(() => secureStateDirectory(root, false)).not.toThrow()
  })

  it.each([0o750, 0o500, 0o1700])('keeps descriptor-based checking and tightening for mode %s', async mode => {
    const { secureStateDirectory } = await import('./secureState.js')
    fs.chmodSync(root, mode)
    const opened = vi.spyOn(fs, 'openSync')
    secureStateDirectory(root, false)
    expect(opened).toHaveBeenCalledTimes(1)
    expect(fs.statSync(root).mode & 0o777).toBe(0o700)
  })

  it('keeps descriptor checking for an inherited setgid bit', async () => {
    const { secureStateDirectory } = await import('./secureState.js'), read = fs.lstatSync
    // Some hosts clear setgid for a group this account does not belong to. Supply the metadata Linux can retain.
    vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => {
      const info = read(...args) as fs.Stats
      info.mode |= 0o2000; return info
    })
    const opened = vi.spyOn(fs, 'openSync')
    secureStateDirectory(root, false)
    expect(opened).toHaveBeenCalledTimes(1)
  })

  it.each([0o770, 0o775])('retains the original unsafe-mode refusal for %s', async mode => {
    const { secureStateDirectory } = await import('./secureState.js')
    fs.chmodSync(root, mode)
    expect(() => secureStateDirectory(root, false)).toThrow(`state directory ${root} is group/world writable`)
    expect(fs.statSync(root).mode & 0o777).toBe(mode)
  })

  it('refuses a link replacing a previously private directory', async () => {
    const { secureStateDirectory } = await import('./secureState.js')
    const folder = join(root, 'original'), displaced = join(root, 'displaced')
    fs.mkdirSync(folder, { mode: 0o700 }); secureStateDirectory(folder, false)
    fs.renameSync(folder, displaced); fs.symlinkSync(displaced, folder)
    expect(() => secureStateDirectory(folder, false)).toThrow()
  })

  it('falls back and refuses a foreign owner', async () => {
    const { secureStateDirectory } = await import('./secureState.js')
    const lstat = fs.lstatSync, fstat = fs.fstatSync
    vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => Object.assign(lstat(...args)!, { uid: process.getuid!() + 1 }))
    vi.spyOn(fs, 'fstatSync').mockImplementation((...args) => Object.assign(fstat(...args), { uid: process.getuid!() + 1 }))
    expect(() => secureStateDirectory(root, false)).toThrow('unsafe owner or type')
  })

  it('keeps the missing-name code and refuses a file in place of a directory', async () => {
    const { secureStateDirectory } = await import('./secureState.js')
    const file = join(root, 'absent')
    expect(() => secureStateDirectory(file, false)).toThrow(expect.objectContaining({ code: 'ENOENT' }))
    fs.writeFileSync(file, '{}')
    expect(() => secureStateDirectory(file, false)).toThrow()
  })

  it('uses the original path after a metadata read failure', async () => {
    const { secureStateDirectory } = await import('./secureState.js')
    vi.spyOn(fs, 'lstatSync').mockImplementationOnce(() => { throw Object.assign(new Error('fixture read failure'), { code: 'EIO' }) })
    const opened = vi.spyOn(fs, 'openSync')
    expect(() => secureStateDirectory(root, false)).not.toThrow()
    expect(opened).toHaveBeenCalledTimes(1)
  })

  it('keeps descriptor checking when the account UID is unavailable', async () => {
    const { secureStateDirectory } = await import('./secureState.js')
    Object.defineProperty(process, 'getuid', { configurable: true, value: undefined })
    const opened = vi.spyOn(fs, 'openSync'), read = vi.spyOn(fs, 'lstatSync')
    secureStateDirectory(root, false)
    expect(opened).toHaveBeenCalledTimes(1); expect(read).not.toHaveBeenCalled()
  })

  it('keeps the creation path even for an existing private directory', async () => {
    const { secureStateDirectory } = await import('./secureState.js')
    const opened = vi.spyOn(fs, 'openSync'), read = vi.spyOn(fs, 'lstatSync')
    secureStateDirectory(root)
    expect(opened).toHaveBeenCalledTimes(1); expect(read).not.toHaveBeenCalled()
  })

  it('refuses a poisoned custody latch before reading private metadata', async () => {
    const state = await import('./secureState.js'), close = fs.closeSync
    const fd = fs.openSync(root, 'r')
    vi.spyOn(fs, 'closeSync').mockImplementationOnce(value => { close(value); throw new Error('fixture uncertain close') })
    expect(() => state.closeStateFileDescriptor(fd)).toThrow(state.StateFileCleanupUnconfirmed)
    const read = vi.spyOn(fs, 'lstatSync'), opened = vi.spyOn(fs, 'openSync')
    expect(() => state.secureStateDirectory(root, false)).toThrow(state.StateFileCleanupUnconfirmed)
    expect(read).not.toHaveBeenCalled(); expect(opened).not.toHaveBeenCalled()
  })
})

it('keeps the Windows root validation without POSIX metadata probing', async () => {
  const { secureStateDirectory } = await import('./secureState.js')
  vi.stubEnv('ADAPTER_DATA_DIR', root)
  Object.defineProperty(process, 'platform', { ...realPlatform, value: 'win32' })
  const read = vi.spyOn(fs, 'lstatSync'), stat = vi.spyOn(fs, 'statSync')
  secureStateDirectory(root, false)
  expect(read).not.toHaveBeenCalled(); expect(stat).toHaveBeenCalledTimes(1)
})
