/** Hook script identity and refusal state retained by the caller that owns launch authority. */
import { existsSync } from 'node:fs'
import { dirname, join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from '../../config/env.js'
import { insideWindowsRoots } from '../../lib/secureState.js'
import { STABLE_NOTIFY } from '../../lib/windows/installNames.js'
import { HookScriptMissing } from './hookHeld.js'
import { hostPlatform } from './windowsFiles.js'
import type { AgentEngine } from '../types.js'

/** The engines whose hook lines run notify.mjs; the others (OpenCode, Pi, Amp, …) report through a plugin of their own. */
export type NotifyEngine = 'claude' | 'codex' | 'cursor' | 'hermes' | 'commandcode' | 'devin' | 'grok' | 'agy' | 'copilot'

// notify.mjs location depends on the layout (import.meta.url is the REAL executing file at runtime):
//  - packaged/bundled: cli.js at ~/.harness/cli/cli.js → notify.mjs is a SIBLING (dist/ bundle too).
//  - a core or service started from the lean bundle (leanCoreEntry.ts / leanEntry.ts): its file is lean/<sha>/ in the data folder, which
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

/**
 * The engines whose hook install was refused because notify.mjs was not there. Only they are told it is missing: an engine
 * whose hooks do not run it, that installs none here (no Windows runner), or whose hooks are off was never refused for it,
 * and blaming the file would hide the reason that does clear by waiting (#3954 review).
 */
const refusedForScript = new Set<string>()

/** The notify.mjs every hook line names, when it is not there; null when it is. With [engine], null too unless that
 *  engine's install was refused for it. */
export function missingHookScript(engine?: string): string | null {
  if (engine !== undefined && !refusedForScript.has(engine)) return null
  return existsSync(HOOK_SCRIPT) ? null : HOOK_SCRIPT
}

/** Refuses [engine]'s install when its hook lines would name a notify.mjs that is not there ([HookScriptMissing]). */
export function noteMissingHookScript(engine: AgentEngine): void {
  refusedForScript.add(engine)
}

export function requireHookScript(engine: NotifyEngine): void {
  const missing = missingHookScript()
  if (!missing) return
  noteMissingHookScript(engine)
  throw new HookScriptMissing(missing)
}
