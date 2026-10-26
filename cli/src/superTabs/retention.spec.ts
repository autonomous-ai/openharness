import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { mayBeLead, RETENTION_LAPSE_MS, retainContributions, retainedHarnesses, retainedLeads, retentionFile } from './retention.js'

const roots: string[] = []
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'super-retention-')); roots.push(dir); return dir }
const row = (harnessId: string, extra: Record<string, unknown> = {}, machineId = 'machine') => ({ tabId: 'tab', agent: { harnessId, machineId }, ...extra })
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })

it('retains exact members durably, avoids unchanged writes and releases only the confirmed host roster', () => {
  const dir = root(), now = Date.now()
  expect([...retainedHarnesses(dir)]).toEqual([])
  retainContributions(dir, 'machine', [row('multiply'), row('divide'), row('multiply')], now)
  expect([...retainedHarnesses(dir, now)]).toEqual(['divide', 'multiply'])
  const file = retentionFile(dir), before = statSync(file, { bigint: true }).mtimeNs
  retainContributions(dir, 'machine', [row('divide'), row('multiply')], now + 1000)
  expect(statSync(file, { bigint: true }).mtimeNs).toBe(before)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  retainContributions(dir, 'machine', [], now)
  expect([...retainedHarnesses(dir, now)]).toEqual([])
})

it('retains paused-tab members but not members of only archived groups or rows for another machine', () => {
  const dir = root(), now = Date.now()
  retainContributions(dir, 'machine', [row('kept'), row('legacy', { active: undefined }), row('paused', { paused: true }),
    row('archived', { active: false }), row('foreign', {}, 'other'), {}, row('../bad')], now)
  expect([...retainedHarnesses(dir, now)]).toEqual(['kept', 'legacy', 'paused'])
  expect(() => retainContributions(dir, '../bad', [])).toThrow()
})

it('lets a new machine identity replace the old entry, and lapses a roster nobody confirms', () => {
  const dir = root(), now = Date.now(), file = retentionFile(dir)
  retainContributions(dir, 'old-machine', [row('combine', {}, 'old-machine')], now)
  retainContributions(dir, 'machine', [row('multiply')], now)
  expect([...retainedHarnesses(dir, now)]).toEqual(['multiply'])
  // An unchanged roster refreshes the lapse clock at most hourly, without rewriting.
  const content = readFileSync(file, 'utf8')
  retainContributions(dir, 'machine', [row('multiply')], now + 2 * 60 * 60_000)
  expect(readFileSync(file, 'utf8')).toBe(content)
  expect(Math.abs(statSync(file).mtimeMs - (now + 2 * 60 * 60_000))).toBeLessThan(1000)
  expect([...retainedHarnesses(dir, now + 2 * 60 * 60_000 + RETENTION_LAPSE_MS - 1000)]).toEqual(['multiply'])
  expect([...retainedHarnesses(dir, now + 2 * 60 * 60_000 + RETENTION_LAPSE_MS + 1000)]).toEqual([])
})

it('pauses cleanup on corrupt or oversized retention until the host rewrites it or it lapses', () => {
  const dir = root(), file = retentionFile(dir), now = Date.now()
  retainContributions(dir, 'machine', [row('multiply')], now)
  for (const value of ['{', '{}', '{"version":1,"machines":{}}', '{"version":2,"machineId":"machine","harnesses":[null]}', ' '.repeat(4 * 1024 * 1024 + 1)]) {
    writeFileSync(file, value)
    utimesSync(file, new Date(now), new Date(now))
    expect(() => retainedHarnesses(dir, now)).toThrow('Automatic cleanup is paused')
    expect([...retainedHarnesses(dir, now + RETENTION_LAPSE_MS + 1)]).toEqual([])
  }
  retainContributions(dir, 'machine', [row('multiply')], now)
  expect([...retainedHarnesses(dir, now)]).toEqual(['multiply'])
  unlinkSync(file)
  expect([...retainedHarnesses(dir, now)]).toEqual([])
})

// The owner, 2026-10-23: the Lead of an active project is never stopped, in any case. It is kept from cleanup even when
// its groups read as archived, and never lapses: a machine signed out for a week still keeps its Lead.
it('keeps a Lead apart, never lapses it, and releases it only when a confirmed roster no longer marks it', () => {
  const dir = root(), now = Date.now()
  expect([...retainedLeads(dir)]).toEqual([])
  retainContributions(dir, 'machine', [row('lead', { lead: true, active: false }), row('worker'), row('foreign-lead', { lead: true }, 'other')], now)
  expect([...retainedLeads(dir)]).toEqual(['lead'])
  expect([...retainedHarnesses(dir, now)]).toEqual(['lead', 'worker'])
  expect([...retainedHarnesses(dir, now + RETENTION_LAPSE_MS + 1000)]).toEqual(['lead'])
  retainContributions(dir, 'machine', [row('lead', { closeSession: true }), row('worker')], now)
  expect([...retainedLeads(dir)]).toEqual([])
})

it('reopens no Lead from an unreadable file', () => {
  const dir = root()
  retainContributions(dir, 'machine', [row('lead', { lead: true })])
  writeFileSync(retentionFile(dir), '{')
  expect([...retainedLeads(dir)]).toEqual([])
})

// The review of #1635: a file from before Leads were kept, or one that cannot be read, must not let a stop through to a
// Lead. Until a roster says which members are Leads, each member may be one; a file nobody can read protects them all.
it('treats a stop as possibly of a Lead until a valid roster says otherwise', () => {
  const dir = root(), file = retentionFile(dir)
  expect(mayBeLead(dir, 'anyone')).toBe(false)
  retainContributions(dir, 'machine', [row('lead', { lead: true }), row('worker')])
  expect([mayBeLead(dir, 'lead'), mayBeLead(dir, 'worker'), mayBeLead(dir, 'personal')]).toEqual([true, false, false])
  writeFileSync(file, JSON.stringify({ version: 2, machineId: 'machine', harnesses: ['old-member'] }))
  expect([mayBeLead(dir, 'old-member'), mayBeLead(dir, 'personal')]).toEqual([true, false])
  writeFileSync(file, '{')
  expect([mayBeLead(dir, 'old-member'), mayBeLead(dir, 'personal')]).toEqual([true, true])
  retainContributions(dir, 'machine', [row('worker')])
  expect([mayBeLead(dir, 'old-member'), mayBeLead(dir, 'worker')]).toEqual([false, false])
})

// A session the backend ends is closed by the host, and only one it already kept as a member: the retention is that proof,
// across host restarts, for the host and for the core's close alike.
it('keeps a session the backend ends only while it was already a member', () => {
  const dir = root(), now = Date.now()
  retainContributions(dir, 'machine', [row('stranger', { closeSession: true, active: false })], now)
  expect([...retainedHarnesses(dir, now)]).toEqual([])
  retainContributions(dir, 'machine', [row('member')], now)
  retainContributions(dir, 'machine', [row('member', { closeSession: true, active: false }), row('stranger', { closeSession: true })], now)
  expect([...retainedHarnesses(dir, now)]).toEqual(['member'])
  retainContributions(dir, 'machine', [row('member', { closeSession: true })], now)
  expect([...retainedHarnesses(dir, now)]).toEqual(['member'])
  retainContributions(dir, 'machine', [], now)
  expect([...retainedHarnesses(dir, now)]).toEqual([])
})
