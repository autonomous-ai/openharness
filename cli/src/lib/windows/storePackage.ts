/**
 * Where a Microsoft Store app's package is installed for this user: its InstallLocation, as Get-AppxPackage answers it.
 * That is Windows' documented query for a user's own packages, and it needs no administrator. The folder sits under
 * %ProgramFiles%\WindowsApps, named for the package's version, which an update changes, and that folder cannot be
 * listed without an administrator: so it is asked, never built. Node has no way to the package API without native code,
 * so Windows PowerShell asks, started directly with no command shell (./powershell.ts), hidden, and bounded in time.
 */
import { win32 } from 'node:path'
import { modulesByPath, runPowershellAsync, type PowershellResult } from './powershell.js'

export const STORE_PACKAGE_TIMEOUT_MS = 10_000

/** A package's name as Windows allows it: 3 to 50 letters, digits, dots and dashes. No wildcard reaches -Name. */
const PACKAGE_NAME = /^[A-Za-z0-9.-]{3,50}$/

export const SCRIPT = `${modulesByPath('Appx')}\n(Get-AppxPackage -Name $env:HARNESS_STORE_PACKAGE | Select-Object -First 1).InstallLocation`

export type PowershellAsk = (script: string, inputs: Record<string, string>, timeoutMs: number) => Promise<PowershellResult>

/** The install folder of package [name] for this user; null when it is not installed, or the query failed or ran late. */
export async function storePackageFolder(name: string, run: PowershellAsk = runPowershellAsync): Promise<string | null> {
  if (!PACKAGE_NAME.test(name)) return null
  const result = await run(SCRIPT, { HARNESS_STORE_PACKAGE: name }, STORE_PACKAGE_TIMEOUT_MS)
  if (result.status !== 0) return null
  const folder = result.stdout.trim()
  return win32.isAbsolute(folder) && !/[\r\n\0]/.test(folder) ? folder : null
}
