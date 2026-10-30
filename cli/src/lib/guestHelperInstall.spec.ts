import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GUEST_HELPER_PATH, type GuestRunner } from './guestAccounts.js'
import { guestHelperScript, helperScriptVersion } from './guestHelperAssets.js'
import {
  adminAppleScript, buildInstallScript, GUEST_HELPER_PROMPT, GUEST_HELPER_VERSION, GUEST_HOOK_DIR, GUEST_NODE_DIR,
  GUEST_SUDOERS_PATH, guestHelperStatus, installGuestHelper, sudoersFor,
} from './guestHelperInstall.js'

const temps: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'guest-install-')); temps.push(dir); return dir }
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('the sudoers drop-in', () => {
  it('lets the owner, and only the owner, run the helper without a password', () => {
    const drop = sudoersFor('ann')
    expect(drop).toContain(`ann ALL=(root) NOPASSWD: ${GUEST_HELPER_PATH} *`)
    expect(drop).toContain(`Defaults!${GUEST_HELPER_PATH} env_keep += "`)
    expect(drop).not.toContain('{{OWNER}}')
    for (const bad of ['root', 'hg_0123456789ab', 'ann ALL=(ALL) ALL', '', 'a'.repeat(40), '-x']) {
      expect(() => sudoersFor(bad), bad).toThrow()
    }
  })
})

describe('the install script', () => {
  const stageDir = '/tmp/harness-guest-AbC'

  it('checks the drop-in, puts the helper in place before the drop-in that names it, and refuses unsafe parents', () => {
    const script = buildInstallScript({ stageDir, nodeRuntimeDir: null, hookScript: false })
    const at = (text: string) => { const index = script.indexOf(text); expect(index, text).toBeGreaterThanOrEqual(0); return index }
    const check = at(`visudo -cf '${stageDir}'/sudoers`)
    const helper = at(`install -o 0 -g 0 -m 0755 '${stageDir}'/guest-helper '${GUEST_HELPER_PATH}'`)
    const drop = at(`install -o 0 -g 0 -m 0440 '${stageDir}'/sudoers '${GUEST_SUDOERS_PATH}'`)
    expect(check).toBeLessThan(helper)
    expect(helper).toBeLessThan(drop)
    expect(at('for dir in / /usr /usr/local /usr/local/libexec /usr/local/lib /etc /etc/sudoers.d; do owned_by_root "$dir"; done')).toBeLessThan(helper)
    expect(script).toContain('includedir')
    expect(script).not.toContain(GUEST_NODE_DIR)
    expect(script).not.toContain('notify.mjs')
    expect(script.startsWith('#!/bin/sh\n')).toBe(true)
  })

  it('copies the Node runtime and the hook script for guests\' engines when there are some', () => {
    const script = buildInstallScript({ stageDir, nodeRuntimeDir: "/Users/o'neil/.harness/runtime/node-v22", hookScript: true })
    expect(script).toContain(`for part in '/Users/o'\\''neil/.harness/runtime/node-v22/bin' '/Users/o'\\''neil/.harness/runtime/node-v22/lib' `
      + `'/Users/o'\\''neil/.harness/runtime/node-v22/include'; do`)
    expect(script).not.toContain('node-v22/libexec')
    expect(script).toContain(`chmod -R a+rX,go-w '${GUEST_NODE_DIR}.new'`)
    expect(script).toContain(`mv '${GUEST_NODE_DIR}.new' '${GUEST_NODE_DIR}'`)
    expect(script).toContain(`install -o 0 -g 0 -m 0644 '${stageDir}'/notify.mjs '${GUEST_HOOK_DIR}/notify.mjs'`)
    // The drop-in last, still.
    expect(script.trimEnd().split('\n').pop()).toBe(`install -o 0 -g 0 -m 0440 '${stageDir}'/sudoers '${GUEST_SUDOERS_PATH}'`)
  })

  it('copies node and npm for guests, never the daemon\'s own process images', () => {
    const dir = temp()
    const runtime = join(dir, 'node-v22')
    for (const [path, text] of [['bin/node', 'node'], ['lib/node_modules/npm/index.js', 'npm'], ['include/node/v8.h', 'h'], ['libexec/harnessd/harnessd-core', 'big']]) {
      mkdirSync(join(runtime, path, '..'), { recursive: true })
      writeFileSync(join(runtime, path), text)
    }
    const dest = join(dir, 'guest-node')
    const copy = buildInstallScript({ stageDir: dir, nodeRuntimeDir: runtime, hookScript: false }).split('\n')
      .filter((line) => line.startsWith('mkdir -p') && line.includes('.new') || line.startsWith('for part in'))
      .map((line) => line.replaceAll(`'${GUEST_NODE_DIR}.new'`, `'${dest}'`)).join('\n')
    expect(spawnSync('sh', ['-c', copy]).status).toBe(0)
    expect(readdirSync(dest).sort()).toEqual(['bin', 'include', 'lib'])
    expect(readFileSync(join(dest, 'lib/node_modules/npm/index.js'), 'utf8')).toBe('npm')
    // A runtime with no headers still copies the rest.
    rmSync(join(runtime, 'include'), { recursive: true })
    rmSync(dest, { recursive: true })
    expect(spawnSync('sh', ['-c', copy]).status).toBe(0)
    expect(readdirSync(dest).sort()).toEqual(['bin', 'lib'])
  })

  it('parses as a shell script', () => {
    const dir = temp()
    const file = join(dir, 'install.sh')
    writeFileSync(file, buildInstallScript({ stageDir: "/tmp/a dir'with quote", nodeRuntimeDir: '/x/node', hookScript: true }))
    expect(spawnSync('sh', ['-n', file]).status).toBe(0)
  })

  it('quotes the script\'s path and the prompt for AppleScript', () => {
    expect(adminAppleScript('/tmp/a"b\\c/install.sh', 'Say "yes"'))
      .toBe('do shell script "/bin/sh " & quoted form of "/tmp/a\\"b\\\\c/install.sh" with prompt "Say \\"yes\\"" with administrator privileges')
  })
})

