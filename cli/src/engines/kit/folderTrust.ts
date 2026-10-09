/**
 * An engine's folder trust, read and recorded as its launch contract declares it (facets/launch.ts
 * `TrustContract`). For a workspace Harness itself just made EMPTY there is nothing in it to review, so the
 * daemon records the answer the way the engine does, in the file the engine launched there actually reads.
 * Moved from lib/claudeTrust.ts, whose every write it reproduces (engines/launchPrep.golden.spec.ts).
 *
 * ⚠️ Never for a folder with content the person has not been asked about (a clone, their own repo, a worktree
 * of one): that answer is theirs. The callers decide (core/agents/create.ts, launches.ts). A worktree only
 * inherits the answer its source repo already has.
 *
 * Only ever ADDS trust, never removes anything, and does nothing when the engine has never run here (no
 * file), when the file does not parse, or when it already says yes.
 */
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import type { TrustContract } from '../facets/launch.js'

type JsonTrust = Extract<TrustContract, { format: 'json' }>
type TomlTrust = Extract<TrustContract, { format: 'toml' }>

/** Whether the engine already trusts `path`, by the settings in `file`. */
export function trustsIn(trust: TrustContract, file: string, path: string): boolean {
  return trust.format === 'json' ? jsonTrusts(trust, file, path) : tomlTrusts(trust, file, path)
}

/** Record trust in `cwd` in `file`. */
export function recordTrustIn(trust: TrustContract, file: string, cwd: string): 'trusted' | 'already' | 'skipped' {
  return trust.format === 'json' ? recordJson(trust, file, cwd) : recordToml(trust, file, cwd)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Replace a config file atomically, THROUGH a symlink. Dotfile managers keep `~/.claude.json` and
 * `~/.codex/config.toml` as links into a repo; renaming a temporary file over the link itself would
 * swap it for a plain file and quietly detach the person's dotfiles.
 */
export function replaceConfigFile(file: string, text: string): void {
  const target = realpathSync(file)
  const tmp = `${target}.harness-${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, target)
}

function recordJson(trust: JsonTrust, file: string, cwd: string): 'trusted' | 'already' | 'skipped' {
  if (!existsSync(file)) return 'skipped'
  let config: unknown
  try {
    config = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return 'skipped'
  }
  // Anything but the shape the engine writes is left exactly as it is: writing trust into an array,
  // or spreading a string entry into an object, would rewrite what the person has.
  if (!isPlainObject(config)) return 'skipped'
  if (config[trust.projects] !== undefined && !isPlainObject(config[trust.projects])) return 'skipped'
  const projects = (config[trust.projects] ?? {}) as Record<string, unknown>
  const existing = projects[cwd]
  if (existing !== undefined && !isPlainObject(existing)) return 'skipped'
  if (existing?.[trust.accepted] === true) return 'already'
  projects[cwd] = { ...structuredClone(trust.entry), ...(existing ?? {}), [trust.accepted]: true }
  config[trust.projects] = projects
  replaceConfigFile(file, JSON.stringify(config, null, 2))
  return 'trusted'
}

/** Its own entry, or a folder above it, says yes: the inheritance Claude Code applies. Unreadable or absent
 *  settings read as no. */
function jsonTrusts(trust: JsonTrust, file: string, path: string): boolean {
  if (!existsSync(file)) return false
  let config: unknown
  try { config = JSON.parse(readFileSync(file, 'utf8')) } catch { return false }
  if (!isPlainObject(config) || !isPlainObject(config[trust.projects])) return false
  for (const [key, entry] of Object.entries(config[trust.projects] as Record<string, unknown>)) {
    if (!isPlainObject(entry) || entry[trust.accepted] !== true) continue
    const base = key.replace(/\/+$/, '')
    if (path === base || path.startsWith(`${base}/`)) return true
  }
  return false
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A `[<table>.<key>]` header, however it is spaced or quoted. */
const headerPattern = (trust: TomlTrust): RegExp =>
  new RegExp(String.raw`^[ \t]*\[[ \t]*${escape(trust.table)}[ \t]*\.[ \t]*("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')[ \t]*\]`, 'gm')
/** The table defined any other way: an inline table, dotted keys, or a bare `[<table>]`. */
const otherwisePattern = (trust: TomlTrust): RegExp =>
  new RegExp(String.raw`^[ \t]*(?:${escape(trust.table)}[ \t]*[.=]|\[[ \t]*${escape(trust.table)}[ \t]*\])`, 'm')

/** The key a quoted TOML key names; null for an escape JSON does not share (`\U0001F600`). */
function tomlKey(quoted: string): string | null {
  if (quoted.startsWith("'")) return quoted.slice(1, -1)
  try { return JSON.parse(quoted) as string } catch { return null }
}

/** Exactly `path`, by its own table's value, which runs to the next header. */
function tomlTrusts(trust: TomlTrust, file: string, path: string): boolean {
  if (!existsSync(file)) return false
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(headerPattern(trust))) {
    if (tomlKey(match[1]) !== path) continue
    const rest = text.slice((match.index ?? 0) + match[0].length)
    const body = rest.split(/^[ \t]*\[/m)[0]
    return new RegExp(String.raw`^[ \t]*${escape(trust.key)}[ \t]*=[ \t]*["']${escape(trust.value)}["']`, 'm').test(body)
  }
  return false
}

/**
 * The table is appended at the end, never rewriting what is there. Appending is only safe when nothing else
 * defines that table: the same folder under another quoting, or the table written as an inline table or
 * dotted keys, would make the appended table a duplicate definition, a file the engine refuses to load.
 * Those are left alone.
 */
function recordToml(trust: TomlTrust, file: string, cwd: string): 'trusted' | 'already' | 'skipped' {
  if (!existsSync(file)) return 'skipped'
  const text = readFileSync(file, 'utf8')
  const keys = [...text.matchAll(headerPattern(trust))].map((match) => tomlKey(match[1]))
  if (keys.includes(cwd)) return 'already'
  // A key this cannot read might be this folder spelled another way: not safe to append after.
  if (keys.includes(null) || otherwisePattern(trust).test(text)) return 'skipped'
  // A TOML basic string is a JSON string, except that DEL must be escaped too.
  const header = `[${trust.table}.${JSON.stringify(cwd).replace(/\x7f/g, '\\u007f')}]`
  replaceConfigFile(file, `${text.replace(/\s*$/, '')}\n\n${header}\n${trust.key} = ${JSON.stringify(trust.value)}\n`)
  return 'trusted'
}
