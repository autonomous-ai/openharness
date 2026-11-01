import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { handoffHash } from '../lib/handoffAuthority.js'
import { leadCloseProtected, leadSwitchHeld, leadSwitching, mayBeLead, resetLeadSwitchStopsForTest, SWITCH_ARM_MS, SWITCH_HOLD_MS,
  SWITCH_STOP_MS } from './leadSwitch.js'
import { retainContributions } from './retention.js'

const roots: string[] = []
const LEAD = 'lead-harness', WORKER = 'worker-harness'
const CHANGE = 'a'.repeat(32), OTHER = 'b'.repeat(32)
afterEach(() => {
  resetLeadSwitchStopsForTest()
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

it('refuses a plain close of a Product Manager, and one naming a switch nobody prepared, as before', () => {
  const dir = machine(), now = Date.now()
  expect(leadCloseProtected(dir, LEAD, undefined, now)).toBe(true)
  expect(leadCloseProtected(dir, LEAD, CHANGE, now)).toBe(true)
  // A change id that is not one Change agent makes.
  prepared(dir, LEAD, 'not-a-change-id', now)
  expect(leadCloseProtected(dir, LEAD, 'not-a-change-id', now)).toBe(true)
  // Stop Harness and every other stop still meet the guard.
  expect(mayBeLead(dir, LEAD, now)).toBe(true)
  // A member that is no Product Manager closes as ever.
  expect(leadCloseProtected(dir, WORKER, undefined, now)).toBe(false)
  expect(mayBeLead(dir, WORKER, now)).toBe(false)
})

it('refuses a switch whose handoff is another agent\'s, another switch\'s, uncommitted, unreadable or too old', () => {
  const dir = machine(), now = Date.now()
  // Prepared for the worker, named for the Product Manager.
  prepared(dir, WORKER, CHANGE, now)
  expect(leadCloseProtected(dir, LEAD, CHANGE, now)).toBe(true)
  // Prepared under another change id.
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
  // Nothing was recorded by any of them: the host keeps reopening it.
  expect(leadSwitchHeld(dir, LEAD, now)).toBe(false)
})

it('lets its owner\'s switch stop the Product Manager once, for a minute, and holds its reopen until the time limit', () => {
  const dir = machine(), now = Date.now()
  prepared(dir, LEAD, CHANGE, now)
  expect(leadCloseProtected(dir, LEAD, CHANGE, now)).toBe(false)
  // The core's stop guard lets this switch's stop through, then refuses again.
  expect(mayBeLead(dir, LEAD, now + 1)).toBe(false)
  expect(mayBeLead(dir, LEAD, now + SWITCH_STOP_MS + 1)).toBe(true)
  // The same switch asked again after a lost reply, while still fresh.
  expect(leadCloseProtected(dir, LEAD, CHANGE, now + 1_000)).toBe(false)
  expect(leadCloseProtected(dir, LEAD, CHANGE, now + SWITCH_ARM_MS + 1)).toBe(true)
  // A plain close in the middle is refused all the same.
  expect(leadCloseProtected(dir, LEAD, undefined, now + 2)).toBe(true)
  // Held from the switch to its time limit; then the host reopens the old one.
  expect(leadSwitchHeld(dir, LEAD, now)).toBe(true)
  expect(leadSwitchHeld(dir, LEAD, now + SWITCH_HOLD_MS)).toBe(true)
  expect(leadSwitchHeld(dir, LEAD, now + SWITCH_HOLD_MS + 1)).toBe(false)
  expect(leadSwitchHeld(dir, WORKER, now)).toBe(false)
  // Its record is private, one per Product Manager.
  const records = readdirSync(join(dir, 'super-tabs', 'lead-switch'))
  expect(records).toHaveLength(1)
  expect(statSync(join(dir, 'super-tabs', 'lead-switch', records[0])).mode & 0o777).toBe(0o600)
})

it('refuses a second switch while one runs, and takes a new one once it ended', () => {
  const dir = machine(), now = Date.now()
  prepared(dir, LEAD, CHANGE, now)
  expect(leadCloseProtected(dir, LEAD, CHANGE, now)).toBe(false)
  prepared(dir, LEAD, OTHER, now + 1_000)
  expect(leadSwitching(dir, LEAD, OTHER, now + 1_000)).toBe(true)
  expect(leadSwitching(dir, LEAD, CHANGE, now + 1_000)).toBe(false)
  expect(leadCloseProtected(dir, LEAD, OTHER, now + 1_000)).toBe(true)
  // Ended by its time limit: the next switch is a new one.
  const later = now + SWITCH_HOLD_MS + 1
  prepared(dir, LEAD, OTHER, later)
  expect(leadSwitching(dir, LEAD, OTHER, later)).toBe(false)
  expect(leadCloseProtected(dir, LEAD, OTHER, later)).toBe(false)
  expect(leadSwitchHeld(dir, LEAD, later)).toBe(true)
})

it('keeps the hold and its limit across a restart mid-switch, and lets no stop through after it', () => {
  const dir = machine(), now = Date.now()
  prepared(dir, LEAD, CHANGE, now)
  expect(leadCloseProtected(dir, LEAD, CHANGE, now)).toBe(false)
  // The daemon restarts: what this process let through is gone, the record on disk is not.
  resetLeadSwitchStopsForTest()
  expect(mayBeLead(dir, LEAD, now + 1)).toBe(true)
  expect(leadSwitchHeld(dir, LEAD, now + 1)).toBe(true)
  // Neither none (the old one comes back after the limit) nor two (no reopen before it).
  expect(leadSwitchHeld(dir, LEAD, now + SWITCH_HOLD_MS + 1)).toBe(false)
  // A record from a clock far ahead, or unreadable, holds nothing.
  writeFileSync(join(dir, 'super-tabs', 'lead-switch', readdirSync(join(dir, 'super-tabs', 'lead-switch'))[0]), '{')
  expect(leadSwitchHeld(dir, LEAD, now + 1)).toBe(false)
})

it('holds nothing for a record written by a clock far ahead', () => {
  const dir = machine(), now = Date.now()
  prepared(dir, LEAD, CHANGE, now)
  expect(leadCloseProtected(dir, LEAD, CHANGE, now)).toBe(false)
  expect(leadSwitchHeld(dir, LEAD, now - 2 * 60_000)).toBe(false)
})
