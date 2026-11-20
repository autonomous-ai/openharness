import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { chmodSync, existsSync, fstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { AtomicWriteUnconfirmed, READ_TRIES, READ_WAIT_MS, RENAME_TRIES, RENAME_WAIT_MS, StateFileUnreadable, atomicWriteFile, atomicWriteFileAsync, atomicWriteJson, atomicWriteJsonAsync, directorySyncSupported, hardenPrivateStateFileIfPresent, insideWindowsRoots, jsonArray, jsonObject, probeState, readPrivateStateFile, readState, requireState, requireWindowsStateFile, secureStateDirectory, syncStateDirectory, windowsStateRoots } from './secureState.js'

const WINDOWS = process.platform === 'win32'

// Pass-through unless a test sets a hook: the faults a disk or another process can hand the writer.
const fault = vi.hoisted(() => ({
  write: undefined as ((fd: number) => void) | undefined,
  rename: undefined as ((attempt: number) => void) | undefined,
  renames: 0,
  link: undefined as string | undefined,
  sync: undefined as ((fd: number) => void) | undefined,
  read: undefined as ((file: string) => void) | undefined,
  rm: undefined as ((path: string) => void) | undefined,
  // The async writer's timer waits, recorded and never slept; and, while a test watches, every synchronous fs call.
  timers: [] as number[],
  syncCalls: undefined as string[] | undefined,
}))
const errno = (code: string) => Object.assign(new Error(`${code}: fixture`), { code })
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  const watched = <K extends keyof typeof actual>(name: K, call: (typeof actual)[K]): (typeof actual)[K] =>
    ((...args: unknown[]) => { fault.syncCalls?.push(name); return (call as (...args: unknown[]) => unknown)(...args) }) as (typeof actual)[K]
  return { ...actual,
    ...Object.fromEntries((['openSync', 'closeSync', 'fchmodSync', 'fstatSync', 'copyFileSync', 'statSync', 'lstatSync', 'mkdirSync'] as const)
      .map((name) => [name, watched(name, actual[name])])),
    // Only a write to a descriptor (the writer's temporary file), and once: a hook may run a second writer.
    writeFileSync: watched('writeFileSync', (...args: Parameters<typeof actual.writeFileSync>) => {
      const hook = fault.write
      if (hook && typeof args[0] === 'number') { fault.write = undefined; hook(args[0]) }
      return actual.writeFileSync(...args)
    }),
    renameSync: watched('renameSync', (...args: Parameters<typeof actual.renameSync>) => {
      fault.rename?.(++fault.renames)
      return actual.renameSync(...args)
    }),
    linkSync: watched('linkSync', (...args: Parameters<typeof actual.linkSync>) => {
      if (fault.link) throw Object.assign(new Error(`${fault.link}: fixture`), { code: fault.link })
      return actual.linkSync(...args)
    }),
    fsyncSync: watched('fsyncSync', (fd: number) => {
      fault.sync?.(fd)
      return actual.fsyncSync(fd)
    }),
    // After the real read of a path: a hook may throw what the read could have, or change the file once it was read.
    readFileSync: watched('readFileSync', ((...args: Parameters<typeof actual.readFileSync>) => {
      const value = actual.readFileSync(...args)
      if (typeof args[0] === 'string') fault.read?.(args[0])
      return value
    }) as typeof actual.readFileSync),
    rmSync: watched('rmSync', (...args: Parameters<typeof actual.rmSync>) => {
      fault.rm?.(String(args[0]))
      return actual.rmSync(...args)
    }),
  }
})
// The same faults for the async writer: its file's write and flush, its rename, link and removal.
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const writeFile = handle.writeFile.bind(handle), sync = handle.sync.bind(handle)
      handle.writeFile = (async (...rest: Parameters<typeof handle.writeFile>) => {
        const hook = fault.write
        if (hook) { fault.write = undefined; hook(handle.fd) }
        return writeFile(...rest)
      }) as typeof handle.writeFile
      handle.sync = async () => { fault.sync?.(handle.fd); return sync() }
      return handle
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      fault.rename?.(++fault.renames)
      return actual.rename(...args)
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      if (fault.link) throw Object.assign(new Error(`${fault.link}: fixture`), { code: fault.link })
      return actual.link(...args)
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      fault.rm?.(String(args[0]))
      return actual.rm(...args)
    },
  }
})
vi.mock('node:timers/promises', async original => ({ ...await original<typeof import('node:timers/promises')>(),
  setTimeout: async (ms?: number) => { fault.timers.push(ms ?? 0) },
}))

