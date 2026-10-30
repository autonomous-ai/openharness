// The Windows engine search on any OS: Windows-shaped paths over an fs fixture. node:path is win32's and the file
// system is what Node answers on NTFS. A symlink or junction on PATH (nvm-windows, Scoop) is followed by statSync;
// only the NativePaths absence proof, which refuses links, must stay out of this search on Windows.
import * as fs from 'node:fs'
import * as nodePath from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const files = new Set<string>()
const dangling = new Set<string>()
const missing = (path: string, code = 'ENOENT') => Object.assign(new Error(`${code}: ${path}`), { code })
vi.mock('node:path', async (original) => {
  const real = await original<typeof nodePath>()
  return { ...real, ...real.win32, default: real.win32, win32: real.win32, posix: real.posix }
})
vi.mock('node:fs', async (original) => ({
  ...await original<typeof fs>(),
  statSync: vi.fn((path: string) => {
    if (!files.has(String(path).toLowerCase())) throw missing(String(path))
    return { isFile: () => true }
  }),
  // The route as lstat sees it: C:\ and C:\Program Files are folders, the PATH folder C:\Program Files\nodejs is a link
  // (nvm-windows), a dangling leaf is a link, and anything else is absent.
  lstatSync: vi.fn((path: string) => {
    const key = String(path).toLowerCase()
    const link = key === 'c:\\program files\\nodejs' || dangling.has(key)
    if (!link && !['c:\\', 'c:\\program files'].includes(key)) throw missing(String(path))
    return { dev: 1n, ino: 1n, mode: link ? 0o120666n : 0o40666n, uid: 0n, size: 0n, mtimeNs: 1n, ctimeNs: 1n,
      isDirectory: () => !link, isSymbolicLink: () => link }
  }),
  readlinkSync: vi.fn(() => 'D:\\nodejs\\'),
  accessSync: vi.fn(),
  openSync: vi.fn((path: string) => { throw missing(String(path)) }),
}))
vi.mock('../../lib/engineBin.js', () => ({ engineBin: () => 'codex', enginePathOverride: () => '' }))
vi.mock('../../lib/engineInstall.js', () => ({ engineInstallRecipe: () => undefined, engineInstallPaths: () => [] }))
vi.mock('../../lib/engineLaunch.js', () => ({ engineShellArgv: () => [], interactiveEngineShell: () => null }))
vi.mock('../../lib/nodeRuntime.js', () => ({ managedNodePath: () => 'C:\\harness\\node.exe' }))
vi.mock('./nativeVersion.js', () => ({
  nativeVersionProbe: (_rule: unknown, binary: () => string) => ({ command: binary }),
  executableSnapshot: (probe: { command(): string }) => ({ command: probe.command() }),
}))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => { Object.defineProperty(process, 'platform', { ...platform, value: 'win32' }); vi.stubEnv('HOME', 'C:\\Users\\u') })
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.unstubAllEnvs(); files.clear(); dangling.clear(); vi.mocked(fs.lstatSync).mockClear() })

async function capture(path: string) {
  vi.stubEnv('PATH', path)
  return (await import('./launchExecutable.js')).captureLaunchExecutable('codex', '')
}

describe('the Windows engine search', () => {
  it('finds a .cmd through a PATH entry that crosses a link or junction', async () => {
    // statSync follows the link: the folder is reached by its linked name.
    files.add('c:\\program files\\nodejs\\codex.cmd')
    expect(await capture('C:\\Program Files\\nodejs')).toMatchObject({ state: 'ready', executable: { command: 'C:\\Program Files\\nodejs\\codex.cmd' } })
    // Only candidate leaves are lstat'ed, never the linked folder on the way.
    expect(vi.mocked(fs.lstatSync).mock.calls.map(([path]) => String(path))).not.toContain('C:\\Program Files\\nodejs')
  })

  it('moves past a UNC entry and a root-relative entry to the next one', async () => {
    files.add('c:\\tools\\codex.cmd')
    expect(await capture('\\\\server\\share\\bin;\\bin;C:\\tools')).toMatchObject({ state: 'ready', executable: { command: 'C:\\tools\\codex.cmd' } })
  })

  it('holds on a dangling link, as POSIX does, instead of installing over it', async () => {
    dangling.add('c:\\tools\\codex.exe')
    expect(await capture('C:\\tools')).toMatchObject({ state: 'held', detail: expect.stringContaining('aliases') })
  })

  it('holds at a dangling link even with an engine after it, where Windows stops too', async () => {
    // POSIX looks past it as bash and zsh do; Windows' search stops at the link, so a later engine is not what runs.
    dangling.add('c:\\tools\\codex.exe')
    files.add('c:\\later\\codex.cmd')
    expect(await capture('C:\\tools;C:\\later')).toMatchObject({ state: 'held', detail: expect.stringContaining('aliases') })
  })

  it('treats a missing entry as absent and holds on any other error', async () => {
    expect(await capture('C:\\tools')).toMatchObject({ state: 'held' })
    vi.mocked(fs.statSync).mockImplementationOnce((() => { throw missing('x', 'EACCES') }) as never)
    expect(await capture('C:\\tools')).toMatchObject({ state: 'held', detail: expect.stringContaining('access') })
  })
})
