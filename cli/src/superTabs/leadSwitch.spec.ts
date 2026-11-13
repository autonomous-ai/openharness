import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { handoffHash } from '../lib/handoffAuthority.js'
import { leadSwitchOf, leadSwitching, preparedSwitch, recordLeadSwitch, SWITCH_ARM_MS, SWITCH_HOLD_MS, switchWithin } from './leadSwitch.js'

const roots: string[] = []
const LEAD = 'lead-harness', WORKER = 'worker-harness'
const CHANGE = 'a'.repeat(32), OTHER = 'b'.repeat(32)
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const machine = () => { const dir = mkdtempSync(join(tmpdir(), 'lead-switch-')); roots.push(dir); return dir }

/** The receipt `agent_handoff_prepare` leaves for its owner's switch (core/handoffPublication.ts), written [at]. */
function prepared(dir: string, agentId: string, changeId: string, at = Date.now(), receipt: Record<string, unknown> = {}) {
  const folder = join(dir, 'handoff-receipts'); mkdirSync(folder, { recursive: true, mode: 0o700 })
  const file = join(folder, `${handoffHash(JSON.stringify([agentId, changeId]))}.json`)
  writeFileSync(file, JSON.stringify({ version: 1, committed: true, prepared: { request: { agentId, changeId, targetEngine: 'codex' } }, ...receipt }), { mode: 0o600 })
  utimesSync(file, at / 1000, at / 1000)
  return file
}
const row = (at: number, changeId = CHANGE) => ({ version: 1 as const, agentId: LEAD, changeId, targetEngine: 'codex', at })

// anh Dee, 2026-11-13: an experiment never touches the core. The core let a Product Manager's switch through and recorded
// it until then; the Swarm sees it for itself now, from the receipt its owner's prepare leaves.
it('finds the switch its owner prepared moments before, to the engine its receipt names, and no other', () => {
  const dir = machine(), now = Date.now()
  expect(preparedSwitch(dir, LEAD, now)).toBeNull()
  prepared(dir, WORKER, OTHER, now)
  expect(preparedSwitch(dir, LEAD, now)).toBeNull()
  // A receipt gone since its folder was read is none.
  symlinkSync(join(dir, 'nowhere'), join(dir, 'handoff-receipts', `${'f'.repeat(64)}.json`))
  prepared(dir, LEAD, CHANGE, now - 1_000)
  expect(preparedSwitch(dir, LEAD, now)).toEqual({ changeId: CHANGE, targetEngine: 'codex' })
  expect(preparedSwitch(dir, WORKER, now)).toEqual({ changeId: OTHER, targetEngine: 'codex' })
})

it('takes no switch from a receipt that is uncommitted, another agent\'s, unreadable, too old or far ahead', () => {
  const dir = machine(), now = Date.now()
  prepared(dir, LEAD, CHANGE, now, { committed: false })
  expect(preparedSwitch(dir, LEAD, now)).toBeNull()
  prepared(dir, LEAD, CHANGE, now, { prepared: { request: { agentId: WORKER, changeId: CHANGE, targetEngine: 'codex' } } })
  expect(preparedSwitch(dir, LEAD, now)).toBeNull()
  prepared(dir, LEAD, CHANGE, now, { prepared: { request: { agentId: LEAD, changeId: 'not-a-change', targetEngine: 'codex' } } })
  expect(preparedSwitch(dir, LEAD, now)).toBeNull()
  writeFileSync(prepared(dir, LEAD, CHANGE, now), '{')
  expect(preparedSwitch(dir, LEAD, now)).toBeNull()
  prepared(dir, LEAD, CHANGE, now - SWITCH_ARM_MS - 1)
  expect(preparedSwitch(dir, LEAD, now)).toBeNull()
  prepared(dir, LEAD, CHANGE, now + 2 * 60_000)
  expect(preparedSwitch(dir, LEAD, now)).toBeNull()
  // A folder another account could write, which could have planted it, holds no switch either.
  const open = machine()
  prepared(open, LEAD, CHANGE, now)
  expect(preparedSwitch(open, LEAD, now)).not.toBeNull()
  chmodSync(join(open, 'handoff-receipts'), 0o777)
  expect(preparedSwitch(open, LEAD, now)).toBeNull()
})

