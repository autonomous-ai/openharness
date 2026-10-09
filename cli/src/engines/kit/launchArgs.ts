/**
 * The argv an engine's launch contract declares as templates (facets/launch.ts): its harness context flag,
 * its session variables as flags, and the provider it goes back to off a grid. Shared mechanics, run in core
 * on the declaration alone: a launch is session control and waits on no engine worker.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ContextArgsTemplate, EnvArgsTemplate, OwnProviderContract } from '../facets/launch.js'

/** `{key}` in `text` replaced by `value`, as written: never read as a `$` replacement pattern. */
const fill = (text: string, key: string, value: string): string => text.split(`{${key}}`).join(value)

/** The context flag's argv for `file`. */
export function contextArgsOf(template: ContextArgsTemplate): (file: string) => string[] {
  return (file) => template.args.map((arg) => fill(arg, 'file', JSON.stringify(file)))
}

/** The session's variables as argv, in their order, those whose names the engine cannot take left out. */
export function envArgsOf(template: EnvArgsTemplate): (env: Record<string, string>) => string[] {
  return (env) => Object.entries(env)
    .filter(([name]) => template.name.test(name))
    .flatMap(([name, value]) => [template.flag, fill(fill(template.setting, 'name', name), 'value', JSON.stringify(value))])
}

/**
 * The value of a top-level `key = "…"` (or `'…'`) in a TOML file, or null: empty, absent, or only inside a
 * table. TOP-LEVEL only: every key after a `[header]` belongs to that table, so the first header ends the
 * search. A deliberately small reader for one key, never a TOML parser.
 */
export function topLevelString(toml: string, key: string): string | null {
  const pattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(?:"([^"]*)"|'([^']*)')\\s*$`)
  for (const raw of toml.split('\n')) {
    const line = stripComment(raw).trim()
    if (!line) continue
    // The first table header ends the top level; anything after it is scoped to that table.
    if (line.startsWith('[')) return null
    const match = pattern.exec(line)
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

/** Read a config file; an unreadable or absent one is "nothing configured", not an error. */
function readConfig(path: string): string | null {
  try { return readFileSync(path, 'utf8') } catch { return null }
}

/**
 * The argv that names the engine's own provider again, read from `home`: the person's top-level choice, else
 * the engine's own default. A relaunch is never blocked by a file that is absent or unreadable: the default
 * is a correct answer for both.
 */
export function ownProviderArgs(own: OwnProviderContract, home: string, read: (path: string) => string | null = readConfig): string[] {
  const toml = read(join(home, own.file))
  const value = (toml ? topLevelString(toml, own.key) : null) ?? own.fallback
  return own.args.map((arg) => fill(arg, 'value', value))
}
