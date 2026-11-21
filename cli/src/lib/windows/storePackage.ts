/**
 * Where a Microsoft Store app's package is installed for this user: its InstallLocation, as Get-AppxPackage answers it.
 * That is Windows' documented query for a user's own packages, and it needs no administrator. The folder sits under
 * %ProgramFiles%\WindowsApps, named for the package's version, which an update changes, and that folder cannot be
 * listed without an administrator: so it is asked, never built. Node has no way to the package API without native code,
 * so Windows PowerShell asks, started directly with no command shell (./powershell.ts), hidden, and bounded in time.
 * Each ask is a PowerShell of 1.3 to 1.8 s on the VM (docs/plans/2026-11-19-dial-windows-vm-notes.md, "Fixes after
 * Task 37" §2), so one look keeps its answer for everyone who needs the package (storePackageLook).
 */
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import { modulesByPath, runPowershellAsync, type PowershellResult } from './powershell.js'

export const STORE_PACKAGE_TIMEOUT_MS = 10_000
/** How long no package, or a failed ask for it, holds: an app installed later is found within it. */
export const STORE_PACKAGE_ASK_MS = 600_000

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

/** One package's folder, asked of Windows at most once at a time and kept. */
export interface StorePackageLook {
  /** The folder last answered, while it is still there; null otherwise. Starts nothing. */
  known(): string | null
  /** Joins the ask under way, or starts one when the kept folder went (an update moves the package to a folder named for
   *  its new version) or STORE_PACKAGE_ASK_MS have passed since no folder was answered; else answers known() at once.
   *  Never rejects. */
  ask(): Promise<string | null>
}

/** [now] is a monotonic clock: a wall clock set back would keep a miss for as long. */
export function storePackageLook(
  name: string,
  query: (name: string) => Promise<string | null> = storePackageFolder,
  now: () => number = () => performance.now(),
  exists: (path: string) => boolean = existsSync,
): StorePackageLook {
  let folder: string | null = null
  // When the last ask answered no folder; null before any ask and after one that found it.
  let missedAt: number | null = null
  let asking: Promise<string | null> | null = null
  const known = () => (folder !== null && exists(folder) ? folder : null)
  return {
    known,
    ask() {
      if (asking) return asking
      const kept = known()
      if (kept !== null || (missedAt !== null && now() - missedAt < STORE_PACKAGE_ASK_MS)) return Promise.resolve(kept)
      asking = query(name).catch(() => null).then((answer) => {
        asking = null
        folder = answer
        missedAt = answer === null ? now() : null
        return answer
      })
      return asking
    },
  }
}
