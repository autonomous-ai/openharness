import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { retainContributions, retainedHarnesses, retentionFile } from './retention.js'

const roots: string[] = []
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'super-retention-')); roots.push(dir); return dir }
const row = (harnessId: string, machineId = 'machine') => ({ tabId: 'tab', agent: { harnessId, machineId } })
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })

it('retains exact members durably, avoids unchanged writes and releases only the confirmed host roster', () => {
  const dir = root()
  expect([...retainedHarnesses(dir)]).toEqual([])
  retainContributions(dir, 'machine', [row('multiply'), row('divide'), row('multiply')])
  retainContributions(dir, 'other', [row('combine', 'other')])
  expect([...retainedHarnesses(dir)].sort()).toEqual(['combine', 'divide', 'multiply'])
  const file = retentionFile(dir), before = statSync(file, { bigint: true }).mtimeNs
  retainContributions(dir, 'machine', [row('divide'), row('multiply')])
  expect(statSync(file, { bigint: true }).mtimeNs).toBe(before)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  retainContributions(dir, 'machine', [])
  expect([...retainedHarnesses(dir)]).toEqual(['combine'])
})

it('does not release retained sessions on a malformed or wrong-machine roster', () => {
  const dir = root()
  retainContributions(dir, 'machine', [row('multiply')])
  const before = readFileSync(retentionFile(dir), 'utf8')
  for (const rows of [[{}], [row('foreign', 'other')], [row('../bad')]]) {
    expect(() => retainContributions(dir, 'machine', rows)).toThrow()
    expect(readFileSync(retentionFile(dir), 'utf8')).toBe(before)
  }
  expect(() => retainContributions(dir, '../bad', [])).toThrow()
})

it('pauses cleanup on corrupt, oversized or lost retention instead of treating it as an empty team', () => {
  const dir = root(), file = retentionFile(dir)
  retainContributions(dir, 'machine', [row('multiply')])
  for (const value of ['{', '{}', '{"version":1,"machines":[]}', '{"version":1,"machines":{"machine":[null]}}', ' '.repeat(4 * 1024 * 1024 + 1)]) {
    writeFileSync(file, value)
    expect(() => retainedHarnesses(dir)).toThrow()
  }
  unlinkSync(file)
  expect(() => retainedHarnesses(dir)).toThrow()
})
