/**
 * How an engine starts in a Windows pane. Windows has no POSIX shell to run Harness's launch script in
 * (lib/engineLaunch.ts `buildEngineLaunchArgv`), so the pane's command is the engine itself (lib/windows/launch.ts),
 * and what that script does on Unix is done here, by the daemon, or by the pty host:
 *
 * - The screen's variables and a native launch's marker: the pane's env (`engineLaunchEnv`).
 * - `cd` into the workspace after the rc files: there are no rc files, so the pane starts in it (`windowsPaneLaunch`).
 * - Codex's owned-process probe (`--no-daemon`): the daemon reads the engine's help as it inspects the launch
 *   (engines/nativeLaunch.ts `startupArgs`), and the flag goes first in the argv (`windowsStartupArgs`). A launch with
 *   no such answer is refused, as the script ends one whose probe could not answer.
 * - Codex's startup retry reads the pane through tmux, and a Windows pane has none: off, as it is on Unix's pty host.
 * - The native guard (the prepared executable and settings are still the ones confirmed): checked as the argv is built
 *   (`nativeLaunchConfirmed`). A launch whose evidence changed opens a held pane instead (`windowsHeldPaneArgv`), which
 *   a respawn under its token replaces once the launch is prepared again, as on the pty host elsewhere.
 * - `harness_after`, the engine's exit turning the pane into the person's shell with its status recorded where the
 *   daemon reads it: the pty host does it, given `afterExit` (pty/src/panes.rs `hand_off`), with
 *   `defaultWindowsShell()`. PowerShell says what happened, as the script does; cmd.exe says nothing.
 * - The variables a grid launch clears (`unset`): the pty host leaves them out of what the engine inherits from the
 *   host's own environment (`clearInherited`, `windowsPaneLaunch`).
 * - Not done: an install before the engine and a take-over's wait (no script to run them in), Harness's Node at the
 *   end of PATH, the open-files raise and the stop handling, which Windows has no counterpart of.
 *
 * Every value the shells are given travels in their environment, never in their command text.
 */
import type { NativeLaunch } from '../../engines/nativeLaunch.js'
import { startupOwnedFlag } from '../../engines/kit/launchStartup.js'
import { launchContract } from '../../engines/launches.js'
import { isTerminalEngine, type AgentEngine } from '../../engines/types.js'
import { baseNode } from '../../harnessd/baseNode.js'
import { engineBin } from '../engineBin.js'
import type { TerminalAfterExit } from '../terminalTypes.js'
import { WindowsLaunchRefused } from './launch.js'
import { defaultWindowsShell } from './shell.js'

/** A launch whose engine declares a startup probe (Codex's owned-process flag) that nobody answered for it. */
export class WindowsStartupUnverified extends WindowsLaunchRefused {
  constructor(readonly engine: string, unverified: string) {
    super(`${unverified.charAt(0).toUpperCase()}${unverified.slice(1)}`)
    this.name = 'WindowsStartupUnverified'
  }
}

/**
 * The arguments [engine]'s declared startup puts first on Windows: its owned-process flag when the engine's help lists
 * it, as the launch script's probe decides elsewhere (engines/kit/launchStartup.ts). The answer is the native launch's,
 * read from the help of the very executable it holds; without one the launch is refused rather than started on the
 * shared server the flag keeps it off.
 */
export function windowsStartupArgs(engine: AgentEngine, native: Pick<NativeLaunch, 'startupArgs'> | undefined): string[] {
  const owned = startupOwnedFlag(launchContract(engine))
  if (!owned) return []
  if (!native?.startupArgs) throw new WindowsStartupUnverified(engine, owned.unverified)
  return [...native.startupArgs]
}

/**
 * Whether a native launch may still run its prepared executable: what the launch script's guard checks after the rc
 * files (engines/kit/nativeLaunchGuard.ts), asked of the launch itself as the argv is built. Nothing runs between this
 * and the engine on Windows but the pane's creation.
 */
export function nativeLaunchConfirmed(native: Pick<NativeLaunch, 'executable' | 'ready' | 'proofs'>): boolean {
  if (!native.executable) return true
  return native.ready?.() !== false && native.executable.current() && native.proofs.every((proof) => proof.current())
}

/**
 * A held pane on Windows: it says why, waits, and survives Ctrl-C and Ctrl-Break, as the `/bin/sh` loop does elsewhere
 * (core/agents/heldLaunches.ts `heldPaneArgv`). Run by the daemon's own Node, the detail and the token as arguments:
 * the start command must carry `harness-held` and the token, which is how the daemon and the host know a held pane
 * (lib/nativePaneHold.ts `isHeldStartCommand`, pty/src/panes.rs `held_by`).
 */
