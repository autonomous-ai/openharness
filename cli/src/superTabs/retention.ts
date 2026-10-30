/** A shared contribution belongs to its Super Tab even while no terminal is shown.
 * Keep the last confirmed roster across host/network restarts; only a successful
 * roster read may release it to automatic cleanup. This grants no input access.
 *
 * Membership only in archived groups is not in use, and a roster nobody confirms
 * for a week (signed out, unlinked machine) lapses, except a project's Lead, which
 * is never stopped. A paused tab still counts: pause blocks new work, while
 * discussion and running assignments continue. */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { identifier, object } from './wire.js'

/** `leads`: the Leads of active projects here, which never lapse (owner, 2026-10-23: the Lead of an active project is never
 *  stopped in any case). Absent in a file from before Leads were kept. */
interface Retention { version: 2; machineId: string; harnesses: string[]; leads?: string[] }
export const retentionFile = (dataDir: string) => join(dataDir, 'super-tabs', 'retained.json')
export const RETENTION_LAPSE_MS = 7 * 24 * 60 * 60_000
const REFRESH_MS = 60 * 60_000

function read(file: string): Retention {
  if (statSync(file).size > 4 * 1024 * 1024) throw new Error('Super Tab retention is too large. Automatic cleanup is paused.')
  let value: Record<string, unknown> = {}
  try { value = object(JSON.parse(readFileSync(file, 'utf8'))) } catch { /* reported below */ }
  if (value.version !== 2 || !identifier(value.machineId) || !Array.isArray(value.harnesses) || !value.harnesses.every(identifier)
    || (value.leads !== undefined && (!Array.isArray(value.leads) || !value.leads.every(identifier)))) {
    throw new Error('Super Tab retention is unreadable. Automatic cleanup is paused.')
  }
  return value as unknown as Retention
}

export function retainedHarnesses(dataDir: string, now = Date.now()): Set<string> {
  const file = retentionFile(dataDir)
  // An unreadable file fails closed only until it lapses; the host rewrites it on its next roster.
  if (!existsSync(file)) return new Set()
  if (now - statSync(file).mtimeMs > RETENTION_LAPSE_MS) return retainedLeads(dataDir)
  return new Set(read(file).harnesses)
}

/** The Leads here the host may reopen: only those a valid roster named. */
export function retainedLeads(dataDir: string): Set<string> {
  try { return new Set(read(retentionFile(dataDir)).leads) } catch { return new Set() }
}

/** Whether a stop may reach a Lead, for the core's guard, which fails closed (the review of #1635): with no file this
 *  machine never had a roster, so no Lead; one from before Leads were kept names no Lead apart, so each member may be one;
 *  one that cannot be read may name anyone, until the host's next roster rewrites it. */
export function mayBeLead(dataDir: string, agentId: string): boolean {
  const file = retentionFile(dataDir)
  if (!existsSync(file)) return false
  try {
    const kept = read(file)
    return (kept.leads ?? kept.harnesses).includes(agentId)
  } catch { return true }
}

export function retainContributions(dataDir: string, machineId: string, rows: unknown[], now = Date.now()): void {
  if (!identifier(machineId)) throw new Error('Invalid Super Tab retention machine.')
  const file = retentionFile(dataDir)
  // This machine's confirmed roster is authoritative: it replaces an unreadable
  // file and another identity's entry. Unchanged rosters only refresh the lapse clock.
  let previous: Retention | null = null
  try { if (existsSync(file)) previous = read(file) } catch { /* rebuilt below */ }
  const ids = new Set<string>(), leads = new Set<string>()
  for (const item of rows) {
    const row = object(item), agent = object(row.agent)
    if (!identifier(row.tabId) || !identifier(agent.harnessId) || agent.machineId !== machineId) continue
    // A session the backend ends (its project deleted, the agent removed) stays kept until the host has closed it, and
    // only if it was a member here before: the host and the core close nothing this file did not already name.
    if (row.closeSession === true && row.lead !== true) {
      if (previous?.machineId === machineId && previous.harnesses.includes(agent.harnessId)) ids.add(agent.harnessId)
      continue
    }
    if (row.lead === true) leads.add(agent.harnessId)
    else if (row.active === false) continue
    ids.add(agent.harnessId)
  }
  const next: Retention = { version: 2, machineId, harnesses: [...ids].sort(), leads: [...leads].sort() }
  if (previous && JSON.stringify(previous) === JSON.stringify(next)) {
    if (now - statSync(file).mtimeMs > REFRESH_MS) utimesSync(file, new Date(now), new Date(now))
    return
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(`${file}.next`, JSON.stringify(next), { mode: 0o600, flush: true })
  renameSync(`${file}.next`, file)
  utimesSync(file, new Date(now), new Date(now))
}
