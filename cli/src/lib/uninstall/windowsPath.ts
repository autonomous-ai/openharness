/**
 * `harness uninstall` on Windows: Harness's bin folder out of the user's PATH (`HKCU\Environment`), where install.ps1
 * put it (spec section 1, step 4). Never the machine PATH, which Harness never touches.
 *
 * The value is read raw (DoNotExpandEnvironmentNames) and written back as the kind it was: a round trip through
 * .NET's Environment API expands every %VARIABLE% in the person's other entries and stores them as plain strings.
 * Then WM_SETTINGCHANGE, so a terminal opened afterwards no longer has the folder.
 *
 * Every script runs with runPowershell's prelude: the first error ends it with exit 1.
 */
import { win32 } from 'node:path'
import type { PowershellRun } from '../windows/powershell.js'

/** How Windows compares PATH folders: case-insensitively, quotes and trailing separators aside. */
function folderKey(entry: string): string {
  return win32.normalize(entry.trim().replace(/^"(.*)"$/, '$1')).replace(/[\\/]+$/, '').toLowerCase()
}

/** %NAME% read from [env] as Windows does (names are case-insensitive); an unknown name stays as written. */
export function expandWindowsVariables(entry: string, env: NodeJS.ProcessEnv): string {
  const byName = new Map(Object.entries(env).map(([key, value]) => [key.toLowerCase(), value]))
  return entry.replace(/%([^%;]+)%/g, (whole, name: string) => byName.get(name.toLowerCase()) ?? whole)
}

/** [value] without the entries that name [folder], every other entry exactly as written; null when none names it. */
export function withoutPathEntry(value: string, folder: string, env: NodeJS.ProcessEnv): string | null {
  const target = folderKey(folder)
  const parts = value.split(';')
  const kept = parts.filter((part) => part.trim() === '' || folderKey(expandWindowsVariables(part, env)) !== target)
  return kept.length === parts.length ? null : kept.join(';')
}

/**
 * The registry key every script opens: HARNESS_PATH_KEY, unless HARNESS_UNINSTALL_ENV_KEY is set. That one is for
 * tests only, like install.ps1's HARNESS_INSTALL_ENV_KEY: a test that forgets to pass a key of its own still never
 * reaches the person's real Environment key, since the PowerShell it starts inherits the variable. It must name a key
 * under Software\HarnessTest that exists, or the script fails: a value left set outside a test run (or one naming
 * Environment) is an error to see, never a quiet "not on your PATH".
 */
const KEY = String.raw`$guard = $env:HARNESS_UNINSTALL_ENV_KEY
if ($guard) {
  if ($guard -notmatch '^Software\\HarnessTest\\[^\\]') { throw "HARNESS_UNINSTALL_ENV_KEY is for tests, and must name a key under Software\HarnessTest (it is '$guard')" }
  $probe = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($guard)
  if ($null -eq $probe) { throw 'HARNESS_UNINSTALL_ENV_KEY is for tests; its key does not exist' }
  $probe.Close()
  $key = $guard
} else { $key = $env:HARNESS_PATH_KEY }
if (-not $key) { throw 'no registry key was given' }
$name = $env:HARNESS_PATH_NAME`

/**
 * Prints the value's kind, a line break, then the value raw. Plain text and not ConvertTo-Json: no cmdlet to load,
 * and the kind is one word, so the first line break is always the separator.
 */
export const READ_USER_PATH = String.raw`${KEY}
$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($key)
$v = if ($k) { $k.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
$kind = if ($null -ne $v) { $k.GetValueKind($name).ToString() } else { 'None' }
[Console]::Out.Write($kind + [char]10 + $v)`

/**
 * Tells Explorer, and through it every terminal started from now on, that the user's environment changed, as
 * install.ps1's Send-HarnessEnvironmentChange does. Add-Type compiles C#, which Constrained Language Mode forbids:
 * the PATH is already edited by then, so that prints `unannounced` and is a note, not a failure.
 */
export const ANNOUNCE_ENVIRONMENT_CHANGE = String.raw`try {
  if (-not ('HarnessUninstall.Native' -as [type])) {
    Add-Type -Namespace HarnessUninstall -Name Native -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint msg, System.UIntPtr wParam, string lParam, uint flags, uint timeout, out System.UIntPtr result);'
  }
  $r = [System.UIntPtr]::Zero
  [void][HarnessUninstall.Native]::SendMessageTimeout([System.IntPtr]0xffff, 0x001A, [System.UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref]$r)
} catch { [Console]::Out.Write('unannounced') }`

/**
 * Sets the value (HARNESS_PATH_ACTION=set) or deletes it (delete), only while it is still exactly what was read
 * (HARNESS_PATH_EXPECTED, HARNESS_PATH_KIND): otherwise it prints `changed` and writes nothing, so a program that
 * edited the PATH in between keeps its edit. The comparison is ordinal: -cne compares by culture, and on the VM took
 * values differing by a soft hyphen, a combining mark or a NUL for equal. No action, or another word, writes nothing and fails: an input that went
 * missing must never read as "delete". It announces the change only for the real Environment key.
 */
