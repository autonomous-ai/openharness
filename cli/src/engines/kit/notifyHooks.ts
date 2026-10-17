/** The notify.mjs command and JSON merge primitives shared by shell-hook engines. */
import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from '../../config/env.js'
import { managedNodePath } from '../../lib/nodeRuntime.js'
import { HookPreparationHeld } from './nativeHookFiles.js'
import { cursorDataDir } from '../cursor/contract.js'
import { nativeHookLocations } from './nativeLocations.js'

// notify.mjs location depends on the layout (import.meta.url is the REAL executing file at runtime):
//  - packaged/bundled: cli.js at ~/.harness/cli/cli.js → notify.mjs is a SIBLING (dist/ bundle too).
//  - a core started from the lean bundle (leanEntry.ts): its file is lean/<sha>/ in the data folder, which
//    holds no notify.mjs, and its script (process.argv[1]) is the cli.js it was read from: the sibling of that.
//  - dev/per-file:      notifyHooks.js at <appRoot>/{src,dist}/engines/kit/ → ../../../hook/notify.mjs.
// Prefer the sibling, fall back to the dev path.
const cliDir = dirname(fileURLToPath(import.meta.url))
export const HOOK_SCRIPT =
  [join(cliDir, 'notify.mjs'), ...(process.argv[1] ? [join(dirname(process.argv[1]), 'notify.mjs')] : []), join(cliDir, '..', '..', '..', 'hook', 'notify.mjs')].find(existsSync) ??
  join(cliDir, '..', '..', '..', 'hook', 'notify.mjs')

interface CommandHook {
  type: string
  command: string
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
 * - `cmd`: `cmd.exe /C` reads it (the line is meant for a wrapping `cmd /s /c "…"`, so it refuses `" % ! & | < > ^ ( )` and a trailing backslash rather than escape them) (Codex 0.162 runs `%COMSPEC% /C "<line>"`; Command Code runs it through Node's `shell: true`).
 * - `powershell`: PowerShell reads it (Copilot CLI's `command` fills its `powershell` field on Windows).
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
    case 'cmd': return argv.map((arg) => {
      // cmd.exe expands %…% (and !…! with delayed expansion) even inside quotes, and a quote ends them. A trailing
      // backslash would escape the closing quote for the program's own parser (CommandLineToArgvW's rules).
      if (/["%!&|<>^()]/.test(arg)) refuse('holds one of " % ! & | < > ^ ( ), which cmd.exe reads as more than text')
      if (arg.endsWith('\\')) refuse('ends in a backslash, which would escape its closing quote')
      return BARE_WORD.test(arg) ? arg : `"${arg}"`
    }).join(' ')
    case 'powershell': return `& ${argv.map((arg) => {
      // Inside single quotes PowerShell reads only a quote, typographic ones too. Windows PowerShell 5.1 passes a
      // double quote inside an argument to a native program unescaped.
      if (arg === '') refuse('is empty, which Windows PowerShell 5.1 drops')
      if (arg.endsWith('\\')) refuse('ends in a backslash, which would escape its closing quote')
      if (/["\u2018\u2019\u201a\u201b]/.test(arg)) refuse('holds a double or typographic quote, which PowerShell passes on differently')
      return BARE_WORD.test(arg) ? arg : `'${arg.replace(/'/g, "''")}'`
    }).join(' ')}`
  }
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

/** Accept only a literal Node invocation with Harness's protocol arguments.
 * A foreign script sharing the notify.mjs basename is not ours to remove. */
export function isManagedHookCommand(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 64 * 1024) return false
  const args: string[] = []
  let word = '', active = false, quote = ''
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (quote) {
      if (char === quote) { quote = ''; continue }
      if (quote === '"' && /[$`\\]/.test(char)) return false
      word += char; continue
    }
    if (char === "'" || char === '"') { quote = char; active = true; continue }
    if (char === '\\') {
      if (++index === value.length || /[\r\n]/.test(value[index])) return false
      word += value[index]; active = true; continue
    }
    if (/[\r\n]/.test(char)) return false
    if (/[ \t]/.test(char)) { if (active) { args.push(word); word = ''; active = false }; continue }
    if (/[;&|<>$`(){}*?\[\]~#]/.test(char)) return false
    word += char; active = true
  }
  if (quote) return false
  if (active) args.push(word)
  if (!/^(?:node|nodejs)(?:\.exe)?$/.test(basename(args[0] ?? '')) || !isAbsolute(args[1] ?? '') || basename(args[1] ?? '') !== 'notify.mjs') return false
  // The original positional protocol was installed only under Harness's own
  // CLI directory. Later commands identify the data root explicitly.
  if (args.length === 4 && /\/\.harness\/cli\/(?:hook\/)?notify\.mjs$/.test(args[1])
    && /^\d+$/.test(args[2]) && /^(?:claude|codex)$/.test(args[3])) return true
  const flags = new Map<string, string>()
  for (let index = 2; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1]
    if (!/^--(?:port|data-dir|claude-projects-dir|(?:codex|grok|cursor|hermes|commandcode|devin|agy|copilot)-home|engine|event|agy-event|copilot-event)$/.test(key)
      || value === undefined || flags.has(key)) return false
    flags.set(key, value)
  }
  return /^\d+$/.test(flags.get('--port') ?? '') && isAbsolute(flags.get('--data-dir') ?? '')
}

export function isOurs(block: HookBlock): boolean {
  return Array.isArray(block?.hooks) && block.hooks.some(hook => isManagedHookCommand(hook?.command))
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
