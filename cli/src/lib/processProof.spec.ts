import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { recordedProcessDead, START_SLACK_MS, startedNoLaterThan } from './processProof.js'

const filetime = (ms: number) => `w:${(BigInt(ms) + 11_644_473_600_000n) * 10_000n}`
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

describe('recordedProcessDead', () => {
  it('is proven by a pid that runs nothing, a table without it, or a process started after its file was written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'proof-'))
    dirs.push(dir)
    const file = join(dir, 'daemon-18473.json')
    writeFileSync(file, '{}')
    const row = (startMarker: string) => ({ pid: 42, executable: 'node.exe', startMarker })
    expect(await recordedProcessDead(file, 42, { alive: () => false })).toBe(true)
    expect(await recordedProcessDead(file, 42, { alive: () => true })).toBe(false)
    expect(await recordedProcessDead(file, 42, { alive: () => true, rows: async () => [] })).toBe(true)
    expect(await recordedProcessDead(file, 42, { alive: () => true, rows: async () => [row(filetime(Date.now() + 60_000))] })).toBe(true)
    expect(await recordedProcessDead(file, 42, { alive: () => true, rows: async () => [row(filetime(Date.now() - 60_000))] })).toBe(false)
    // No proof: a table that cannot be read, a marker that cannot be read, a file that is not there.
    expect(await recordedProcessDead(file, 42, { alive: () => true, rows: async () => null })).toBe(false)
    expect(await recordedProcessDead(file, 42, { alive: () => true, rows: async () => { throw new Error('ps') } })).toBe(false)
    expect(await recordedProcessDead(file, 42, { alive: () => true, rows: async () => [row('soon')] })).toBe(false)
    expect(await recordedProcessDead(join(dir, 'gone.json'), 42, { alive: () => true, rows: async () => [row(filetime(Date.now() + 60_000))] })).toBe(false)
  })
})

describe('startedNoLaterThan', () => {
  const filetime = (ms: number) => `w:${(BigInt(ms) + 11_644_473_600_000n) * 10_000n}`
  it('holds for a process that started before the file was written, or within the slack after', () => {
    const written = Date.parse('2026-10-18T10:00:00Z')
    expect(startedNoLaterThan({ startMarker: filetime(written - 60_000) }, written)).toBe(true)
    expect(startedNoLaterThan({ startMarker: filetime(written + START_SLACK_MS) }, written)).toBe(true)
    expect(startedNoLaterThan({ startMarker: filetime(written + START_SLACK_MS + 1) }, written)).toBe(false)
  })

  it('does not hold when the start cannot be read', () => {
    expect(startedNoLaterThan({ startMarker: '' }, Date.now())).toBe(false)
    expect(startedNoLaterThan({ startMarker: 'not a time' }, Date.now())).toBe(false)
  })
})
