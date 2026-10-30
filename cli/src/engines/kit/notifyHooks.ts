/** The notify.mjs command and JSON merge primitives shared by shell-hook engines. */
import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from '../../config/env.js'
import { engineName } from '../../lib/agentNames.js'
import { managedNodePath } from '../../lib/nodeRuntime.js'
import { insideWindowsRoots } from '../../lib/secureState.js'
import { STABLE_NOTIFY } from '../../lib/windows/installLayout.js'
import { HookPreparationHeld } from './nativeHookFiles.js'
import { cursorDataDir } from '../cursor/contract.js'
import { nativeHookLocations } from './nativeLocations.js'
import { hostPlatform } from './windowsFiles.js'

// notify.mjs location depends on the layout (import.meta.url is the REAL executing file at runtime):
//  - packaged/bundled: cli.js at ~/.harness/cli/cli.js → notify.mjs is a SIBLING (dist/ bundle too).
//  - a core started from the lean bundle (leanEntry.ts): its file is lean/<sha>/ in the data folder, which
//    holds no notify.mjs, and its script (process.argv[1]) is the cli.js it was read from: the sibling of that.
//  - dev/per-file:      notifyHooks.js at <appRoot>/{src,dist}/engines/kit/ → ../../../hook/notify.mjs.
// Prefer the sibling, fall back to the dev path.
const cliDir = dirname(fileURLToPath(import.meta.url))

/**
 * Where notify.mjs is, best first. Windows' installed layout (lib/windows/installLayout.ts) keeps one CLI folder per
 * version, with a stable `cli\notify.mjs` beside them that the updater refreshes. The hook lines name that one, so
 * they do not change at each update, and Codex does not ask to review them again.
 */
export function hookScriptCandidates(dir: string, script: string | undefined, platform: NodeJS.Platform = hostPlatform(),
  cliRoot: string = env.ADAPTER_CLI_DIR): string[] {
  const stable = platform === 'win32' && insideWindowsRoots(dir, [cliRoot]) ? [win32.join(cliRoot, STABLE_NOTIFY)] : []
  return [...stable, join(dir, 'notify.mjs'), ...(script ? [join(dirname(script), 'notify.mjs')] : []), join(dir, '..', '..', '..', 'hook', 'notify.mjs')]
}
export const HOOK_SCRIPT = hookScriptCandidates(cliDir, process.argv[1]).find(existsSync) ?? join(cliDir, '..', '..', '..', 'hook', 'notify.mjs')

/** An engine that declares no Windows hook runner gets no hooks there. That is said once per install and is not a failure. */
export function hooksNotOnWindows(engine: string): true {
  console.log(`[hooks] ${engine} hooks are not installed on Windows yet`)
  return true
}

/**
 * The log line for an install that did not happen, when [error] says why: on Windows one sentence, no stack. A refused
 * hook line (quoteHookCommand) or a held file is the person's to read, and a stack trace there buried the reason (B4.10
 * VM log). Null for any other error or platform: the caller logs as before, so mac and Linux logs do not change.
 */
export function hooksNotInstalled(engine: NotifyEngine, error: unknown, platform: NodeJS.Platform): string | null {
  if (platform !== 'win32' || !(error instanceof HookPreparationHeld)) return null
  return `[hooks] ${engineName(engine)} hooks are not installed: ${error.reason}`
}

/**
 * A hook rule as a preparation's identity names it (`runHookPreparation`'s `identity`: a refresh and a launch with
 * the same one share a preparation). Off Windows `win32Runner` is left out, so the identity is byte for byte what it
 * was before Windows hooks: mac and Linux do not change. The other keys keep their order.
 */
export function identitySettings<T extends object>(settings: T, platform: NodeJS.Platform = hostPlatform()): T | Omit<T, 'win32Runner'> {
  if (platform === 'win32') return settings
  const { win32Runner: _runner, ...rest } = settings as T & { win32Runner?: unknown }
  return rest
}

export interface CommandHook {
  type: string
  command: string
  /** Exec form: the program in `command`, these its arguments, no shell (Claude Code on Windows, B4.6). */
  args?: string[]
  timeout?: number
}
export interface HookBlock {
  matcher?: string
  hooks: CommandHook[]
}
export type Settings = { hooks?: Record<string, HookBlock[]> } & Record<string, unknown>

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

type NotifyEngine = 'claude' | 'codex' | 'cursor' | 'hermes' | 'commandcode' | 'devin' | 'grok' | 'agy' | 'copilot'

