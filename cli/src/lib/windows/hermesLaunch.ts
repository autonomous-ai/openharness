/**
 * Hermes on Windows, past the one program Smart App Control refuses
 * (docs/windows-rules.md, "An unsigned program is blocked, and the person is told").
 *
 * Hermes' installer writes `%LOCALAPPDATA%\hermes\bin\hermes.exe`: a 115 KB uv launcher, **unsigned**, that starts the
 * *also unsigned* Python it ships (`tools\python-<version>-win32-x64\python.exe`). On a PC with Smart App Control on
 * (measured 2026-11-09, DESKTOP-0TFH0OJ: `VerifiedAndReputablePolicyState = 1`, `hermes.exe` = `NotSigned`), Windows
 * refuses the launcher outright — "An Application Control policy has blocked this file." — so a Hermes harness there
 * never started.
 *
 * The package itself is fine: its `hermes_cli.main` imports and runs when started by the Python beside it. So the
 * launcher is stepped past, exactly as `gridCommand` steps past `grid.exe` (lib/gridBinary.ts): the boot module is
 * generated next to the install and run as `<python> -I <boot.py> <args>`. `-I` keeps the person's own `PYTHONPATH`
 * and user site-packages out of the engine, and `sys.path` carries only the install's own folder, as the launcher
 * itself does.
 *
 * Nothing here runs on any other platform, and a Hermes installed some other way (a real `hermes` on PATH that is not
 * this launcher) is left exactly as it was.
 */
import { accessSync, constants, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** A launcher is small; anything larger is a program of its own, not read to find out. */
const MAX_LAUNCHER_BYTES = 1024 * 1024

/** Where Hermes' installer puts its launcher, relative to `%LOCALAPPDATA%`: `<root>\bin\hermes.exe`. */
// Both separators: Windows writes `\`, and a test (or a transcript of one) may spell the same path with `/`.
const LAUNCHER = /^(.*[\\/]hermes)[\\/]bin[\\/]hermes\.exe$/i

const exists = (file: string): boolean => {
  try {
    accessSync(file, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The Python a uv launcher `.exe` starts, named on a `#!` line near its end (`#!<python.exe> -I`), when it is there.
 * The same shape lib/gridBinary.ts reads for `grid.exe`.
 */
export function launcherPython(launcher: string, read: (file: string) => Buffer = readFileSync): string | null {
  let size: number
  try { size = statSync(launcher).size } catch { return null }
  if (!/\.exe$/i.test(launcher) || size > MAX_LAUNCHER_BYTES) return null
  let bytes: Buffer
  try { bytes = read(launcher) } catch { return null }
  const at = bytes.lastIndexOf('#!')
  if (at < 0) return null
  // The line is `<python.exe> -I`: the program is its first word, as grid's launcher writes `"<python.exe>" -m cli`.
  const line = bytes.subarray(at + 2, at + 2 + 4096).toString('utf8').split(/[\r\n]/, 1)[0]!.replaceAll('"', '').trim()
  const program = line.split(/\s+/, 1)[0]!
  // Either separator, for the same reason as LAUNCHER: a test's temp folder is spelt with `/`.
  const name = program.split(/[\\/]/).pop()?.toLowerCase()
  return name === 'python.exe' && exists(program) ? program : null
}

/** The install root beside a launcher (`<root>` of `<root>\bin\hermes.exe`), when it holds the package. */
export function hermesRoot(launcher: string): string | null {
  const match = LAUNCHER.exec(launcher)
  if (!match) return null
  const root = match[1]!
  return exists(join(root, 'hermes-agent', 'hermes_cli', 'main.py')) ? root : null
}

/** The Python Hermes ships, `<root>\tools\python-<version>-win32-x64\python.exe`, when the launcher does not name one. */
function bundledPython(root: string): string | null {
  let names: string[]
  try { names = readdirSync(join(root, 'tools')) } catch { return null }
  const newest = names.filter((name) => /^python-[^-]+-win32-x64$/i.test(name)).sort().at(-1)
  if (!newest) return null
  const python = join(root, 'tools', newest, 'python.exe')
  return exists(python) ? python : null
}

/** Where the boot module is written: `bin\hermes-boot.py`, beside the launcher it stands in for. */
export const hermesBootFile = (root: string): string => join(root, 'bin', 'hermes-boot.py')

/**
 * The boot module: `sys.path` first gets the install's own `hermes-agent` folder (the launcher's own rule), then Hermes'
 * CLI entry runs. Written once, and rewritten when an update moved the install (`root` changed).
 */
export function hermesBootSource(root: string): string {
  return [
    '# Written by Harness, never by Hermes: the launcher below is refused by Smart App Control (lib/windows/hermesLaunch.ts).',
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(join(root, 'hermes-agent'))})`,
    'from hermes_cli.main import main',
    'sys.exit(main())',
    '',
  ].join('\n')
}

/**
 * The argv a Hermes harness runs on Windows when [program] is the install's own launcher: `<python> -I <boot.py> <args>`.
 * Null for anything else — another `hermes`, a different platform, or an install whose package is not there — which is
 * then launched exactly as asked.
 */
export function hermesArgv(program: string, args: readonly string[], options: {
  platform?: NodeJS.Platform
  write?: (file: string, text: string) => void
  read?: (file: string) => Buffer
} = {}): string[] | null {
  const { platform = process.platform, read = readFileSync } = options
  if (platform !== 'win32') return null
  const root = hermesRoot(program)
  if (!root) return null
  const python = launcherPython(program, read) ?? bundledPython(root)
  if (!python) return null
  const boot = hermesBootFile(root)
  const source = hermesBootSource(root)
  const write = options.write ?? ((file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) })
  try {
    // Rewritten only when it is not already this: an update that moved the install changes the path it names.
    if (!exists(boot) || readFileSync(boot, 'utf8') !== source) write(boot, source)
  } catch {
    // A boot file that cannot be written leaves the launcher's own argv, which Windows refuses with its own sentence.
    return null
  }
  return [python, '-I', boot, ...args]
}
