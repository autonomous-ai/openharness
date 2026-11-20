/**
 * A program as Harness starts it on Windows: an `.exe` with its arguments, never cmd.exe.
 *
 * A `.cmd` or `.bat` file runs only as `cmd.exe /c <command line>`, which reads every argument again by its own rules:
 * `&` starts a command, `%x%` expands, a line break ends the line ("BatBadBut", lib/windows/launch.ts). So the two
 * batch files these programs come as are read, and what they run is started directly: an npm shim (Codex) through
 * `windowsEngineArgv`, and VS Code's or Cursor's own launcher, whose whole text must be the form real installs write
 * (fixtures/code.cmd, fixtures/cursor.cmd). Any other batch file is refused, Orca's `orca.cmd` among them: Orca is run
 * as its `orca.exe`. A launcher is read at every start and nothing is kept, because VS Code's script sits under a folder
 * named by its build's commit, which an update renames.
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { WindowsBatchLaunchRefused, windowsEngineArgv } from './launch.js'

/** What to start. `env`, when set, is the child's whole environment. */
export interface Program { file: string; args: string[]; env?: NodeJS.ProcessEnv }

export interface WindowsProgramOptions {
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
  read?: (file: string) => string
  exists?: (file: string) => boolean
}

/** A batch file Harness does not start on Windows: not an npm shim or an editor's own launcher, or what it runs is not
 *  there. The message names the file alone, so no profile's folder reaches a log. */
export class WindowsProgramRefused extends Error {
  constructor(readonly program: string) {
    super(`Harness does not start ${basename(program)} on Windows: only cmd.exe could run it.`)
    this.name = 'WindowsProgramRefused'
  }
}

const BATCH = /\.(?:cmd|bat)$/i

/** VS Code's `bin\code.cmd` and Cursor's `resources\app\bin\cursor.cmd`, whole: the line that passes `%*` names the
 *  `.exe` and the script beside the launcher (`%~dp0`), after `set ELECTRON_RUN_AS_NODE=1`. A path holds no quote and
 *  no `%`, so nothing in it is expanded or ends its quoting. */
const ELECTRON_LAUNCHER = /^@echo off\r\nsetlocal\r\nset VSCODE_DEV=\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%~dp0([^"%\r\n]+\.exe)" "%~dp0([^"%\r\n]+\.js)" %\*\r\nIF %ERRORLEVEL% NEQ 0 EXIT \/b %ERRORLEVEL%\r\nendlocal\r\n$/

/** The `.exe` and the CLI script an editor's own launcher in [launcherDir] runs, or null for any other text. */
export function parseElectronLauncher(text: string, launcherDir: string): { exe: string; script: string } | null {
  const match = ELECTRON_LAUNCHER.exec(text)
  if (!match) return null
  const beside = (relative: string): string => join(launcherDir, ...relative.split('\\'))
  return { exe: beside(match[1]!), script: beside(match[2]!) }
}

/** [environment] as the launcher's own `set` lines leave it, under which the app's `.exe` runs the script as Node.
 *  Windows reads a name in any case, so each is matched so. */
function launcherEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = Object.entries(environment).filter(([name]) => !/^(?:VSCODE_DEV|ELECTRON_RUN_AS_NODE)$/i.test(name))
  return { ...Object.fromEntries(kept), ELECTRON_RUN_AS_NODE: '1' }
}

/**
 * [file] and [args] as Windows starts them with no shell: an `.exe` (or any program that is not a batch file) as it is;
 * an npm shim as `node.exe <script>` or the package's `.exe`; VS Code's or Cursor's own launcher as the app's `.exe`
 * on its CLI script. Any other batch file, or one whose program is not there, throws `WindowsProgramRefused`.
 * Unchanged off Windows.
 */
export function windowsProgram(file: string, args: readonly string[], options: WindowsProgramOptions = {}): Program {
  const { platform = process.platform, environment = process.env, read = (path) => readFileSync(path, 'utf8'), exists = existsSync } = options
  if (platform !== 'win32' || !BATCH.test(file)) return { file, args: [...args] }
  let text: string
  try { text = read(file) } catch { throw new WindowsProgramRefused(file) }
  const launcher = parseElectronLauncher(text, dirname(file))
  if (launcher) {
    if (!exists(launcher.exe) || !exists(launcher.script)) throw new WindowsProgramRefused(file)
    return { file: launcher.exe, args: [launcher.script, ...args], env: launcherEnvironment(environment) }
  }
  let argv: string[]
  // No engine's own rule (Hermes', OpenCode's) applies to these programs. The shim is the text just read.
  try { argv = windowsEngineArgv('the program', [file, ...args], { environment, platform, read: () => text }) } catch (error) {
    if (error instanceof WindowsBatchLaunchRefused) throw new WindowsProgramRefused(file)
    throw error
  }
  // A shim it could not carry out comes back as the batch file itself, which only cmd.exe runs.
  const [program = file, ...rest] = argv
  if (BATCH.test(program)) throw new WindowsProgramRefused(file)
  return { file: program, args: rest }
}
