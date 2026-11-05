/**
 * How to start a program in its own process group without a window ever flashing on Windows (docs/windows-rules.md, rule 1).
 *
 * `detached: true` on Windows is DETACHED_PROCESS: the child has no console, so every console program it starts gets a new one,
 * and its window flashes up. `windowsHide` cannot help, since Windows ignores CREATE_NO_WINDOW beside DETACHED_PROCESS. Measured on
 * Windows 11, 2026-11-05: detached flashed with and without `windowsHide`; `windowsHide` alone never did. Windows has no process
 * groups to gain from `detached` either. Node does end such a child when it exits (not what the child starts in turn): a program
 * that must outlive Node starts through bin\harness-launch.exe (./launcher.ts) or a hidden runner (engines/kit/windowsInstall.ts).
 */
export function ownProcessGroup(platform: NodeJS.Platform = process.platform): { detached?: boolean; windowsHide?: boolean } {
  return platform === 'win32' ? { windowsHide: true } : { detached: true }
}
