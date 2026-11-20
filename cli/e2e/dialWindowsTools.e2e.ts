/**
 * The tools of the dial's checks on Windows (harness/windowsDaemon.ts and scripts/windows-dial-e2e/desk.mts), on every
 * platform: what they decide before anything starts. What they do on Windows is dialWindows.e2e.ts's and the hand
 * checks' (scripts/windows-dial-e2e/README.md).
 */
import { describe, expect, it } from 'vitest'
import { sealedPath } from './harness/windowsDaemon.js'

describe('the Windows dial tools', () => {
  it('a sealed daemon finds programs only in Windows\' own folders, never the account\'s', () => {
    expect(sealedPath('C:\\Windows').split(';')).toEqual([
      'C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\Wbem', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
    ])
  })
})
