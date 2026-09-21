/**
 * Claude Code asks "do you trust this folder?" the first time it opens a project. For a workspace
 * Harness itself just made — a fresh `~/harnesses/codex-2026-09-17-15-26`, or a harness template it laid out —
 * the answer is the one the person already gave by clicking Create, so the daemon records it the
 * way Claude Code does: `projects[<path>].hasTrustDialogAccepted` in `~/.claude.json`.
 *
 * Only ever ADDS trust for a folder the daemon created; never touches a folder the person chose
 * themselves, never removes anything, and does nothing when Claude Code has never run here (no
 * `~/.claude.json`), when the file does not parse, or when the entry already says yes.
 */
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Replace a config file atomically, THROUGH a symlink. Dotfile managers keep `~/.claude.json` and
 * `~/.codex/config.toml` as links into a repo; renaming a temporary file over the link itself would
 * swap it for a plain file and quietly detach the person's dotfiles.
 */
function replaceConfigFile(file: string, text: string): void {
  const target = realpathSync(file)
  const tmp = `${target}.harness-${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, target)
}

export function preTrustClaudeProject(cwd: string, home = homedir()): 'trusted' | 'already' | 'skipped' {
  const file = join(home, '.claude.json')
  if (!existsSync(file)) return 'skipped'
  let config: unknown
  try {
    config = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return 'skipped'
  }
  // Anything but the shape Claude Code writes is left exactly as it is: writing trust into an array,
  // or spreading a string entry into an object, would rewrite what the person has.
  if (!isPlainObject(config)) return 'skipped'
  if (config.projects !== undefined && !isPlainObject(config.projects)) return 'skipped'
  const projects = (config.projects ?? {}) as Record<string, unknown>
  const existing = projects[cwd]
  if (existing !== undefined && !isPlainObject(existing)) return 'skipped'
  if (existing?.hasTrustDialogAccepted === true) return 'already'
  projects[cwd] = { allowedTools: [], ...(existing ?? {}), hasTrustDialogAccepted: true }
  config.projects = projects
  replaceConfigFile(file, JSON.stringify(config, null, 2))
  return 'trusted'
}

/** A `[projects.<key>]` header, however it is spaced or quoted. */
const CODEX_PROJECT_HEADER_RE = /^[ \t]*\[[ \t]*projects[ \t]*\.[ \t]*("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')[ \t]*\]/gm
/** `projects` defined any other way: an inline table, dotted keys, or a bare `[projects]` table. */
const CODEX_PROJECTS_OTHERWISE_RE = /^[ \t]*(?:projects[ \t]*[.=]|\[[ \t]*projects[ \t]*\])/m

/** The key a quoted TOML key names; null for an escape JSON does not share (`\U0001F600`). */
function tomlKey(quoted: string): string | null {
  if (quoted.startsWith("'")) return quoted.slice(1, -1)
  try { return JSON.parse(quoted) as string } catch { return null }
}

/**
 * Codex keeps the same answer in `~/.codex/config.toml` as a `[projects."<path>"]` table with
 * `trust_level = "trusted"`. Same rules: only a folder the daemon made, only when Codex has a
 * config here, never rewriting what is there — the table is appended at the end.
 *
 * Appending is only safe when nothing else defines that table. The same folder under another quoting,
 * or `projects` written as an inline table or dotted keys, would make the appended table a duplicate
 * definition — a config.toml Codex refuses to load. Those are left alone.
 */
export function preTrustCodexProject(cwd: string, home = homedir()): 'trusted' | 'already' | 'skipped' {
  const file = join(home, '.codex', 'config.toml')
  if (!existsSync(file)) return 'skipped'
  const text = readFileSync(file, 'utf8')
  const keys = [...text.matchAll(CODEX_PROJECT_HEADER_RE)].map((match) => tomlKey(match[1]))
  if (keys.includes(cwd)) return 'already'
  // A key this cannot read might be this folder spelled another way: not safe to append after.
  if (keys.includes(null) || CODEX_PROJECTS_OTHERWISE_RE.test(text)) return 'skipped'
  // A TOML basic string is a JSON string, except that DEL must be escaped too.
  const header = `[projects.${JSON.stringify(cwd).replace(/\x7f/g, '\\u007f')}]`
  replaceConfigFile(file, `${text.replace(/\s*$/, '')}\n\n${header}\ntrust_level = "trusted"\n`)
  return 'trusted'
}
