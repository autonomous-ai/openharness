/**
 * Is `command` runnable — an executable at that path, or a name resolvable on PATH?
 *
 * Resolved by reading PATH rather than by spawning: callers use it on the startup path and in error
 * reporting, where launching a process to ask would be both slower and noisier.
 */
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

export function binaryOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveBinaryOnPath(command, env) !== null
}

/** The same lookup, answering WHERE — the first executable PATH entry that has it, or null. */
export function resolveBinaryOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!command) return null
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const candidates = command.includes('/') || command.includes('\\')
    ? [command]
    : (env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, command))
  for (const candidate of candidates) {
    for (const extension of extensions) {
      try { accessSync(candidate + extension, constants.X_OK); return candidate + extension } catch { /* next */ }
    }
  }
  return null
}

const WINDOWS_PROGRAM = /\.(?:exe|cmd|bat|com)$/i
const WINDOWS_LAUNCH_EXTENSIONS = ['.exe', '.cmd', '.bat', '.com']

/**
 * The program a Windows launch names for [command]: its `.exe`, or else its `.cmd`/`.bat` shim, never its `.ps1`.
 * npm installs a global CLI as three shims (`codex`, a sh script; `codex.cmd`; `codex.ps1`), and PowerShell picks the
 * `.ps1`, which Windows 11's default execution policy (Restricted) refuses to load: `codex` typed in a PowerShell pane
 * fails with "running scripts is disabled on this system" (measured 2026-10-15). CreateProcess runs neither the
 * `.ps1` nor the sh script, and appends only `.exe` to a bare name. So a bare name is looked up on PATH, a path keeps
 * its folder, and a `.ps1` is swapped for its sibling program. Off Windows, for a name that already names a program,
 * and when there is none, [command] is returned as it is: the launch then fails as it did.
 */
export function windowsLaunchCommand(command: string, environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32' || !command || WINDOWS_PROGRAM.test(command)) return command
  const stem = command.replace(/\.ps1$/i, '')
  const candidates = stem.includes('/') || stem.includes('\\')
    ? [stem]
    : (environment.PATH ?? environment.Path ?? '').split(';').filter(Boolean).map((dir) => join(dir, stem))
  for (const candidate of candidates) {
    for (const extension of WINDOWS_LAUNCH_EXTENSIONS) {
      try { accessSync(candidate + extension, constants.F_OK); return candidate + extension } catch { /* next */ }
    }
  }
  return command
}
