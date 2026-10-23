// Adapted from stablyai/orca src/main/providers/windows-shell-fallback-chain.ts (MIT): its order, PowerShell 7, then
// the Windows PowerShell every Windows has, then the command processor. See THIRD_PARTY_NOTICES.md.
/**
 * The shell a Windows pane created with no command runs (ptyHostBackend.ts), as tmux's `default-shell` is the user's
 * shell elsewhere: PowerShell 7 (`pwsh.exe`) where it is installed, else Windows PowerShell, else `%ComSpec%`. `-NoLogo`
 * keeps the banner out of a pane a person did not open by hand.
 *
 * Git Bash, the user's own choice of shell and the pane's environment and PATH are sub-project B.
 */
import { binaryOnPath } from '../binaryOnPath.js'

export function defaultWindowsShell(find: (binary: string) => unknown = binaryOnPath): string[] {
  if (find('pwsh.exe')) return ['pwsh.exe', '-NoLogo']
  if (find('powershell.exe')) return ['powershell.exe', '-NoLogo']
  return [process.env.ComSpec ?? 'cmd.exe']
}
