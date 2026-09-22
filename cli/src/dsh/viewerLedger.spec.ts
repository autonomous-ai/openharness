import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ViewerLedger, processStartedAt } from './viewerLedger.js'

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
