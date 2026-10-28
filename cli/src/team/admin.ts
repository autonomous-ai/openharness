/**
 * Runs a privileged team script once as root, behind the system's own administrator prompt (password or Touch ID),
 * as the guest helper's install does (lib/guestHelperInstall.ts), or with sudo in the terminal the command runs in. The
 * script and the files it installs are staged in a folder private to this account (mkdtemp is 0700), so nobody can swap
 * one in between, and removed after.
 *
 * Why sudo at all: macOS 26 deletes an account only for an app the person allowed to administer the computer, and it
 * cannot ask that for the administrator prompt's process (authtrampoline), so it refuses it. With sudo in a terminal the
 * terminal app is the one asking, and macOS asks the person once: "Terminal would like to administer your computer".
 *
 * On Linux the prompt is polkit's (`pkexec`), as for the guest helper, when a desktop session can show it. Without one
 * (over SSH, or a daemon with no display) it is sudo in a terminal, and a caller with no terminal is told so (`NO_PROMPT`).
 *
 * Everything that touches the system goes through [AdminDeps]; the specs never run osascript, pkexec or sudo.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { runGuestCommand, type GuestRunner } from '../lib/guestAccounts.js'
import { adminAppleScript } from '../lib/guestHelperInstall.js'

export type AdminResult =
  | { ok: true; stdout: string }
  /** [status]: the script's own exit status, when it stopped with one (`do shell script` ends its error with it).
   *  `NO_PROMPT`: no administrator prompt can be shown here, and nothing ran. */
  | { ok: false; code: 'CANCELLED' | 'FAILED' | 'NO_PROMPT'; message: string; status?: number }

export interface AdminScript {
  script: string
  /** Files the script installs from the staging folder, by name. */
  files?: Record<string, string>
}

/** How root is asked for: the administrator prompt (a dialog), or sudo in this terminal, which asks for the password there. */
export type AdminVia = 'prompt' | 'sudo'

/** Builds the script once the staging folder exists (the script names it), then runs it as root. */
export type RunAdmin = (build: (stageDir: string) => AdminScript, prompt: string, via?: AdminVia) => Promise<AdminResult>

export interface AdminDeps {
  runner?: GuestRunner
  makeStage?: () => string
  removeStage?: (dir: string) => void
  /** Which system's prompt asks. A Mac's unless told: the owner's CLI passes its own (./deps.ts). */
  platform?: NodeJS.Platform
  /** Linux: whether `pkexec` and a desktop session to show its dialog in are there. */
  graphical?: boolean
  /** Windows: this account's name, the one the staging folder is granted to. */
  owner?: () => string
}

/** What a Linux computer with no desktop session answers for the prompt (over SSH, or Desktop's daemon with no display). */
export const NO_PROMPT_MESSAGE = 'No administrator prompt here: run harness team setup in a terminal.'

/**
 * Whether pkexec's answer is the person's "no". 126 is a dismissed dialog. 127 is a refused authorization only when pkexec
 * says so: it is also no authentication agent to ask with (pkexec 124 with no session: "Error creating textual
 * authentication agent", gridtest VM, 2026-10-28) and a command the script could not find. Those are failures; read as a
 * cancel, Desktop's offer would remember a "no" nobody gave, for good (./autoSetup.ts).
 */
function pkexecCancelled(code: number | null, stderr: string): boolean {
  if (code === 126) return true
  return code === 127 && (stderr.includes('Error executing command as another user: Not authorized')
    || stderr.includes('Error executing command as another user: Request dismissed'))
}

/** The script's own reason, its last `harness:` line, or its exit status when it said none. */
function stopped(stderr: string, code: number | null): AdminResult {
  const last = stderr.trim().split(/[\r\n]+/).pop() ?? ''
  return { ok: false, code: 'FAILED', message: last.replace(/^.*harness: /, '') || `The script stopped (exit ${code}).`,
    ...(code !== null ? { status: code } : {}) }
}

/** PowerShell single quotes: nothing is special inside but the quote itself, doubled. */
const psQuote = (word: string): string => `'${word.replaceAll("'", "''")}'`