export function windowsHeldPaneArgv(detail: string, token?: string, node: string = baseNode(process.execPath)): string[] {
  const script = 'for(const s of ["SIGINT","SIGBREAK","SIGHUP"])process.on(s,()=>{});'
    + 'process.stdout.write(process.argv[2]+"\\r\\n");setInterval(()=>{},3600000)'
  const argv = [node, '-e', script, 'harness-held', detail, ...(token ? [token] : [])]
  HELD_PANES.add(argv)
  return argv
}

/** The argv `windowsHeldPaneArgv` made, by identity: never what an argv says, which a person's prompt can say too. */
const HELD_PANES = new WeakSet<readonly string[]>()

/** Whether [argv] is a held pane's, as `windowsHeldPaneArgv` made it (`buildEngineLaunchArgv` returns it as it is). */
export function isWindowsHeldPane(argv: readonly string[]): boolean {
  return HELD_PANES.has(argv)
}

/**
 * What PowerShell runs before its prompt in a pane an engine has left, read from the environment the host gives it
 * (`HARNESS_ENGINE_EXIT`, the engine's status; `HARNESS_ENGINE_COMMAND`, its name): the line a Unix pane prints in
 * `harness_after`. Both are then taken out, so the person's shell does not keep them.
 */
export const ENGINE_EXIT_NOTICE_PS = "Write-Host ''; Write-Host ('harness: ' + $env:HARNESS_ENGINE_COMMAND + ' exited ('"
  + " + $env:HARNESS_ENGINE_EXIT + '). This pane is a shell now - run ' + $env:HARNESS_ENGINE_COMMAND + ' again, or stop"
  + " the pane.'); Remove-Item Env:HARNESS_ENGINE_COMMAND, Env:HARNESS_ENGINE_EXIT -ErrorAction SilentlyContinue"

/** What cmd.exe, the shell where there is no PowerShell, runs first: both variables taken out again, fixed text. */
export const ENGINE_EXIT_CLEAR_CMD = 'set HARNESS_ENGINE_COMMAND=& set HARNESS_ENGINE_EXIT='

/** The shell a Windows engine's pane becomes when the engine exits (`afterExit`), named by [command] in its notice. */
export function windowsAfterExit(command: string, shell: string[] = defaultWindowsShell()): TerminalAfterExit {
  const powershell = /^(?:pwsh|powershell)(?:\.exe)?$/i.test(shell[0]!.split(/[\\/]/).pop()!)
  return {
    command: powershell ? [...shell, '-NoExit', '-Command', ENGINE_EXIT_NOTICE_PS] : [...shell, '/k', ENGINE_EXIT_CLEAR_CMD],
    env: { HARNESS_ENGINE_COMMAND: command },
  }
}

/** What a pane request takes beside its argv on Windows (`windowsPaneLaunch`). */
export interface WindowsPaneLaunch {
  /** The folder the engine starts in: the workspace, which a Unix launch enters after the rc files. */
  cwd?: string
  afterExit?: TerminalAfterExit
  /**
   * Names this launch's engine, and the shell it hands the pane to, must not get from the host's own environment: the
   * launch's `clearEnv` (a grid launch's provider keys, lib/gridLaunch.ts) and the native launch's `clearEnvironment`,
   * which the script unsets elsewhere. The host inherited the daemon's environment, so without this a grid launch saw
   * the person's ANTHROPIC_API_KEY. Per launch, as the script's unset is: an agent moved home gets them back.
   */
  clearInherited?: string[]
}

/** The launch facts `windowsPaneLaunch` reads: its options (lib/engineLaunch.ts `LaunchCommandOptions`). */
export interface WindowsPaneLaunchOptions {
  cwd?: string | null
  clearEnv?: readonly string[]
  native?: Pick<NativeLaunch, 'clearEnvironment'>
  /** The argv is a held pane's (`isWindowsHeldPane`), which hands off to nothing. */
  held?: boolean
}

/**
 * The cwd, cleared names and hand-off of a Windows pane for [engine], to spread into its create or respawn request;
 * nothing elsewhere, where the launch script enters the workspace, unsets the names and hands the pane on itself. A
 * terminal or a held pane hands off to nothing: its process ending is the pane's end. The notice names the engine by
 * the command a person would type (`cursor-agent`, `command-code`), as `harness_after`'s does.
 */
export function windowsPaneLaunch(engine: AgentEngine, launch: WindowsPaneLaunchOptions,
  platform: NodeJS.Platform = process.platform): WindowsPaneLaunch {
  if (platform !== 'win32') return {}
  const clearInherited = [...new Set([...(launch.clearEnv ?? []), ...(launch.native?.clearEnvironment ?? [])])]
  return {
    ...(launch.cwd ? { cwd: launch.cwd } : {}),
    ...(clearInherited.length ? { clearInherited } : {}),
    ...(isTerminalEngine(engine) || launch.held ? {} : { afterExit: windowsAfterExit(engineBin(engine, platform).split(/[\\/]/).pop() || engine) }),
  }
}
