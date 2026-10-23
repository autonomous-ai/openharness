// The daemon's token, on Unix and as Windows reads it (its platform and its open without O_NOFOLLOW). The real
// Windows file is checked in daemonPipe.real.spec.ts.
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asWindows } from '../../testing/windowsOpen.js'
import { daemonTokenPath, ensureDaemonToken, readDaemonToken } from './pipeAuth.js'

// linkSync and unlinkSync go through [hooks], so a spec can run something just before the link (another start
// winning the race) or fail the temp file's removal (a Windows antivirus or indexer holding it).
const hooks = vi.hoisted(() => ({ beforeLink: null as null | (() => void), unlinkError: null as null | NodeJS.ErrnoException }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = (await import('../../testing/windowsOpen.js')).windowsOpenFs(await importOriginal<typeof import('node:fs')>())
  const linkSync: typeof fs.linkSync = (from, to) => {
    const run = hooks.beforeLink
    hooks.beforeLink = null
    run?.()
    return fs.linkSync(from, to)
  }
  const unlinkSync: typeof fs.unlinkSync = (path) => {
    if (hooks.unlinkError) throw hooks.unlinkError
    return fs.unlinkSync(path)
  }
  return { ...fs, linkSync, unlinkSync, default: { ...fs, linkSync, unlinkSync } }
})

const dirs: string[] = []
afterEach(() => {
  hooks.beforeLink = null
  hooks.unlinkError = null
  vi.restoreAllMocks()
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})
const age = (file: string, seconds: number) => { const then = new Date(Date.now() - seconds * 1000); utimesSync(file, then, then) }
const scratch = (prefix = '/tmp/htoken-') => { const dir = mkdtempSync(prefix); dirs.push(dir); return dir }

describe.skipIf(process.platform === 'win32')('the daemon token', () => {
  it('is made once: 32 random bytes, as hex, owner-only, and read back', () => {
    const dir = scratch()
    expect(readDaemonToken(dir)).toBeNull()
    const token = ensureDaemonToken(dir)
    expect(token).toHaveLength(32)
    expect(ensureDaemonToken(dir).equals(token)).toBe(true)
    expect(readDaemonToken(dir)!.equals(token)).toBe(true)
    expect(statSync(daemonTokenPath(dir)).mode & 0o777).toBe(0o600)
    expect(ensureDaemonToken(scratch()).equals(token)).toBe(false)
  })

  it('replaces a token cut short, and refuses one another account could have written', () => {
    const dir = scratch()
    writeFileSync(daemonTokenPath(dir), 'ab12', { mode: 0o600 })
    expect(readDaemonToken(dir)).toBeNull()
    age(daemonTokenPath(dir), 20)
    const token = ensureDaemonToken(dir)
    expect(readDaemonToken(dir)!.equals(token)).toBe(true)
    chmodSync(daemonTokenPath(dir), 0o666)
    expect(readDaemonToken(dir)).toBeNull()
    expect(() => ensureDaemonToken(dir)).toThrow(/daemon token/)
  })

  it('writes only a whole token at the name, and leaves no temp file behind', () => {
    const dir = scratch()
    const token = ensureDaemonToken(dir)
    expect(readFileSync(daemonTokenPath(dir), 'utf8')).toBe(`${token.toString('hex')}\n`)
    expect(readdirSync(dir)).toEqual(['daemon-token'])
  })

  it('starts when the temp file cannot be removed after the link, and that failure never hides an earlier one', () => {
    const busy = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    const dir = scratch()
    hooks.unlinkError = busy
    const token = ensureDaemonToken(dir)
    expect(readDaemonToken(dir)!.equals(token)).toBe(true)
    const other = scratch()
    hooks.beforeLink = () => { throw Object.assign(new Error('EIO: i/o error, link'), { code: 'EIO' }) }
    expect(() => ensureDaemonToken(other)).toThrow(/EIO/)
  })

  it('accepts 64 lowercase hex digits and at most one newline, nothing else', () => {
    const dir = scratch()
    const hex = 'a'.repeat(64)
    for (const [text, ok] of [[hex, true], [`${hex}\n`, true], [`${hex}\r\n`, false], [`${hex}\n\n`, false],
      [` ${hex}\n`, false], [`${'A'.repeat(64)}\n`, false], [`${hex}0\n`, false]] as const) {
      writeFileSync(daemonTokenPath(dir), text, { mode: 0o600 })
      expect(readDaemonToken(dir) !== null, JSON.stringify(text)).toBe(ok)
    }
  })

  it('returns the winner\'s token when another start publishes first', () => {
    const dir = scratch()
    const planted = 'c'.repeat(64)
    hooks.beforeLink = () => writeFileSync(daemonTokenPath(dir), `${planted}\n`, { mode: 0o600 })
    expect(ensureDaemonToken(dir).toString('hex')).toBe(planted)
    expect(readdirSync(dir)).toEqual(['daemon-token'])
  })

  it('two starts at once end with one token', () => {
    const dir = scratch()
    let inner: Buffer | undefined
    hooks.beforeLink = () => { inner = ensureDaemonToken(dir) }
    const outer = ensureDaemonToken(dir)
    expect(inner).toHaveLength(32)
    expect(outer.equals(inner!)).toBe(true)
    expect(readDaemonToken(dir)!.equals(outer)).toBe(true)
  })

  it('does not remove a young empty file, and reads it once it is filled', () => {
    const dir = scratch()
    const file = daemonTokenPath(dir)
    writeFileSync(file, '', { mode: 0o600 })
    const filled = 'd'.repeat(64)
    const wait = vi.spyOn(Atomics, 'wait').mockImplementation(() => {
      writeFileSync(file, `${filled}\n`, { mode: 0o600 })
      return 'ok'
    })
    expect(ensureDaemonToken(dir).toString('hex')).toBe(filled)
    expect(wait).toHaveBeenCalledTimes(1)
  })

  it('gives up on a young short file that is never filled, leaving it', () => {
    const dir = scratch()
    const file = daemonTokenPath(dir)
    writeFileSync(file, '', { mode: 0o600 })
    vi.spyOn(Atomics, 'wait').mockImplementation(() => 'ok')
    const now = Date.now()
    let calls = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now + 600 * calls++)
    expect(() => ensureDaemonToken(dir)).toThrow(/daemon token/)
    expect(statSync(file).size).toBe(0)
  })

  it('replaces a short file once it is stale', () => {
    const dir = scratch()
    const file = daemonTokenPath(dir)
    writeFileSync(file, '', { mode: 0o600 })
    age(file, 11)
    const token = ensureDaemonToken(dir)
    expect(readDaemonToken(dir)!.equals(token)).toBe(true)
  })

  it('on Windows, is read where the profile protects it, never through a link', () => {
    const dir = scratch(), elsewhere = scratch()
    const planted = join(elsewhere, 'daemon-token')
    writeFileSync(planted, `${'1'.repeat(64)}\n`, { mode: 0o600 })
    asWindows(dir, () => {
      expect(ensureDaemonToken(dir)).toHaveLength(32)
    })
    rmSync(daemonTokenPath(dir))
    symlinkSync(planted, daemonTokenPath(dir))
    asWindows(dir, () => {
      expect(readDaemonToken(dir)).toBeNull()
      expect(() => ensureDaemonToken(dir)).toThrow(/daemon token/)
    })
  })
})