/**
 * What runs elevated on Windows: the team script, with what it says kept in the staging folder. `Start-Process -Verb
 * RunAs` cannot hand an elevated process's output back, and this is how it reaches the owner's `harness team`.
 */
const ELEVATED_PS1 = [
  '# Runs the Harness Team script elevated and keeps what it said (cli/src/team/admin.ts).',
  // Redirection in Windows PowerShell 5.1 writes UTF-16 unless told otherwise.
  "$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'",
  "$out = Join-Path $PSScriptRoot 'stdout.txt'",
  "$err = Join-Path $PSScriptRoot 'stderr.txt'",
  'try {',
  "  & (Join-Path $PSScriptRoot 'run.ps1') 1> $out 2> $err",
  '  exit $LASTEXITCODE',
  '} catch {',
  '  "harness: $($_.Exception.Message)" | Out-File -Append -Encoding utf8 $err',
  '  exit 1',
  '}',
  '',
].join('\r\n')

/** A file Windows PowerShell wrote: UTF-8, or UTF-16 by its byte order mark, without the mark. */
function decodeText(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
  const text = bytes.toString('utf8')
  return text.startsWith('﻿') ? text.slice(1) : text
}

/** Win32's ERROR_CANCELLED: the person chose No in User Account Control's prompt. */
const UAC_CANCELLED = 1223

/**
 * Windows: User Account Control's prompt (Windows PowerShell's own, signed), for `run.ps1` in a staging folder only the
 * owner, SYSTEM and Administrators can open. Inheritance is removed first, before anything is written in it.
 * docs/superpowers/plans/2026-10-28-harness-team-account-windows.md, Task 3.
 */
