/**
 * Windows app execution aliases: the 0-byte links a Microsoft Store app puts in %LOCALAPPDATA%\Microsoft\WindowsApps.
 * Node reads one as a link into the app's package folder under WindowsApps; it can neither stat nor run it (EACCES, in
 * the person's session and in session 0 alike), though accessSync(X_OK) passes (measured on Windows 11 with Node 24,
 * 2026-11-11). So an alias is never an engine Harness can start. Older Claude desktop apps registered `claude.exe`.
 */
import { lstatSync, readlinkSync } from 'node:fs'

/** The program the alias at [path] starts, when [path] is a Store app's alias; null for anything else. */
export function storeAppAlias(path: string): string | null {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null
    const target = readlinkSync(path)
    return target.toLowerCase().includes('\\windowsapps\\') ? target : null
  } catch { return null }
}

/** Whether [path] is something other than a Store app's alias: always on any other OS. */
export function notStoreAppAlias(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32' || storeAppAlias(path) === null
}
