/**
 * The tools of the dial's checks on Windows (harness/windowsDaemon.ts and scripts/windows-dial-e2e/desk.mts), on every
 * platform: what they decide with nothing started. What they do on Windows is dialWindows.e2e.ts's and the hand
 * checks' (scripts/windows-dial-e2e/README.md).
 */
import { describe, expect, it } from 'vitest'
import { endedWithin, sealedPath } from './harness/windowsDaemon.js'

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
})
