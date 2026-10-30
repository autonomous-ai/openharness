/**
 * A short PowerShell script run from the CLI on Windows: Windows PowerShell 5.1 by its full path (every Windows has
 * it, and a `powershell` earlier on PATH is not ours to run), the script as -EncodedCommand (UTF-16LE, base64) so
 * nothing in it is quoted twice by cmd and PowerShell, and its inputs in environment variables, never in its text.
 */
import { spawnSync } from 'node:child_process'
import { win32 } from 'node:path'

export const POWERSHELL_TIMEOUT_MS = 30_000

export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
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

export interface PowershellResult { status: number | null; stdout: string; stderr: string; error?: Error }
export type PowershellRun = (script: string, inputs?: Record<string, string>) => PowershellResult

export const runPowershell: PowershellRun = (script, inputs = {}) => {
  const result = spawnSync(powershellPath(), encodedCommandArgs(withPrelude(script)), {
    env: { ...process.env, ...inputs }, encoding: 'utf8', timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: result.error } : {}) }
}
