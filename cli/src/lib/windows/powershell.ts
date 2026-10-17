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
 * [script], printing UTF-8. Into a pipe Windows PowerShell 5.1 writes the console's OEM code page, which Node would
 * decode as UTF-8: a PATH entry under a profile named `Jö` or `日` would never match, and one written back would hold
 * U+FFFD. Every script runPowershell runs starts with this line.
 */
export function withUtf8Output(script: string): string {
  return `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n${script}`
}

export interface PowershellResult { status: number | null; stdout: string; stderr: string; error?: Error }
export type PowershellRun = (script: string, inputs?: Record<string, string>) => PowershellResult

export const runPowershell: PowershellRun = (script, inputs = {}) => {
  const result = spawnSync(powershellPath(), encodedCommandArgs(withUtf8Output(script)), {
    env: { ...process.env, ...inputs }, encoding: 'utf8', timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: result.error } : {}) }
}