/** notify.mjs's argument list for [engine]: the managed Node, the script, and Harness's own flags. No user input. */
export function hookArgv(
  port: number,
  engine: NotifyEngine,
  // Only ever non-default for 'codex': a per-agent CODEX_HOME profile gets its OWN hooks.json, and
  // that file's baked --codex-home must match where it actually lives (see installCodexHooks).
  codexHome: string = env.CODEX_HOME,
  // Same rule for Hermes, and it was broken the same way: a `hermes -p <name>` profile has its own
  // config.yaml, and the block in it carried the DEFAULT home — so the hook looked the session up in
  // a store it was not in (openharness#191). See installHermesHooks.
  hermesHome: string = env.HERMES_HOME,
  environment?: Readonly<Record<string, string>>,
): string[] {
  const homes = environment ? nativeHookLocations(environment) : { ...env, CURSOR_HOME: cursorDataDir() }
  return [
    // Absolute, never the bare word `node`. This string is executed later by the ENGINE, in a shell
    // whose PATH is none of our business — and since the product ships its own Node, a computer with
    // no `node` on PATH is normal. See managedNodePath(); a changed interpreter is picked up by the
    // same drift comparison each installer already does for a changed path or port.
    managedNodePath(),
    HOOK_SCRIPT,
    '--port', String(port),
    '--data-dir', env.ADAPTER_DATA_DIR,
    '--claude-projects-dir', homes.CLAUDE_PROJECTS_DIR,
    '--codex-home', environment ? homes.CODEX_HOME : codexHome,
    '--grok-home', homes.GROK_HOME,
    '--cursor-home', homes.CURSOR_HOME,
    '--hermes-home', environment ? homes.HERMES_HOME : hermesHome,
    '--commandcode-home', homes.COMMANDCODE_HOME,
    '--devin-home', homes.DEVIN_HOME,
    '--agy-home', homes.AGY_HOME,
    '--copilot-home', homes.COPILOT_HOME,
    ...(engine !== 'claude' ? ['--engine', engine] : []),
  ]
}

/** The hook line for a shell runner: POSIX `bash` everywhere but Windows, where the caller names its engine's runner. */
export function command(
  port: number,
  engine: NotifyEngine,
  codexHome: string = env.CODEX_HOME,
  hermesHome: string = env.HERMES_HOME,
  environment?: Readonly<Record<string, string>>,
  runner: Exclude<HookRunner, 'argv'> = 'bash',
): string {
  return quoteHookCommand(runner, hookArgv(port, engine, codexHome, hermesHome, environment)) as string
}

/** The words of a POSIX shell line as `sh` splits it; null for anything but literal words. */
function posixWords(value: string): string[] | null {
  const args: string[] = []
  let word = '', active = false, quote = ''
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (quote) {
      if (char === quote) { quote = ''; continue }
      if (quote === '"' && /[$`\\]/.test(char)) return null
      word += char; continue
    }
    if (char === "'" || char === '"') { quote = char; active = true; continue }
    if (char === '\\') {
      if (++index === value.length || /[\r\n]/.test(value[index])) return null
      word += value[index]; active = true; continue
    }
    if (/[\r\n]/.test(char)) return null
    if (/[ \t]/.test(char)) { if (active) { args.push(word); word = ''; active = false }; continue }
    if (/[;&|<>$`(){}*?\[\]~#]/.test(char)) return null
    word += char; active = true
  }
  if (quote) return null
  if (active) args.push(word)
  return args
}

// Exactly what quoteHookCommand writes: it refuses the characters excluded here, a trailing backslash (cmd, PowerShell)
// and an empty argument (PowerShell), so a line holding one was written by somebody else.
const CMD_WORD = /"([^"%!&|<>^()]*)"|([A-Za-z0-9_-]+)/y
const POWERSHELL_WORD = /'((?:[^'"\u2018\u2019\u201a\u201b]|'')+)'|([A-Za-z0-9_-]+)/y

/** Words separated by one space, each matching [word] whole; null otherwise. */
function separatedWords(text: string, word: RegExp, unquote: (quoted: string) => string): string[] | null {
  const words: string[] = []
  let at = 0
  while (at < text.length) {
    if (words.length) { if (text[at] !== ' ') return null; at++ }
    word.lastIndex = at
    const match = word.exec(text)
    if (!match) return null
    const quoted = match[1] !== undefined
    if (quoted && /\\$/.test(unquote(match[1]))) return null
    words.push(quoted ? unquote(match[1]) : match[2])
    at = word.lastIndex
  }
  return words.length ? words : null
}

/** The words of a Windows hook line as quoteHookCommand writes it: cmd.exe's (`"…"`) or PowerShell's (`& '…'`). */
function windowsWords(value: string): string[] | null {
  if (/[\0\r\n]/.test(value)) return null
  if (value.startsWith('& ')) return separatedWords(value.slice(2), POWERSHELL_WORD, (quoted) => quoted.replace(/''/g, "'"))
  return separatedWords(value, CMD_WORD, (quoted) => quoted)
}

