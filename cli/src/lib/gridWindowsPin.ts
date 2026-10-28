/**
 * The grid pin on Windows.
 *
 * On macOS and Linux the pin is a managed runtime: an archive Harness builds, downloads and points `current-grid` at
 * (`ensureManagedGrid`, runtimeInstall.ts). Windows has no such build — an unsigned grid.exe is what Smart App Control
 * blocks — so the manifest's `win32-*` entry carries a version only, and grid's own installer (`install.ps1`, the one
 * that copes with Smart App Control) lays that release down in `%USERPROFILE%\.local\bin`. Before this, a Windows
 * machine stayed on whatever release was latest the day grid was first installed there.
 */
import type { GridInstallResult } from './gridInstall.js'
import { isReleaseNumber, meetsVersionFloor } from './gridExec.js'

/** The first grid that runs on Windows as Harness drives it: `grid.cmd` where Smart App Control blocks `grid.exe`,
 *  and a `grid update` that leaves the install whole. A lower pin — the one for macOS and Linux may be — is not
 *  followed here. */
export const GRID_WINDOWS_VERSION_FLOOR = '0.3.61'

export interface WindowsGridPinDeps {
  /** This computer's manifest key (`win32-x64`), or null on an architecture the manifest does not name. */
  key: string | null
  manifest: () => Promise<unknown>
  /** What the installed grid says it is; null when there is none. */
  installedVersion: () => Promise<string | null>
  install: (version: string) => Promise<GridInstallResult>
  log: (message: string) => void
}

/** Install the pinned grid when this computer runs another. Best-effort: every failure is a log line at most. */
export async function followWindowsGridPin(deps: WindowsGridPinDeps): Promise<void> {
  if (!deps.key) return
  let document: unknown
  try { document = await deps.manifest() } catch { return }
  const entry = (document as Record<string, Record<string, { version?: unknown } | undefined> | undefined> | null)?.grid?.[deps.key]
  const version = entry?.version
  if (typeof version !== 'string' || !isReleaseNumber(version)) return
  if (!meetsVersionFloor(version) || !meetsVersionFloor(version, GRID_WINDOWS_VERSION_FLOOR)) return
  if (await deps.installedVersion() === version) return
  deps.log(`▸ installing grid ${version}, the version Harness pins (grid's Windows installer)…`)
  const result = await deps.install(version)
  deps.log(result.status === 'installed' ? `  ✓ grid ${version} installed` : result.message)
}
