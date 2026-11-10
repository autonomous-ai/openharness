/**
 * Runs a script once elevated on Windows, behind User Account Control's own prompt: guest sharing's installer
 * (lib/windows/guestHelperInstallWin.ts). The script and the files it installs are staged in a folder only the owner,
 * SYSTEM and Administrators can open, and removed after. Everything that touches the system goes through the runner;
 * the specs never run powershell, icacls or whoami.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGuestCommand, type GuestRunner } from '../guestAccounts.js'
import { ps } from './powershellQuote.js'

export type AdminResult =
  | { ok: true; stdout: string }
  /** [status]: the script's own exit status, when it stopped with one. */
  | { ok: false; code: 'CANCELLED' | 'FAILED'; message: string; status?: number }

/** Runs [script] elevated, in a staging folder only [ownerSid] (this process's own account, as `whoami /user` read it:
 *  lib/windows/whoami.ts), SYSTEM and Administrators can open. */
export type RunAdmin = (script: string, ownerSid: string) => Promise<AdminResult>

export interface AdminDeps {
  runner?: GuestRunner
  makeStage?: () => string
  removeStage?: (dir: string) => void
}

/** The script's own reason, its last `harness:` line, or its exit status when it said none. */
function stopped(stderr: string, code: number | null): AdminResult {
  const last = stderr.trim().split(/[\r\n]+/).pop() ?? ''
  return { ok: false, code: 'FAILED', message: last.replace(/^.*harness: /, '') || `The script stopped (exit ${code}).`,
    ...(code !== null ? { status: code } : {}) }
}

/**
 * What runs elevated on Windows (guest sharing's installer), with what it says kept in the staging folder. `Start-Process
 * -Verb RunAs` cannot hand an elevated process's output back, and this is how it reaches the owner's command.
 *
 * run.ps1 runs as a child powershell.exe whose own stdout and stderr are the two files. Run in this process with
 * `1> $out 2> $err`, only PowerShell's streams were kept, and the scripts write through [Console]: every
 * failure read "The script stopped (exit N)" (review, 2026-10-28). The child's handle is read once before waiting, so its exit code is kept.
 */
const ELEVATED_PS1 = [
  '# Runs a Harness script elevated and keeps what it said (cli/src/lib/windows/elevated.ts).',
  "$out = Join-Path $PSScriptRoot 'stdout.txt'",
  "$err = Join-Path $PSScriptRoot 'stderr.txt'",
  "$run = Join-Path $PSScriptRoot 'run.ps1'",
  "$ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
  'try {',
  "  $p = Start-Process -FilePath $ps -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', \"`\"$run`\"\") -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err",
  '  $null = $p.Handle',
  '  $p.WaitForExit()',
  '  exit $p.ExitCode',
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
 */
async function runElevatedOnWindows(runner: GuestRunner, stageDir: string, script: string, ownerSid: string): Promise<AdminResult> {
  // Every principal by SID. The owner's from this process's own token: a bare name could resolve to a same-named
  // domain or local account. SYSTEM's and Administrators' names change with the language of Windows.
  const acl = await runner('icacls', [stageDir, '/inheritance:r', '/grant:r', `*${ownerSid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'],
    { timeoutMs: 30_000 })
  if (acl.code !== 0) {
    return { ok: false, code: 'FAILED', message: `Could not make the staging folder private: ${(acl.stderr || acl.stdout).trim() || `icacls exited ${acl.code}`}` }
  }
  // With a byte order mark: Windows PowerShell 5.1 reads a script without one in the computer's ANSI code page.
  writeFileSync(join(stageDir, 'run.ps1'), `﻿${script}`)
  const elevated = join(stageDir, 'elevated.ps1')
  writeFileSync(elevated, `﻿${ELEVATED_PS1}`)
  // Windows names cannot hold a double quote, which would end the path inside the argument list.
  if (elevated.includes('"')) throw new Error(`not a usable staging folder: ${JSON.stringify(stageDir)}`)
  const outer = [
    'try {',
    `  $p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList ${ps(`-NoProfile -ExecutionPolicy Bypass -File "${elevated}"`)}`,
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

export function windowsAdminRunner(deps: AdminDeps = {}): RunAdmin {
  const runner = deps.runner ?? runGuestCommand
  const makeStage = deps.makeStage ?? (() => mkdtempSync(join(tmpdir(), 'harness-admin-')))
  const removeStage = deps.removeStage ?? ((dir: string) => rmSync(dir, { recursive: true, force: true }))
  return async (script, ownerSid) => {
    const stageDir = makeStage()
    try { return await runElevatedOnWindows(runner, stageDir, script, ownerSid) } finally { removeStage(stageDir) }
  }
}
