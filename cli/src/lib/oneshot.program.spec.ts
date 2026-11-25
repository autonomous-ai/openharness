/**
 * The program a one-shot worker starts: off Windows its command as it is; on Windows the engine the daemon's lookup
 * finds, started through windowsProgram, so neither an npm `.cmd` nor a `claude.exe` off PATH fails with ENOENT.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { errorKind } from './log.js'
import { oneShotProgram, runGrokOneShot, runRouterOneShot } from './oneshot.js'
import { spawnTied } from './tied.js'

vi.mock('./tied.js', () => ({
  spawnTied: vi.fn(() => { throw new Error('not started in this spec') }),
}))

const roots: string[] = []
const restore: (() => void)[] = []
afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.mocked(spawnTied).mockClear()
})

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), 'oneshot-program-'))
  roots.push(root)
  return root
}

function file(path: string, text = ''): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

const windows = (PATH: string) => ({ platform: 'win32' as const, environment: { PATH }, home: folder() })

function thrown(run: () => unknown): unknown {
  try { run() } catch (error) { return error }
  throw new Error('it did not throw')
}

describe('oneShotProgram', () => {
  it('off Windows, starts the command as it is', () => {
    expect(oneShotProgram('claude', () => 'claude', ['-p'], { platform: 'linux' })).toEqual({ file: 'claude', args: ['-p'] })
  })

  it('on Windows, starts the claude.exe the lookup finds', () => {
    const dir = folder()
    const exe = file(join(dir, 'claude.exe'))
    expect(oneShotProgram('claude', () => 'claude', ['-p'], windows(dir))).toEqual({ file: exe, args: ['-p'] })
  })

  it('on Windows, starts an npm shim as node on its script', () => {
    const dir = folder()
    const npm = join(dir, 'npm'), nodeDir = join(dir, 'nodejs')
    const script = file(join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'))
    const node = file(join(nodeDir, 'node.exe'))
    file(join(npm, 'codex.cmd'), readFileSync(join(import.meta.dirname, 'windows', 'fixtures', 'npm-codex.cmd'), 'utf8'))
    expect(oneShotProgram('codex', () => 'codex', ['exec', '-'], windows(`${nodeDir};${npm}`)))
      .toEqual({ file: node, args: [script, 'exec', '-'] })
  })

  it('on Windows, none found is ENGINE_NOT_INSTALLED', () => {
    expect(errorKind(thrown(() => oneShotProgram('claude', () => 'claude', [], windows(folder()))))).toBe('ENGINE_NOT_INSTALLED')
  })

  it('on Windows, a batch file that is no npm shim is refused', () => {
    const dir = folder()
    file(join(dir, 'claude.cmd'), '@echo off\r\nstart calc %*\r\n')
    expect(errorKind(thrown(() => oneShotProgram('claude', () => 'claude', [], windows(dir))))).toBe('WindowsProgramRefused')
  })
})

describe('the warm worker on Windows', () => {
  function asWindows(): string {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    restore.push(() => Object.defineProperty(process, 'platform', platform))
    const dir = folder(), home = folder()
    vi.stubEnv('PATH', dir)
    vi.stubEnv('HOME', home)
    vi.stubEnv('LOCALAPPDATA', join(home, 'AppData', 'Local'))
    return dir
  }

  it('spawns the program the lookup found, not claude', async () => {
    const dir = asWindows()
    const exe = file(join(dir, 'claude.exe'))
    await expect(runRouterOneShot('claude', { prompt: 'p', cwd: dir })).rejects.toThrow()
    expect(vi.mocked(spawnTied).mock.calls[0]?.[0]).toBe(exe)
  })

  it('spawns the grok.exe the lookup found, not grok', async () => {
    const dir = asWindows()
    const exe = file(join(dir, 'grok.exe'))
    await expect(runGrokOneShot({ prompt: 'p', cwd: dir })).rejects.toThrow()
    expect(vi.mocked(spawnTied).mock.calls[0]?.[0]).toBe(exe)
  })
})
