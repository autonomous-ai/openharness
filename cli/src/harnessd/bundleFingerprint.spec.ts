import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async real => {
  const fs = await real<typeof import('node:fs')>()
  return { ...fs, constants: { ...fs.constants }, openSync: vi.fn(fs.openSync), readSync: vi.fn(fs.readSync), closeSync: vi.fn(fs.closeSync),
    fstatSync: vi.fn(fs.fstatSync), lstatSync: vi.fn(fs.lstatSync) }
})
const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
let directory: string, file: string
beforeEach(() => {
  vi.resetModules()
  for (const [mock, real] of [[openSync, fs.openSync], [readSync, fs.readSync], [closeSync, fs.closeSync], [fstatSync, fs.fstatSync], [lstatSync, fs.lstatSync]] as const) {
    vi.mocked(mock).mockReset().mockImplementation(real as never)
  }
  directory = mkdtempSync(join(tmpdir(), 'bounded-fingerprint-')); file = join(directory, 'cli.mjs')
  writeFileSync(file, 'selected code')
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks() })

describe('bounded descriptor fingerprints', () => {
  it('rejects oversized files before any read and reports only a fixed reason', async () => {
    const { fingerprint } = await import('./bundleFingerprint.js')
    truncateSync(file, 128 * 1024 * 1024 + 1)
    const refused = vi.fn()
    expect((fingerprint as (path: string, refused: (reason: string) => void) => string | null)(file, refused)).toBeNull()
    expect(readSync).not.toHaveBeenCalled()
    expect(refused).toHaveBeenCalledExactlyOnceWith('bundle_fingerprint_size_refused')
    expect(closeSync).toHaveBeenCalledTimes(1)
  })

  it('refuses nonregular and symlink leaves before opening them', async () => {
    const { fingerprint } = await import('./bundleFingerprint.js')
    expect(fingerprint(directory)).toBeNull()
    // A symlink-shaped leaf without requiring Windows developer-mode privileges.
    vi.mocked(lstatSync).mockReturnValueOnce(Object.assign(fs.lstatSync(file), { isFile: () => false, isSymbolicLink: () => true }) as never)
    expect(fingerprint(file)).toBeNull()
    expect(openSync).not.toHaveBeenCalled()
  })

  it('uses POSIX nonblocking opens, explicit Windows disk opens, and no unsupported-flag fallback', async () => {
    const { bundleReadFlags } = await import('./bundleFingerprint.js')
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    const nonblock = constants.O_NONBLOCK
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      expect(bundleReadFlags()).toBe(constants.O_RDONLY | nonblock)
      Object.defineProperty(process, 'platform', { value: 'win32' })
      expect(bundleReadFlags()).toBe(constants.O_RDONLY)
      Object.defineProperty(process, 'platform', { value: 'linux' })
      Object.defineProperty(constants, 'O_NONBLOCK', { value: undefined, writable: true, configurable: true })
      expect(() => bundleReadFlags()).toThrow('bundle_fingerprint_unavailable')
    } finally {
      Object.defineProperty(process, 'platform', platform)
      Object.defineProperty(constants, 'O_NONBLOCK', { value: nonblock, writable: true, configurable: true })
    }
  })

  it('hashes exactly the declared bytes through one fixed buffer, then checks EOF', async () => {
    const { sha256File } = await import('./bundleFingerprint.js')
    const bytes = Buffer.alloc(3 * 64 * 1024 + 7, 42)
    writeFileSync(file, bytes)
    expect(sha256File(file)).toBe(createHash('sha256').update(bytes).digest('hex'))
    const calls = vi.mocked(readSync).mock.calls as unknown as Array<[number, Buffer, number, number, null]>
    expect(calls.map(call => call[3])).toEqual([65_536, 65_536, 65_536, 7, 1])
    expect(new Set(calls.map(call => call[1])).size).toBe(1)
  })

  it.each(['shrunk', 'grown'])('rejects an in-place file that has %s since descriptor inspection', async change => {
    const { fingerprint } = await import('./bundleFingerprint.js')
    vi.mocked(fstatSync).mockImplementationOnce((fd, options) => {
      const stat = fs.fstatSync(fd, options as never)
      writeFileSync(file, change === 'shrunk' ? '' : 'selected code plus more')
      return stat
    })
    expect(fingerprint(file)).toBeNull()
    expect(closeSync).toHaveBeenCalledTimes(1)
  })

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])('rejects unsafe descriptor size %s without reading', async size => {
    const { fingerprint } = await import('./bundleFingerprint.js')
    vi.mocked(fstatSync).mockImplementationOnce(fd => Object.assign(fs.fstatSync(fd), { size }) as never)
    expect(fingerprint(file)).toBeNull()
    expect(readSync).not.toHaveBeenCalled()
  })

  it('refuses a descriptor that became nonregular after the pre-open check', async () => {
    const { fingerprint } = await import('./bundleFingerprint.js')
    vi.mocked(fstatSync).mockReturnValueOnce(fs.statSync(directory) as never)
    expect(fingerprint(file)).toBeNull()
    expect(readSync).not.toHaveBeenCalled()
  })

  it('never opens another descriptor after close became uncertain, and never retries that fd', async () => {
    const { fingerprint } = await import('./bundleFingerprint.js')
    vi.mocked(closeSync).mockImplementationOnce(fd => { fs.closeSync(fd); throw new Error('uncertain close') })
    const refused = vi.fn()
    const read = fingerprint as (path: string, refused: (reason: string) => void) => string | null
    expect(read(file, refused)).toBeNull()
    expect(read(file, refused)).toBeNull()
    expect(openSync).toHaveBeenCalledTimes(1)
    expect(closeSync).toHaveBeenCalledTimes(1)
    expect(refused.mock.calls).toEqual([['bundle_fingerprint_close_unsettled'], ['bundle_fingerprint_close_unsettled']])
  })

  it('reports restart guidance and starts no child when the master fingerprint close is uncertain', async () => {
    const { runMaster } = await import('./master.js')
    vi.mocked(closeSync).mockImplementationOnce(fd => { fs.closeSync(fd); throw new Error('private close detail') })
    const lines: string[] = [], signals = new Map<string, () => void>()
    const exit = vi.fn(), prepare = vi.fn()
    vi.spyOn(console, 'log').mockImplementation(line => { lines.push(String(line)) })
    const supervisor = runMaster({
      nodePath: process.execPath, execArgv: [], scriptPath: file, pidFile: join(directory, 'pid'),
      env: { HARNESSD_SERVICES: 'none', HOME: directory, USERPROFILE: directory },
      restoreUpdate: () => {}, confirmUpdate: () => {}, execve: null, exit,
      onSignal: (signal, listener) => { signals.set(signal, listener) }, executionArtifacts: { prepare },
    })
    try {
      await vi.waitFor(() => expect(supervisor.status().lastExit).toBe('bundle admission refused'))
      expect(lines.some(line => line.includes('bundle_fingerprint_close_unsettled — restart the supervisor'))).toBe(true)
      expect(lines.join('\n')).not.toContain('private close detail')
      expect(prepare).not.toHaveBeenCalled()
      expect(supervisor.status().corePid).toBeNull()
      expect(openSync).toHaveBeenCalledTimes(1)
    } finally {
      signals.get('SIGTERM')!()
      await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0))
    }
  })
})
