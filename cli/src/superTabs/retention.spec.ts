import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { RETENTION_LAPSE_MS, retainContributions, retainedHarnesses, retentionFile } from './retention.js'

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
