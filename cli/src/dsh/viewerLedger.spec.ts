import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProcessRow } from '../lib/processTable.js'
import { ViewerLedger, processStartedAt, windowsViewerLeftovers } from './viewerLedger.js'

// Windows has no `ps`, so nothing was ever reaped, and a viewer's parent is gone once it runs (Git Bash's fork): twelve generations
// of one viewer were running on DESKTOP-0TFH0OJ on 2026-11-04.
describe('a viewer left over on Windows', () => {
  const fileTime = (ms: number) => `w:${(BigInt(ms) + 11_644_473_600_000n) * 10_000n}`
  const row = (pid: number, parentPid: number, args: string, startedMs: number): ProcessRow =>
    ({ pid, parentPid, executable: 'node.exe', startMarker: fileTime(startedMs), args })
  const entry = { pid: 50, startedAt: 1_000_000, agentId: 'a', dshId: 'acme/thing', viewerDir: 'C:\\Users\\Me\\.harness\\dsh\\acme\\thing' }
  const VIEWER = '"C:\\Program Files\\nodejs\\node.exe" C:/Users/me/.harness/dsh/acme/thing/toolchain/viewer.mjs'

  it('is the program from its folder whose parent has gone, started since the ledger says', () => {
    expect(windowsViewerLeftovers(entry, [row(9, 1, 'host', 1), row(60, 999, VIEWER, 1_000_500)])).toEqual([60])
  })

  it('is also its launcher, when that still runs and started when the ledger says', () => {
    expect(windowsViewerLeftovers(entry, [row(50, 999, 'bash.exe', 1_000_100)])).toEqual([50])
    expect(windowsViewerLeftovers(entry, [row(50, 999, 'bash.exe', 5_000_000)])).toEqual([])
  })

  it.each([
    ['an agent ran from that folder: its parent is alive', [row(9, 1, 'claude', 1), row(60, 9, VIEWER, 1_000_500)]],
    ['it started long before this viewer: an old pid or an older run', [row(60, 999, VIEWER, 900_000)]],
    ['it runs from another folder', [row(60, 999, '"node.exe" C:/Users/me/.harness/dsh/acme/thing2/viewer.mjs', 1_000_500)]],
  ])('leaves it alone when %s', (_name, rows) => {
    expect(windowsViewerLeftovers(entry, rows)).toEqual([])
  })

  it('ends them, and keeps the ledger when the process table could not be read', () => {
    const file = `${mkdtempSync(join(tmpdir(), 'viewer-ledger-'))}/viewers.json`
    const killed: number[] = []
    const table = { rows: null as ProcessRow[] | null }
    const ledger = new ViewerLedger({ file, platform: 'win32', windowsRows: () => table.rows, kill: pid => { killed.push(pid) } })
    ledger.add(entry)
    expect(ledger.reapOrphans()).toEqual([])
    expect(ledger.read()).toEqual([entry])
    table.rows = [row(60, 999, VIEWER, 1_000_500)]
    expect(ledger.reapOrphans()).toEqual([entry])
    expect(killed).toEqual([60])
    expect(ledger.read()).toEqual([])
  })
})

describe('ViewerLedger', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'viewer-ledger-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const entry = (pid: number, startedAt = 1_000_000) => ({ pid, startedAt, agentId: 'agent-1', dshId: 'acme/thing', viewerDir: '/i/acme/thing' })

  it('records a spawned viewer and forgets it on exit, atomically on disk', () => {
    const file = join(dir, 'viewers.json')
    const ledger = new ViewerLedger({ file, now: () => 42 })
    ledger.add({ pid: 101, agentId: 'a', dshId: 'x/y', viewerDir: '/v' })
    ledger.add(entry(102))
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([
      { pid: 101, agentId: 'a', dshId: 'x/y', viewerDir: '/v', startedAt: 42 },
      entry(102),
    ])
    ledger.remove(101)
    expect(ledger.read()).toEqual([entry(102)])
    // A pid seen again replaces its old row rather than duplicating it.
    ledger.add(entry(102, 2_000_000))
    expect(ledger.read()).toEqual([entry(102, 2_000_000)])
  })

  it('reads a missing or malformed file as empty', () => {
    const ledger = new ViewerLedger({ file: join(dir, 'nope.json') })
    expect(ledger.read()).toEqual([])
    expect(ledger.reapOrphans()).toEqual([])
  })

  it('reaps only a pid that is alive AND started when the ledger says; then starts over', () => {
    const file = join(dir, 'viewers.json')
    const killed: number[] = []
    const log: string[] = []
    const ledger = new ViewerLedger({
      file,
      startedAt: (pid) => ({ 11: 1_000_500, 12: 5_000_000, 13: null }[pid] ?? null),
      kill: (pid) => killed.push(pid),
      log: (line) => log.push(line),
    })
    ledger.add(entry(11))         // alive, start agrees (within tolerance) → reaped
    ledger.add(entry(12))         // alive, but a DIFFERENT process now wears this pid → left alone
    ledger.add(entry(13))         // gone → nothing to do
    ledger.add(entry(1))          // never: pid 1 is init, and its group is everything → refused at add
    const reaped = ledger.reapOrphans()
    expect(reaped.map((e) => e.pid)).toEqual([11])
    expect(killed).toEqual([11])
    expect(log.some((l) => l.includes('reaped orphaned acme/thing viewer pid 11'))).toBe(true)
    expect(log.some((l) => l.includes('pid 12 is no longer'))).toBe(true)
    expect(ledger.read()).toEqual([])
  })

  it('a ledger file naming pid 1 is not trusted either', () => {
    const file = join(dir, 'viewers.json')
    writeFileSync(file, JSON.stringify([entry(1), entry(0), entry(-5)]))
    const killed: number[] = []
    const ledger = new ViewerLedger({ file, startedAt: () => 1_000_000, kill: (pid) => killed.push(pid) })
    expect(ledger.read()).toEqual([])
    expect(ledger.reapOrphans()).toEqual([])
    expect(killed).toEqual([])
  })

  it('processStartedAt reads a real process and reports a dead one as null', async () => {
    const child: ChildProcess = spawn('sleep', ['30'], { stdio: 'ignore' })
    try {
      const at = processStartedAt(child.pid!)
      expect(at).not.toBeNull()
      expect(Math.abs(at! - Date.now())).toBeLessThan(10_000)
    } finally {
      child.kill('SIGKILL')
      await new Promise((resolve) => child.once('exit', resolve))
    }
    expect(processStartedAt(child.pid!)).toBeNull()
  })

  it('the default reaper really stops a leftover process group', async () => {
    const file = join(dir, 'viewers.json')
    const child = spawn('sleep', ['30'], { stdio: 'ignore', detached: true })
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    const ledger = new ViewerLedger({ file, log: vi.fn() })
    ledger.add({ pid: child.pid!, agentId: 'a', dshId: 'x/y', viewerDir: '/v' })
    expect(ledger.reapOrphans().map((e) => e.pid)).toEqual([child.pid])
    await exited
  })
})