describe('installing the helper', () => {
  const ok = { code: 0, stdout: '', stderr: '' }

  it('asks macOS once for an admin, with every file staged privately, and cleans up', async () => {
    const hook = join(temp(), 'notify.mjs')
    writeFileSync(hook, '// hook')
    let staged = ''
    const runner = vi.fn<GuestRunner>(async (command, args) => {
      expect(command).toBe('osascript')
      expect(args[0]).toBe('-e')
      expect(args[1]).toContain('with administrator privileges')
      expect(args[1]).toContain(GUEST_HELPER_PROMPT)
      const script = /quoted form of "([^"]+)"/.exec(args[1])![1]
      staged = join(script, '..')
      expect(statSync(staged).mode & 0o777).toBe(0o700)
      expect(readFileSync(join(staged, 'guest-helper'), 'utf8')).toBe(guestHelperScript())
      expect(readFileSync(join(staged, 'sudoers'), 'utf8')).toContain('ann ALL=(root) NOPASSWD:')
      expect(statSync(join(staged, 'sudoers')).mode & 0o777).toBe(0o600)
      expect(readFileSync(join(staged, 'notify.mjs'), 'utf8')).toBe('// hook')
      expect(readFileSync(script, 'utf8')).toContain('/usr/local/lib/harness/node')
      return ok
    })
    const result = await installGuestHelper({ owner: 'ann', runner, platform: 'darwin', nodeRuntimeDir: '/runtime/node', hookScript: hook })
    expect(result).toEqual({ ok: true })
    expect(runner).toHaveBeenCalledTimes(1)
    expect(existsSync(staged)).toBe(false)
  })

  it('tells a cancelled prompt from a failure, and says what failed', async () => {
    const cancelled = vi.fn<GuestRunner>(async () => ({ code: 1, stdout: '', stderr: '0:200: execution error: User canceled. (-128)' }))
    expect(await installGuestHelper({ owner: 'ann', runner: cancelled, platform: 'darwin', nodeRuntimeDir: null, hookScript: null }))
      .toMatchObject({ ok: false, code: 'CANCELLED' })
    const failed = vi.fn<GuestRunner>(async () => ({ code: 1, stdout: '', stderr: '0:1: execution error: harness: /usr/local is not owned by root (6)' }))
    expect(await installGuestHelper({ owner: 'ann', runner: failed, platform: 'darwin', nodeRuntimeDir: null, hookScript: null }))
      .toEqual({ ok: false, code: 'FAILED', message: '/usr/local is not owned by root (6)' })
    const silent = vi.fn<GuestRunner>(async () => ({ code: 1, stdout: '', stderr: '' }))
    expect(await installGuestHelper({ owner: 'ann', runner: silent, platform: 'darwin', nodeRuntimeDir: null, hookScript: null }))
      .toEqual({ ok: false, code: 'FAILED', message: 'Sharing could not be set up on this computer.' })
  })

  it('finds the script\'s reason after earlier lines, which osascript ends with CR', async () => {
    // As macOS hands `do shell script`'s stderr back (seen in the VM rig, 24 Oct 2026): every line but the last ends in CR.
    const stderr = '0:120: execution error: cp: /usr/local/lib/harness/x: Operation not permitted\r'
      + 'harness: /usr/local is not owned by root (6)\n'
    const failed = vi.fn<GuestRunner>(async () => ({ code: 1, stdout: '', stderr }))
    expect(await installGuestHelper({ owner: 'ann', runner: failed, platform: 'darwin', nodeRuntimeDir: null, hookScript: null }))
      .toEqual({ ok: false, code: 'FAILED', message: '/usr/local is not owned by root (6)' })
  })

  it('uses pkexec on a Linux desktop and sudo in a terminal', async () => {
    const runner = vi.fn<GuestRunner>(async () => ok)
    expect(await installGuestHelper({ owner: 'ann', runner, platform: 'linux', graphical: true, nodeRuntimeDir: null, hookScript: null })).toEqual({ ok: true })
    expect(runner.mock.calls[0][0]).toBe('pkexec')
    expect(runner.mock.calls[0][1][0]).toBe('/bin/sh')
    await installGuestHelper({ owner: 'ann', runner, platform: 'linux', graphical: false, nodeRuntimeDir: null, hookScript: null })
    expect(runner.mock.calls[1][0]).toBe('sudo')
    expect(runner.mock.calls[1][2]).toMatchObject({ interactive: true })
    const dismissed = vi.fn<GuestRunner>(async () => ({ code: 126, stdout: '', stderr: '' }))
    expect(await installGuestHelper({ owner: 'ann', runner: dismissed, platform: 'linux', graphical: true, nodeRuntimeDir: null, hookScript: null }))
      .toMatchObject({ ok: false, code: 'CANCELLED' })
  })

  it('refuses a platform with no sudo, and an owner name it cannot write into the drop-in', async () => {
    const runner = vi.fn<GuestRunner>(async () => ok)
    expect(await installGuestHelper({ owner: 'ann', runner, platform: 'win32' })).toMatchObject({ ok: false, code: 'UNSUPPORTED' })
    expect(await installGuestHelper({ owner: 'root', runner, platform: 'darwin' })).toMatchObject({ ok: false, code: 'FAILED' })
    expect(runner).not.toHaveBeenCalled()
  })
})

