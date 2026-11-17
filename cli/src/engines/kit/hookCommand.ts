/** Literal argument quoting shared by core launch authority and optional hook rendering. */
import { win32 } from 'node:path'
import { HookPreparationHeld } from './hookHeld.js'

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * What runs an engine's hook command. Each engine declares it for Windows (facets/hooks.ts `HookSettings.win32Runner`,
 * nativeHookSettings.ts `NativeHookSettings.win32Runner`). Off Windows every engine runs its hooks in a POSIX shell (`bash`).
 * - `argv`: the engine starts the program with its arguments and no shell (Claude Code's exec form, `command` + `args`).
 * - `bash`: a POSIX shell reads the line.
 * - `cmd`: `cmd.exe` reads it, meant for a line the engine wraps in quotes (`/d /s /c "…"` — Command Code via Node's
 *   shell:true). It refuses `" % ! & | < > ^ ( )` and a trailing backslash rather than escape them.
 * - `powershell`: PowerShell reads it (Copilot CLI's `command` fills its `powershell` field on Windows; Codex runs it with
 *   `powershell.exe -NoProfile -Command`, its Windows session shell).
 */
export type HookRunner = 'argv' | 'bash' | 'cmd' | 'powershell'

const BARE_WORD = /^[A-Za-z0-9_-]+$/
const refuse = (reason: string): never => { throw new HookPreparationHeld(`a hook argument ${reason}`) }

/**
 * [argv] as [runner] takes it: the list itself for `argv`; for the others, one line that [runner] splits back into
 * exactly these arguments. Words (`--port`, `18473`, `codex`) stay bare and everything else is quoted, so the POSIX
 * line is byte for byte what every release wrote. An argument a runner would read as anything but itself is refused,
 * never escaped. The line holds only Harness's own paths and flags, so a path with such a character holds the hook
 * install with a reason.
 */
export function quoteHookCommand(runner: HookRunner, argv: string[]): string | string[] {
  if (!argv.length) refuse('list is empty')
  for (const arg of argv) {
    if (typeof arg !== 'string') refuse('is not text')
    if (/[\0\r\n]/.test(arg)) refuse('holds a line break or NUL, which no hook runner passes whole')
  }
  switch (runner) {
    case 'argv': return [...argv]
    case 'bash': return argv.map((arg) => BARE_WORD.test(arg) ? arg : shellQuote(arg)).join(' ')
    case 'cmd': return argv.map(withoutTrailingSeparators).map((arg) => {
      // cmd.exe expands %…% (and !…! with delayed expansion) even inside quotes, and a quote ends them. `& | < > ^ ( )`
      // are refused too, in case an engine does not wrap the line: unquoted, cmd.exe reads them as its own syntax. A
      // trailing backslash would escape the closing quote for the program's own parser (CommandLineToArgvW's rules).
      if (/["%!&|<>^()]/.test(arg)) refuse('holds one of " % ! & | < > ^ ( ), which cmd.exe reads as more than text')
      if (arg.endsWith('\\')) refuse('ends in a backslash, which would escape its closing quote')
      return BARE_WORD.test(arg) ? arg : `"${arg}"`
    }).join(' ')
    case 'powershell': return `& ${argv.map(withoutTrailingSeparators).map((arg) => {
      // Inside single quotes PowerShell reads only a quote, typographic ones too. Windows PowerShell 5.1 passes a
      // double quote inside an argument to a native program unescaped.
      if (arg === '') refuse('is empty, which Windows PowerShell 5.1 drops')
      if (arg.endsWith('\\')) refuse('ends in a backslash, which would escape its closing quote')
      if (/["\u2018\u2019\u201a\u201b]/.test(arg)) refuse('holds a double or typographic quote, which PowerShell passes on differently')
      return BARE_WORD.test(arg) ? arg : `'${arg.replace(/'/g, "''")}'`
    }).join(' ')}`
  }
}

/**
 * A Windows folder without its trailing backslashes, which name the same folder: `CODEX_HOME=C:\codex\`, as the
 * environment dialog takes a folder, turned that engine's hooks off as "ends in a backslash" (final review R2-3). A root
 * (`C:\`, `\\server\share\`) has nothing to drop, and anything that is not an absolute path is left as it is.
 */
function withoutTrailingSeparators(arg: string): string {
  if (!win32.isAbsolute(arg)) return arg
  const root = win32.parse(arg).root
  let end = arg.length
  while (end > root.length && arg[end - 1] === '\\') end--
  return arg.slice(0, end)
}

