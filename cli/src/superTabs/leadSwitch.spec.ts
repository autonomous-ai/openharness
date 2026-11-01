import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { handoffHash } from '../lib/handoffAuthority.js'
import { leadCloseProtected, leadSwitchEnded, leadSwitching, leadSwitchOf, mayBeLead, resetLeadSwitchPassesForTest, SWITCH_ARM_MS,
  SWITCH_HOLD_MS, switchWithin } from './leadSwitch.js'
import { retainContributions } from './retention.js'

const roots: string[] = []
const LEAD = 'lead-harness', WORKER = 'worker-harness'
const CHANGE = 'a'.repeat(32), OTHER = 'b'.repeat(32)
afterEach(() => {
  resetLeadSwitchPassesForTest()
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A data folder whose host keeps [LEAD] as a Product Manager and [WORKER] as a member. */
function machine(now = Date.now()) {
  const dir = mkdtempSync(join(tmpdir(), 'lead-switch-')); roots.push(dir)
  retainContributions(dir, 'machine', [
    { tabId: 'tab', lead: true, agent: { harnessId: LEAD, machineId: 'machine' } },
    { tabId: 'tab', agent: { harnessId: WORKER, machineId: 'machine' } }], now)
  return dir
}

/** The receipt `agent_handoff_prepare` leaves for its owner's switch (lib/handoffPublication.ts), written [at]. */
function prepared(dir: string, agentId: string, changeId: string, at = Date.now(), receipt: Record<string, unknown> = {}) {
  const folder = join(dir, 'handoff-receipts'); mkdirSync(folder, { recursive: true })
  const file = join(folder, `${handoffHash(JSON.stringify([agentId, changeId]))}.json`)
  writeFileSync(file, JSON.stringify({ version: 1, committed: true, prepared: { request: { agentId, changeId, targetEngine: 'codex' } }, ...receipt }))
  utimesSync(file, at / 1000, at / 1000)
}

it('refuses a plain close or stop of a Product Manager, and one naming a switch nobody prepared, as before', () => {
  const dir = machine(), now = Date.now()
  expect(leadCloseProtected(dir, LEAD, undefined, now)).toBe(true)
  expect(leadCloseProtected(dir, LEAD, CHANGE, now)).toBe(true)
  prepared(dir, LEAD, 'not-a-change-id', now)
  expect(leadCloseProtected(dir, LEAD, 'not-a-change-id', now)).toBe(true)
  // Stop Harness, a delete or a purge carries no switch; a stop naming one that was never let through is refused too.
  expect(mayBeLead(dir, LEAD)).toBe(true)
  expect(mayBeLead(dir, LEAD, CHANGE)).toBe(true)
  // A member that is no Product Manager closes and stops as ever.
  expect(leadCloseProtected(dir, WORKER, undefined, now)).toBe(false)
  expect(mayBeLead(dir, WORKER)).toBe(false)
})

it('refuses a switch whose handoff is another agent\'s, another switch\'s, uncommitted, unreadable or too old', () => {
  const dir = machine(), now = Date.now()
  prepared(dir, WORKER, CHANGE, now)
  expect(leadCloseProtected(dir, LEAD, CHANGE, now)).toBe(true)
  prepared(dir, LEAD, OTHER, now)
  expect(leadCloseProtected(dir, LEAD, CHANGE, now)).toBe(true)
  prepared(dir, LEAD, CHANGE, now, { committed: false })
  expect(leadCloseProtected(dir, LEAD, CHANGE, now)).toBe(true)
  prepared(dir, LEAD, CHANGE, now, { prepared: { request: { agentId: WORKER, changeId: CHANGE, targetEngine: 'codex' } } })
  expect(leadCloseProtected(dir, LEAD, CHANGE, now)).toBe(true)
  writeFileSync(join(dir, 'handoff-receipts', `${handoffHash(JSON.stringify([LEAD, CHANGE]))}.json`), '{')
  expect(leadCloseProtected(dir, LEAD, CHANGE, now)).toBe(true)
  prepared(dir, LEAD, CHANGE, now - SWITCH_ARM_MS - 1)
  expect(leadCloseProtected(dir, LEAD, CHANGE, now)).toBe(true)
  expect(mayBeLead(dir, LEAD, CHANGE)).toBe(true)
  expect(leadSwitchOf(dir, LEAD)).toBeNull()
})

// Security reviews 1 and 2 of #2493: the pass goes from the switch's close to the one stop it starts, and to nothing else.
it('lets only the one stop its owner\'s switch starts through, once, and records the switch once that stop went through', () => {
  const dir = machine(), now = Date.now()
  prepared(dir, LEAD, CHANGE, now)
  expect(leadCloseProtected(dir, LEAD, CHANGE, now)).toBe(false)
  // Nothing is recorded, and no hold starts, before the stop went through.
  expect(leadSwitchOf(dir, LEAD)).toBeNull()
  // Stop Harness, a delete or a script's close right after carries no switch, or another: refused.
  expect(mayBeLead(dir, LEAD)).toBe(true)
  expect(mayBeLead(dir, LEAD, OTHER)).toBe(true)
  expect(leadCloseProtected(dir, LEAD, undefined, now)).toBe(true)
  // The switch's own stop passes, once.
  expect(mayBeLead(dir, LEAD, CHANGE)).toBe(false)
  expect(mayBeLead(dir, LEAD, CHANGE)).toBe(true)
  leadSwitchEnded(dir, LEAD, CHANGE, true, now + 1_000)
  expect(leadSwitchOf(dir, LEAD)).toEqual({ version: 1, agentId: LEAD, changeId: CHANGE, targetEngine: 'codex', at: now + 1_000 })
  // The same switch is never let through again, nor its end recorded twice.
  expect(leadCloseProtected(dir, LEAD, CHANGE, now + 2_000)).toBe(true)
  leadSwitchEnded(dir, LEAD, CHANGE, true, now + 5_000)
  expect(leadSwitchOf(dir, LEAD)?.at).toBe(now + 1_000)
  // Held from its stop to the limit.
  expect(switchWithin(leadSwitchOf(dir, LEAD), now + 1_000 + SWITCH_HOLD_MS)).toBe(true)
  expect(switchWithin(leadSwitchOf(dir, LEAD), now + 1_000 + SWITCH_HOLD_MS + 1)).toBe(false)
  const records = readdirSync(join(dir, 'super-tabs', 'lead-switch'))
  expect(records).toHaveLength(1)
  expect(statSync(join(dir, 'super-tabs', 'lead-switch', records[0])).mode & 0o777).toBe(0o600)
})

it('leaves nothing open after a close that failed: no pass, no record, and another switch may start at once', () => {
  const dir = machine(), now = Date.now()
  prepared(dir, LEAD, CHANGE, now)
  expect(leadCloseProtected(dir, LEAD, CHANGE, now)).toBe(false)
  // The save failed before the stop: the close ends unstopped.
  leadSwitchEnded(dir, LEAD, CHANGE, false, now + 1_000)
  expect(mayBeLead(dir, LEAD, CHANGE)).toBe(true)
  expect(leadSwitchOf(dir, LEAD)).toBeNull()
  // Its repeat is not let through; a new switch is, at once.
  expect(leadCloseProtected(dir, LEAD, CHANGE, now + 2_000)).toBe(true)
  prepared(dir, LEAD, OTHER, now + 2_000)
  expect(leadSwitching(dir, LEAD, OTHER, now + 2_000)).toBe(false)
  expect(leadCloseProtected(dir, LEAD, OTHER, now + 2_000)).toBe(false)
  // An end for a switch never let through records nothing.
  leadSwitchEnded(dir, WORKER, CHANGE, true, now)
  expect(leadSwitchOf(dir, WORKER)).toBeNull()
})

it('refuses a second switch while one runs, from its close to its time limit, and takes a new one after', () => {
  const dir = machine(), now = Date.now()
  prepared(dir, LEAD, CHANGE, now)
  prepared(dir, LEAD, OTHER, now)
  expect(leadCloseProtected(dir, LEAD, CHANGE, now)).toBe(false)
  // Its close under way.
  expect(leadSwitching(dir, LEAD, OTHER, now)).toBe(true)
  expect(leadSwitching(dir, LEAD, CHANGE, now)).toBe(false)
  expect(leadCloseProtected(dir, LEAD, OTHER, now)).toBe(true)
  expect(mayBeLead(dir, LEAD, CHANGE)).toBe(false)
  leadSwitchEnded(dir, LEAD, CHANGE, true, now)
  // Its new session awaited.
  expect(leadSwitching(dir, LEAD, OTHER, now + 1_000)).toBe(true)
  expect(leadCloseProtected(dir, LEAD, OTHER, now + 1_000)).toBe(true)
  // Ended by its time limit: a new switch is let through.
  const later = now + SWITCH_HOLD_MS + 1
  prepared(dir, LEAD, OTHER, later)
  expect(leadSwitching(dir, LEAD, OTHER, later)).toBe(false)
  expect(leadCloseProtected(dir, LEAD, OTHER, later)).toBe(false)
})

it('across a restart, keeps the hold of a switch that stopped, and refuses the stop of one that had not', () => {
  const dir = machine(), now = Date.now()
  prepared(dir, LEAD, CHANGE, now)
  expect(leadCloseProtected(dir, LEAD, CHANGE, now)).toBe(false)
  // The daemon restarts between the close's pass and its stop: the stop is refused, and nothing was recorded.
  resetLeadSwitchPassesForTest()
  expect(mayBeLead(dir, LEAD, CHANGE)).toBe(true)
  expect(leadSwitchOf(dir, LEAD)).toBeNull()
  // A switch that stopped keeps its record and limit across one.
  expect(leadCloseProtected(dir, LEAD, CHANGE, now)).toBe(false)
  expect(mayBeLead(dir, LEAD, CHANGE)).toBe(false)
  leadSwitchEnded(dir, LEAD, CHANGE, true, now)
  resetLeadSwitchPassesForTest()
  expect(switchWithin(leadSwitchOf(dir, LEAD), now + 1)).toBe(true)
  expect(mayBeLead(dir, LEAD)).toBe(true)
})

it('reads no switch from an unreadable record, and holds none from a clock far ahead', () => {
  const dir = machine(), now = Date.now()
  prepared(dir, LEAD, CHANGE, now)
  expect(leadCloseProtected(dir, LEAD, CHANGE, now)).toBe(false)
  expect(mayBeLead(dir, LEAD, CHANGE)).toBe(false)
  leadSwitchEnded(dir, LEAD, CHANGE, true, now)
  expect(switchWithin(leadSwitchOf(dir, LEAD), now - 2 * 60_000)).toBe(false)
  const folder = join(dir, 'super-tabs', 'lead-switch')
  writeFileSync(join(folder, readdirSync(folder)[0]), '{')
  expect(leadSwitchOf(dir, LEAD)).toBeNull()
  expect(switchWithin(null, now)).toBe(false)
})