// The retries' blocking waits (pauseSync) are recorded, not slept: a test never waits for real.
let pauses: MockInstance<typeof Atomics.wait>
const pausedFor = () => pauses.mock.calls.map(call => call[3])
beforeEach(() => { pauses = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out') })

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  Object.assign(fault, { write: undefined, rename: undefined, renames: 0, link: undefined, sync: undefined, read: undefined, rm: undefined,
    timers: [], syncCalls: undefined })
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(mode: number): string {
  const root = mkdtempSync(join(tmpdir(), 'secure-state-'))
  dirs.push(root)
  const dir = join(root, 'data')
  mkdirSync(dir)
  chmodSync(dir, mode)
  return dir
}

const modeOf = (dir: string) => statSync(dir).mode & 0o777

// POSIX modes: Windows reports none of them (see 'state on Windows' below).
describe.skipIf(WINDOWS)('secureStateDirectory', () => {
  it('creates a private directory regardless of the ambient umask', () => {
    const root = mkdtempSync(join(tmpdir(), 'secure-state-'))
    dirs.push(root)
    const dir = join(root, 'a', 'b')
    const previous = process.umask(0o002)   // Ubuntu's default
    try { secureStateDirectory(dir) } finally { process.umask(previous) }
    expect(modeOf(dir)).toBe(0o700)
  })

  /**
   * A group-writable directory is refused, NOT tightened — if another account could write here it could
   * already have planted the registry or the token, and chmod-then-trust would keep the planted copy.
   * registry.spec.ts, hookAuth.spec.ts and terminalConfigSnapshot.spec.ts pin the same rule.
   *
   * What Ubuntu changed is where the mode comes from, not what to do about it: umask 0002 meant the
   * daemon's OWN `mkdirSync(..., { recursive: true })` produced 0775 and then refused to start on it —
   * measured on 24.04, on every entry point. The fix is above, at creation time. A pre-existing 0775
   * directory from an older build still lands here, so the message must be actionable.
   */
  it('refuses a group-writable directory and says how to fix it', () => {
    const dir = scratch(0o775)
    expect(() => secureStateDirectory(dir, false)).toThrow(/group\/world writable/)
    expect(() => secureStateDirectory(dir, false)).toThrow(new RegExp(`chmod 700 ${dir}`))
    expect(modeOf(dir)).toBe(0o775)   // untouched: the caller decides, we do not paper over it
  })

  it('refuses a world-writable directory too', () => {
    expect(() => secureStateDirectory(scratch(0o707), false)).toThrow(/group\/world writable/)
  })

  it('leaves an already-private directory alone', () => {
    const dir = scratch(0o700)
    secureStateDirectory(dir, false)
    expect(modeOf(dir)).toBe(0o700)
  })

  it('tightens a group/other-readable directory too', () => {
    const dir = scratch(0o755)
    secureStateDirectory(dir, false)
    expect(modeOf(dir)).toBe(0o700)
  })
})

describe.skipIf(WINDOWS)('readPrivateStateFile', () => {
  function file(mode: number): string {
    const root = mkdtempSync(join(tmpdir(), 'secure-state-'))
    dirs.push(root)
    const path = join(root, 'token')
    writeFileSync(path, 'secret')
    chmodSync(path, mode)
    return path
  }

  // Same rule as the directory: refuse, never chmod-then-trust. Every writer under ADAPTER_DATA_DIR
  // passes mode 0o600, so Ubuntu's umask 0002 cannot produce a 0664 state file in the first place.
  it('refuses a group-writable state file rather than tightening it', () => {
    const path = file(0o664)
    expect(() => readPrivateStateFile(path)).toThrow(/group\/world writable/)
    expect(statSync(path).mode & 0o777).toBe(0o664)
  })

  it('reads a private state file', () => {
    expect(readPrivateStateFile(file(0o600))).toBe('secret')
  })
})

describe('state on Windows', () => {
  it('lives in the user profile, or in the data folder the person configured', () => {
    expect(windowsStateRoots({}, 'C:\\Users\\me')).toEqual(['C:\\Users\\me'])
    // Absolute where the spec runs: a relative folder is the home's (config/envFields.ts homePath).
    const elsewhere = join(tmpdir(), 'harness')
    expect(windowsStateRoots({ ADAPTER_DATA_DIR: ` ${elsewhere} ` }, 'C:\\Users\\me')).toEqual(['C:\\Users\\me', elsewhere])
    expect(windowsStateRoots({ ADAPTER_DATA_DIR: '' }, '')).toEqual([])
  })

  it('a relative data folder is the home\'s, as config/env.ts reads it', () => {
    expect(windowsStateRoots({ ADAPTER_DATA_DIR: 'data' }, '/h')).toEqual(['/h', join('/h', 'data')])
  })

  it('is inside a root by path, as Windows compares paths', () => {
    const roots = ['C:\\Users\\me', 'D:\\harness']
    expect(insideWindowsRoots('C:\\Users\\me', roots)).toBe(true)
    expect(insideWindowsRoots('c:\\users\\ME\\.harness\\cli\\data', roots)).toBe(true)
    expect(insideWindowsRoots('D:\\harness\\saved', roots)).toBe(true)
    expect(insideWindowsRoots('C:\\Users\\me2\\data', roots)).toBe(false)
    expect(insideWindowsRoots('C:\\Users', roots)).toBe(false)
    expect(insideWindowsRoots('C:\\ProgramData\\harness', roots)).toBe(false)
    expect(insideWindowsRoots('E:\\Users\\me', roots)).toBe(false)
    expect(insideWindowsRoots('C:\\Users\\me\\..data', roots)).toBe(true)
    expect(insideWindowsRoots('C:\\Users\\me', [])).toBe(false)
  })

  it.runIf(WINDOWS)('takes a folder in the profile (the temp folder is in it) whatever its mode bits say, and its files', () => {
    const root = mkdtempSync(join(tmpdir(), 'secure-state-'))
    dirs.push(root)
    const dir = join(root, 'a', 'b')
    secureStateDirectory(dir)
    secureStateDirectory(dir, false)
    writeFileSync(join(dir, 'token'), 'secret', { mode: 0o600 })
    expect(readPrivateStateFile(join(dir, 'token'))).toBe('secret')
    expect(hardenPrivateStateFileIfPresent(join(dir, 'token'))).toBe(true)
    expect(hardenPrivateStateFileIfPresent(join(dir, 'missing'))).toBe(false)
    expect(() => readPrivateStateFile(join(dir, 'token'), 2)).toThrow(/size limit/)
  })

  it.runIf(WINDOWS)('refuses a folder outside the profile, and a file that is not a folder', () => {
    const windows = process.env.SystemRoot ?? 'C:\\Windows'
    expect(() => secureStateDirectory(windows, false)).toThrow(/outside your user profile/)
    expect(() => readPrivateStateFile(join(windows, 'win.ini'))).toThrow(/outside your user profile/)
    const root = mkdtempSync(join(tmpdir(), 'secure-state-'))
    dirs.push(root)
    writeFileSync(join(root, 'file'), '')
    expect(() => secureStateDirectory(join(root, 'file'), false)).toThrow(/unsafe owner or type/)
  })
})

describe('syncStateDirectory', () => {
  // Windows cannot flush a directory handle Node opened (EPERM): every registry save failed after its rename.
  it('makes a rename in a state directory durable, where the platform can', () => {
    const root = mkdtempSync(join(tmpdir(), 'secure-state-'))
    dirs.push(root)
    expect(() => syncStateDirectory(root)).not.toThrow()
  })

  it.skipIf(WINDOWS)('fails as fsync does for a directory that is not there', () => {
    expect(() => syncStateDirectory(join(tmpdir(), 'secure-state-missing-dir'))).toThrow(/ENOENT/)
  })

  it('does nothing on Windows, and says so to a caller that holds the directory open', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
      expect(directorySyncSupported()).toBe(false)
      expect(() => syncStateDirectory(join(tmpdir(), 'secure-state-missing-dir'))).not.toThrow()
      Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
      expect(directorySyncSupported()).toBe(true)
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })
})

// Windows' open has no O_NOFOLLOW: a credential file is checked by itself before it is read (hookAuth.ts, the daemon
// token). The rule needs no Windows API, so it runs here too; on Windows itself there is no folder outside the profile
// to make one in (its temp folder is in it, /tmp is not there) and a link needs a privilege.
describe.skipIf(WINDOWS)('requireWindowsStateFile', () => {
  it('takes a real file inside the state roots, and refuses a link or a file outside them', () => {
    const dir = mkdtempSync('/tmp/secure-file-')
    const outside = mkdtempSync('/tmp/secure-outside-')
    dirs.push(dir, outside)
    const configured = process.env.ADAPTER_DATA_DIR
    process.env.ADAPTER_DATA_DIR = dir
    try {
      const file = join(dir, 'daemon-token')
      writeFileSync(file, 'x')
      expect(() => requireWindowsStateFile(file)).not.toThrow()
      const link = join(dir, 'hook-credential')
      symlinkSync(file, link)
      expect(() => requireWindowsStateFile(link)).toThrow(/link or junction/)
      const far = join(outside, 'daemon-token')
      writeFileSync(far, 'x')
      expect(() => requireWindowsStateFile(far)).toThrow(/outside your user profile/)
      expect(() => requireWindowsStateFile(join(dir, 'missing'))).toThrow(/ENOENT/)
    } finally {
      if (configured === undefined) delete process.env.ADAPTER_DATA_DIR
      else process.env.ADAPTER_DATA_DIR = configured
    }
  })
})

describe('atomicWriteFile', () => {
  function folder(): string {
    const dir = mkdtempSync(join(tmpdir(), 'secure-write-'))
    dirs.push(dir)
    return dir
  }

  function onPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...real, value: platform })
    try { return run() } finally { Object.defineProperty(process, 'platform', real) }
  }

  it('writes the whole file with its mode', () => {
    const dir = folder(), f = join(dir, 'f')
    expect(atomicWriteFile(f, '#!/bin/sh\n', 'cache', { mode: 0o700 })).toBe(true)
    expect(readFileSync(f, 'utf8')).toBe('#!/bin/sh\n')
    expect(readdirSync(dir)).toEqual(['f'])
    const g = join(folder(), 'g')
    expect(atomicWriteFile(g, new TextEncoder().encode('bytes'), 'trust')).toBe(true)
    expect(readFileSync(g, 'utf8')).toBe('bytes')
    if (!WINDOWS) {
      expect(modeOf(f)).toBe(0o700)
      expect(modeOf(g)).toBe(0o600)
    }
  })

  it('atomicWriteJson writes JSON.stringify(value, null, 2)', () => {
    const f = join(folder(), 'f')
    const value = { rows: [1, 'two'], none: null }
    expect(atomicWriteJson(f, value, 'trust')).toBe(true)
    expect(readFileSync(f, 'utf8')).toBe(JSON.stringify(value, null, 2))
  })

  it('a write that fails part way leaves the old file whole and no temporary file', () => {
    const dir = folder(), f = join(dir, 'f')
    writeFileSync(f, 'old')
    fault.write = fd => { writeSync(fd, 'ne'); throw errno('ENOSPC') }
    expect(() => atomicWriteFile(f, 'new', 'trust')).toThrow(/ENOSPC/)
    expect(readFileSync(f, 'utf8')).toBe('old')
    expect(readdirSync(dir)).toEqual(['f'])
  })

  // Windows cannot flush a folder (syncStateDirectory skips it), so a rename there is never left unconfirmed.
  it.skipIf(WINDOWS)('a rename the folder does not confirm is AtomicWriteUnconfirmed', () => {
    const dir = folder(), f = join(dir, 'f')
    writeFileSync(f, 'old')
    fault.sync = fd => { if (fstatSync(fd).isDirectory()) throw errno('EIO') }
    let failure: unknown
    try { atomicWriteFile(f, 'new', 'trust') } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(AtomicWriteUnconfirmed)
    expect((failure as Error).cause).toMatchObject({ code: 'EIO' })
    expect(readFileSync(f, 'utf8')).toBe('new')
    expect(readdirSync(dir)).toEqual(['f'])
  })

  // What a write flushed, in order: a file (the temporary one, or a copy) or the folder.
  function flushes(): string[] {
    const synced: string[] = []
    fault.sync = fd => { synced.push(fstatSync(fd).isDirectory() ? 'folder' : 'file') }
    return synced
  }
  // Windows cannot flush a folder (syncStateDirectory).
  const fileAndFolder = directorySyncSupported() ? ['file', 'folder'] : ['file']

  it('a trust write flushes the file, then its folder', () => {
    const synced = flushes()
    expect(atomicWriteFile(join(folder(), 'f'), 'new', 'trust')).toBe(true)
    expect(synced).toEqual(fileAndFolder)
  })

  // A cache file can be rebuilt, and the rename alone keeps a reader from half of one. Flushed, a full recap save took
  // 90-143 ms instead of 12 (2026-11-19); a power cut that leaves the file empty is the set-aside read (readState).
  it('a cache write is renamed whole and flushes nothing, unless asked to be durable', () => {
    const dir = folder(), f = join(dir, 'f')
    writeFileSync(f, 'old')
    const synced = flushes()
    expect(atomicWriteFile(f, 'new', 'cache')).toBe(true)
    expect(readFileSync(f, 'utf8')).toBe('new')
    expect(readdirSync(dir)).toEqual(['f'])
    expect(synced).toEqual([])
    expect(atomicWriteFile(f, 'newer', 'cache', { durable: true })).toBe(true)
    expect(readFileSync(f, 'utf8')).toBe('newer')
    expect(synced).toEqual(fileAndFolder)
  })

  // Made once and never written again (the computer id the backend binds this computer to): a power cut that lost it
  // would leave no later write to put it back.
  it('exclusive: flushed whatever its kind, a copy too', () => {
    const synced = flushes()
    expect(atomicWriteFile(join(folder(), 'f'), 'id', 'cache', { exclusive: true })).toBe(true)
    expect(synced.splice(0)).toEqual(fileAndFolder)
    fault.link = 'EXDEV'
    expect(atomicWriteFile(join(folder(), 'g'), 'id', 'cache', { exclusive: true })).toBe(true)
    expect(synced).toEqual(['file', ...fileAndFolder])
  })

  it('exclusive: one creator wins and the other reads the winner\'s', () => {
    const dir = folder(), f = join(dir, 'f')
    expect(atomicWriteFile(f, 'first', 'trust', { exclusive: true })).toBe(true)
    expect(atomicWriteFile(f, 'second', 'trust', { exclusive: true })).toBe(false)
    expect(readFileSync(f, 'utf8')).toBe('first')
    expect(readdirSync(dir)).toEqual(['f'])
  })

  it('exclusive: the file is never there half-written', () => {
    const dir = folder(), f = join(dir, 'f')
    let seen: boolean | undefined, second: boolean | undefined
    fault.write = () => {
      seen = existsSync(f)
      second = atomicWriteFile(f, 'second', 'trust', { exclusive: true })
    }
    expect(atomicWriteFile(f, 'first', 'trust', { exclusive: true })).toBe(false)
    expect(seen).toBe(false)
    expect(second).toBe(true)
    expect(readFileSync(f, 'utf8')).toBe('second')
    expect(readdirSync(dir)).toEqual(['f'])
  })

  // EISDIR: Windows' answer on exFAT and FAT, whose ERROR_INVALID_FUNCTION libuv maps to it.
  it.each(['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS', 'EISDIR'])('exclusive: where link is refused (%s) it copies, still exclusive', code => {
    const dir = folder(), f = join(dir, 'f')
    fault.link = code
    expect(atomicWriteFile(f, 'first', 'trust', { exclusive: true })).toBe(true)
    expect(readFileSync(f, 'utf8')).toBe('first')
    if (!WINDOWS) expect(modeOf(f)).toBe(0o600)
    expect(atomicWriteFile(f, 'second', 'trust', { exclusive: true })).toBe(false)
    expect(readFileSync(f, 'utf8')).toBe('first')
    expect(readdirSync(dir)).toEqual(['f'])
  })

  // The temporary file's flush covers a link (the same file under a second name), not a copy (a new file).
  it('exclusive: a copy is flushed before its folder, as a link is', () => {
    const f = join(folder(), 'f')
    const synced: Array<number | 'folder'> = []
    fault.sync = fd => { const stat = fstatSync(fd); synced.push(stat.isDirectory() ? 'folder' : stat.ino) }
    fault.link = 'EXDEV'
    expect(atomicWriteFile(f, 'first', 'trust', { exclusive: true })).toBe(true)
    const flushed = synced.indexOf(statSync(f).ino)
    expect(flushed).toBeGreaterThan(-1)
    if (directorySyncSupported()) expect(synced.indexOf('folder')).toBeGreaterThan(flushed)
  })

  it('exclusive: a copy that cannot be flushed is AtomicWriteUnconfirmed', () => {
    const dir = folder(), f = join(dir, 'f')
    let files = 0
    fault.sync = fd => { if (!fstatSync(fd).isDirectory() && ++files === 2) throw errno('EIO') }   // the temporary's, then the copy's
    fault.link = 'EXDEV'
    let failure: unknown
    try { atomicWriteFile(f, 'first', 'trust', { exclusive: true }) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(AtomicWriteUnconfirmed)
    expect((failure as Error).cause).toMatchObject({ code: 'EIO' })
    expect(readFileSync(f, 'utf8')).toBe('first')
    expect(readdirSync(dir)).toEqual(['f'])
  })

  // Windows: a scanner can hold the temporary file's name for a moment (EBUSY). What is left there nothing reads.
  it('exclusive: a publish that landed is true though its temporary name cannot be removed', () => {
    const f = join(folder(), 'f')
    fault.rm = () => { throw errno('EBUSY') }
    expect(atomicWriteFile(f, 'id', 'cache', { exclusive: true })).toBe(true)
    expect(readFileSync(f, 'utf8')).toBe('id')
  })

  it('a write that fails throws its own error, not its cleanup\'s', () => {
    const dir = folder(), f = join(dir, 'f')
    writeFileSync(f, 'old')
    fault.write = () => { throw errno('ENOSPC') }
    fault.rm = () => { throw errno('EBUSY') }
    expect(() => atomicWriteFile(f, 'new', 'trust')).toThrow(/ENOSPC/)
    expect(readFileSync(f, 'utf8')).toBe('old')
  })

  it.skipIf(WINDOWS)('trust refuses a target another account could write; cache replaces it', () => {
    const f = join(folder(), 'f')
    writeFileSync(f, 'old')
    chmodSync(f, 0o664)
    expect(() => atomicWriteFile(f, 'new', 'trust')).toThrow(/group\/world writable/)
    expect(readFileSync(f, 'utf8')).toBe('old')
    expect(atomicWriteFile(f, 'new', 'cache')).toBe(true)
    expect(readFileSync(f, 'utf8')).toBe('new')
    expect(modeOf(f)).toBe(0o600)
  })

  // Windows refuses a rename over a file another process holds open (a scanner, a reader), for a moment.
  it.each(['EPERM', 'EACCES', 'EBUSY'])('on Windows a rename refused for a moment (%s) is tried again', code => {
    const f = join(folder(), 'f')
    writeFileSync(f, 'old')
    fault.rename = attempt => { if (attempt <= 2) throw errno(code) }
    expect(onPlatform('win32', () => atomicWriteFile(f, 'new', 'cache'))).toBe(true)
    expect(fault.renames).toBe(3)
    expect(pausedFor()).toEqual([RENAME_WAIT_MS, RENAME_WAIT_MS])
    expect(readFileSync(f, 'utf8')).toBe('new')
  })

  it('on Windows it gives up after RENAME_TRIES', () => {
    const dir = folder(), f = join(dir, 'f')
    writeFileSync(f, 'old')
    fault.rename = () => { throw errno('EBUSY') }
    expect(() => onPlatform('win32', () => atomicWriteFile(f, 'new', 'cache'))).toThrow(/EBUSY/)
    expect(fault.renames).toBe(RENAME_TRIES)
    expect(pausedFor()).toEqual(Array(RENAME_TRIES - 1).fill(RENAME_WAIT_MS))
    expect(readFileSync(f, 'utf8')).toBe('old')
    expect(readdirSync(dir)).toEqual(['f'])
  })

  it.each([['linux', 'EPERM'], ['win32', 'ENOENT']] as const)('on %s a rename refused with %s is not retried', (platform, code) => {
    const f = join(folder(), 'f')
    fault.rename = () => { throw errno(code) }
    expect(() => onPlatform(platform, () => atomicWriteFile(f, 'new', 'cache'))).toThrow(code)
    expect(fault.renames).toBe(1)
    expect(pausedFor()).toEqual([])
  })

  it.runIf(WINDOWS)('replaces an existing file for real, and loses an exclusive create for real', () => {
    const dir = folder(), f = join(dir, 'f')
    writeFileSync(f, 'old')
    expect(atomicWriteFile(f, 'new', 'trust')).toBe(true)
    expect(readFileSync(f, 'utf8')).toBe('new')
    expect(atomicWriteFile(f, 'other', 'trust', { exclusive: true })).toBe(false)
    expect(readFileSync(f, 'utf8')).toBe('new')
    expect(readdirSync(dir)).toEqual(['f'])
  })
})

