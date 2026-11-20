import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hookCredentialMatches, hookCredentialPath, loadOrCreateHookCredential, readHookCredential } from './hookAuth.js'
import { StateFileUnreadable } from './secureState.js'
import { asWindows } from '../testing/windowsOpen.js'

type FsHook = (name: string, args: unknown[], phase: 'before' | 'after') => void
const fsCalls = vi.hoisted(() => ({ hook: undefined as FsHook | undefined }))

// Windows' open has no O_NOFOLLOW: asWindows says when to open as Windows does (src/testing/windowsOpen.ts). Each call
// that makes, fills or publishes a file passes through fsCalls.hook, before and after, so a spec can look at the
// credential's final path between them, or start a second daemon there.
vi.mock('node:fs', async (importOriginal) => {
  const fs = (await import('../testing/windowsOpen.js')).windowsOpenFs(await importOriginal<typeof import('node:fs')>())
  const names = ['openSync', 'writeFileSync', 'fchmodSync', 'fsyncSync', 'closeSync', 'linkSync', 'copyFileSync', 'renameSync', 'rmSync'] as const
  const watched = Object.fromEntries(names.map((name) => [name, (...args: unknown[]) => {
    fsCalls.hook?.(name, args, 'before')
    const result = (fs[name] as (...callArgs: unknown[]) => unknown)(...args)
    fsCalls.hook?.(name, args, 'after')
    return result
  }]))
  return { ...fs, ...watched, default: { ...fs, ...watched } }
})

const dirs: string[] = []
afterEach(() => {
  fsCalls.hook = undefined
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

describe('hook channel credential', () => {
  it('creates and reuses a high-entropy mode-0600 credential', () => {
    const root = mkdtempSync(join(tmpdir(), 'hook-auth-'))
    dirs.push(root)
    const dir = join(root, 'data')
    mkdirSync(dir, { mode: 0o755 })
    chmodSync(dir, 0o755)
    const first = loadOrCreateHookCredential(dir)
    expect(first).toHaveLength(43)
    expect(loadOrCreateHookCredential(dir)).toBe(first)
    expect(readHookCredential(dir)).toBe(first)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(hookCredentialPath(dir)).mode & 0o777).toBe(0o600)
    expect(hookCredentialMatches(first, first)).toBe(true)
    expect(hookCredentialMatches(first, `${first.slice(0, -1)}x`)).toBe(false)
  })

  it('rejects a credential file with permissive mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-auth-'))
    dirs.push(dir)
    loadOrCreateHookCredential(dir)
    chmodSync(hookCredentialPath(dir), 0o644)
    expect(readHookCredential(dir)).toBeNull()
  })

  it('reuses the credential on Windows, where every file reads as mode 0o666', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-auth-'))
    dirs.push(dir)
    const first = loadOrCreateHookCredential(dir)
    chmodSync(hookCredentialPath(dir), 0o666)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    const configured = process.env.ADAPTER_DATA_DIR
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
      // The Windows state roots are the profile and the configured data folder (secureState.ts).
      process.env.ADAPTER_DATA_DIR = dir
      expect(readHookCredential(dir)).toBe(first)
      expect(loadOrCreateHookCredential(dir)).toBe(first)
    } finally {
      Object.defineProperty(process, 'platform', platform)
      if (configured === undefined) delete process.env.ADAPTER_DATA_DIR
      else process.env.ADAPTER_DATA_DIR = configured
    }
  })

  it('refuses to read or create credentials in a group-writable state directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-auth-'))
    dirs.push(dir)
    chmodSync(dir, 0o770)
    expect(readHookCredential(dir)).toBeNull()
    expect(() => loadOrCreateHookCredential(dir)).toThrow('unsafe owner, mode, or type')
  })

  // In a child, because a read that blocked on the FIFO would block this worker for good. The child's
  // start (node and tsx, compiling hookAuth.ts) is not what is measured: a 1.5 s limit on the whole child
  // timed it out under load (the full unit suite at load 100) while the read itself returned at once. A
  // blocked read never returns, so any answer is the proof; the limit only ends a child that blocked.
  it('on Windows, refuses a credential that is a link, which Windows would open through', () => {
    const dir = mkdtempSync('/tmp/hook-auth-')
    const elsewhere = mkdtempSync('/tmp/hook-elsewhere-')
    dirs.push(dir, elsewhere)
    const planted = join(elsewhere, 'hook-credential')
    writeFileSync(planted, `${'A'.repeat(43)}\n`, { mode: 0o600 })
    symlinkSync(planted, hookCredentialPath(dir))
    asWindows(dir, () => {
      expect(readHookCredential(dir)).toBeNull()
      // Never replaced either: the link is not this daemon's to remove.
      expect(() => loadOrCreateHookCredential(dir)).toThrow(/outside your user profile/)
    })
    expect(lstatSync(hookCredentialPath(dir)).isSymbolicLink()).toBe(true)
  })

  it('two daemons creating the credential at once read one value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-auth-'))
    dirs.push(dir)
    const file = hookCredentialPath(dir)
    let second: string | undefined
    let secondFailed: unknown
    // The second daemon runs the moment the first has made the final path (an open that creates it), or is about to
    // publish its complete file there (a link): whichever the first reaches.
    fsCalls.hook = (name, [path, target], phase) => {
      const made = name === 'openSync' && phase === 'after' && path === file && (Number(target) & constants.O_CREAT) !== 0
      const published = name === 'linkSync' && phase === 'before' && target === file
      if (!made && !published) return
      fsCalls.hook = undefined
      try { second = loadOrCreateHookCredential(dir) } catch (error) { secondFailed = error }
    }

    const first = loadOrCreateHookCredential(dir)

    expect(secondFailed).toBeUndefined()
    expect(second).toHaveLength(43)
    expect(first).toBe(second)
  })

  it('the credential is never there empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-auth-'))
    dirs.push(dir)
    const file = hookCredentialPath(dir)
    const sizes: number[] = []
    fsCalls.hook = () => { if (existsSync(file)) sizes.push(statSync(file).size) }

    loadOrCreateHookCredential(dir)

    expect(sizes.length).toBeGreaterThan(0)
    // 43 characters and the line's end.
    expect(sizes.filter((size) => size < 44)).toEqual([])
  })

  it('a credential that cannot be used is left, and said', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-auth-'))
    dirs.push(dir)
    const file = hookCredentialPath(dir)
    writeFileSync(file, 'x', { mode: 0o600 })

    const failure = (() => { try { loadOrCreateHookCredential(dir) } catch (error) { return error } })()

    expect(failure).toBeInstanceOf(StateFileUnreadable)
    expect((failure as Error).message).toBe('hook-credential cannot be read (unexpected content). Move it aside to start over.')
    expect(readFileSync(file, 'utf8')).toBe('x')
    expect(readdirSync(dir)).toEqual(['hook-credential'])
  })

  it('rejects a credential FIFO without blocking', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-auth-'))
    dirs.push(dir)
    execFileSync('mkfifo', [hookCredentialPath(dir)])
    const script = `import('./src/lib/hookAuth.ts').then(({ readHookCredential }) => process.exit(readHookCredential(${JSON.stringify(dir)}) === null ? 0 : 2))`

    const result = spawnSync(process.execPath, ['--import', 'tsx', '--eval', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 60_000,
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(statSync(hookCredentialPath(dir)).isFIFO()).toBe(true)
  }, 90_000)
})
