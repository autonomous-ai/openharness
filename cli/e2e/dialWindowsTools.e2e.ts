/**
 * The tools of the dial's checks on Windows (harness/windowsDaemon.ts and scripts/windows-dial-e2e/desk.mts), on every
 * platform: what they decide with nothing started. What they do on Windows is dialWindows.e2e.ts's and the hand
 * checks' (scripts/windows-dial-e2e/README.md).
 */
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLI_ROOT } from './harness/daemon.js'
import { endedWithin, sealedPath } from './harness/windowsDaemon.js'

const DESK = join(CLI_ROOT, 'scripts', 'windows-dial-e2e', 'desk.mts')

/** The desk run with [args]: its exit code and what it said on stderr. */
function desk(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', DESK, ...args], { cwd: CLI_ROOT, timeout: 60_000 }, (error, _stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stderr }))
  })
}

describe('the Windows dial tools', () => {
  it('a sealed daemon finds programs only in Windows\' own folders, never the account\'s', () => {
    expect(sealedPath('C:\\Windows').split(';')).toEqual([
      'C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\Wbem', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
    ])
  })

  it('a close waits a bounded time for a daemon a forced end did not end, and names its pid', async () => {
    await expect(endedWithin(new Promise<void>(() => {}), 50, 4242)).rejects.toThrow('the daemon (pid 4242) did not end in 0.05 s after taskkill')
    await expect(endedWithin(Promise.resolve(), 50, 4242)).resolves.toBeUndefined()
  })

  it('a stand-in desk is sealed unless --own-account names the account, which no other mode takes', async () => {
    expect(await desk(['--sealed'])).toEqual({ code: 2, stderr: expect.stringContaining('--sealed is no argument of the desk') })
    expect(await desk(['--dial-read', 'COM3', '--out', 'read.json', '--serial-bin', 'C:\\h\\harness-serial.exe', '--own-account']))
      .toEqual({ code: 2, stderr: expect.stringContaining('--own-account does not go with this mode') })
  })

  it.runIf(process.platform !== 'win32')('the desk takes --own-account, and then stops where it is not Windows', async () => {
    expect(await desk(['--own-account'])).toEqual({ code: 1, stderr: 'the desk runs on Windows\n' })
  })
})
