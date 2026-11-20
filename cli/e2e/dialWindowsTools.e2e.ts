/**
 * The tools of the dial's checks on Windows (harness/windowsDaemon.ts and scripts/windows-dial-e2e/desk.mts), on every
 * platform: what they decide with nothing started. What they do on Windows is dialWindows.e2e.ts's and the hand
 * checks' (scripts/windows-dial-e2e/README.md).
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CLI_ROOT } from './harness/daemon.js'
import { besideEnvironment, endedWithin, ownHomes, sealedPath } from './harness/windowsDaemon.js'

const DESK = join(CLI_ROOT, 'scripts', 'windows-dial-e2e', 'desk.mts')
const CONSOLE = join(CLI_ROOT, 'scripts', 'windows-dial-e2e', 'console.ps1')

// The CI shard sets E2E_ARTIFACTS_DIR and every desk inherits it: with it set, a harness that registered vitest's hooks
// as it was imported ended the desk before it read its arguments (2026-11-21). Set here so every machine runs as CI does.
const ARTIFACTS = mkdtempSync(join(tmpdir(), 'desk-artifacts-'))
afterAll(() => rmSync(ARTIFACTS, { recursive: true, force: true }))

/** The desk run with [args]: its exit code and what it said on stderr. */
function desk(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env, E2E_ARTIFACTS_DIR: ARTIFACTS }
    execFile(process.execPath, ['--import', 'tsx', DESK, ...args], { cwd: CLI_ROOT, env, timeout: 60_000 }, (error, _stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stderr }))
  })
}

describe('the Windows dial tools', () => {
  it('a sealed daemon finds programs only in Windows\' own folders, never the account\'s', () => {
    expect(sealedPath('C:\\Windows').split(';')).toEqual([
      'C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\Wbem', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
    ])
  })

  // On the Dell a herdr started with the owner's profile put its Codex hook into the owner's ~/.codex (2026-11-20).
  it('what a desk starts beside its sealed daemon has every home in the desk\'s root, and nothing of the account\'s', () => {
    const owner = join('C:', 'Users', 'Owner')
    const account = {
      USERPROFILE: owner, HOME: owner, APPDATA: join(owner, 'AppData', 'Roaming'), LOCALAPPDATA: join(owner, 'AppData', 'Local'),
      TEMP: join(owner, 'AppData', 'Local', 'Temp'), CODEX_HOME: join(owner, '.codex'), CLAUDE_CONFIG_DIR: join(owner, '.claude'),
      HARNESS_DEVICES_DIR: join(owner, '.harness', 'devices'), XDG_CONFIG_HOME: join(owner, '.config'),
      PATH: 'C:\\Windows\\System32;C:\\run\\herdr', SystemRoot: 'C:\\Windows',
    }
    const root = join('C:', 'run', 'harness-dial-win-x')
    const env = besideEnvironment(root, account)
    for (const name of ['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
      expect(env[name], name).toMatch(new RegExp(`^${root.replace(/[\\.]/g, '\\$&')}[\\\\/]`))
    }
    expect(Object.entries(env).filter(([, value]) => value?.includes(owner))).toEqual([])
    // What a program needs to start, and to find herdr and the stand-in engines.
    expect(env).toMatchObject({ PATH: account.PATH, SystemRoot: 'C:\\Windows' })
  })

  // On the VM a desk on the account dropped the caller's CLAUDE_CONFIG_DIR, and its daemon put the dial's plugin and
  // hooks into the test user's real ~/.claude (2026-11-20).
  it('a desk on the account passes on the engine homes its caller named, and names none it did not', () => {
    const owner = join('C:', 'Users', 'Tester')
    const account = { USERPROFILE: owner, CLAUDE_CONFIG_DIR: join('C:', 'run', 'claude'), CODEX_HOME: join('C:', 'run', 'codex') }
    expect(ownHomes(owner, account)).toMatchObject({ CLAUDE_CONFIG_DIR: account.CLAUDE_CONFIG_DIR, CODEX_HOME: account.CODEX_HOME })
    const unnamed = ownHomes(owner, { USERPROFILE: owner })
    expect(Object.keys(unnamed)).not.toContain('CLAUDE_CONFIG_DIR')
    expect(Object.keys(unnamed)).not.toContain('CODEX_HOME')
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

  it('a program beside a desk names the desk\'s root by its whole path, and the program to run', async () => {
    expect(await desk(['--beside', 'root', '--run', 'C:\\h\\herdr.exe']))
      .toEqual({ code: 2, stderr: expect.stringContaining('--beside takes the whole path of a sealed desk\'s root') })
    expect(await desk(['--beside', 'C:\\run\\root', 'C:\\h\\herdr.exe']))
      .toEqual({ code: 2, stderr: expect.stringContaining('--beside needs --run <program>') })
    expect(await desk(['--beside', 'C:\\run\\root', '--run']))
      .toEqual({ code: 2, stderr: expect.stringContaining('--beside needs --run <program>') })
  })

  it.runIf(process.platform !== 'win32')('the desk takes a program beside it, its arguments as they are, and then stops where it is not Windows', async () => {
    expect(await desk(['--beside', 'C:\\run\\root', '--run', 'C:\\h\\wezterm.exe', 'start', '--', 'C:\\h\\herdr.exe']))
      .toEqual({ code: 1, stderr: 'the desk runs on Windows\n' })
  })

  // On the VM a program's UTF-8 output came back as `Nguyá»…n` (2026-11-20, the VM notes' Final head §7): in the task's
  // headless conhost the wrapper's PowerShell has no console whose code page it can set, so .NET's encoding for a
  // program's output fell back to the ANSI page. Read as text: no PowerShell runs here.
  it('console.ps1\'s wrapper sets the encoding a program\'s output is read in, with no console, before it runs the script', () => {
    const wrapper = /@'\r?\n([\s\S]*?)\r?\n'@/.exec(readFileSync(CONSOLE, 'utf8'))![1]
    const runs = wrapper.indexOf('& $program')
    const cached = wrapper.indexOf("[Console].GetField('_outputEncoding', [Reflection.BindingFlags]'NonPublic,Static').SetValue($null, $utf8)")
    const input = wrapper.indexOf('$OutputEncoding = $utf8')
    expect(wrapper).toMatch(/^\s*\$utf8 = New-Object Text\.UTF8Encoding \$false$/m)
    expect([cached, input].every((at) => at >= 0 && at < runs)).toBe(true)
    // The setter alone throws with no console, unseen: one way, the one that holds.
    expect(wrapper).not.toContain('[Console]::OutputEncoding =')
  })
})
