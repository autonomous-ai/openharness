import { statSync } from 'node:fs'

/** A daemon left running by Fast User Switching must release the physical USB
 * device. macOS hides other users' descriptors from unprivileged lsof, so its
 * empty result cannot establish that the current desktop owns the port. */
export function isUsbConsoleUser({
  platform = process.platform,
  uid = process.getuid?.(),
  consoleUid = () => statSync('/dev/console').uid,
}: { platform?: NodeJS.Platform; uid?: number; consoleUid?: () => number } = {}): boolean {
  if (platform !== 'darwin') return true
  try { return uid !== undefined && uid !== 0 && uid === consoleUid() }
  catch { return false }
}
