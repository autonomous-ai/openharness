/** The notify.mjs command and JSON merge primitives shared by shell-hook engines. */
import { existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from '../../config/env.js'
import { managedNodePath } from '../../lib/nodeRuntime.js'
import { cursorDataDir } from '../cursor/contract.js'

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
): string {
  return [
    // Absolute, never the bare word `node`. This string is executed later by the ENGINE, in a shell
    // whose PATH is none of our business — and since the product ships its own Node, a computer with
    // no `node` on PATH is normal. See managedNodePath(); a changed interpreter is picked up by the
    // same drift comparison each installer already does for a changed path or port.
    shellQuote(managedNodePath()),
    shellQuote(HOOK_SCRIPT),
    '--port', String(port),
    '--data-dir', shellQuote(env.ADAPTER_DATA_DIR),
    '--claude-projects-dir', shellQuote(env.CLAUDE_PROJECTS_DIR),
    '--codex-home', shellQuote(codexHome),
    '--grok-home', shellQuote(env.GROK_HOME),
    '--cursor-home', shellQuote(cursorDataDir()),
    '--hermes-home', shellQuote(hermesHome),
    '--commandcode-home', shellQuote(env.COMMANDCODE_HOME),
    '--devin-home', shellQuote(env.DEVIN_HOME),
    '--agy-home', shellQuote(env.AGY_HOME),
    '--copilot-home', shellQuote(env.COPILOT_HOME),
    ...(engine !== 'claude' ? ['--engine', engine] : []),
  ].join(' ')
}

/** True if a block already points at our notify.mjs script (any path — robust across layout/version). */
export function isOurs(block: HookBlock): boolean {
  return Array.isArray(block?.hooks) && block.hooks.some((h) => h?.command?.includes('notify.mjs'))
}

export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, file)
}