// The form for the paths that were async before (hot paths): the same rules, run with fs/promises and a timer.
describe('atomicWriteFileAsync', () => {
  function folder(): string {
    const dir = mkdtempSync(join(tmpdir(), 'secure-write-async-'))
    dirs.push(dir)
    return dir
  }

  async function onPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...real, value: platform })
    try { return await run() } finally { Object.defineProperty(process, 'platform', real) }
  }

  /** What one write did: its answer, the file's bytes and mode, what it flushed in order, and what is in its folder. */
  async function outcome(write: (file: string) => boolean | Promise<boolean>, before?: string) {
    const dir = folder(), file = join(dir, 'f')
    if (before !== undefined) writeFileSync(file, before)
    const flushed: string[] = []
    fault.sync = fd => { flushed.push(fstatSync(fd).isDirectory() ? 'folder' : 'file') }
    const answer = await write(file)
    fault.sync = undefined
    return { answer, bytes: readFileSync(file, 'utf8'), mode: WINDOWS ? null : modeOf(file), flushed, entries: readdirSync(dir) }
  }

  it.each([
    ['trust', {}], ['cache', {}], ['cache', { durable: true }], ['cache', { mode: 0o700 }], ['cache', { exclusive: true }],
    ['trust', { exclusive: true }],
  ] as const)('writes what the sync form writes: %s %o', async (kind, options) => {
    const sync = await outcome(file => atomicWriteFile(file, 'new', kind, options))
    expect(await outcome(file => atomicWriteFileAsync(file, 'new', kind, options))).toEqual(sync)
    const over = await outcome(file => atomicWriteFile(file, 'new', kind, options), 'old')
    expect(await outcome(file => atomicWriteFileAsync(file, 'new', kind, options), 'old')).toEqual(over)
  })

  it('where link is refused it copies, as the sync form does', async () => {
    fault.link = 'EXDEV'
    const sync = await outcome(file => atomicWriteFile(file, 'id', 'cache', { exclusive: true }))
    expect(sync.flushed).toEqual(['file', 'file', ...(directorySyncSupported() ? ['folder'] : [])])
    expect(await outcome(file => atomicWriteFileAsync(file, 'id', 'cache', { exclusive: true }))).toEqual(sync)
  })

  it('atomicWriteJsonAsync writes JSON.stringify(value, null, 2)', async () => {
    const f = join(folder(), 'f')
    const value = { rows: [1, 'two'], none: null }
    expect(await atomicWriteJsonAsync(f, value, 'cache')).toBe(true)
    expect(readFileSync(f, 'utf8')).toBe(JSON.stringify(value, null, 2))
  })

  it('a write that fails part way leaves the old file whole and no temporary file', async () => {
    const dir = folder(), f = join(dir, 'f')
    writeFileSync(f, 'old')
    fault.write = fd => { writeSync(fd, 'ne'); throw errno('ENOSPC') }
    await expect(atomicWriteFileAsync(f, 'new', 'trust')).rejects.toThrow(/ENOSPC/)
    expect(readFileSync(f, 'utf8')).toBe('old')
    expect(readdirSync(dir)).toEqual(['f'])
  })

  it.skipIf(WINDOWS)('a rename the folder does not confirm is AtomicWriteUnconfirmed', async () => {
    const f = join(folder(), 'f')
    fault.sync = fd => { if (fstatSync(fd).isDirectory()) throw errno('EIO') }
    await expect(atomicWriteFileAsync(f, 'new', 'trust')).rejects.toBeInstanceOf(AtomicWriteUnconfirmed)
    expect(readFileSync(f, 'utf8')).toBe('new')
  })

  it.skipIf(WINDOWS)('trust refuses a target another account could write', async () => {
    const f = join(folder(), 'f')
    writeFileSync(f, 'old')
    chmodSync(f, 0o664)
    await expect(atomicWriteFileAsync(f, 'new', 'trust')).rejects.toThrow(/group\/world writable/)
    expect(readFileSync(f, 'utf8')).toBe('old')
  })

  it('exclusive: the second creator answers false and leaves the first one\'s file', async () => {
    const dir = folder(), f = join(dir, 'f')
    expect(await atomicWriteFileAsync(f, 'first', 'trust', { exclusive: true })).toBe(true)
    expect(await atomicWriteFileAsync(f, 'second', 'trust', { exclusive: true })).toBe(false)
    expect(readFileSync(f, 'utf8')).toBe('first')
    expect(readdirSync(dir)).toEqual(['f'])
  })

  // The event loop goes on while a scanner holds the file: the wait is a timer, never Atomics.wait or a sync call.
  it('on Windows a rename refused for a moment waits by a timer, and blocks nothing', async () => {
    const dir = folder(), f = join(dir, 'f')
    writeFileSync(f, 'old')
    fault.rename = attempt => { if (attempt <= 2) throw errno('EBUSY') }
    // A trust write: its check of the file there (and, on Windows, of where it is) is in the async steps too.
    vi.stubEnv('ADAPTER_DATA_DIR', dir)
    fault.syncCalls = []
    try {
      expect(await onPlatform('win32', () => atomicWriteFileAsync(f, 'new', 'trust'))).toBe(true)
    } finally { vi.unstubAllEnvs() }
    const syncCalls = fault.syncCalls
    fault.syncCalls = undefined
    expect(syncCalls).toEqual([])
    expect(pausedFor()).toEqual([])
    expect(fault.renames).toBe(3)
    expect(fault.timers).toEqual([RENAME_WAIT_MS, RENAME_WAIT_MS])
    expect(readFileSync(f, 'utf8')).toBe('new')
  })

  it('on Windows it gives up after RENAME_TRIES', async () => {
    const dir = folder(), f = join(dir, 'f')
    writeFileSync(f, 'old')
    fault.rename = () => { throw errno('EBUSY') }
    await expect(onPlatform('win32', () => atomicWriteFileAsync(f, 'new', 'cache'))).rejects.toThrow(/EBUSY/)
    expect(fault.renames).toBe(RENAME_TRIES)
    expect(fault.timers).toEqual(Array(RENAME_TRIES - 1).fill(RENAME_WAIT_MS))
    expect(readFileSync(f, 'utf8')).toBe('old')
    expect(readdirSync(dir)).toEqual(['f'])
  })
})