export const WRITE_USER_PATH = String.raw`${KEY}
$action = $env:HARNESS_PATH_ACTION
if ($action -cne 'set' -and $action -cne 'delete') { throw "no PATH action was given ('$action')" }
if ($env:HARNESS_PATH_KIND -cne 'String' -and $env:HARNESS_PATH_KIND -cne 'ExpandString') { throw "Harness does not write a '$($env:HARNESS_PATH_KIND)' value" }
if ($action -ceq 'set' -and [string]::IsNullOrEmpty($env:HARNESS_PATH_VALUE)) { throw 'no PATH value was given to set' }
$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($key, $true)
if ($null -eq $k) { [Console]::Out.Write('changed'); exit 0 }
try {
  $now = $k.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if (($now -isnot [string]) -or (-not [string]::Equals($now, $env:HARNESS_PATH_EXPECTED, [StringComparison]::Ordinal)) -or ($k.GetValueKind($name).ToString() -cne $env:HARNESS_PATH_KIND)) {
    [Console]::Out.Write('changed'); exit 0
  }
  if ($action -ceq 'set') { $k.SetValue($name, $env:HARNESS_PATH_VALUE, [Microsoft.Win32.RegistryValueKind]$env:HARNESS_PATH_KIND) }
  else { $k.DeleteValue($name) }
} finally { $k.Close() }
if ($key -ieq 'Environment') {
${ANNOUNCE_ENVIRONMENT_CHANGE}
}`

export const PATH_UNANNOUNCED_NOTE = 'Could not announce the PATH change; terminals opened before you sign in again may still have it.'

export type PathRemoval =
  | { state: 'removed'; folder: string; note?: string }
  | { state: 'absent'; folder: string }
  | { state: 'failed'; folder: string; detail: string }

type Answer = { status: number | null; stdout: string; stderr: string; error?: Error }

const why = (result: Answer): string => result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`)

/** Why a write gave no clear answer: PowerShell's own failure, or exit 0 with words the write never prints. */
const unclear = (result: Answer): string => (result.status === 0 && !result.error ? 'an answer Harness does not understand' : why(result))

type ReadPath = { ok: true; kind: string; value: string | null } | { ok: false; detail: string }

function readPath(run: PowershellRun, where: Record<string, string>): ReadPath {
  const read = run(READ_USER_PATH, where)
  // Exit 0 is the answer even with stderr beside it: the prelude turns every error into exit 1, and what is left on
  // stderr is noise such as 5.1's progress records.
  if (read.error || read.status !== 0) return { ok: false, detail: why(read) }
  const split = read.stdout.indexOf('\n')
  if (split < 0) return { ok: false, detail: 'an answer Harness does not understand' }
  const kind = read.stdout.slice(0, split)
  return { ok: true, kind, value: kind === 'None' ? null : read.stdout.slice(split + 1) }
}

/**
 * Take [folder] out of the user's PATH: value [name] of HKCU\[key] (tests use their own; HARNESS_UNINSTALL_ENV_KEY
 * moves every call off the real key).
 */
export function removeUserPathEntry(
  folder: string, run: PowershellRun, env: NodeJS.ProcessEnv = process.env, name = 'Path', key = 'Environment',
): PathRemoval {
  const where = { HARNESS_PATH_KEY: key, HARNESS_PATH_NAME: name }
  const current = readPath(run, where)
  if (!current.ok) return { state: 'failed', folder, detail: `could not read your PATH (${current.detail})` }
  if (current.value === null) return { state: 'absent', folder }
  if (current.kind !== 'String' && current.kind !== 'ExpandString') {
    return { state: 'failed', folder, detail: `your PATH is a ${current.kind} value, which Harness does not edit` }
  }
  const next = withoutPathEntry(current.value, folder, env)
  if (next === null) return { state: 'absent', folder }
  const change: Record<string, string> = next === '' ? { HARNESS_PATH_ACTION: 'delete' } : { HARNESS_PATH_ACTION: 'set', HARNESS_PATH_VALUE: next }
  const written = run(WRITE_USER_PATH, { ...where, ...change, HARNESS_PATH_KIND: current.kind, HARNESS_PATH_EXPECTED: current.value })
  if (!written.error && written.status === 0) {
    if (written.stdout === '') return { state: 'removed', folder }
    if (written.stdout === 'unannounced') return { state: 'removed', folder, note: PATH_UNANNOUNCED_NOTE }
    if (written.stdout === 'changed') {
      return { state: 'failed', folder, detail: 'your PATH changed while Harness was removing its folder, so Harness left it as it was' }
    }
  } else if (!written.error && written.status !== null) {
    // The script ended with an error (the prelude's exit 1): it never got as far as a write that could have happened.
    return { state: 'failed', folder, detail: `could not write your PATH (${why(written)})` }
  }
  // No clear answer: PowerShell did not start, timed out, was killed, or printed something unexpected after it may
  // have written. The PATH itself says whether the folder is gone; Windows may not have been told.
  const after = readPath(run, where)
  if (!after.ok) return { state: 'failed', folder, detail: `could not tell whether your PATH was changed (${unclear(written)})` }
  if (after.value === null || withoutPathEntry(after.value, folder, env) === null) {
    return { state: 'removed', folder, note: PATH_UNANNOUNCED_NOTE }
  }
  return { state: 'failed', folder, detail: `could not write your PATH (${unclear(written)})` }
}
