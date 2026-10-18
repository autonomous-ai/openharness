import { afterEach, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { clearLaunchEnvironmentCache, launchEnvironment } from './launchExecutable.js'

vi.mock('../../lib/engineLaunch.js', () => ({
  interactiveEngineShell: () => ({ path: '/fixture/login-shell', args: ['-ic'], label: 'fixture shell' }),
  engineShellArgv: (shell: { path: string; args: string[] }, args: string[]) => [shell.path, ...shell.args, ...args],
}))
vi.mock('../../lib/nodeRuntime.js', () => ({ managedNodePath: () => '/fixture/node' }))
vi.mock('node:child_process', () => ({ execFile: vi.fn((_file, _args, _options, done) => {
  queueMicrotask(() => done(null, '__HARNESS_LAUNCH_ENV__' + JSON.stringify({
    HOME: '/fixture/home', PATH: '/fixture/bin', CODEX_HOME: '/fixture/moved-codex',
  })))
  return { stdin: { end: vi.fn() } }
}) }))
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); vi.useRealTimers(); clearLaunchEnvironmentCache() })

it('captures the actual launch shell for an isolated daemon running with NODE_ENV=test', async () => {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('CODEX_HOME', '/fixture/daemon-codex')
  expect(await launchEnvironment()).toEqual({ HOME: '/fixture/home', PATH: '/fixture/bin', CODEX_HOME: '/fixture/moved-codex' })
  expect(execFile).toHaveBeenCalledWith('/fixture/login-shell', expect.any(Array),
    expect.objectContaining({ timeout: 5_000, maxBuffer: 64 * 1024 }), expect.any(Function))
})

it('answers a capture again for a few seconds, and joins one still running, instead of starting another login shell', async () => {
  vi.useFakeTimers()
  const [first, joined] = await Promise.all([launchEnvironment(), launchEnvironment()])
  expect(joined).toEqual(first)
  expect(execFile).toHaveBeenCalledOnce()
  // A caller's copy is its own: changing it never changes what the next caller is told.
  first!.PATH = '/changed'
  expect((await launchEnvironment())!.PATH).toBe('/fixture/bin')
  expect(execFile).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(10_000)
  await launchEnvironment()
  expect(execFile).toHaveBeenCalledTimes(2)
})

it('never answers a failed capture again: the next ask runs the shell', async () => {
  vi.mocked(execFile).mockImplementationOnce(((_file: string, _args: string[], _options: unknown, done: (error: Error | null, output: string) => void) => {
    queueMicrotask(() => done(new Error('rc file failed'), ''))
    return { stdin: { end: vi.fn() } }
  }) as never)
  expect(await launchEnvironment()).toBeNull()
  expect(await launchEnvironment()).toMatchObject({ HOME: '/fixture/home' })
  expect(execFile).toHaveBeenCalledTimes(2)
})