describe('readState', () => {
  let warn: MockInstance<typeof console.warn>
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })

  function stateFile(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'secure-read-'))
    dirs.push(dir)
    return join(dir, name)
  }
  const torn = '[{"identityPub":"'   // what a reader saw mid-write
  const whole = '[{"identityPub":"k"}]'

  it('a missing file is missing', () => {
    const parse = vi.fn(jsonArray)
    expect(readState(stateFile('paired.json'), 'trust', parse)).toEqual({ state: 'missing' })
    expect(readState(stateFile('summaries.json'), 'cache', parse)).toEqual({ state: 'missing' })
    expect(probeState(stateFile('paired.json'), parse)).toEqual({ state: 'missing' })
    expect(parse).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('a file under a path that is not a folder is missing', () => {
    const file = stateFile('data')
    writeFileSync(file, '')
    expect(readState(join(file, 'summaries.json'), 'cache', jsonObject)).toEqual({ state: 'missing' })
    expect(readState(join(file, 'paired.json'), 'trust', jsonArray)).toEqual({ state: 'missing' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('a trust file that cannot be parsed is left, and said once', () => {
    const file = stateFile('paired.json')
    writeFileSync(file, torn)
    expect(readState(file, 'trust', jsonArray)).toEqual({ state: 'unreadable', failure: 'not valid JSON' })
    expect(readFileSync(file, 'utf8')).toBe(torn)
    expect(warn).toHaveBeenCalledExactlyOnceWith('[state] paired.json cannot be read (not valid JSON); left as it is. Move it aside to start over.')
    expect(readState(file, 'trust', jsonArray)).toEqual({ state: 'unreadable', failure: 'not valid JSON' })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('a cache file that cannot be parsed is set aside and read as missing', () => {
    const file = stateFile('summaries.json')
    writeFileSync(file, '{"s1":["a recap')
    expect(readState(file, 'cache', jsonObject)).toEqual({ state: 'missing' })
    expect(readFileSync(`${file}.unreadable`, 'utf8')).toBe('{"s1":["a recap')
    expect(existsSync(file)).toBe(false)
    expect(warn).toHaveBeenCalledExactlyOnceWith('[state] summaries.json could not be read (not valid JSON); kept as summaries.json.unreadable, starting empty.')
  })

  it('one copy is kept', () => {
    const file = stateFile('summaries.json')
    writeFileSync(file, '{"first')
    readState(file, 'cache', jsonObject)
    writeFileSync(file, '{"second')
    expect(readState(file, 'cache', jsonObject)).toEqual({ state: 'missing' })
    expect(readFileSync(`${file}.unreadable`, 'utf8')).toBe('{"second')
    expect(readdirSync(dirname(file))).toEqual(['summaries.json.unreadable'])
  })

  // A person replacing a file on purpose (a sign-in over a torn session) sets aside what a trust read left.
  it('a trust file left as it is can still be set aside', () => {
    const file = stateFile('session.json')
    writeFileSync(file, '{"version":1,"accessTok')
    expect(readState(file, 'trust', jsonObject)).toMatchObject({ state: 'unreadable' })
    expect(readState(file, 'cache', jsonObject)).toEqual({ state: 'missing' })
    expect(readFileSync(`${file}.unreadable`, 'utf8')).toBe('{"version":1,"accessTok')
  })

  it('a file another process is still writing is read again', () => {
    const file = stateFile('paired.json')
    writeFileSync(file, torn)
    pauses.mockImplementation(() => {
      if (pauses.mock.calls.length === 2) writeFileSync(file, whole)   // its writer finishes during the second wait
      return 'timed-out'
    })
    const parse = vi.fn(jsonArray)
    expect(readState(file, 'trust', parse)).toEqual({ state: 'ok', value: [{ identityPub: 'k' }] })
    expect(parse).toHaveBeenCalledTimes(3)
    expect(pausedFor()).toEqual([READ_WAIT_MS, READ_WAIT_MS])
    expect(warn).not.toHaveBeenCalled()
  })

  it('it stops after READ_TRIES, and a probe says and moves nothing', () => {
    const file = stateFile('summaries.json')
    writeFileSync(file, torn)
    const parse = vi.fn(jsonArray)
    expect(probeState(file, parse)).toEqual({ state: 'unreadable', failure: 'not valid JSON' })
    expect(parse).toHaveBeenCalledTimes(READ_TRIES)
    expect(pausedFor()).toEqual(Array(READ_TRIES - 1).fill(READ_WAIT_MS))
    expect(warn).not.toHaveBeenCalled()
    expect(readdirSync(dirname(file))).toEqual(['summaries.json'])
  })

  it('an unchanged unreadable file is not retried', () => {
    const file = stateFile('machinePeers.json')
    writeFileSync(file, torn)
    const parse = vi.fn(jsonArray)
    probeState(file, parse)
    parse.mockClear()
    pauses.mockClear()
    expect(probeState(file, parse)).toEqual({ state: 'unreadable', failure: 'not valid JSON' })
    expect(parse).not.toHaveBeenCalled()
    expect(pausedFor()).toEqual([])
    writeFileSync(file, whole)
    expect(probeState(file, parse)).toEqual({ state: 'ok', value: [{ identityPub: 'k' }] })
  })

  it('the memory holds the last 64 files', () => {
    const files = Array.from({ length: 65 }, (_, index) => stateFile(`${index}.json`))
    for (const file of files) writeFileSync(file, torn)
    const parse = vi.fn(jsonArray)
    for (const file of files) probeState(file, parse)
    parse.mockClear()
    probeState(files[64]!, parse)
    expect(parse).not.toHaveBeenCalled()
    probeState(files[0]!, parse)
    expect(parse).toHaveBeenCalledTimes(READ_TRIES)
  })

  it('the failure is a fixed word', () => {
    const thrown = stateFile('group.json')
    writeFileSync(thrown, '{}')
    expect(probeState(thrown, () => { throw new Error('x') })).toEqual({ state: 'unreadable', failure: 'unexpected content' })
    const wrongType = stateFile('machinePeers.json')
    writeFileSync(wrongType, '{}')
    expect(probeState(wrongType, jsonArray)).toEqual({ state: 'unreadable', failure: 'unexpected content' })
    const folder = stateFile('group-blocked.json')
    mkdirSync(folder)
    expect(probeState(folder, jsonArray)).toEqual({ state: 'unreadable', failure: 'EISDIR', readFailed: true })
  })

  it('no line holds the folder or the file\'s text', () => {
    const trust = stateFile('paired.json')
    const cache = stateFile('summaries.json')
    writeFileSync(trust, torn)
    writeFileSync(cache, torn)
    let failure: unknown
    try { requireState(trust, jsonArray) } catch (error) { failure = error }
    readState(cache, 'cache', jsonArray)
    expect(warn).toHaveBeenCalledTimes(2)
    const said = [...warn.mock.calls.flat().map(String), String(failure)].join('\n')
    for (const secret of [dirname(trust), dirname(cache), 'identityPub']) expect(said).not.toContain(secret)
  })

  it('requireState: the value, null when missing, StateFileUnreadable otherwise', () => {
    const file = stateFile('paired.json')
    expect(requireState(file, jsonArray)).toBeNull()
    writeFileSync(file, whole)
    expect(requireState(file, jsonArray)).toEqual([{ identityPub: 'k' }])
    writeFileSync(file, torn)
    let failure: unknown
    try { requireState(file, jsonArray) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(StateFileUnreadable)
    expect(failure).toMatchObject({
      name: 'StateFileUnreadable', base: 'paired.json', failure: 'not valid JSON',
      message: 'paired.json cannot be read (not valid JSON). Move it aside to start over.',
    })
    expect(readFileSync(file, 'utf8')).toBe(torn)
  })

  it('a file that cannot be set aside is still read as missing, and not tried again', () => {
    const file = stateFile('summaries.json')
    writeFileSync(file, torn)
    mkdirSync(`${file}.unreadable`)
    writeFileSync(join(`${file}.unreadable`, 'older'), 'x')
    expect(readState(file, 'cache', jsonArray)).toEqual({ state: 'missing' })
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^\[state\] summaries\.json could not be set aside \([A-Z]+\)$/))
    expect(readFileSync(file, 'utf8')).toBe(torn)
    expect(readState(file, 'cache', jsonArray)).toEqual({ state: 'missing' })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  // Nothing was read to judge (EMFILE, EIO, Windows' EBUSY or EPERM while a scanner holds the file): a good file stays
  // where it is, and the next read tries again.
  it.each(['EMFILE', 'EBUSY', 'EIO'])('a read that fails (%s) is neither remembered nor set aside', code => {
    const file = stateFile('summaries.json')
    writeFileSync(file, whole)
    fault.read = () => { throw errno(code) }
    const failed = { state: 'unreadable', failure: code, readFailed: true }
    expect(readState(file, 'cache', jsonArray)).toEqual(failed)
    expect(readState(file, 'trust', jsonArray)).toEqual(failed)
    expect(pausedFor()).toEqual(Array(2 * (READ_TRIES - 1)).fill(READ_WAIT_MS))
    fault.read = undefined
    expect(readdirSync(dirname(file))).toEqual(['summaries.json'])
    expect(readFileSync(file, 'utf8')).toBe(whole)
    expect(readState(file, 'cache', jsonArray)).toEqual({ state: 'ok', value: [{ identityPub: 'k' }] })
    expect(readState(file, 'trust', jsonArray)).toEqual({ state: 'ok', value: [{ identityPub: 'k' }] })
  })

  it('a read that fails is said once, and never as a file to move aside', () => {
    const file = stateFile('paired.json')
    writeFileSync(file, whole)
    fault.read = () => { throw errno('EMFILE') }
    readState(file, 'trust', jsonArray)
    readState(file, 'cache', jsonArray)
    let failure: unknown
    try { requireState(file, jsonArray) } catch (error) { failure = error }
    expect(warn).toHaveBeenCalledExactlyOnceWith('[state] paired.json could not be read (EMFILE); left as it is, read again next time.')
    expect(failure).toBeInstanceOf(StateFileUnreadable)
    expect(failure).toMatchObject({ base: 'paired.json', failure: 'EMFILE', message: 'paired.json could not be read (EMFILE), so it was not changed.' })
    fault.read = undefined
    expect(requireState(file, jsonArray)).toEqual([{ identityPub: 'k' }])
  })

  it.skipIf(WINDOWS || process.getuid?.() === 0)('a file this account cannot read is left as it is, and read once it can', () => {
    const file = stateFile('machinePeers.json')
    writeFileSync(file, whole)
    chmodSync(file, 0o000)
    expect(readState(file, 'cache', jsonArray)).toEqual({ state: 'unreadable', failure: 'EACCES', readFailed: true })
    expect(() => requireState(file, jsonArray)).toThrow(StateFileUnreadable)
    expect(readdirSync(dirname(file))).toEqual(['machinePeers.json'])
    chmodSync(file, 0o600)
    expect(readFileSync(file, 'utf8')).toBe(whole)
    expect(readState(file, 'trust', jsonArray)).toEqual({ state: 'ok', value: [{ identityPub: 'k' }] })
  })

  // An older build writing in place: the bytes read were torn, but the file a writer put there since is whole.
  it('a file replaced after its last read is read again, not set aside', () => {
    const file = stateFile('summaries.json')
    writeFileSync(file, torn)
    let reads = 0
    fault.read = () => { if (++reads === READ_TRIES) writeFileSync(file, whole) }
    expect(readState(file, 'cache', jsonArray)).toEqual({ state: 'ok', value: [{ identityPub: 'k' }] })
    expect(readdirSync(dirname(file))).toEqual(['summaries.json'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('requireState of a cache file: set aside and null when it cannot be parsed, thrown when it cannot be read', () => {
    const file = stateFile('pets.json')
    writeFileSync(file, '{"all":')
    expect(requireState(file, jsonObject, 'cache')).toBeNull()
    expect(readFileSync(`${file}.unreadable`, 'utf8')).toBe('{"all":')
    writeFileSync(file, '{"all":null}')
    fault.read = () => { throw errno('EMFILE') }
    expect(() => requireState(file, jsonObject, 'cache')).toThrow(StateFileUnreadable)
    fault.read = undefined
    expect(readFileSync(file, 'utf8')).toBe('{"all":null}')
    expect(requireState(file, jsonObject, 'cache')).toEqual({ all: null })
  })

  it('jsonArray and jsonObject take their own shape only', () => {
    expect(jsonArray('[1]')).toEqual([1])
    expect(jsonObject('{"a":1}')).toEqual({ a: 1 })
    expect(() => jsonArray('{}')).toThrow()
    expect(() => jsonObject('[]')).toThrow()
    expect(() => jsonObject('null')).toThrow()
  })
})