describe('the helper\'s status', () => {
  const current = guestHelperScript()

  it('is the version the shipped script names', () => {
    expect(GUEST_HELPER_VERSION).toBe(helperScriptVersion(current))
    expect(GUEST_HELPER_VERSION).toBeGreaterThanOrEqual(1)
    expect(helperScriptVersion('#!/bin/sh\necho hi\n')).toBeNull()
  })

  it('is missing, outdated, not allowed, or ready', async () => {
    const runner = vi.fn<GuestRunner>(async () => ({ code: 0, stdout: '', stderr: '' }))
    expect(await guestHelperStatus({ read: () => null, runner })).toEqual({ state: 'missing', version: null })
    expect(await guestHelperStatus({ read: () => 'HELPER_VERSION=0\n', runner })).toEqual({ state: 'outdated', version: 0 })
    expect(await guestHelperStatus({ read: () => '#!/bin/sh\n', runner })).toEqual({ state: 'outdated', version: null })
    expect(runner).not.toHaveBeenCalled()
    expect(await guestHelperStatus({ read: () => current, runner })).toEqual({ state: 'ready', version: GUEST_HELPER_VERSION })
    expect(runner).toHaveBeenCalledWith('sudo', ['-n', '-l', GUEST_HELPER_PATH], { timeoutMs: 10_000 })
    const asks = vi.fn<GuestRunner>(async () => ({ code: 1, stdout: '', stderr: 'sudo: a password is required' }))
    expect(await guestHelperStatus({ read: () => current, runner: asks, helperPath: '/opt/h' })).toEqual({ state: 'not-authorized', version: GUEST_HELPER_VERSION })
    expect(asks).toHaveBeenCalledWith('sudo', ['-n', '-l', '/opt/h'], { timeoutMs: 10_000 })
  })

  it('reads an installed helper from disk without sudo', async () => {
    const file = join(temp(), 'guest-helper')
    writeFileSync(file, 'HELPER_VERSION=0\n')
    expect(await guestHelperStatus({ helperPath: file, runner: vi.fn<GuestRunner>() })).toEqual({ state: 'outdated', version: 0 })
    expect(await guestHelperStatus({ helperPath: join(temp(), 'none'), runner: vi.fn<GuestRunner>() })).toEqual({ state: 'missing', version: null })
  })
})
