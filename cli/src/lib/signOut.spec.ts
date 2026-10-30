import { existsSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { isDesktopApp, removalLine, SIGN_OUT_BUTTON_FLAG, signOutAsked, type Asker } from './signOut.js'

// 10-27: a desktop test ran the real `harness logout` and signed the whole Mac out. Only a person asks.
describe('who asked for the sign-in to go', () => {
  const shell: Asker = { pid: 10, command: '-zsh' }
  const tester: Asker = { pid: 11, command: '/Users/me/flutter/bin/cache/artifacts/engine/darwin-x64/flutter_tester --run-forever' }
  const app: Asker = { pid: 12, command: '/Applications/Harness.app/Contents/MacOS/Harness' }
  const never = (): boolean => false

  // Review of #1866: on Windows the processes above come from PowerShell, which takes a while; a terminal or
  // the button's flag decides without them.
  it('reads the processes above only when a terminal or the flag does not decide', () => {
    const above = vi.fn((): Asker[] => [tester])
    expect(signOutAsked({ interactive: false, flags: [SIGN_OUT_BUTTON_FLAG], ancestors: above, isApp: never })).toBe('sign-out button')
    expect(signOutAsked({ interactive: true, flags: [], ancestors: above, isApp: never })).toBe('terminal')
    expect(above).not.toHaveBeenCalled()

    expect(signOutAsked({ interactive: false, flags: [], ancestors: above, isApp: never })).toBeNull()
    expect(above).toHaveBeenCalledTimes(1)
  })

  it('a terminal is a person', () => {
    expect(signOutAsked({ interactive: true, flags: [], ancestors: () => [shell], isApp: never })).toBe('terminal')
  })

  it("the desktop app's Sign out button says so", () => {
    expect(signOutAsked({ interactive: false, flags: [SIGN_OUT_BUTTON_FLAG], ancestors: () => [], isApp: never })).toBe('sign-out button')
  })

  it('an app from before the flag is known by its process, above the CLI or its launcher', () => {
    const isApp = (asker: Asker): boolean => isDesktopApp(asker, 'darwin')
    expect(signOutAsked({ interactive: false, flags: [], ancestors: () => [app], isApp })).toBe('desktop app')
    expect(signOutAsked({ interactive: false, flags: [], ancestors: () => [{ pid: 13, command: '/bin/sh /Users/me/.local/bin/harness logout' }, app], isApp })).toBe('desktop app')
  })

  it.runIf(process.platform === 'darwin')('by default, the app is known on this platform', () => {
    expect(signOutAsked({ interactive: false, flags: [], ancestors: () => [shell, app] })).toBe('desktop app')
    expect(signOutAsked({ interactive: false, flags: [], ancestors: () => [tester, shell] })).toBeNull()
  })

  it('a test, an agent or a script with no terminal and no flag is not', () => {
    const isApp = (asker: Asker): boolean => isDesktopApp(asker, 'darwin')
    expect(signOutAsked({ interactive: false, flags: ['--json'], ancestors: () => [tester, shell], isApp })).toBeNull()
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

// Final review of #2310: every sign-out (harness logout, reset, a Team account turned off) takes back every Buddy's grant at
// once. The sign-in itself is a stand-in here, so nothing of this machine's is signed out.
describe('signing out and the Buddies\' grants', () => {
  it('removes the account every Buddy\'s grant holds for', async () => {
    vi.resetModules()
    vi.doMock('./authSession.js', async (original) => ({ ...(await original<object>()), clearAuthSession: vi.fn() }))
    const { writeBuddyAccount, buddyAccountFile } = await import('./buddyAccount.js')
    const { removeSignIn } = await import('./signOut.js')
    const { clearAuthSession } = await import('./authSession.js')
    writeBuddyAccount('peer')
    expect(existsSync(buddyAccountFile())).toBe(true)
    removeSignIn('logout', { asked: 'person' } as never, () => [])
    expect(existsSync(buddyAccountFile())).toBe(false)
    expect(clearAuthSession).toHaveBeenCalledOnce()
    vi.doUnmock('./authSession.js')
  })
})
