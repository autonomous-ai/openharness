/**
 * A project's Product Manager switched to another engine from its own pane, as any pane is (Change agent; Dee, 11-01: "PM is
 * just an agent/pane like in v1"). Its stop is the one exception to "a Lead is never closed" (retention.ts mayBeLead), and a
 * narrow one (Lead, 11-01; security reviews 1 and 2 of #2493):
 * - Only a `now` close that names the switch's change id is considered, and only when this machine's own handoff receipt
 *   shows that very switch of that very agent was prepared moments ago. `agent_handoff_prepare` answers the machine's owner
 *   alone: the owner's apps, or any process on the owner's Mac, agents with a shell included, which could already stop the
 *   Product Manager's process or type into its terminal.
 * - That close gets a one-time pass, held in this process, which only the stop it starts carries (lib/closeAgentService.ts
 *   hands it to lib/stopAgentService.ts options). No other stop carries it, whoever asks: Stop Harness (a paired dial's
 *   included), a delete, a purge, a script's close. The stop uses it up; the close's end clears it, stopped or not; the same
 *   switch is never let through twice. A restart forgets it, which only refuses.
 * - The switch is recorded only once its stop went through, one per Product Manager. While it runs, a second switch is refused,
 *   and the host does not reopen the stopped one (superTabs/host.ts keepAlive), so the new session can take its place: the
 *   existing replacement report and the backend's agent.rebind keep the same Swarm agent, its lead and its work.
 * - The new session not started within SWITCH_HOLD_MS, the hold ends and the host reopens the old one on its old engine. A new
 *   session that runs but is not taken into the Swarm by SWITCH_ADOPT_MS, or starts after the old one was reopened, is closed
 *   by the host first, so no unlinked session runs beside the Product Manager. A project never has two, and never none for long.
 * The record is a file, so a restart in the middle keeps the hold and its limits.
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
/** How long, from its stop, the host waits for the new session before it reopens the old one. */
export const SWITCH_HOLD_MS = 3 * 60_000
/** How long, from its stop, the host waits for the Swarm to take in a new session that runs (agent.rebind, every 5 s). */
export const SWITCH_ADOPT_MS = 10 * 60_000
/** Ended records go after a day; each Product Manager has at most one. */
const KEEP_MS = 24 * 60 * 60_000
const CHANGE_ID = /^[0-9a-f]{32}$/
const MAX_RECEIPT_BYTES = 20 * 1024 * 1024
/** The switches this process let through, so none is let through twice; the oldest are forgotten past this many. */
const MAX_USED = 256

export interface LeadSwitch { version: 1; agentId: string; changeId: string; targetEngine: string; at: number }

const folder = (dataDir: string) => join(dataDir, 'super-tabs', 'lead-switch')
const fileOf = (dataDir: string, agentId: string) => join(folder(dataDir), `${createHash('sha256').update(agentId).digest('hex')}.json`)

/** The pass a switch's close holds for the one stop it starts, by Product Manager: its change id. */
const passes = new Map<string, string>()
/** Every switch this process let through (`agentId:changeId`), with its engine: none is let through twice, and only these
 *  record. The oldest are forgotten past MAX_USED. */
const issued = new Map<string, string>()
/** The issued switches whose close ended. */
const ended = new Set<string>()

/** The switch recorded for [agentId], whether running or ended; null when none or unreadable. */
export function leadSwitchOf(dataDir: string, agentId: string): LeadSwitch | null {
  const file = fileOf(dataDir, agentId)
  if (!existsSync(file)) return null
  try {
    const row = object(JSON.parse(readPrivateStateFile(file, 4_096)))
    if (row.version !== 1 || row.agentId !== agentId || typeof row.changeId !== 'string' || !CHANGE_ID.test(row.changeId)
      || !identifier(row.targetEngine) || typeof row.at !== 'number' || !Number.isFinite(row.at)) return null
    return row as unknown as LeadSwitch
  } catch { return null }
}

/** Running: recorded [limit] ago or less, and not in the future (a clock set back holds no longer than this). */
export const switchWithin = (row: LeadSwitch | null, now: number, limit = SWITCH_HOLD_MS): row is LeadSwitch =>
  !!row && row.at <= now + 60_000 && now - row.at <= limit

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

/** Another switch of [agentId] than [changeId] is running, its close under way or its new session awaited: refused. */
export function leadSwitching(dataDir: string, agentId: string, changeId: string, now = Date.now()): boolean {
  const pass = passes.get(agentId)
  if (pass && pass !== changeId) return true
  const row = leadSwitchOf(dataDir, agentId)
  return switchWithin(row, now) && row.changeId !== changeId
}

/** Whether the close guard (lib/closeAgentService.ts) refuses a close of [agentId] naming [changeId] (a `now` close of Change
 *  agent) or none: refused for a Product Manager unless it is that switch's close, which then gets the pass for its one stop. */
export function leadCloseProtected(dataDir: string, agentId: string, changeId?: string, now = Date.now()): boolean {
  if (!retainedLead(dataDir, agentId)) return false
  if (!changeId || !CHANGE_ID.test(changeId)) return true
  const key = `${agentId}:${changeId}`
  if (issued.has(key) || passes.has(agentId) || switchWithin(leadSwitchOf(dataDir, agentId), now)) return true
  const engine = prepared(dataDir, agentId, changeId, now)
  if (!engine) return true
  passes.set(agentId, changeId)
  issued.set(key, engine)
  if (issued.size > MAX_USED) issued.delete(issued.keys().next().value!)
  return false
}

/** The core's stop guard (core/agents/lifecycle.ts): a Product Manager is never stopped, but by the one stop of its switch's
 *  close, which carries the switch [leadSwitch] and uses its pass up. */
export function mayBeLead(dataDir: string, agentId: string, leadSwitch?: string): boolean {
  if (!retainedLead(dataDir, agentId)) return false
  if (!leadSwitch || passes.get(agentId) !== leadSwitch) return true
  passes.delete(agentId)
  return false
}

/** The switch's close ended (lib/closeAgentService.ts): its pass, used or not, is gone; stopped, the switch is recorded and the
 *  host's hold starts now. A close that failed records nothing, so its owner may switch again at once and a crashed Product
 *  Manager is reopened as ever. Only the close that was given the pass records: [changeId] must be one this process let
 *  through, and once. */
export function leadSwitchEnded(dataDir: string, agentId: string, changeId: string, stopped: boolean, now = Date.now()): void {
  if (passes.get(agentId) === changeId) passes.delete(agentId)
  const key = `${agentId}:${changeId}`, engine = issued.get(key)
  if (!stopped || engine === undefined || ended.has(key)) return
  ended.add(key)
  if (ended.size > MAX_USED) ended.delete(ended.values().next().value!)
  try { write(dataDir, { version: 1, agentId, changeId, targetEngine: engine, at: now }, now) } catch (error) {
    // Unrecorded, the host reopens the old one as for any stopped Product Manager: never none.
    console.warn(`[super-tabs] could not record the switch of ${agentId.slice(0, 8)}: ${error instanceof Error ? error.name : 'unknown'}`)
  }
}

/** Tests: forget this process's passes, as a restart does. */
export function resetLeadSwitchPassesForTest(): void { passes.clear(); issued.clear(); ended.clear() }
