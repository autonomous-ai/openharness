import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findTuiBinary, opensClient, platformKey, tuiCommand } from './index.js'
import { localDaemonStatus } from '../lib/daemonEndpoint.js'
vi.mock('../lib/daemonEndpoint.js', () => ({ localDaemonStatus: vi.fn() }))

// No test may start a real binary, daemon or login flow, or make a network request.
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), spawnSync: vi.fn() }))
const ok = { status: 0, signal: null, pid: 0, stdout: '', stderr: '', output: [] }

describe('harness tui launcher', () => {
  let home: string
  let binary: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hn-launcher-test-'))
    binary = join(home, 'hn')
    writeFileSync(binary, '#!/bin/sh\n', { mode: 0o755 })
    vi.stubEnv('HOME', home)
    vi.stubEnv('ADAPTER_DATA_DIR', join(home, '.harness', 'cli', 'data'))
    vi.stubEnv('HARNESS_TUI_BIN', binary)
    vi.stubEnv('PORT', '19418')
    vi.stubEnv('HN_SOCKET_NAME', 'hnr19fix-launcher')
    for (const key of ['TMUX', 'TMUX_PANE', 'HN_SOCKET']) vi.stubEnv(key, undefined)
    vi.mocked(spawnSync).mockReset().mockReturnValue(ok)
    vi.mocked(localDaemonStatus).mockReset().mockResolvedValue(null)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    rmSync(home, { recursive: true, force: true })
  })

  it('names the build for each platform a release publishes', () => {
    expect(platformKey('darwin', 'arm64')).toBe('darwin-arm64')
    expect(platformKey('darwin', 'x64')).toBe('darwin-x64')
    expect(platformKey('linux', 'arm64')).toBe('linux-arm64')
    expect(platformKey('linux', 'x64')).toBe('linux-x64')
    expect(platformKey('win32', 'x64')).toBeNull()
    expect(platformKey('linux', 'ia32')).toBeNull()
  })

  it('prefers HARNESS_TUI_BIN when it exists', () => {
    expect(findTuiBinary()).toBe(binary)
  })

  it('bootstraps the default client, including bundled global flags', () => {
    expect(opensClient([])).toBe(true)
    expect(opensClient(['-L', 'work'])).toBe(true)
    expect(opensClient(['-Lwork', '-f', '/dev/null'])).toBe(true)
    expect(opensClient(['--port', '19519'])).toBe(true)
    expect(opensClient(['-T', 'RGB,extkeys', '-Lwork'])).toBe(true)
    expect(opensClient(['list-panes'])).toBe(false)
    expect(opensClient(['-L', 'work', 'send-keys', '-t', '1', 'ls', 'Enter'])).toBe(false)
    expect(opensClient(['-S', '/tmp/s', 'display', '-p', '#{pane_id}'])).toBe(false)
    expect(opensClient(['--', 'ls'])).toBe(false)
    for (const info of [['--help'], ['-h'], ['-V'], ['--version'], ['--keys'], ['--licenses']]) expect(opensClient(info)).toBe(false)
  })

  it('ignores a HARNESS_TUI_BIN that is not there', () => {
    vi.stubEnv('HARNESS_TUI_BIN', join(home, 'missing'))
    expect(findTuiBinary()).not.toBe(join(home, 'missing'))
  })

  it('starts the local daemon and client without requiring an account or opening login', async () => {
    vi.mocked(localDaemonStatus).mockResolvedValueOnce(null).mockResolvedValue({ machineId: 'guest-computer', signedIn: false })
    const args = ['-L', 'hnr19fix-launcher', '--port', '19418']
    await expect(tuiCommand(args, { port: 19418 })).resolves.toBe(0)
    expect(spawnSync).toHaveBeenCalledTimes(2)
    expect(vi.mocked(spawnSync).mock.calls[0][1]).toContain('start')
    expect(vi.mocked(spawnSync).mock.calls.flatMap((call) => call[1])).not.toContain('login')
    expect(spawnSync).toHaveBeenLastCalledWith(binary, args, expect.objectContaining({
      env: expect.objectContaining({ HOME: home, PORT: '19418', ADAPTER_DATA_DIR: join(home, '.harness', 'cli', 'data') }),
    }))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reuses this user\'s signed-out daemon', async () => {
    vi.mocked(localDaemonStatus).mockResolvedValue({ machineId: 'guest-computer', signedIn: false })
    await expect(tuiCommand([], { port: 19418, identity: () => 'guest-computer' })).resolves.toBe(0)
    expect(spawnSync).toHaveBeenCalledTimes(1)
    expect(vi.mocked(spawnSync).mock.calls[0][0]).toBe(binary)
  })

  it('asks start to reconcile a daemon still serving a previous sign-in', async () => {
    vi.mocked(localDaemonStatus).mockResolvedValueOnce({ machineId: 'old-account' }).mockResolvedValue({ machineId: 'new-account' })
    await expect(tuiCommand([], { port: 19418, identity: () => 'new-account' })).resolves.toBe(0)
    expect(vi.mocked(spawnSync).mock.calls[0][1]).toContain('start')
    expect(spawnSync).toHaveBeenCalledTimes(2)
  })

  it('uses the explicit port for daemon status, daemon start and the native client', async () => {
    vi.mocked(spawnSync).mockReturnValueOnce({ ...ok, status: 1 })
    const args = ['-L', 'hnr19fix-launcher', '--port', '19419']
    await expect(tuiCommand(args, { port: 19418 })).resolves.toBe(0)
    expect(localDaemonStatus).toHaveBeenCalledWith(join(home, '.harness', 'cli', 'data'), 19419)
    expect(fetch).not.toHaveBeenCalled()
    const calls = vi.mocked(spawnSync).mock.calls
    expect(calls[0][1]).toContain('start')
    expect(calls[0][2]?.env?.PORT).toBe('19419')
    expect(calls[1]).toEqual([binary, args, expect.objectContaining({
      env: expect.objectContaining({ PORT: '19419' }),
    })])
  })

  it('opens a local client after the daemon startup deadline', async () => {
    vi.useFakeTimers()
    const launched = tuiCommand(['-L', 'hnr19fix-launcher', '--port', '19418'], { port: 19418 })
    await vi.runAllTimersAsync()
    await expect(launched).resolves.toBe(0)
    expect(vi.mocked(spawnSync).mock.calls[0][1]).toContain('start')
    expect(vi.mocked(spawnSync).mock.calls[1][0]).toBe(binary)
  })

  it('leaves commands and invalid arguments to the native binary without bootstrapping', async () => {
    const identity = vi.fn(() => 'current-user')
    for (const args of [
      ['--port', 'broken'], ['--port', '65536'], ['--port'], ['--unknown'],
      ['-c', 'true'], ['--headless'], ['--local-server'], ['-C'],
      ['list-panes'], ['--', 'ls'], ['-L'],
    ]) {
      await tuiCommand(['-L', 'hnr19fix-launcher', '--port', '19418', ...args], { port: 19418, identity })
    }
    expect(identity).not.toHaveBeenCalled()
    expect(localDaemonStatus).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(vi.mocked(spawnSync).mock.calls.every(([command]) => command === binary)).toBe(true)
  })
})
