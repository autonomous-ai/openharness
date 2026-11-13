/**
 * A project's Product Manager switched to another engine from its own pane, as any pane is (Change agent; Dee, 11-01: "PM is
 * just an agent/pane like in v1"). Its old session stops, and its host must not reopen it while the new one starts: the
 * existing replacement report and the backend's agent.rebind keep the same Swarm agent, its lead and its work.
 * - The Swarm sees the switch for itself, in its own process: a Product Manager that stopped within SWITCH_ARM_MS of its
 *   owner preparing the switch (this machine's handoff receipt, which `agent_handoff_prepare` writes for the machine's owner
 *   alone, core/handoffPublication.ts) is switching, to the engine the receipt names. Until 2026-11-13 the core let only that
 *   one stop of a Product Manager through and recorded it; it keeps no Swarm rule now (anh Dee: an experiment never touches
 *   the core), so a Product Manager closes as any agent does, and one that stops for anything else is reopened.
 * - The switch is recorded once, one per Product Manager, as its host first finds it stopped (superTabs/host.ts keepAlive),
 *   or as the host's own switch's close went through (superTabs/leadSwitchRequest.ts). While it runs, a second switch is not
 *   started, and the host does not reopen the stopped one, so the new session can take its place.
 * - The new session not started within SWITCH_HOLD_MS, the hold ends and the host reopens the old one on its old engine. A new
 *   session that runs but is not taken into the Swarm by SWITCH_ADOPT_MS, or starts after the old one was reopened, is closed
 *   by the host first, so no unlinked session runs beside the Product Manager. A project never has two, and never none for long.
 * The record is a file, so a restart in the middle keeps the hold and its limits.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readPrivateStateFile, secureStateDirectory, syncStateDirectory } from '../lib/secureState.js'
import { identifier, object } from './wire.js'

/** How soon after its owner prepared the switch its stop must come (Desktop closes at once after preparing). */
export const SWITCH_ARM_MS = 2 * 60_000
/** How long, from its stop, the host waits for the new session before it reopens the old one. */
export const SWITCH_HOLD_MS = 3 * 60_000
/** How long, from its stop, the host waits for the Swarm to take in a new session that runs (agent.rebind, every 5 s). */
export const SWITCH_ADOPT_MS = 10 * 60_000

/** Ended records go after a day; each Product Manager has at most one. */
const KEEP_MS = 24 * 60 * 60_000
const CHANGE_ID = /^[0-9a-f]{32}$/
const MAX_RECEIPT_BYTES = 20 * 1024 * 1024
/** Receipts read for one stop, newest first: a machine with more prepared switches in two minutes is not a person's. */
const MAX_FRESH_RECEIPTS = 16

export interface LeadSwitch { version: 1; agentId: string; changeId: string; targetEngine: string; at: number }

const folder = (dataDir: string) => join(dataDir, 'super-tabs', 'lead-switch')
const fileOf = (dataDir: string, agentId: string) => join(folder(dataDir), `${createHash('sha256').update(agentId).digest('hex')}.json`)

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

/** Another switch of [agentId] than [changeId] is running, its new session awaited: not started. */
export function leadSwitching(dataDir: string, agentId: string, changeId: string, now = Date.now()): boolean {
  const row = leadSwitchOf(dataDir, agentId)
  return switchWithin(row, now) && row.changeId !== changeId
}

/** The switch [agentId]'s owner prepared within SWITCH_ARM_MS of [now], by this machine's handoff receipts; else null. Read
 *  once, as its host finds it stopped. */
export function preparedSwitch(dataDir: string, agentId: string, now = Date.now()): { changeId: string; targetEngine: string } | null {
  const dir = join(dataDir, 'handoff-receipts')
  try {
    if (!existsSync(dir)) return null
    secureStateDirectory(dir, false)
    const fresh = readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
      // One gone since the folder was read is none.
      const age = now - (statSync(join(dir, name), { throwIfNoEntry: false })?.mtimeMs ?? -Infinity)
      return age <= SWITCH_ARM_MS && age >= -60_000 ? [{ name, age }] : []
    }).sort((a, b) => a.age - b.age).slice(0, MAX_FRESH_RECEIPTS)
    for (const { name } of fresh) {
      try {
        const receipt = object(JSON.parse(readPrivateStateFile(join(dir, name), MAX_RECEIPT_BYTES)))
        const request = object(object(receipt.prepared).request)
        if (receipt.version === 1 && receipt.committed === true && request.agentId === agentId && typeof request.changeId === 'string'
          && CHANGE_ID.test(request.changeId) && identifier(request.targetEngine)) return { changeId: request.changeId, targetEngine: request.targetEngine }
      } catch { /* A partial or unreadable receipt is no switch. */ }
    }
  } catch { /* No receipts to read: no switch. */ }
  return null
}

/** Records [row], its Product Manager's one switch, unless that switch is recorded already; ended ones go after a day. */
export function recordLeadSwitch(dataDir: string, row: LeadSwitch): void {
  if (leadSwitchOf(dataDir, row.agentId)?.changeId === row.changeId) return
  const dir = folder(dataDir)
  secureStateDirectory(dir)
  for (const name of readdirSync(dir)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
    try { if (row.at - statSync(join(dir, name)).mtimeMs > KEEP_MS) unlinkSync(join(dir, name)) } catch { /* Gone already. */ }
  }
  const file = fileOf(dataDir, row.agentId), temporary = `${file}.${randomUUID()}.next`
  try {
    writeFileSync(temporary, JSON.stringify(row), { mode: 0o600, flush: true, flag: 'wx' })
    renameSync(temporary, file)
    syncStateDirectory(dir)
  } finally { if (existsSync(temporary)) unlinkSync(temporary) }
}