async function runElevatedOnWindows(runner: GuestRunner, stageDir: string, build: (stageDir: string) => AdminScript, owner: string): Promise<AdminResult> {
  // SYSTEM and Administrators by SID: their names change with the language of Windows.
  const acl = await runner('icacls', [stageDir, '/inheritance:r', '/grant:r', `${owner}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'],
    { timeoutMs: 30_000 })
  if (acl.code !== 0) {
    return { ok: false, code: 'FAILED', message: `Could not make the staging folder private: ${(acl.stderr || acl.stdout).trim() || `icacls exited ${acl.code}`}` }
  }
  const { script, files = {} } = build(stageDir)
  for (const [name, content] of Object.entries(files)) writeFileSync(join(stageDir, name), content)
  // With a byte order mark: Windows PowerShell 5.1 reads a script without one in the computer's ANSI code page.
  writeFileSync(join(stageDir, 'run.ps1'), `﻿${script}`)
  const elevated = join(stageDir, 'elevated.ps1')
  writeFileSync(elevated, `﻿${ELEVATED_PS1}`)
  // Windows names cannot hold a double quote, which would end the path inside the argument list.
  if (elevated.includes('"')) throw new Error(`not a usable staging folder: ${JSON.stringify(stageDir)}`)
  const outer = [
    'try {',
    `  $p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList ${psQuote(`-NoProfile -ExecutionPolicy Bypass -File "${elevated}"`)}`,
    '  exit $p.ExitCode',
    '} catch {',
    `  if ($_.Exception.NativeErrorCode -eq ${UAC_CANCELLED} -or $_.Exception.InnerException.NativeErrorCode -eq ${UAC_CANCELLED}) { exit ${UAC_CANCELLED} }`,
    '  [Console]::Error.WriteLine("harness: $($_.Exception.Message)")',
    '  exit 1',
    '}',
  ].join('\n')
  // Encoded, so no quoting of the command line between Node and PowerShell can change it.
  const result = await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(outer, 'utf16le').toString('base64')],
    { timeoutMs: 15 * 60_000 })
  if (result.code === UAC_CANCELLED) return { ok: false, code: 'CANCELLED', message: 'The administrator prompt was cancelled.' }
  const said = (name: string) => { try { return decodeText(readFileSync(join(stageDir, name))) } catch { return '' } }
  if (result.code === 0) return { ok: true, stdout: said('stdout.txt') }
  return stopped(said('stderr.txt') || result.stderr, result.code)
}

export function adminRunner(deps: AdminDeps = {}): RunAdmin {
  const runner = deps.runner ?? runGuestCommand
  const makeStage = deps.makeStage ?? (() => mkdtempSync(join(tmpdir(), 'harness-team-')))
  const removeStage = deps.removeStage ?? ((dir: string) => rmSync(dir, { recursive: true, force: true }))
  const platform = deps.platform ?? 'darwin'
  // As the guest helper's install decides it (lib/guestHelperInstall.ts).
  const graphical = () => deps.graphical ?? (existsSync('/usr/bin/pkexec') && !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY))
  return async (build, prompt, via = 'prompt') => {
    const stageDir = makeStage()
    try {
      if (platform === 'win32') return await runElevatedOnWindows(runner, stageDir, build, deps.owner?.() ?? userInfo().username)
      chmodSync(stageDir, 0o700)
      // Nothing is staged for a prompt that cannot be shown: a Desktop offer answers at once, never waits on a dialog.
      if (platform === 'linux' && via === 'prompt' && !graphical()) return { ok: false, code: 'NO_PROMPT', message: NO_PROMPT_MESSAGE }
      const { script, files = {} } = build(stageDir)
      for (const [name, content] of Object.entries(files)) writeFileSync(join(stageDir, name), content, { mode: 0o600 })
      const path = join(stageDir, 'run.sh')
      writeFileSync(path, script, { mode: 0o700 })
      if (platform === 'linux' && via === 'prompt') {
        // polkit's own dialog. pkexec hands back the script's output and exit status.
        const result = await runner('pkexec', ['/bin/sh', path], { timeoutMs: 15 * 60_000 })
        if (result.code === 0) return { ok: true, stdout: result.stdout }
        if (pkexecCancelled(result.code, result.stderr)) return { ok: false, code: 'CANCELLED', message: 'The administrator prompt was cancelled.' }
        return stopped(result.stderr, result.code)
      }
      if (via === 'sudo') {
        // sudo asks on the terminal itself (/dev/tty), so the script's output is still collected here. `-k`: the password
        // every time, as the dialog asks for it, never a few minutes' leftover sudo from something else.
        const ask = `${prompt.replaceAll('%', '%%')}\nPassword for %u: `
        const result = await runner('sudo', ['-k', '-p', ask, '/bin/sh', path], { timeoutMs: 15 * 60_000 })
        if (result.code === 0) return { ok: true, stdout: result.stdout }
        const lines = result.stderr.trim().split(/[\r\n]+/)
        const last = lines.pop() ?? ''
        if (!/^harness: /.test(last) && /incorrect password|password is required|terminal is required|no tty present/i.test(result.stderr)) {
          return { ok: false, code: 'CANCELLED', message: 'sudo did not get an administrator password.' }
        }
        return { ok: false, code: 'FAILED', message: last.replace(/^.*harness: /, '') || `The script stopped (exit ${result.code}).`,
          ...(result.code !== null ? { status: result.code } : {}) }
      }
      const result = await runner('osascript', ['-e', adminAppleScript(path, prompt)], { timeoutMs: 15 * 60_000 })
      // -128 is the prompt's Cancel.
      if (result.code !== 0 && /-128|User canceled/i.test(result.stderr)) {
        return { ok: false, code: 'CANCELLED', message: 'The administrator prompt was cancelled.' }
      }
      if (result.code !== 0) {
        // `do shell script` hands the script's stderr back with its lines ended by CR, not LF: split on both, or a reason
        // after an earlier line is never found, and the CR left in it makes a terminal print the line over itself.
        const last = result.stderr.trim().split(/[\r\n]+/).pop() ?? ''
        const status = /\((\d+)\)$/.exec(last)?.[1]
        const said = last.replace(/^.*harness: /, '').replace(/\s*\(\d+\)$/, '')
        return { ok: false, code: 'FAILED', message: said || `The script stopped (exit ${result.code}).`, ...(status ? { status: Number(status) } : {}) }
      }
      return { ok: true, stdout: result.stdout }
    } finally {
      removeStage(stageDir)
    }
  }
}
