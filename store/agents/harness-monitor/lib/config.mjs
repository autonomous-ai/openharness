/**
 * Where the rules live, and where the bookkeeping lives — one of each per machine.
 *
 *   ~/.config/harness/policy.jsonc   the rules, and `pins`. Written for a person: commented, hand-edited,
 *                                    next to `keybindings.jsonc`. $XDG_CONFIG_HOME is respected.
 *   ~/.harness/monitor/paused.json (legacy filename)   the open tickets. Written by the program, never by a person.
 *   ~/.harness/monitor/log.jsonl     one line per stop and open, with the rule that caused it.
 *
 * Machine-wide on purpose. The first version kept all three inside the Harness Monitor workspace, which
 * meant a second workspace got a second policy, and a harness stopped from one could not be reopened from
 * the other because its ticket was in the wrong folder. There is one fleet per machine; there is one
 * policy and one ticket book per machine.
 */

import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { DEFAULT_POLICY } from './policy.mjs'

export function configPath(env = process.env) {
  if (env.HARNESS_MONITOR_CONFIG) return env.HARNESS_MONITOR_CONFIG
  const base = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(env.HOME || homedir(), '.config')
  return join(base, 'harness', 'policy.jsonc')
}

export function stateDir(env = process.env) {
  return env.HARNESS_MONITOR_STATE || join(env.HOME || homedir(), '.harness', 'monitor')
}
export const ticketsPath = (env) => join(stateDir(env), 'paused.json')
export const logPath = (env) => join(stateDir(env), 'log.jsonl')

/** JSONC → JSON: comments and trailing commas out, strings untouched. The same dialect as the app's own
 *  `keybindings.jsonc`, so a person who has edited one has edited both. */
