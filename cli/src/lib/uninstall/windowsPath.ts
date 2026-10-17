/**
 * `harness uninstall` on Windows: Harness's bin folder out of the user's PATH (`HKCU\Environment`), where install.ps1
 * put it (spec section 1, step 4). Never the machine PATH, which Harness never touches.
 *
 * The value is read raw (DoNotExpandEnvironmentNames) and written back as the kind it was: a round trip through
 * .NET's Environment API expands every %VARIABLE% in the person's other entries and stores them as plain strings.
 * Then WM_SETTINGCHANGE, so a terminal opened afterwards no longer has the folder.
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

const READ = String.raw`$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
$v = if ($k) { $k.GetValue($env:HARNESS_PATH_NAME, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
$kind = if ($null -ne $v) { $k.GetValueKind($env:HARNESS_PATH_NAME).ToString() } else { 'None' }
[Console]::Out.Write((ConvertTo-Json -Compress @{ value = $v; kind = $kind }))`

const WRITE = String.raw`$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if ([string]::IsNullOrEmpty($env:HARNESS_PATH_VALUE)) { $k.DeleteValue($env:HARNESS_PATH_NAME, $false) }
else { $k.SetValue($env:HARNESS_PATH_NAME, $env:HARNESS_PATH_VALUE, [Microsoft.Win32.RegistryValueKind]$env:HARNESS_PATH_KIND) }
Add-Type -Namespace HarnessUninstall -Name Native -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint msg, System.UIntPtr wParam, string lParam, uint flags, uint timeout, out System.UIntPtr result);'
$r = [System.UIntPtr]::Zero
[void][HarnessUninstall.Native]::SendMessageTimeout([System.IntPtr]0xffff, 0x001A, [System.UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref]$r)`

export type PathRemoval =
  | { state: 'removed' | 'absent'; folder: string }
  | { state: 'failed'; folder: string; detail: string }

const why = (result: { error?: Error; stderr: string; status: number | null }): string =>
  result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`)

/** Take [folder] out of the user's PATH (value [name]; tests use one of their own). */
export function removeUserPathEntry(folder: string, run: PowershellRun, env: NodeJS.ProcessEnv = process.env, name = 'Path'): PathRemoval {
  const read = run(READ, { HARNESS_PATH_NAME: name })
  if (read.error || read.status !== 0) return { state: 'failed', folder, detail: `could not read your PATH (${why(read)})` }
  let current: { value: string | null; kind: string }
  try { current = JSON.parse(read.stdout) } catch { return { state: 'failed', folder, detail: 'could not read your PATH (an answer that is not JSON)' } }
  if (current.value === null) return { state: 'absent', folder }
  if (current.kind !== 'String' && current.kind !== 'ExpandString') {
    return { state: 'failed', folder, detail: `your PATH is a ${current.kind} value, which Harness does not edit` }
  }
  const next = withoutPathEntry(current.value, folder, env)
  if (next === null) return { state: 'absent', folder }
  const written = run(WRITE, { HARNESS_PATH_NAME: name, HARNESS_PATH_VALUE: next, HARNESS_PATH_KIND: current.kind })
  if (written.error || written.status !== 0) return { state: 'failed', folder, detail: `could not write your PATH (${why(written)})` }
  return { state: 'removed', folder }
}
