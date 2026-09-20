/**
 * Undoing the provider a grid launch left behind in Codex's own state.
 *
 * Codex does not resolve its provider from argv alone. From 0.155 it records one PER THREAD in
 * `<CODEX_HOME>/state_5.sqlite` (`threads.model_provider`), written at launch from whatever
 * `-c model_provider=` said. The grid contract says `grid` there (`gridLaunch.ts`), and defines what
 * `grid` means in the SAME argv — so the name is persisted while its definition is not.
 *
 * Move the agent back to its own login and that asymmetry is the bug: the harness correctly stops
 * passing every `-c model_providers.grid.*`, `codex resume` loads the thread row, and resolving it
 * fails before the TUI is up —
 *
 *   thread/resume failed: failed to load configuration: Model provider `grid` not found (code -32600)
 *
 * — which the daemon can only answer by giving up on the session and starting a fresh one
 * ("[restart] codex did not come back up resuming its session — retrying fresh"). The conversation
 * survives on disk and is never reached again, which is exactly what `subscriptionModel.ts` and
 * `portableHistory.ts` exist to prevent.
 *
 * So the move back names a provider too, rather than only un-naming the grid's. Measured against
 * codex-cli 0.155.1: argv OUTRANKS the stored row, so this repairs a thread that is already
 * poisoned rather than only keeping the next one clean — no database is read, written, or migrated.
 *
 * ## Why the user's own config is read first
 *
 * `openai` is Codex's default, not its only answer: a `model_provider` at the top of the user's
 * `config.toml` is their standing choice for every Codex they run, and a harness that overwrote it
 * with `openai` would move them off their own provider as the price of leaving a grid. So the file
 * is asked first and `openai` is the fallback — the same value Codex itself would have picked.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentEngine } from '../../engines/types.js'

/** What Codex uses when nothing configures otherwise. */
export const CODEX_DEFAULT_PROVIDER = 'openai'

/**
 * The top-level `model_provider` in a Codex `config.toml`, or null.
 *
 * TOP-LEVEL only, and that is the whole subtlety: in TOML every key after a `[header]` belongs to
 * that table, so `model_provider` under `[profiles.work]` is that profile's and not the file's.
 * Reading it as the file's would hand Codex a provider the user selected for something else. Bare
 * keys stop at the first header for that reason.
 */
export function parseCodexModelProvider(toml: string): string | null {
  for (const raw of toml.split('\n')) {
    const line = stripComment(raw).trim()
    if (!line) continue
    // The first table header ends the top level; anything after it is scoped to that table.
    if (line.startsWith('[')) return null
    const match = /^model_provider\s*=\s*(?:"([^"]*)"|'([^']*)')\s*$/.exec(line)
    if (match) {
      const value = (match[1] ?? match[2] ?? '').trim()
      return value || null
    }
  }
  return null
}

/** Drop a trailing `#` comment, but not one inside a quoted value. */
function stripComment(line: string): string {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) { if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '#') return line.slice(0, i)
  }
  return line
}

/** Where Codex keeps its configuration — the same resolution `prepareCodexResume` uses. */
export function codexConfigPath(codexHome: string | null | undefined, env = process.env): string {
  return join(codexHome || env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml')
}

/** Read a Codex `config.toml`; an unreadable or absent file is "nothing configured", not an error. */
function readCodexConfig(path: string): string | null {
  try { return readFileSync(path, 'utf8') } catch { return null }
}

/**
 * The argv that puts `engine` back on its own provider, or nothing when there is none to put back.
 *
 * Only Codex: it is the one engine here that persists a provider of its own accord. Claude Code and
 * Hermes read theirs from the environment or argv every launch, so dropping the grid's is already
 * the whole of the move, and OpenCode's lives in a configuration file this daemon writes and can
 * therefore stop writing.
 */
export function ownLoginProviderArgs(
  engine: AgentEngine,
  codexHome: string | null | undefined,
  deps: { read?: (path: string) => string | null; env?: NodeJS.ProcessEnv } = {},
): string[] {
  if (engine !== 'codex') return []
  const read = deps.read ?? readCodexConfig
  const toml = read(codexConfigPath(codexHome, deps.env ?? process.env))
  const configured = toml ? parseCodexModelProvider(toml) : null
  return ['-c', `model_provider="${configured ?? CODEX_DEFAULT_PROVIDER}"`]
}
