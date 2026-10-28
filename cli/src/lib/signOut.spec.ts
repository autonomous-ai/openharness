import { describe, expect, it } from 'vitest'
import { isDesktopApp, removalLine, SIGN_OUT_BUTTON_FLAG, signOutAsked, type Asker } from './signOut.js'

// 10-27: a desktop test ran the real `harness logout` and signed the whole Mac out. Only a person asks.
describe('who asked for the sign-in to go', () => {
  const shell: Asker = { pid: 10, command: '-zsh' }
  const tester: Asker = { pid: 11, command: '/Users/me/flutter/bin/cache/artifacts/engine/darwin-x64/flutter_tester --run-forever' }
  const app: Asker = { pid: 12, command: '/Applications/Harness.app/Contents/MacOS/Harness' }
  const never = (): boolean => false

  it('a terminal is a person', () => {
    expect(signOutAsked({ interactive: true, flags: [], ancestors: [shell], isApp: never })).toBe('terminal')
  })

  it("the desktop app's Sign out button says so", () => {
    expect(signOutAsked({ interactive: false, flags: [SIGN_OUT_BUTTON_FLAG], ancestors: [], isApp: never })).toBe('sign-out button')
  })

  it('an app from before the flag is known by its process, above the CLI or its launcher', () => {
    const isApp = (asker: Asker): boolean => isDesktopApp(asker, 'darwin')
    expect(signOutAsked({ interactive: false, flags: [], ancestors: [app], isApp })).toBe('desktop app')
    expect(signOutAsked({ interactive: false, flags: [], ancestors: [{ pid: 13, command: '/bin/sh /Users/me/.local/bin/harness logout' }, app], isApp })).toBe('desktop app')
  })

  it.runIf(process.platform === 'darwin')('by default, the app is known on this platform', () => {
    expect(signOutAsked({ interactive: false, flags: [], ancestors: [shell, app] })).toBe('desktop app')
    expect(signOutAsked({ interactive: false, flags: [], ancestors: [tester, shell] })).toBeNull()
  })

  it('a test, an agent or a script with no terminal and no flag is not', () => {
    const isApp = (asker: Asker): boolean => isDesktopApp(asker, 'darwin')
    expect(signOutAsked({ interactive: false, flags: ['--json'], ancestors: [tester, shell], isApp })).toBeNull()
  })

  it.each([
    ['darwin', '/Applications/Harness.app/Contents/MacOS/Harness', true],
    ['darwin', '/Users/me/build/Harness Dev.app/Contents/MacOS/Harness Dev', true],
    ['darwin', '/Users/me/.local/bin/harness logout', false],
    ['win32', '"C:\\Program Files\\Harness\\harness-desktop.exe"', true],
    ['win32', 'C:\\Users\\me\\.harness\\bin\\harness.exe logout', false],
  ] as const)('on %s, %s is the desktop app: %s', (platform, command, expected) => {
    expect(isDesktopApp({ pid: 99_999_999, command }, platform)).toBe(expected)
  })
})

describe("harness.log's line for a removal", () => {
  it('says why, how a person asked, and every process from the command up', () => {
    const line = removalLine({
      reason: 'logout',
      asked: 'terminal',
      self: { pid: 3, command: 'node cli.js logout' },
      ancestors: [{ pid: 2, command: '-zsh' }, { pid: 1, command: 'tmux' }],
      now: new Date(2026, 9, 27, 6, 45, 20, 22),
    })

    expect(line).toBe('2026-10-27 06:45:20.022 [auth] sign-in removed · reason=logout · asked=terminal · '
      + 'pid=3 (node cli.js logout) · parent=2 (-zsh) · above=1 (tmux)')
  })
})