export function stripJsonc(text) {
  let out = '', i = 0, inString = false
  while (i < text.length) {
    const c = text[i], next = text[i + 1]
    if (inString) {
      out += c
      if (c === '\\') { out += next ?? ''; i += 2; continue }
      if (c === '"') inString = false
      i += 1; continue
    }
    if (c === '"') { inString = true; out += c; i += 1; continue }
    if (c === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i += 1; continue }
    if (c === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 2; continue }
    out += c; i += 1
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

/** The file a person opens. Every key says what it does and what it costs, because this is the only
 *  documentation most people will ever read about the policy. */
export function template(policy = DEFAULT_POLICY) {
  return `// Harness Monitor — the rules for this machine's harnesses.
//
// Edit this file and review Cleanup in the Harness Monitor table. It is read on every refresh, so a
// save takes effect within seconds. Preview any change without moving anything:  hps stop --policy
//
// Rules only propose stopping sessions. Apply a reviewed plan explicitly; nothing runs automatically.
// The daemon retains history and launch settings. Open behavior depends on the engine's resumeMode.
{
  // Most engines running at once on each machine. Cleanup proposes stopping the least recently active.
  // Lower it on a machine that swaps: free memory divided by ~300 MB per harness.
  "runningCeiling": ${policy.runningCeiling},

  // Untouched this long (time since the last real turn) and a harness is stopped.
  "stopAfterIdle": "${policy.stopAfterIdle}",

  // Untouched this long and it drops out of the default list. Still there under --all; nothing is stopped
  // or removed by this — it only decides what you see.
  "hideAfterIdle": "${policy.hideAfterIdle}",

  // A harness whose folder no longer exists is stopped, whatever its idle time.
  "stopWhenWorkspaceGone": ${policy.stopWhenWorkspaceGone},

  // What is never stopped, by any rule.
  "protect": {
    "needsInput": ${policy.protect.needsInput},   // daemon reports a pending question
    "working": ${policy.protect.working},      // daemon reports an open turn
    "attached": ${policy.protect.attached},     // reserved; current daemon inventory does not report attachment
    "pinned": ${policy.protect.pinned}        // listed in "pins" below
  },

  // Composite machine/agent ids the rules must never stop. \`hps --json --all --machines\` shows each id.
  "pins": []
}
`
}

/** Read the rules, writing the commented default the first time so there is always a file to open. */
export async function readConfig(env = process.env) {
  const path = configPath(env)
  let text
  try { text = await readFile(path, 'utf8') }
  catch {
    text = template()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text, { flag: 'wx' }).catch(() => {}) // someone else may have just written it
  }
  let parsed
  try { parsed = JSON.parse(stripJsonc(text)) }
  catch (error) { throw new Error(`${path}: not valid JSON (${error.message}). Fix it, or delete it to get the defaults back.`) }
  const { pins = [], ...policy } = parsed && typeof parsed === 'object' ? parsed : {}
  return { path, text, policy, pins: Array.isArray(pins) ? pins.filter((id) => typeof id === 'string') : [] }
}

/**
 * Change values in the rules file without losing a person's comments.
 *
 * Only the keys given are touched, each by rewriting its own `"key": value` in place — the file is never
 * regenerated. A key the file does not have is added to the top-level object. The pane uses this for its
 * two draggable lines and its pin button; nothing else writes this file.
 */
export async function updateConfig(changes, env = process.env) {
  const { path, text } = await readConfig(env)
  let next = text
  for (const [key, value] of Object.entries(changes)) {
    const json = JSON.stringify(value)
    const pattern = new RegExp(`("${key}"\\s*:\\s*)(\\[[^\\]]*\\]|"[^"]*"|-?\\d+(?:\\.\\d+)?|true|false|null)`)
    if (pattern.test(next)) next = next.replace(pattern, (_, lead) => `${lead}${json}`)
    else next = next.replace(/\{/, `{\n  "${key}": ${json},`)
  }
  JSON.parse(stripJsonc(next)) // never write a file that will not read back
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, next)
  await rename(temp, path)
  return path
}

export async function readTickets(env = process.env) {
  try {
    const parsed = JSON.parse(await readFile(ticketsPath(env), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

export async function writeTickets(tickets, env = process.env) {
  const path = ticketsPath(env)
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(tickets, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, path)
}

export async function appendLog(entry, env = process.env) {
  try {
    await mkdir(stateDir(env), { recursive: true })
    await appendFile(logPath(env), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
  } catch { /* the receipt is a courtesy, not the action */ }
}

export async function readLogFile({ limit = 200 } = {}, env = process.env) {
  try {
    const lines = (await readFile(logPath(env), 'utf8')).split('\n').filter(Boolean).slice(-limit)
    return lines.map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean).reverse()
  } catch { return [] }
}

/**
 * Carry the old per-workspace file forward, once.
 *
 * Tickets and pins are DATA — a harness stopped under the old layout must still be openable — so they are
 * merged into the machine files. The old POLICY is not carried over: it was the stricter default, and a
 * machine-wide file starting from it would undo the reason the file moved.
 */
export async function migrateWorkspace(workspace, env = process.env) {
  const old = join(workspace, 'monitor.json')
  if (!existsSync(old)) return null
  let parsed
  try { parsed = JSON.parse(await readFile(old, 'utf8')) } catch { return null }
  if (parsed?.migrated) return null
  const tickets = await readTickets(env)
  let moved = 0
  for (const [id, ticket] of Object.entries(parsed?.stopped ?? parsed?.paused ?? {})) {
    if (!tickets[id]) { tickets[id] = ticket; moved += 1 }
  }
  if (moved) await writeTickets(tickets, env)
  const pins = Array.isArray(parsed?.pins) ? parsed.pins : []
  if (pins.length) {
    const { pins: current } = await readConfig(env)
    await updateConfig({ pins: [...new Set([...current, ...pins])] }, env)
  }
  await writeFile(old, `${JSON.stringify({ migrated: true, to: { rules: configPath(env), tickets: ticketsPath(env) }, at: new Date().toISOString() }, null, 2)}\n`)
  return { tickets: moved, pins: pins.length }
}
