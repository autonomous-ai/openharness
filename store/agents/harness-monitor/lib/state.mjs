/**
 * What a person decided, and what Harness Monitor did about it — read and written through one module so
 * the CLI and the pane can never disagree about where anything lives.
 *
 * The rules and pins are `~/.config/harness/policy.jsonc`; the resume tickets and the log are under
 * `~/.harness/monitor/` (lib/config.mjs has why). The only file left in the WORKSPACE is the verdict,
 * because that is the one file Harness itself reads, and it reads it from the workspace.
 */

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appendLog, migrateWorkspace, readConfig, readLogFile, readTickets, updateConfig, writeTickets } from './config.mjs'
import { DEFAULT_POLICY, normalizePolicy } from './policy.mjs'

export function verdictPath(workspace) { return join(workspace, '.harness', 'verdict.json') }

export const EMPTY_STATE = { spec: 1, policy: { ...DEFAULT_POLICY }, pins: [], paused: {} }

/** Write through a temp file in the same directory: a reader must never see half of it. */
export async function atomicJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, path)
}

/** The rules, the pins and the tickets, as one object. `workspace` is only consulted to carry an older
 *  per-workspace file forward the first time it is seen. */
export async function readState(workspace, env = process.env) {
  if (workspace) await migrateWorkspace(workspace, env).catch(() => null)
  const { path, policy, pins } = await readConfig(env)
  const merged = { ...DEFAULT_POLICY, ...policy, protect: { ...DEFAULT_POLICY.protect, ...(policy.protect ?? {}) } }
  // A typo must fail here, at the edge, where the message can name the file — not three layers down inside
  // a rule while the fleet waits.
  try { normalizePolicy(merged) } catch (error) { throw new Error(`${path}: ${error.message}`) }
  return { spec: 1, policy: merged, pins, paused: await readTickets(env), configPath: path }
}

/** Persist what the program changed: the tickets always, the pins only when they moved. The rules are
 *  never rewritten from here — a person's file is changed key by key through `updateConfig`, or not at all. */
export async function writeState(workspace, state, env = process.env) {
  await writeTickets(state.paused ?? {}, env)
  const { pins } = await readConfig(env)
  const next = [...new Set(state.pins ?? [])]
  if (next.length !== pins.length || next.some((id) => !pins.includes(id))) await updateConfig({ pins: next }, env)
  return state
}

/** The policy thresholds, changed in place in the person's own file — comments and all. */
export function savePolicyValues(values, env = process.env) {
  return updateConfig(values, env)
}

/** Append a receipt. A log that cannot be written must not undo an action that already happened. */
export async function record(workspace, entry, env = process.env) { await appendLog(entry, env) }

export async function readLog(workspace, { limit = 200 } = {}, env = process.env) { return readLogFile({ limit }, env) }

/**
 * The pane header, in Harness's own words.
 *
 * `ready` means the fleet is inside its policy: nothing is waiting to be paused, nothing is
 * over the ceiling. That makes the header a live answer to "is my machine tidy?" rather than a build
 * status, which is the only useful reading for a harness that manages other harnesses.
 */
export async function writeVerdict(workspace, { summary, rows, plan, problems = [] }) {
  const findings = []
  const overdue = plan.filter((entry) => entry.action === 'pause').length
  if (overdue) findings.push({ severity: 'warn', kind: 'idle', message: `${overdue} running ${overdue === 1 ? 'harness is' : 'harnesses are'} past the pause threshold, holding ${gb(plan.filter((e) => e.action === 'pause').reduce((sum, e) => sum + (e.frees || 0), 0))}` })
  if (summary.needsInput) findings.push({ severity: 'warn', kind: 'attention', message: `${summary.needsInput} ${summary.needsInput === 1 ? 'harness looks' : 'harnesses look'} like they are waiting on you` })
  for (const problem of problems) findings.push({ severity: 'error', kind: 'machine', message: `${problem.machine}: ${problem.error}` })
  const verdict = {
    spec: 1,
    ready: overdue === 0 && problems.length === 0,
    summary: `${summary.total} harnesses · ${summary.running} running · ${summary.paused} paused · ${gb(summary.held)} held`,
    findings,
    updatedAt: new Date().toISOString(),
  }
  await atomicJson(verdictPath(workspace), verdict)
  return verdict
}

export function gb(bytes) {
  const n = Number(bytes) || 0
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`
  return `${Math.round(n / 1024)} KB`
}

/**
 * The ticket back, written the moment a harness is paused.
 *
 * The daemon releases an engine from its row when the process leaves, and the row's session id goes with
 * it — the transcript is still on disk, but nothing would know which conversation belonged to this agent.
 * So pause's receipt is kept here, and resume reads it. This is the one piece of state Harness Monitor cannot afford
 * to lose, which is why it is written before the success is reported.
 */
export function markPaused(state, row, ticket) {
  if (!ticket?.sessionId) return state
  return { ...state, paused: { ...state.paused, [row.id]: { at: Date.now(), ...ticket } } }
}

export function clearPaused(state, id) {
  const paused = { ...state.paused }
  delete paused[id]
  return { ...state, paused }
}

/** Pin and unpin — the only edits a person makes to this file by hand, kept here so the CLI and
 *  the viewer cannot drift on what a record looks like. */
export function pin(state, id, on) {
  const pins = new Set(state.pins)
  if (on) pins.add(id); else pins.delete(id)
  return { ...state, pins: [...pins] }
}

/** Forget is the hps's own bookkeeping and nothing else: the row leaves `monitor.json`. No transcript,
 *  no tmux session, no registry entry is touched here — those belong to the engine and the daemon. */
export function forget(state, id) {
  return clearPaused(pin(state, id, false), id)
}
