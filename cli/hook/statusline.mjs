#!/usr/bin/env node
/**
 * Claude Code's status line command for every session Harness launches (engines/kit/statusLine.ts, task #4137).
 *
 * Self-contained: node built-ins only, no dependency on the adapter's node_modules (it runs inside the person's
 * `claude` process, as hook/notify.mjs does). The CLI writes this file into its data folder at launch
 * (`__STATUS_LINE_SCRIPT__`), so an installed CLI needs nothing beside cli.js.
 *
 *   node statusline.mjs --data <harness data folder> [--then <base64url of the person's own status line command>]
 *     [--bash <the Git Bash Claude Code runs status lines in, on Windows>]
 *
 * Claude Code hands its status line command a JSON status on stdin, with the plan's rate limits in it
 * (`rate_limits.five_hour` / `seven_day`: `used_percentage` 0-100, `resets_at` in epoch seconds; null for an API key).
 * Those numbers, and nothing else of the status, go to `<data>/quota/claude-<sha256(reportKey(CLAUDE_CONFIG_DIR))[0..16]>.json`,
 * which the daemon reads for the router's quota (lib/quotaReports.ts). Then the person's own command runs with the
 * same input and its output is the status line, exactly as without Harness. Nothing in the recording may stop that:
 * every error there is swallowed.
 */

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'

// Claude Code closes stdin once it has written the status. Should it not, the person's line still shows, a little late.
const INPUT_WAIT_MS = 2000
// Claude Code runs the status line at every message and on its refresh. The report is rewritten when the windows
// change, and else at most once a minute, so its `at` says the numbers are current without a write per refresh.
const REWRITE_AFTER_MS = 60_000

function option(name) {
  const at = process.argv.indexOf(name)
  return at > 0 && at + 1 < process.argv.length ? process.argv[at + 1] : null
}

function readInput() {
  return new Promise((resolve) => {
    const chunks = []
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(Buffer.concat(chunks))
    }
    const timer = setTimeout(() => { finish(); process.stdin.destroy() }, INPUT_WAIT_MS)
    process.stdin.on('data', (chunk) => chunks.push(chunk))
    process.stdin.on('end', finish)
    process.stdin.on('error', finish)
  })
}

/** A reset time in epoch seconds: given so, or as an ISO 8601 string. */
function resetSeconds(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const ms = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(ms) ? ms / 1000 : null
}

/**
 * A window as the report keeps it, or null when Claude Code reported none or a percentage that is not one. Its status
 * line docs name the fields `used_percentage` and epoch-second `resets_at`; 2.1.316's own schema for the same windows
 * names them `utilization` (0-100) with an ISO `resets_at`. Either is read.
 */
function windowOf(value) {
  if (!value || typeof value !== 'object') return null
  const used = value.used_percentage ?? value.utilization
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null
  // A window Claude Code ran past reads above 100: used up, not unmeasured (#4252).
  return { used_percentage: Math.min(used, 100), resets_at: resetSeconds(value.resets_at) }
}

/** The real path, in the case the file system keeps; the path itself while there is none. */
function realPath(path) {
  try { return realpathSync.native(path) } catch { return path }
}

/**
 * What names the report of a Claude config folder: '' for the default one (unset, or `~/.claude` however written), else
 * its absolute real path. lib/quotaReports.ts claudeReportKey is the same rule: the daemon reads the folder from its
 * own launch environment, which may spell it otherwise than this session's shell.
 */
function reportKey(configDir) {
  const dir = configDir?.trim()
  if (!dir) return ''
  const key = realPath(resolve(dir))
  return key === realPath(join(homedir(), '.claude')) ? '' : key
}

function record(input, data) {
  if (!data) return
  const limits = JSON.parse(input.toString('utf8'))?.rate_limits
  if (!limits || typeof limits !== 'object') return
  const windows = {}
  for (const name of ['five_hour', 'seven_day']) {
    const window = windowOf(limits[name])
    if (window) windows[name] = window
  }
  if (!Object.keys(windows).length) return
  const folder = join(data, 'quota')
  const key = createHash('sha256').update(reportKey(process.env.CLAUDE_CONFIG_DIR)).digest('hex').slice(0, 16)
  const file = join(folder, `claude-${key}.json`)
  try {
    const { at, five_hour, seven_day } = JSON.parse(readFileSync(file, 'utf8'))
    const same = JSON.stringify({ five_hour, seven_day }) === JSON.stringify({ five_hour: windows.five_hour, seven_day: windows.seven_day })
    if (same && Date.now() - at < REWRITE_AFTER_MS) return
  } catch { /* none yet, or unreadable: written below */ }
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  // Renamed into place, so the daemon never reads half a report; two sessions of one folder: the last one wins.
  const temporary = join(folder, `.claude-${key}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    writeFileSync(temporary, JSON.stringify({ v: 1, at: Date.now(), ...windows }), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function ownCommand() {
  try {
    const encoded = option('--then')
    return encoded ? Buffer.from(encoded, 'base64url').toString('utf8') || null : null
  } catch {
    return null
  }
}

/**
 * [command] as Claude Code 2.1.316 runs a status line in Git Bash on Windows (task #4164): a line whose first word, unquoted,
 * is a `.sh` file runs as `bash <line>`.
 */
function asGitBashRunsIt(command) {
  const line = command.trim()
  let first = ''
  for (let i = 0; i < line.length;) {
    const c = line[i]
    if (c === '"' || c === "'") {
      const end = line.indexOf(c, i + 1)
      if (end === -1) { first += line.slice(i + 1); break }
      first += line.slice(i + 1, end)
      i = end + 1
    } else if (c === '\\' && i + 1 < line.length) {
      first += line[i + 1]
      i += 2
    } else if (/\s/.test(c)) {
      break
    } else {
      first += c
      i++
    }
  }
  return first.endsWith('.sh') ? `bash ${command}` : command
}

/** [env] with [folder] first on its PATH, whatever its key's case, as Claude Code starts Git Bash. */
function firstOnPath(env, folder) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  return { ...env, [key]: env[key] ? folder + delimiter + env[key] : folder }
}

async function main() {
  const input = await readInput()
  try { record(input, option('--data')) } catch { /* never in the way of the person's own line */ }
  const command = ownCommand()
  if (!command) process.exit(0)
  // Through the shell, as Claude Code runs a status line command. No window on Windows, and no `detached`.
  const bash = option('--bash')
  const child = bash
    ? spawn(asGitBashRunsIt(command), { shell: bash, env: firstOnPath(process.env, dirname(bash)), stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true })
    : spawn(command, { shell: true, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true })
  child.on('error', () => process.exit(1))
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
  // A command that does not read its input closes the pipe early.
  child.stdin.on('error', () => {})
  child.stdin.end(input)
}

main().catch(() => process.exit(0))
