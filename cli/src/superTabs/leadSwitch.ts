/**
 * A project's Product Manager switched to another engine from its own pane, as any pane is (Change agent; Dee, 11-01: "PM is
 * just an agent/pane like in v1"). Its stop is the one exception to "a Lead is never closed" (retention.ts mayBeLead), and a
 * narrow one (Lead, 11-01):
 * - Only a close that names the switch's change id passes, and only when this machine's own handoff receipt shows its owner
 *   prepared that very switch of that very agent moments ago (core handoffPublication: `agent_handoff_prepare` answers the
 *   owner alone). A plain close or Stop Harness names none and is refused as before.
 * - The switch is recorded here when its close passes, one per Product Manager: a second switch while it runs is refused.
 * - While it runs, this machine's host does not reopen the stopped Product Manager (superTabs/host.ts keepAlive), so the new
 *   session can take its place (replacements.ts, then the backend's agent.rebind keeps the same Swarm agent, its lead and its
 *   work). Not reported within SWITCH_HOLD_MS, the hold ends and the host reopens the old one on its old engine: a project
 *   never has none, and never two.
 * The record is a file, so a restart in the middle keeps the hold and its time limit.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { handoffHash } from '../lib/handoffAuthority.js'
import { readPrivateStateFile, secureStateDirectory, syncStateDirectory } from '../lib/secureState.js'
import { mayBeLead as retainedLead } from './retention.js'
import { identifier, object } from './wire.js'

/** How soon after its owner prepared the switch its close must come (Desktop closes at once after preparing). */
export const SWITCH_ARM_MS = 2 * 60_000
/** How long the stop its close started may pass the core's stop guard, in this process only. */
export const SWITCH_STOP_MS = 60_000
/** How long the host waits for the new session before it reopens the old one. */
export const SWITCH_HOLD_MS = 3 * 60_000
/** Ended records go after a day; each Product Manager has at most one. */
const KEEP_MS = 24 * 60 * 60_000
const CHANGE_ID = /^[0-9a-f]{32}$/
const MAX_RECEIPT_BYTES = 20 * 1024 * 1024

interface LeadSwitch { version: 1; agentId: string; changeId: string; targetEngine: string; at: number }

const folder = (dataDir: string) => join(dataDir, 'super-tabs', 'lead-switch')
const fileOf = (dataDir: string, agentId: string) => join(folder(dataDir), `${createHash('sha256').update(agentId).digest('hex')}.json`)

/** The stops this process let through for a switch, until when. A restart forgets them, which only refuses again. */
const stopping = new Map<string, number>()

function read(dataDir: string, agentId: string): LeadSwitch | null {
  const file = fileOf(dataDir, agentId)
  if (!existsSync(file)) return null
  try {
    const row = object(JSON.parse(readPrivateStateFile(file, 4_096)))
    if (row.version !== 1 || row.agentId !== agentId || typeof row.changeId !== 'string' || !CHANGE_ID.test(row.changeId)
      || !identifier(row.targetEngine) || typeof row.at !== 'number' || !Number.isFinite(row.at)) return null
    return row as unknown as LeadSwitch
  } catch { return null }
}

/** Running: recorded, no more than SWITCH_HOLD_MS ago, and not in the future (a clock set back holds no longer than this). */
const running = (row: LeadSwitch | null, now: number): row is LeadSwitch => !!row && row.at <= now + 60_000 && now - row.at <= SWITCH_HOLD_MS

/** The engine its owner prepared [agentId]'s switch [changeId] to, when this machine's handoff receipt shows it was done
 *  within SWITCH_ARM_MS; else null. The receipt is written only for the machine's owner (services/handoffRequest.ts). */
function prepared(dataDir: string, agentId: string, changeId: string, now: number): string | null {
  const file = join(dataDir, 'handoff-receipts', `${handoffHash(JSON.stringify([agentId, changeId]))}.json`)
  try {
    if (!existsSync(file)) return null
    const age = now - statSync(file).mtimeMs
    if (age > SWITCH_ARM_MS || age < -60_000) return null
    const receipt = object(JSON.parse(readPrivateStateFile(file, MAX_RECEIPT_BYTES)))
    const request = object(object(receipt.prepared).request)
    if (receipt.version !== 1 || receipt.committed !== true || request.agentId !== agentId || request.changeId !== changeId
      || !identifier(request.targetEngine)) return null
    return request.targetEngine as string
  } catch { return null }
}

function write(dataDir: string, row: LeadSwitch, now: number): void {
  const dir = folder(dataDir)
  secureStateDirectory(dir)
  for (const name of readdirSync(dir)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
    try { if (now - statSync(join(dir, name)).mtimeMs > KEEP_MS) unlinkSync(join(dir, name)) } catch { /* Gone already. */ }
  }
  const file = fileOf(dataDir, row.agentId), temporary = `${file}.${randomUUID()}.next`
  try {
    writeFileSync(temporary, JSON.stringify(row), { mode: 0o600, flush: true, flag: 'wx' })
    renameSync(temporary, file)
    syncStateDirectory(dir)
  } finally { if (existsSync(temporary)) unlinkSync(temporary) }
}

/** Another switch of [agentId] than [changeId] is running: its close is refused, whatever the agent's state. */
export function leadSwitching(dataDir: string, agentId: string, changeId: string, now = Date.now()): boolean {
  const row = read(dataDir, agentId)
  return running(row, now) && row.changeId !== changeId
}

/** Whether the close guard (lib/closeAgentService.ts) refuses a close of [agentId] that names [changeId] (a `now` close of
 *  Change agent) or none: refused for a Product Manager unless it is that switch's close, which then starts its hold. */
export function leadCloseProtected(dataDir: string, agentId: string, changeId?: string, now = Date.now()): boolean {
  if (!retainedLead(dataDir, agentId)) return false
  if (!changeId || !CHANGE_ID.test(changeId)) return true
  const row = read(dataDir, agentId)
  if (running(row, now)) {
    // The same switch's close asked again (a lost reply): still within the time its owner prepared it.
    if (row.changeId !== changeId || now - row.at > SWITCH_ARM_MS) return true
  } else {
    const engine = prepared(dataDir, agentId, changeId, now)
    if (!engine) return true
    try { write(dataDir, { version: 1, agentId, changeId, targetEngine: engine, at: now }, now) } catch { return true }
  }
  stopping.set(agentId, now + SWITCH_STOP_MS)
  return false
}

/** The core's stop guard (core/agents/lifecycle.ts): a Product Manager is never stopped, except by its switch's close. */
export function mayBeLead(dataDir: string, agentId: string, now = Date.now()): boolean {
  const until = stopping.get(agentId)
  if (until !== undefined) {
    if (until > now) return false
    stopping.delete(agentId)
  }
  return retainedLead(dataDir, agentId)
}

/** Whether the host holds off reopening the stopped Product Manager [harnessId]: its switch is running. */
export function leadSwitchHeld(dataDir: string, harnessId: string, now = Date.now()): boolean {
  return running(read(dataDir, harnessId), now)
}

/** Tests: forget this process's stops. */
export function resetLeadSwitchStopsForTest(): void { stopping.clear() }
