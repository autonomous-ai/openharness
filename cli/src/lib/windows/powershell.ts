/**
 * A short PowerShell script run from the CLI on Windows: Windows PowerShell 5.1 by its full path (every Windows has
 * it, and a `powershell` earlier on PATH is not ours to run), the script as -EncodedCommand (UTF-16LE, base64) so
 * nothing in it is quoted twice by cmd and PowerShell, and its inputs in environment variables, never in its text.
 */
import { execFile, spawnSync } from 'node:child_process'
import { systemProgram } from './systemProgram.js'

export const POWERSHELL_TIMEOUT_MS = 30_000

export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  return systemProgram('WindowsPowerShell\\v1.0\\powershell.exe', env)
}

export function encodedCommandArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}

/**
 * The lines every script runPowershell runs starts with.
 * - UTF-8 output. Into a pipe Windows PowerShell 5.1 writes the console's OEM code page, which Node would decode as
 *   UTF-8: a PATH entry under a profile named `Jö` or `日` would never match, and one written back would hold U+FFFD.
 * - Stop on the first error, and leave with exit 1 and its message alone on stderr. Without them a failed SetValue is
 *   a printed error and exit 0, which the B5.3 review saw report a PATH as edited when it was not, and the error comes
 *   out serialized as CLIXML.
 * - No progress records: 5.1's "Preparing modules for first use" otherwise reaches stderr as CLIXML.
 */
export const POWERSHELL_PRELUDE = [
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  'trap { [Console]::Error.Write($_.Exception.Message); exit 1 }',
].join('\n')

export function withPrelude(script: string): string {
  return `${POWERSHELL_PRELUDE}\n${script}`
}

/** The modules of Windows PowerShell 5.1 a script here imports ([modulesByPath]). */
export type PowershellModule = 'Appx' | 'CimCmdlets' | 'Microsoft.PowerShell.LocalAccounts' | 'Microsoft.PowerShell.Management'
  | 'Microsoft.PowerShell.Security' | 'Microsoft.PowerShell.Utility' | 'NetTCPIP' | 'ScheduledTasks'

/**
 * The lines a script starts with, before its first command: autoload off, then each of [modules] imported from this
 * PowerShell's own folder. Autoload finds a command by searching every module on PSModulePath: the first one it had to
 * find cost a 5.1 process 22-29 s on windows-11-arm and 0.25-0.8 s on windows-latest (runs 43581413308, 43582091190),
 * and the peer query timed out at 93.7 s against WINDOWS_PEER_MS's 45 s, while ptySignatures.ts, importing by path,
 * took 1.8 s on the same runner. Off, a command of a module not imported is "not recognized", Join-Path and Select-Object
 * among them (powershellModules.spec.ts names one first). A module goes in by its folder, a string (Join-Path is a
 * module's command): PowerShell finds its manifest there or in a version folder, where LocalAccounts keeps it (1.0.0.0).
 * Each import stops the script when it fails: these lines come before a script's own `$ErrorActionPreference = 'Stop'`,
 * and under -File a failed import is only printed.
 */
export function modulesByPath(...modules: PowershellModule[]): string {
  return ["$PSModuleAutoLoadingPreference = 'None'",
    ...modules.map((module) => `Import-Module -Name "$PSHOME\\Modules\\${module}" -ErrorAction Stop`)].join('\n')
}

export interface PowershellResult { status: number | null; stdout: string; stderr: string; error?: Error }
export type PowershellRun = (script: string, inputs?: Record<string, string>) => PowershellResult

export const runPowershell: PowershellRun = (script, inputs = {}) => {
  const result = spawnSync(powershellPath(), encodedCommandArgs(withPrelude(script)), {
    env: { ...process.env, ...inputs }, encoding: 'utf8', timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: result.error } : {}) }
}

/** [runPowershell] without blocking: for the daemon, whose event loop must not wait on a PowerShell. Never rejects; a
 *  script that could not start or ran past [timeoutMs] has a null status. */
export function runPowershellAsync(script: string, inputs: Record<string, string> = {}, timeoutMs = POWERSHELL_TIMEOUT_MS): Promise<PowershellResult> {
  return new Promise((resolve) => {
    execFile(powershellPath(), encodedCommandArgs(withPrelude(script)), {
      env: { ...process.env, ...inputs }, encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
    }, (error, stdout, stderr) => {
      const status = !error ? 0 : typeof error.code === 'number' && !error.killed ? error.code : null
      resolve({ status, stdout: stdout ?? '', stderr: stderr ?? '', ...(error ? { error } : {}) })
    })
  })
}
