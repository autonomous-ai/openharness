/**
 * The one way a tap brings an app forward on Windows, as macOS's `open -b` does and Linux's raise (linuxRaise.ts)
 * (docs/plans/2026-11-19-dial-windows-design.md, part C). Each answers whether the tap was done, as Linux's raise does.
 * Where Windows differs, and why:
 * - The app is named by its bundle id, as on macOS, not by a window class, as on Linux: a Windows window is found by the
 *   program that owns it, which `harness-pty raise --exe` matches by image name (pty/src/raise.rs).
 * - A `refused` raise is a tap done: Windows gives the foreground only to a process with foreground rights, and a tap
 *   arrives over serial, which Windows does not count as input. Its documented answer is the taskbar flash.
 * - Harness Desktop is started through its own launcher, never raised: a running Desktop takes a second launch over and
 *   brings its own window forward (desktop/windows/runner/single_instance.cpp).
 * - App links and Cursor's folder open through programs, never a shell: `harness-pty open-link` (ShellExecuteExW) and
 *   Cursor's CLI, every value one argument.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { APP_BUNDLES } from './hostDetect.js'
import { RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'

/** What the helper answers for a raise: the window came, Windows flashed its taskbar button instead, or no window. */
export type RaiseOutcome = 'raised' | 'refused' | 'none'

/**
 * Each app a tap raises, by the bundle a tap names (open.ts BUNDLES), to the program whose process owns its window
 * (docs/plans/2026-11-19-dial-windows-vm-notes.md, Task 1 §5). VS Code and Cursor were seen running. Orca's is the app at
 * its install root, not the CLI `resources\bin\orca.exe`: the helper matches names without case, so the CLI's processes
 * match too and own no visible window, which the helper passes over. WezTerm's, Warp's and Alacritty's are in their
 * installs, not seen running; the Claude and ChatGPT apps were not installed. The VM's console check (the plan's
 * Task 37) confirms those five.
 */
export const WINDOWS_APPS: Readonly<Record<string, string>> = {
  [APP_BUNDLES.vscode]: 'Code.exe',
  [APP_BUNDLES.cursor]: 'Cursor.exe',
  [APP_BUNDLES.orca]: 'Orca.exe',
  [APP_BUNDLES.wezterm]: 'wezterm-gui.exe',
  [APP_BUNDLES.warp]: 'warp.exe',
  'org.alacritty': 'alacritty.exe',
  [APP_BUNDLES.claude]: 'Claude.exe',
  [APP_BUNDLES.codex]: 'ChatGPT.exe',
}

/** The schemes `harness-pty open-link` takes (pty/src/cli.rs), checked here too so no other link reaches it. */
const LINK = /^(claude|codex|vscode|cursor):\/\//
const OUTCOMES: ReadonlySet<string> = new Set<RaiseOutcome>(['raised', 'refused', 'none'])

/**
 * Harness Desktop's launcher, `%LOCALAPPDATA%\Programs\Harness\Harness.exe`, where its installer puts it
 * (pty/src/desktop/mod.rs: `FOLDERID_UserProgramFiles`\Harness and `LAUNCHER_EXE`); null when it is not there or
 * `LOCALAPPDATA` is no absolute path, which a relative one would make one under this process's working folder.
 */
export function harnessDesktopLauncher(env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = existsSync): string | null {
  const local = env.LOCALAPPDATA
  if (!local || !path.win32.isAbsolute(local)) return null
  const launcher = path.win32.join(local, 'Programs', 'Harness', 'Harness.exe')
  return exists(launcher) ? launcher : null
}

export interface WindowsRaiseDeps {
  /** `harness-pty`; null when none is installed. */
  binary(): string | null
  run: OrcaDeps['run']
  /** Cursor's own CLI; null when none is found. */
  cursorCli(): string | null
  /** Harness Desktop's launcher (harnessDesktopLauncher); null when it is not installed. */
  desktopLauncher(): string | null
  /** Each raise's outcome, once: the outcome alone, never the app. */
  count(outcome: RaiseOutcome): void
}

export interface WindowsRaise {
  /** Brings the app of [bundle] forward; false only when no window of it came or flashed. */
  app(bundle: string): Promise<boolean>
  /** Opens [url] in its scheme's app, then brings [bundle]'s app forward: the link reaches the app, not the front. */
  link(url: string, bundle?: string): Promise<boolean>
  /** Opens [folder] in Cursor, which raises its window on it or opens one, then brings Cursor forward. */
  cursorFolder(folder: string): Promise<boolean>
  /** Starts Harness Desktop, which brings its own window forward when it runs already. */
  desktop(): Promise<boolean>
}

export function createWindowsRaise(deps: WindowsRaiseDeps): WindowsRaise {
  // A run that cannot start answers as one that ran and failed: no tap path throws.
  const run = (file: string, args: string[]) => deps.run(file, args, RUN_TIMEOUT_MS).catch(() => ({ code: null, stdout: '' }))
  // The helper's one word on a clean exit. An older helper exits 2 for a command it does not know, and 3 off Windows.
  const helper = async (args: string[]): Promise<string | undefined> => {
    const binary = deps.binary()
    if (binary === null) return undefined
    const { code, stdout } = await run(binary, args)
    return code === 0 ? stdout.trim() : undefined
  }
  const raise = async (bundle: string): Promise<RaiseOutcome> => {
    if (!Object.hasOwn(WINDOWS_APPS, bundle)) return 'none'
    const word = await helper(['raise', '--exe', WINDOWS_APPS[bundle]])
    return word !== undefined && OUTCOMES.has(word) ? word as RaiseOutcome : 'none'
  }
  const app = async (bundle: string): Promise<boolean> => {
    const outcome = await raise(bundle)
    deps.count(outcome)
    return outcome !== 'none'
  }

  return {
    app,
    async link(url, bundle) {
      if (!LINK.test(url) || (await helper(['open-link', url])) !== 'opened') return false
      // The link was taken, whatever the raise answers: a refused open answers false, and the opener's fallback decides
      // (open.ts), as on Linux.
      if (bundle !== undefined) await app(bundle)
      return true
    },
    async cursorFolder(folder) {
      const cli = deps.cursorCli()
      if (cli === null || (await run(cli, [folder])).code !== 0) return false
      await app(APP_BUNDLES.cursor)
      return true
    },
    // Not counted: the count is the helper's answers alone.
    async desktop() {
      const launcher = deps.desktopLauncher()
      return launcher !== null && (await run(launcher, [])).code === 0
    },
  }
}
