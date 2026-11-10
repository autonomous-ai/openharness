import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ASSIGNED_GRACE_MS, mayBeLead, RETENTION_LAPSE_MS, retainContributions, retainedHarnesses, retainedLeads, retentionFile } from './retention.js'

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

// The v3 Buddy is gone (backend S17): a row that still names an owner keeps nothing in no open group, and reopens nothing.
it('keeps no session in no open group, whatever owner its row names', () => {
  const dir = root(), now = Date.now()
  retainContributions(dir, 'machine', [{ tabId: 'tab', active: false, agent: { harnessId: 'owned', machineId: 'machine',
    buddyOf: { personId: 'diego', generation: 'g1' } }, buddySleepManaged: true }], now)
  expect([...retainedHarnesses(dir, now)]).toEqual([])
  expect([...retainedLeads(dir)]).toEqual([])
  expect(mayBeLead(dir, 'owned')).toBe(false)
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

// 11-04 on the Mac Studio: Tern's last group was archived, so the roster no longer kept it, and the idle cleanup may close it
// in the very poll its next task arrives in (task #2744). An assignment the host holds keeps its harness, and for a minute.
it('retains a harness that holds an assignment, and for a minute after the host first received it', () => {
  const dir = root(), now = Date.now(), file = retentionFile(dir)
  const work = (harnessId: string) => ({ tabId: 'tab', assignmentId: `work-${harnessId}`, harnessId })
  retainContributions(dir, 'machine', [row('tern', { active: false })], now, [work('tern'), { tabId: 'tab' }, work('../bad')])
  expect([...retainedHarnesses(dir, now)]).toEqual(['tern'])
  // Unchanged while it holds it: no write each poll.
  const before = statSync(file, { bigint: true }).mtimeNs
  retainContributions(dir, 'machine', [row('tern', { active: false })], now + 20_000, [work('tern')])
  expect(statSync(file, { bigint: true }).mtimeNs).toBe(before)
  // Its assignment ended: kept until a minute after it first came, then released.
  retainContributions(dir, 'machine', [row('tern', { active: false })], now + ASSIGNED_GRACE_MS - 1, [])
  expect([...retainedHarnesses(dir, now + ASSIGNED_GRACE_MS - 1)]).toEqual(['tern'])
  retainContributions(dir, 'machine', [row('tern', { active: false })], now + ASSIGNED_GRACE_MS, [])
  expect([...retainedHarnesses(dir, now + ASSIGNED_GRACE_MS)]).toEqual([])
  // A roster read alone, as an older caller makes it, keeps the minute of one received just now.
  retainContributions(dir, 'machine', [], now, [work('heron')])
  retainContributions(dir, 'machine', [], now + 1000)
  expect([...retainedHarnesses(dir, now + 1000)]).toEqual(['heron'])
})

// Backend S14 (#3877): there is no crew. A row the server still marks crew or Member is kept as any member: it lapses, and
// it is not among the sessions the core may reopen.
it('keeps no crew: a row marked crew or Member is retained as any member', () => {
  const dir = root(), now = Date.now(), file = retentionFile(dir)
  const marked = (harnessId: string, agent: Record<string, unknown>) => ({ tabId: 'tab', active: false, agent: { harnessId, machineId: 'machine', ...agent } })
  retainContributions(dir, 'machine', [marked('crew', { crew: { role: 'Engineer', at: 1, by: 'pm' } }),
    marked('member', { member: { projectId: 'p1' } }), row('pm', { lead: true })], now)
  expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('crew')
  expect([...retainedLeads(dir)]).toEqual(['pm'])
  const lapsed = new Date(now - RETENTION_LAPSE_MS - 60_000)
  utimesSync(file, lapsed, lapsed)
  expect([...retainedHarnesses(dir, now)]).toEqual(['pm'])
})

