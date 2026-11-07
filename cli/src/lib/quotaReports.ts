/**
 * Claude Code's allowance as Claude Code reports it: the status line Harness gives every Claude session it starts
 * (hook/statusline.mjs) writes the `rate_limits` of Claude Code's status-line JSON to a small file per config folder,
 * and the daemon reads it here. Harness never opens Claude's sign-in to ask (#4137).
 *
 * `{ "v": 1, "at": <ms>, "five_hour": { "used_percentage", "resets_at" }, "seven_day": { … } }`, written by rename, so a
 * read sees a whole file. It holds only percentages, reset times (unix seconds, as Claude Code gives them) and when.
 */
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export type UsageProviderId = 'claude' | 'codex'

/**
 * An account, as the wire names it: the first 16 hex characters of sha256(`<provider>:<id>`).
 *
 * Hashed rather than sent raw because the reply is LOGGED: the desktop writes every RPC answer to `~/.harness/logs`,
 * and a raw account id has no business there.
 *
 * ⚠️ **A cross-language contract.** The desktop computes the same key for its own account
 * (`lib/usage/usage_account_key.dart`) and the two must agree byte for byte, or every remote reading would look like
 * a different account. Both test suites pin the same vector for that reason.
 */
export function accountKey(provider: UsageProviderId, accountId: string): string {
  return createHash('sha256').update(`${provider}:${accountId}`).digest('hex').slice(0, 16)
}

export interface ClaudeReportWindow { used_percentage: number; resets_at: number | null }
export interface ClaudeReport { at: number; five_hour?: ClaudeReportWindow; seven_day?: ClaudeReportWindow }

/**
 * What names the report of the Claude config folder [configDir] (CLAUDE_CONFIG_DIR): '' for the default folder, unset
 * or however it is written, else its absolute real path. The status line (hook/statusline.mjs) carries the same rule:
 * it reads the folder from the session's shell and the daemon from its launch environment, which may spell one
 * folder two ways (#4252).
 */
export function claudeReportKey(configDir?: string, home = homedir()): string {
  const dir = configDir?.trim()
  if (!dir) return ''
  const key = realPath(resolve(dir))
  return key === realPath(join(home, '.claude')) ? '' : key
}

/** The report for the Claude config folder [configDir] (CLAUDE_CONFIG_DIR), by its key (`claudeReportKey`). */
export function claudeReportPath(dataDir: string, configDir?: string): string {
  return reportFile(dataDir, claudeReportKey(configDir))
}

/** The last report for [configDir], or null when there is none or it is not a version-1 report with a window in it. */
export function readClaudeReport(dataDir: string, configDir?: string): ClaudeReport | null {
  let raw: unknown
  try { raw = JSON.parse(readFileSync(claudeReportPath(dataDir, configDir), 'utf8')) } catch {
    // A status line from before the key rule named the file after the raw variable. Until 2026-12-07 (30 days).
    try { raw = JSON.parse(readFileSync(reportFile(dataDir, configDir ?? ''), 'utf8')) } catch { return null }
  }
  const file = record(raw)
  if (!file || file.v !== 1 || !finite(file.at)) return null
  const five_hour = windowOf(file.five_hour), seven_day = windowOf(file.seven_day)
  if (!five_hour && !seven_day) return null
  return { at: file.at, ...(five_hour ? { five_hour } : {}), ...(seven_day ? { seven_day } : {}) }
}

function windowOf(raw: unknown): ClaudeReportWindow | null {
  const w = record(raw)
  if (!w || !finite(w.used_percentage) || w.used_percentage < 0 || w.used_percentage > 100) return null
  if (w.resets_at !== null && w.resets_at !== undefined && !finite(w.resets_at)) return null
  return { used_percentage: w.used_percentage, resets_at: finite(w.resets_at) ? w.resets_at : null }
}

const reportFile = (dataDir: string, key: string) => join(dataDir, 'quota', `claude-${createHash('sha256').update(key).digest('hex').slice(0, 16)}.json`)
// The native call gives the case the file system keeps (macOS, Windows), so one folder typed two ways is one key.
const realPath = (path: string) => { try { return realpathSync.native(path) } catch { return path } }
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const record = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
