#!/usr/bin/env node
/**
 * Claude Code's status line command for every session Harness launches (engines/kit/statusLine.ts, task #4137).
 *
 * Self-contained: node built-ins only, no dependency on the adapter's node_modules (it runs inside the person's
 * `claude` process, as hook/notify.mjs does). The CLI writes this file into its data folder at launch
 * (`__STATUS_LINE_SCRIPT__`), so an installed CLI needs nothing beside cli.js.
 *
 *   node statusline.mjs --data <harness data folder> [--then <base64url of the person's own status line command>]
 *
 * Claude Code hands its status line command a JSON status on stdin, with the plan's rate limits in it
 * (`rate_limits.five_hour` / `seven_day`: `used_percentage` 0-100, `resets_at` in epoch seconds; null for an API key).
 * Those numbers, and nothing else of the status, go to `<data>/quota/claude-<sha256(CLAUDE_CONFIG_DIR)[0..16]>.json`,
 * which the daemon reads for the router's quota (lib/quotaReports.ts). Then the person's own command runs with the
 * same input and its output is the status line, exactly as without Harness. Nothing in the recording may stop that:
 * every error there is swallowed.
 */

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

/** A window as the report keeps it, or null when Claude Code reported none or a percentage that is not one. */
function windowOf(value) {
  if (!value || typeof value !== 'object') return null
  const used = value.used_percentage
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return null
  const resets = value.resets_at
  return { used_percentage: used, resets_at: typeof resets === 'number' && Number.isFinite(resets) ? resets : null }
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
  const key = createHash('sha256').update(process.env.CLAUDE_CONFIG_DIR || '').digest('hex').slice(0, 16)
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

async function main() {
  const input = await readInput()
  try { record(input, option('--data')) } catch { /* never in the way of the person's own line */ }
  const command = ownCommand()
  if (!command) process.exit(0)
  // Through the shell, as Claude Code runs a status line command. No window on Windows, and no `detached`.
  const child = spawn(command, { shell: true, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true })
  child.on('error', () => process.exit(1))
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
  // A command that does not read its input closes the pipe early.
  child.stdin.on('error', () => {})
  child.stdin.end(input)
}

main().catch(() => process.exit(0))
