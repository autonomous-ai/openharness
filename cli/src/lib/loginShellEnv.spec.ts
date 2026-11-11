import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The account's shell, as the passwd entry gives it: none unless a test names one, never that of whoever runs the tests.
const account = vi.hoisted(() => ({ shell: null as string | null }))
vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(), userInfo: () => ({ shell: account.shell }) }))

import {
  loginShellCaptureLine,
  loginShellEnvironment,
  oneShotParentEnv,
  resetLoginShellEnvironmentCache,
  warmLoginShellEnvironment,
} from './loginShellEnv.js'

const realShell = process.env.SHELL

afterEach(() => {
  if (realShell === undefined) delete process.env.SHELL
  else process.env.SHELL = realShell
  delete process.env.HARNESS_LOGIN_SHELL_PROBE
  account.shell = null
  resetLoginShellEnvironmentCache()
})

describe('loginShellEnvironment', () => {
  /**
   * The property the pi fix rests on: the daemon's own environment always wins, so every variable it
   * already has keeps its value and nothing that works today can change. The shell only fills gaps.
   */
  it('never lets the shell override a variable the daemon already has', async () => {
    process.env.HARNESS_LOGIN_SHELL_PROBE = 'from-daemon'
    resetLoginShellEnvironmentCache()
    await warmLoginShellEnvironment()

    expect(oneShotParentEnv().HARNESS_LOGIN_SHELL_PROBE).toBe('from-daemon')
  })

  it('never spawns a shell on the one-shot path — only an explicit warm-up does', () => {
    resetLoginShellEnvironmentCache()
    // Reading before warming must be free: a ~1s synchronous spawn inside a recap raced a 200ms
    // timeout in devinTrust.spec and would stall a live turn just the same.
    expect(loginShellEnvironment()).toEqual({})
    expect(oneShotParentEnv().PATH).toBe(process.env.PATH)
  })

  it('still carries the daemon environment when no shell can be consulted', async () => {
    delete process.env.SHELL
    resetLoginShellEnvironmentCache()

    expect(await warmLoginShellEnvironment()).toEqual({})
    expect(oneShotParentEnv().PATH).toBe(process.env.PATH)
  })

  it('refuses a relative or bogus SHELL rather than spawning it', async () => {
    process.env.SHELL = 'zsh'                     // not absolute
    resetLoginShellEnvironmentCache()
    expect(await warmLoginShellEnvironment()).toEqual({})
  })

  it.skipIf(process.platform === 'win32')('asks the account\'s shell when the daemon was given no SHELL', async () => {
    // As from `docker exec` or a bare service: bash keeps SHELL to itself and zsh never sets it, so the daemon has
    // none. It then read nothing of the person's profile, and logged that it could not.
    const dir = mkdtempSync(join(tmpdir(), 'account-shell-'))
    try {
      const shell = join(dir, 'fake-shell')
      // Takes `-lic <script>` as a shell does, with one variable only a profile would have exported.
      writeFileSync(shell, '#!/bin/sh\nexport HARNESS_LOGIN_SHELL_PROBE=from-the-profile\nexec /bin/sh -c "$2"\n')
      chmodSync(shell, 0o755)
      account.shell = shell
      delete process.env.SHELL
      resetLoginShellEnvironmentCache()
      expect((await warmLoginShellEnvironment()).HARNESS_LOGIN_SHELL_PROBE).toBe('from-the-profile')
      expect(oneShotParentEnv().HARNESS_LOGIN_SHELL_PROBE).toBe('from-the-profile')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('says nothing about the empty capture on Windows, where there is no login shell', () => {
    expect(loginShellCaptureLine(0, 12, 'win32')).toBeNull()
    expect(loginShellCaptureLine(0, 12, 'darwin')).toContain('could not read a login shell')
    expect(loginShellCaptureLine(3, 12, 'win32')).toContain('read 3 variables')
  })

  it('caches, so a recap never pays for the probe twice', async () => {
    resetLoginShellEnvironmentCache()
    // Two overlapping callers join the same in-flight capture rather than each spawning their own
    // shell, and a call after it settles reuses the cached, already-resolved value.
    const [a, b] = await Promise.all([warmLoginShellEnvironment(), warmLoginShellEnvironment()])
    expect(a).toBe(b)
    expect(await warmLoginShellEnvironment()).toBe(a)
  })

  // Reads ~/.zshrc etc., so it only runs where a real shell exists — the environment this fixes.
  it.skipIf(process.platform === 'win32' || !realShell?.startsWith('/'))(
    'captures variables an interactive login shell exports', async () => {
      resetLoginShellEnvironmentCache()
      const captured = await warmLoginShellEnvironment()

      // A login shell always exports these two; if neither came back, the capture is not working.
      expect(Object.keys(captured).length).toBeGreaterThan(0)
      expect(captured.PATH ?? captured.HOME).toBeDefined()
    },
  )
})
