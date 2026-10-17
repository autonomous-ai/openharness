/**
 * An engine's argv as a Windows pane runs it, so no argument is read by cmd.exe.
 *
 * The pty host starts a pane with `CreateProcessW(NULL, <command line>)`, its arguments quoted by the C runtime's
 * rules. A `.cmd` or `.bat` program is run as `cmd.exe /c <command line>`, and cmd.exe parses that line again by its
 * own rules: `fix&calc` runs calc, an unbalanced `"` ends the quoting, `%PATH%` expands, a newline ends the command.
 * An engine's first message is the person's text and Harness's own instructions (several lines), so a `.cmd` engine
 * would run whatever the message says ("BatBadBut", which Rust's std refuses the same way).
 *
 * npm installs every global CLI on Windows as a `.cmd` shim (npm's cmd-shim), which only runs node (or the package's
 * own .exe) on a script beside it. So a shim is read, and its program is started directly: `node.exe <script>`, with
 * the node beside the shim when there is one, as the shim itself prefers, else node on PATH; or the package's .exe.
 * Any other batch file is refused when an argument holds a character cmd.exe reads (`%`, `"`, `&`, `|`, `<`, `>`, `^`,
 * `(`, `)`, `!`, a backtick, or a line break), with an error that names the engine.
 */
import { accessSync, closeSync, constants, openSync, readFileSync, readSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { windowsLaunchCommand } from '../binaryOnPath.js'

const BATCH = /\.(?:cmd|bat)$/i
/** What cmd.exe reads in a command line: Rust's std refuses these in a batch file's arguments (BatBadBut). */
const CMD_METACHARACTERS = /[%"&|<>^()!`\r\n]/

/** A launch Windows cannot make as asked, refused before any pane opens, its message the person's to read
 *  (`windowsLaunchRefusal`). */
export class WindowsLaunchRefused extends Error {}

export class WindowsBatchLaunchRefused extends WindowsLaunchRefused {
  constructor(readonly engine: string, readonly program: string) {
    super(`Harness cannot start ${engine} on Windows with these arguments: ${program} is a batch file, and cmd.exe would `
      + 'read characters in them (such as % " & | < > ^ ( ) ! or a line break) as commands. Install it as a program (an .exe) '
      + 'or through npm, or start it without a first message.')
    this.name = 'WindowsBatchLaunchRefused'
  }
}

/** An engine whose Windows build cannot run here, refused before any pane opens (outcome of Task B4.12). */
export class WindowsEngineUnavailable extends WindowsLaunchRefused {
  constructor(readonly engine: string, detail: string) {
    super(detail)
    this.name = 'WindowsEngineUnavailable'
  }
}

/** The machine a Windows program is built for, from its PE header (`IMAGE_FILE_HEADER.Machine`); null if it is not one. */
export function peMachine(file: string, read: (file: string) => Buffer = readHead): 'x64' | 'arm64' | 'x86' | null {
  let head: Buffer
  try { head = read(file) } catch { return null }
  if (head.length < 0x40 || head.toString('latin1', 0, 2) !== 'MZ') return null
  const header = head.readUInt32LE(0x3c)
  if (header + 6 > head.length || head.toString('latin1', header, header + 4) !== 'PE\0\0') return null
  switch (head.readUInt16LE(header + 4)) {
    case 0x8664: return 'x64'
    case 0xaa64: return 'arm64'
    case 0x14c: return 'x86'
    default: return null
  }
}

function readHead(file: string): Buffer {
  const fd = openSync(file, 'r')
  try {
    const bytes = Buffer.alloc(4096)
    return bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0))
  } finally { closeSync(fd) }
}

/**
 * Why [engine] cannot run as [program] on Windows, in words for the person, or null. Measured on the Windows VM
 * (Task B4.12, cli/scripts/windows-pty-e2e/evidence/opencode-arm64.log): outcome C.
 */
export function windowsEngineUnavailable(engine: string, program: string, machine: (file: string) => ReturnType<typeof peMachine> = peMachine): string | null {
  if (engine === 'opencode' && /\.exe$/i.test(program) && machine(program) === 'arm64') {
    return 'OpenCode does not run on Windows on Arm yet: its Arm build stops before its screen opens. Use another engine on this computer.'
  }
  return null
}

export type NpmShimTarget = { kind: 'node'; script: string; nodeArgs: string[] } | { kind: 'exe'; program: string }

const exists = (file: string): boolean => {
  try { accessSync(file, constants.F_OK); return true } catch { return false }
}

/** `%dp0%\node_modules\…` (or the older `%~dp0\…`), as a path beside [shimDir]. */
const besideShim = (shimDir: string, relative: string): string => join(shimDir, ...relative.split('\\').filter(Boolean))