const LEGACY_SCRIPT = /\/\.harness\/cli\/(?:hook\/)?notify\.mjs$/
const NODE = /^(?:node|nodejs)(?:\.exe)?$/
const WINDOWS_NODE = /^(?:node|nodejs)(?:\.exe)?$/i
// POSIX path rules for a POSIX-quoted line on every host: on Windows, `C:\…` inside sh quotes is no line Harness writes,
// and the win32 rules took a person's look-alike for Harness's (carried B4.2, final review R2-1).
const POSIX_LINE_PATH = { basename: posix.basename, isAbsolute: posix.isAbsolute }

/** Harness's protocol: a literal Node, an absolute notify.mjs, and only Harness's flags, each once. */
function managedArgs(args: string[], path: Pick<typeof win32, 'basename' | 'isAbsolute'>, node: RegExp, legacy: boolean): boolean {
  if (!node.test(path.basename(args[0] ?? '')) || !path.isAbsolute(args[1] ?? '') || path.basename(args[1] ?? '') !== 'notify.mjs') return false
  // The original positional protocol was installed only under Harness's own
  // CLI directory. Later commands identify the data root explicitly.
  if (legacy && args.length === 4 && LEGACY_SCRIPT.test(args[1])
    && /^\d+$/.test(args[2]) && /^(?:claude|codex)$/.test(args[3])) return true
  const flags = new Map<string, string>()
  for (let index = 2; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1]
    if (!/^--(?:port|data-dir|claude-projects-dir|(?:codex|grok|cursor|hermes|commandcode|devin|agy|copilot)-home|engine|event|agy-event|copilot-event)$/.test(key)
      || value === undefined || flags.has(key)) return false
    flags.set(key, value)
  }
  return /^\d+$/.test(flags.get('--port') ?? '') && path.isAbsolute(flags.get('--data-dir') ?? '')
}

/** Accept only a literal Node invocation with Harness's protocol arguments.
 * A foreign script sharing the notify.mjs basename is not ours to remove. On Windows, the cmd.exe and PowerShell
 * lines quoteHookCommand writes are literal invocations too. */
export function isManagedHookCommand(value: unknown, platform: NodeJS.Platform = process.platform): boolean {
  if (typeof value !== 'string' || value.length > 64 * 1024) return false
  const words = posixWords(value)
  if (words && managedArgs(words, POSIX_LINE_PATH, NODE, true)) return true
  if (platform !== 'win32') return false
  const windows = windowsWords(value)
  return !!windows && managedArgs(windows, win32, WINDOWS_NODE, false)
}

/** One hook of an engine's settings: a line, or on Windows exec form (Claude Code's `command` + `args`). */
export function isManagedHook(hook: { type?: unknown; command?: unknown; args?: unknown } | null | undefined, platform: NodeJS.Platform = process.platform): boolean {
  if (!hook || typeof hook !== 'object') return false
  // On win32 any `args` key (even `[]`) sends a hook to the exec-form check, so a line-form hook with a stray `args` is not ours: the safe direction.
  if (hook.args === undefined || platform !== 'win32') return isManagedHookCommand(hook.command, platform)
  return typeof hook.command === 'string' && Array.isArray(hook.args) && hook.args.length <= 64
    && hook.args.every((arg) => typeof arg === 'string' && !/[\0\r\n]/.test(arg))
    && managedArgs([hook.command, ...hook.args as string[]], win32, WINDOWS_NODE, false)
}

export function isOurs(block: HookBlock, platform: NodeJS.Platform = process.platform): boolean {
  return Array.isArray(block?.hooks) && block.hooks.some(hook => isManagedHook(hook, platform))
}

/** A managed command can share a block with somebody else's command. Updating
 * ours must keep those siblings and the block's matcher and other fields. */
export function foreignHookBlocks(blocks: HookBlock[], owns: (block: HookBlock) => boolean = isOurs): HookBlock[] {
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || !Array.isArray(block.hooks) || block.hooks.some(hook =>
      !hook || typeof hook !== 'object' || (hook.command !== undefined && typeof hook.command !== 'string'))) {
      throw new HookPreparationHeld('a hook block has an unconfirmed shape')
    }
  }
  return blocks.flatMap(block => {
    if (!owns(block)) return [block]
    const hooks = block.hooks.filter(hook => !owns({ hooks: [hook] }))
    return hooks.length ? [{ ...block, hooks }] : []
  })
}
