import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { AUTH_SESSION_FILE } from './authSession.js'
import { isDesktopApp, REMOVALS_FILE, removalLine, removeSignIn, SIGN_OUT_BUTTON_FLAG, signOutAsked, type Asker } from './signOut.js'

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


// anh Dee's Mac, 2026-11-12: the session went at 04:58, and a flood of "Not signed in" lines filled harness.log to its cap, whose
// trim took this line with it: nobody could tell what had signed the person out. Each removal is kept apart too, never trimmed.
describe('the removals kept apart from harness.log', () => {
  it('keeps each removal\'s line in a file of its own, the last 20 of them', () => {
    const kept = join(env.ADAPTER_DATA_DIR, REMOVALS_FILE)
    rmSync(kept, { force: true })
    const chain = () => [{ pid: 2, command: '-zsh' }]
    removeSignIn('logout', 'terminal', chain)
    const first = readFileSync(kept, 'utf8').trimEnd().split('\n')
    expect(first).toHaveLength(1)
    expect(first[0]).toMatch(/\[auth\] sign-in removed · reason=logout · asked=terminal · pid=\d+ \(.*\) · parent=2 \(-zsh\)$/)
    expect(readFileSync(join(env.ADAPTER_DATA_DIR, 'harness.log'), 'utf8')).toContain(first[0])
    for (let n = 0; n < 25; n++) removeSignIn(`reset-${n}`, 'desktop app', chain)
    const lines = readFileSync(kept, 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(20)
    expect(lines[0]).toContain('reason=reset-5 ')
    expect(lines[19]).toContain('reason=reset-24 ')
  })

  // The review of #4221: a line of any length, a file left world-readable before, and a write cut short each cost the history.
  it('cuts a line to 2 KB, keeps the file to its person alone, and writes it whole or not at all', () => {
    const kept = join(env.ADAPTER_DATA_DIR, REMOVALS_FILE)
    rmSync(kept, { force: true })
    writeFileSync(kept, 'an earlier removal\n')
    chmodSync(kept, 0o644)
    removeSignIn('logout', 'terminal', () => [{ pid: 2, command: 'x'.repeat(10_000) }])
    const lines = readFileSync(kept, 'utf8').trimEnd().split('\n')
    expect(lines[0]).toBe('an earlier removal')
    expect(Buffer.byteLength(lines[1]!)).toBeLessThanOrEqual(2_048)
    // Cut on a character, never inside one: a command of four-byte characters keeps whole ones, and stays within 2 KB.
    removeSignIn('logout', 'terminal', () => [{ pid: 2, command: '\u{1F98A}'.repeat(2_000) }])
    const cut = readFileSync(kept, 'utf8').trimEnd().split('\n').at(-1)!
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(2_048)
    expect(cut).not.toContain('\uFFFD')
    expect(cut.endsWith('…')).toBe(true)
    expect(statSync(kept).mode & 0o777).toBe(0o600)
    // Written beside it and renamed over it: no half-written file, and nothing left beside it.
    expect(readdirSync(env.ADAPTER_DATA_DIR).filter(name => name.startsWith(`${REMOVALS_FILE}.`))).toEqual([])
  })

  // The third review of #4221: the file keeps process command lines with no age limit, so what a command line carried stays.
  it('keeps no secret a command line carried, in the new line or the ones kept before', () => {
    const kept = join(env.ADAPTER_DATA_DIR, REMOVALS_FILE)
    rmSync(kept, { force: true })
    writeFileSync(kept, `an earlier removal · pid=4 (node cli.js --api-key=sk-live1234567890abcdef) · ${'y'.repeat(5_000)}\n`)
    removeSignIn('logout', 'terminal', () => [{ pid: 2, command: 'curl -H "Authorization: Bearer abcdefghijklmnop" --token 0123456789abcdef0123456789abcdef' }])
    const text = readFileSync(kept, 'utf8')
    for (const secret of ['sk-live1234567890abcdef', 'abcdefghijklmnop', '0123456789abcdef0123456789abcdef']) expect(text).not.toContain(secret)
    expect(text).toContain('<redacted>')
    for (const line of text.trimEnd().split('\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(2_048)
  })

  it('still removes the sign-in when the kept file cannot be written', () => {
    const kept = join(env.ADAPTER_DATA_DIR, REMOVALS_FILE)
    rmSync(kept, { recursive: true, force: true })
    // A folder where the file goes: it can be neither read nor written, and the sign-in goes all the same.
    mkdirSync(kept, { recursive: true })
    mkdirSync(join(AUTH_SESSION_FILE, '..'), { recursive: true })
    writeFileSync(AUTH_SESSION_FILE, '{}')
    expect(() => removeSignIn('logout', 'terminal', () => [])).not.toThrow()
    expect(existsSync(AUTH_SESSION_FILE)).toBe(false)
    rmSync(kept, { recursive: true, force: true })
  })
})
