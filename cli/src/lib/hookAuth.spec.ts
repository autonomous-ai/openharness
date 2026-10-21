import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hookCredentialMatches, hookCredentialPath, loadOrCreateHookCredential, readHookCredential } from './hookAuth.js'
import { asWindows } from '../testing/windowsOpen.js'

// Windows' open has no O_NOFOLLOW: asWindows says when to open as Windows does (src/testing/windowsOpen.ts).
vi.mock('node:fs', async (importOriginal) =>
  (await import('../testing/windowsOpen.js')).windowsOpenFs(await importOriginal<typeof import('node:fs')>()))

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

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
      expect(() => loadOrCreateHookCredential(dir)).toThrow(/EEXIST/)
    })
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
