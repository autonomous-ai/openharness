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

export function command(
  port: number,
  engine: 'claude' | 'codex' | 'cursor' | 'hermes' | 'commandcode' | 'devin' | 'grok' | 'agy' | 'copilot',
  // Only ever non-default for 'codex': a per-agent CODEX_HOME profile gets its OWN hooks.json, and
  // that file's baked --codex-home must match where it actually lives (see installCodexHooks).
  codexHome: string = env.CODEX_HOME,
  // Same rule for Hermes, and it was broken the same way: a `hermes -p <name>` profile has its own
  // config.yaml, and the block in it carried the DEFAULT home — so the hook looked the session up in
  // a store it was not in (openharness#191). See installHermesHooks.
  hermesHome: string = env.HERMES_HOME,
  environment?: Readonly<Record<string, string>>,
): string {
  const homes = environment ? nativeHookLocations(environment) : { ...env, CURSOR_HOME: cursorDataDir() }
  return [
    // Absolute, never the bare word `node`. This string is executed later by the ENGINE, in a shell
    // whose PATH is none of our business — and since the product ships its own Node, a computer with
    // no `node` on PATH is normal. See managedNodePath(); a changed interpreter is picked up by the
    // same drift comparison each installer already does for a changed path or port.
    shellQuote(managedNodePath()),
    shellQuote(HOOK_SCRIPT),
    '--port', String(port),
    '--data-dir', shellQuote(env.ADAPTER_DATA_DIR),
    '--claude-projects-dir', shellQuote(homes.CLAUDE_PROJECTS_DIR),
    '--codex-home', shellQuote(environment ? homes.CODEX_HOME : codexHome),
    '--grok-home', shellQuote(homes.GROK_HOME),
    '--cursor-home', shellQuote(homes.CURSOR_HOME),
    '--hermes-home', shellQuote(environment ? homes.HERMES_HOME : hermesHome),
    '--commandcode-home', shellQuote(homes.COMMANDCODE_HOME),
    '--devin-home', shellQuote(homes.DEVIN_HOME),
    '--agy-home', shellQuote(homes.AGY_HOME),
    '--copilot-home', shellQuote(homes.COPILOT_HOME),
    ...(engine !== 'claude' ? ['--engine', engine] : []),
  ].join(' ')
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