it('records a switch once, privately, holds it from its stop to its limit, and lets ended ones go after a day', () => {
  const dir = machine(), now = Date.now()
  expect(leadSwitchOf(dir, LEAD)).toBeNull()
  recordLeadSwitch(dir, row(now))
  expect(leadSwitchOf(dir, LEAD)).toEqual(row(now))
  // The same switch found again, by the host after its own close or after a restart, keeps the time it was first found.
  recordLeadSwitch(dir, row(now + 5_000))
  expect(leadSwitchOf(dir, LEAD)?.at).toBe(now)
  expect(switchWithin(leadSwitchOf(dir, LEAD), now + SWITCH_HOLD_MS)).toBe(true)
  expect(switchWithin(leadSwitchOf(dir, LEAD), now + SWITCH_HOLD_MS + 1)).toBe(false)
  const folder = join(dir, 'super-tabs', 'lead-switch'), [file] = readdirSync(folder)
  expect(statSync(join(folder, file!)).mode & 0o777).toBe(0o600)
  // A day on, another Product Manager's switch takes the old record with it.
  utimesSync(join(folder, file!), (now - 25 * 60 * 60_000) / 1000, (now - 25 * 60 * 60_000) / 1000)
  recordLeadSwitch(dir, { ...row(now), agentId: WORKER })
  expect(leadSwitchOf(dir, LEAD)).toBeNull()
  expect(leadSwitchOf(dir, WORKER)?.agentId).toBe(WORKER)
})

it('starts no second switch while one is awaited, and takes a new one after its limit', () => {
  const dir = machine(), now = Date.now()
  expect(leadSwitching(dir, LEAD, OTHER, now)).toBe(false)
  recordLeadSwitch(dir, row(now))
  expect(leadSwitching(dir, LEAD, OTHER, now + 1_000)).toBe(true)
  expect(leadSwitching(dir, LEAD, CHANGE, now + 1_000)).toBe(false)
  expect(leadSwitching(dir, LEAD, OTHER, now + SWITCH_HOLD_MS + 1)).toBe(false)
})

it('reads no switch from an unreadable record, and holds none from a clock far ahead', () => {
  const dir = machine(), now = Date.now()
  recordLeadSwitch(dir, row(now))
  expect(switchWithin(leadSwitchOf(dir, LEAD), now - 2 * 60_000)).toBe(false)
  const folder = join(dir, 'super-tabs', 'lead-switch')
  writeFileSync(join(folder, readdirSync(folder)[0]!), '{')
  expect(leadSwitchOf(dir, LEAD)).toBeNull()
  writeFileSync(join(folder, readdirSync(folder)[0]!), JSON.stringify({ ...row(now), changeId: 'short' }))
  expect(leadSwitchOf(dir, LEAD)).toBeNull()
  expect(switchWithin(null, now)).toBe(false)
})

it('throws on a record it cannot write, leaving nothing half written, and passes over what is no record', () => {
  const dir = machine(), now = Date.now()
  recordLeadSwitch(dir, row(now))
  const folder = join(dir, 'super-tabs', 'lead-switch')
  // What else the folder holds: a stray file, and a record gone since the folder was read.
  writeFileSync(join(folder, 'notes.txt'), 'x')
  symlinkSync(join(dir, 'nowhere'), join(folder, `${'e'.repeat(64)}.json`))
  const [record] = readdirSync(folder).filter(name => name !== 'notes.txt' && !name.startsWith('e'))
  rmSync(join(folder, record!)); mkdirSync(join(folder, record!)); writeFileSync(join(folder, record!, 'inside'), 'x')
  expect(() => recordLeadSwitch(dir, row(now, OTHER))).toThrow()
  expect(readdirSync(folder).filter(name => name.endsWith('.next'))).toEqual([])
})
