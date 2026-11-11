// The Windows check that the selected `claude` is Claude Code, before its help is asked. The Claude desktop app's own
// Claude.exe answers `--version` with its bare version at once, and `--help` by opening its window and never exiting:
// every launch then held at "permission flags" for good (a customer, 2026-11-10; reproduced on Windows 11, 2026-11-11).
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ version: '', versionCode: 0, calls: [] as string[][], identity: 0 }))
vi.mock('./kit/launchExecutable.js', () => ({
  captureLaunchExecutable: async () => ({ state: 'ready',
    executable: { command: 'C:\\Program Files\\WindowsApps\\Claude_5.1231.2.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe', identity: `claude-${fixture.identity}`, current: () => true },
    // Homes this OS's node:path calls absolute: only the platform check is Windows' here.
    environment: { HOME: '/fixture/home', PATH: '/fixture/bin' },
  }),
  LAUNCH_LOCATION_VARIABLES: ['HOME', 'PATH'],
}))
vi.mock('../lib/windows/launch.js', async (original) => ({ ...await original<object>(), windowsEngineArgv: (_what: string, argv: string[]) => argv }))
vi.mock('./kit/nativeLocations.js', async (original) => ({
  ...await original<object>(),
  nativeHookLocations: () => ({ CLAUDE_HOME: '/fixture/home/.claude', CLAUDE_PROJECTS_DIR: '/fixture/home/.claude/projects', CODEX_HOME: '/fixture/home/.codex' }),
  nativeProcessEnvironment: (environment: object) => environment,
}))
vi.mock('./kit/homeAdoption.js', () => ({ homeIsNetworkOrDevice: () => false, networkHomeSentence: () => '' }))
vi.mock('node:child_process', async (original) => ({
  ...await original<object>(),
  execFile: (_file: string, args: string[], _options: object, done: (error: unknown, stdout: string, stderr: string) => void) => {
    fixture.calls.push(args)
    const help = 'Usage: claude [options]\n  --permission-mode <mode>\n  --dangerously-skip-permissions\n'
    setImmediate(() => args[0] === '--version'
      ? done(fixture.versionCode ? Object.assign(new Error('failed'), { code: fixture.versionCode }) : null, fixture.version, '')
      : done(null, help, ''))
    return { exitCode: 0, signalCode: null, stdin: { end() {}, destroy() {} }, stdout: { destroy() {} }, stderr: { destroy() {} }, kill() {} }
  },
}))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  fixture.identity++; fixture.calls = []; fixture.versionCode = 0
})
afterEach(() => { Object.defineProperty(process, 'platform', platform) })

it('refuses the Claude desktop app\'s program, naming it, and never asks it for help (which opens its window)', async () => {
  fixture.version = '5.1231.2\r\n'
  const { inspectNativeLaunch } = await import('./nativeLaunch.js')
  const result = await inspectNativeLaunch('claude', { permissionMode: 'auto' })
  expect(result).toMatchObject({ ok: false, refusal: 'ENGINE_CANNOT_RUN',
    detail: 'C:\\Program Files\\WindowsApps\\Claude_5.1231.2.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe is not Claude Code: asked its version, it answered "5.1231.2" '
      + '(the Claude desktop app\'s own program answers this way). Install Claude Code (irm https://claude.ai/install.ps1 | iex), or set CLAUDE_PATH to its claude.exe, then start the harness again.' })
  expect(fixture.calls).toEqual([['--version']])
})

it('goes on for Claude Code, whose version names it', async () => {
  fixture.version = '2.1.322 (Claude Code)\n'
  const { inspectNativeLaunch } = await import('./nativeLaunch.js')
  expect(await inspectNativeLaunch('claude', { permissionMode: 'auto' })).toMatchObject({ ok: true })
  expect(fixture.calls[0]).toEqual(['--version'])
  expect(fixture.calls).toContainEqual(['--help'])
})

it('takes no answer, or a failed one, as no evidence: the launch goes on to the help it always asked', async () => {
  fixture.version = ''
  const { inspectNativeLaunch } = await import('./nativeLaunch.js')
  expect(await inspectNativeLaunch('claude', { permissionMode: 'auto' })).toMatchObject({ ok: true })
  fixture.identity++; fixture.calls = []; fixture.version = 'boom'; fixture.versionCode = 1
  expect(await inspectNativeLaunch('claude', { permissionMode: 'auto' })).toMatchObject({ ok: true })
})

it('asks no version of another engine', async () => {
  fixture.version = '5.1231.2'
  const { inspectNativeLaunch } = await import('./nativeLaunch.js')
  await inspectNativeLaunch('codex', { permissionMode: 'auto' })
  expect(fixture.calls).not.toContainEqual(['--version'])
})
