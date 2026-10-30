import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { directorySyncSupported, hardenPrivateStateFileIfPresent, insideWindowsRoots, readPrivateStateFile, requireWindowsStateFile, secureStateDirectory, syncStateDirectory, windowsStateRoots } from './secureState.js'

const WINDOWS = process.platform === 'win32'

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
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
    expect(windowsStateRoots({ ADAPTER_DATA_DIR: ' D:\\harness ' }, 'C:\\Users\\me')).toEqual(['C:\\Users\\me', 'D:\\harness'])
    expect(windowsStateRoots({ ADAPTER_DATA_DIR: '' }, '')).toEqual([])
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
// token). The rule needs no Windows API, so it runs here too.
describe('requireWindowsStateFile', () => {
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