/**
 * What an npm cmd-shim runs (npm's cmd-shim, the form npm 6–11 write), or null for any other batch file. Read from the
 * line that passes the arguments on (`… "%dp0%\<target>" %*`):
 * - `"%_prog%" [args] "%dp0%\<script>" %*`, where `_prog` is `%dp0%\node.exe` if it is there, else `node`: node;
 * - `"%~dp0\node.exe" … "%~dp0\<script>" %*` / `node … "%~dp0\<script>" %*` (cmd-shim before npm 7): node;
 * - `"%dp0%\<program>.exe" %*`: the package's own program.
 * A shim for anything else (`sh`, `pwsh`, a runner with arguments that are not plain words) is not one this reads.
 */
export function parseNpmCmdShim(text: string, shimDir: string): NpmShimTarget | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim())
  const passing = lines.filter((line) => /%\*$/.test(line))
  const last = passing.at(-1)
  if (!last) return null
  const match = /^(.*?)"%~?dp0%?\\([^"%]+)"\s+%\*$/.exec(last)
  if (!match) return null
  const [, runner, relative] = match
  const target = besideShim(shimDir, relative)
  const before = runner.replace(/^.*&\s*/, '').replace(/^@/, '').trim()
  if (!before) return /\.exe$/i.test(relative) ? { kind: 'exe', program: target } : null
  const prog = /^"%_prog%"(?:\s+(.*))?$/.exec(before)
  const oldNode = /^(?:"%~dp0\\node\.exe"|node)(?:\s+(.*))?$/i.exec(before)
  if (prog) {
    const named = lines.map((line) => /^SET\s+"_prog=([^"]+)"$/i.exec(line)?.[1]).filter((name): name is string => !!name)
    if (!named.length || !named.every((name) => /^(?:%dp0%\\node\.exe|node)$/i.test(name))) return null
  } else if (!oldNode) return null
  const extra = ((prog ?? oldNode)![1] ?? '').trim()
  if (extra && !/^[\w=.:+-]+(?:\s+[\w=.:+-]+)*$/.test(extra)) return null
  return { kind: 'node', script: target, nodeArgs: extra ? extra.split(/\s+/) : [] }
}

export interface WindowsEngineArgvOptions {
  environment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  read?: (file: string) => string
  /** The PE machine of a program (tests). */
  machine?: (file: string) => ReturnType<typeof peMachine>
}

/**
 * [argv] (an engine's program and its arguments) as a Windows pane should run it: the program resolved to its .exe or
 * npm shim (binaryOnPath.ts `windowsLaunchCommand`), an npm shim run as its node script or program, and any other
 * batch file refused when an argument holds a character cmd.exe reads. Unchanged off Windows.
 */
export function windowsEngineArgv(engine: string, argv: readonly string[], options: WindowsEngineArgvOptions = {}): string[] {
  const { environment = process.env, platform = process.platform, read = (file) => readFileSync(file, 'utf8'), machine = peMachine } = options
  const [command = '', ...args] = argv
  if (platform !== 'win32') return [...argv]
  const runs = (resolved: string[]): string[] => {
    const unavailable = windowsEngineUnavailable(engine, resolved[0]!, machine)
    if (unavailable) throw new WindowsEngineUnavailable(engine, unavailable)
    return resolved
  }
  const program = windowsLaunchCommand(command, environment, platform)
  if (!BATCH.test(program)) return runs([program, ...args])
  let shim: NpmShimTarget | null = null
  try { shim = exists(program) ? parseNpmCmdShim(read(program), dirname(program)) : null } catch { shim = null }
  if (shim?.kind === 'exe' && exists(shim.program)) return runs([shim.program, ...args])
  if (shim?.kind === 'node' && exists(shim.script)) {
    const beside = join(dirname(program), 'node.exe')
    const node = exists(beside) ? beside : windowsLaunchCommand('node', environment, platform)
    if (/\.exe$/i.test(node)) return runs([node, ...shim.nodeArgs, shim.script, ...args])
  }
  if (args.some((arg) => CMD_METACHARACTERS.test(arg))) throw new WindowsBatchLaunchRefused(engine, program)
  return runs([program, ...args])
}

/** A create's or fork's answer for [error] when it is a refused Windows launch, a batch file's or an unverified
 *  startup's (lib/windows/engineStart.ts), shown to the person as its detail; any other error is thrown on. */
export function windowsLaunchRefusal(error: unknown): { ok: false; error: 'ENGINE_LAUNCH_REFUSED'; detail: string } {
  if (error instanceof WindowsLaunchRefused) return { ok: false, error: 'ENGINE_LAUNCH_REFUSED', detail: error.message }
  throw error
}
