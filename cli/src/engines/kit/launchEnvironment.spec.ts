import { afterEach, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { launchEnvironment } from './launchExecutable.js'

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
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

it('captures the actual launch shell for an isolated daemon running with NODE_ENV=test', async () => {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('CODEX_HOME', '/fixture/daemon-codex')
  expect(await launchEnvironment()).toEqual({ HOME: '/fixture/home', PATH: '/fixture/bin', CODEX_HOME: '/fixture/moved-codex' })
  expect(execFile).toHaveBeenCalledWith('/fixture/login-shell', expect.any(Array),
    expect.objectContaining({ timeout: 5_000, maxBuffer: 64 * 1024 }), expect.any(Function))
})
