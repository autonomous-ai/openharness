import { statSync } from 'node:fs'
import { windowsDialWatch } from './windowsSerial.js'

/** A daemon left running by Fast User Switching must release the physical USB
 * device. macOS hides other users' descriptors from unprivileged lsof, so its
 * empty result cannot establish that the current desktop owns the port. Windows
 * has the same switch: harness-serial's watch says whether this daemon's session
 * is the console session (WTSGetActiveConsoleSessionId). */
export function isUsbConsoleUser({
  platform = process.platform,
  uid = process.getuid?.(),
  consoleUid = () => statSync('/dev/console').uid,
  windowsConsole = () => windowsDialWatch().console(),
}: { platform?: NodeJS.Platform; uid?: number; consoleUid?: () => number; windowsConsole?: () => boolean } = {}): boolean {
  if (platform === 'win32') return windowsConsole()
  if (platform !== 'darwin') return true
  try { return uid !== undefined && uid !== 0 && uid === consoleUid() }
  catch { return false }
}
