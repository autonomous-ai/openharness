import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearSafeModeMarker, readSafeModeMarker, runBootHandoff, safeModeDisposition,
  safeModeFile, safeModeStatusBody, SafeModeRequest, writeSafeModeMarker, type BootHandoffDeps,
} from './daemonSafeMode.js'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-safe-mode-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('safeModeDisposition', () => {
  const nobody = { selfPid: 100, readPid: () => null, isAlive: () => false }

  it('stays up for a start-up that simply failed', () => {
    expect(safeModeDisposition(new Error('Cannot access \'p4\' before initialization'), nobody))
      .toEqual({ stay: true, reason: 'Cannot access \'p4\' before initialization' })
    expect(safeModeDisposition('tmux is required but unavailable', nobody).stay).toBe(true)
  })

  it('leaves when another daemon owns the machine — a loser must not hold port, pid and update slot', () => {
    expect(safeModeDisposition(new Error('listen EADDRINUSE: address already in use 127.0.0.1:18473'), nobody))
      .toMatchObject({ stay: false })
    expect(safeModeDisposition(new Error('boom'), { selfPid: 100, readPid: () => 200, isAlive: () => true }))
      .toMatchObject({ stay: false, reason: 'another daemon (pid 200) owns this machine' })
    // The data folder's socket already served, before any pid file names the daemon serving it.
    const served = Object.assign(new Error('A Harness daemon is already serving /data/daemon-18473.sock'), { code: 'EADDRINUSE' })
    expect(safeModeDisposition(served, nobody)).toEqual({ stay: false, reason: 'A Harness daemon is already serving /data/daemon-18473.sock' })
    expect(safeModeDisposition(Object.assign(new Error('boom'), { code: 'ENOENT' }), nobody).stay).toBe(true)
    // The core of a master that is gone, still leaving: this core leaves to be started again, not for good.
    const leaving = Object.assign(new Error('The core (pid 8) of a master that is gone still serves /data/daemon-18473.sock'), { code: 'ORPHAN_STILL_SERVING' })
    expect(safeModeDisposition(leaving, nobody)).toEqual({ stay: false, reason: leaving.message, retry: true })
    expect(safeModeDisposition(null, nobody).stay).toBe(true)
  })

  it('stays when the pid file names us, or names a corpse', () => {
    expect(safeModeDisposition(new Error('boom'), { selfPid: 100, readPid: () => 100, isAlive: () => true }).stay).toBe(true)
    expect(safeModeDisposition(new Error('boom'), { selfPid: 100, readPid: () => 200, isAlive: () => false }).stay).toBe(true)
  })

  // Under harnessd the pid file is the master's. Leaving because of it was why safe mode never held
  // under a master: the core exited, and the master restarted it into the same failure.
  it('stays when the pid file names the harnessd master running this core', () => {
    expect(safeModeDisposition(new Error('boom'), { selfPid: 100, masterPid: 200, readPid: () => 200, isAlive: () => true }).stay).toBe(true)
    expect(safeModeDisposition(new Error('boom'), { selfPid: 100, masterPid: 300, readPid: () => 200, isAlive: () => true }).stay).toBe(false)
  })

  it('stays, saying why, when the master asked for safe mode', () => {
    expect(safeModeDisposition(new SafeModeRequest('crash-loop'), { ...nobody, masterPid: 1 }))
      .toEqual({ stay: true, reason: 'harnessd saw this core crash again and again — started in safe mode' })
    const other = new SafeModeRequest('a corrupt registry')
    expect([other.name, other.why, other.message]).toEqual(['SafeModeRequest', 'a corrupt registry', 'harnessd asked for safe mode: a corrupt registry'])
  })
})

describe('safeModeStatusBody', () => {
  // ⚠️ Cross-language contract: `desktop/lib/ws/local_cli_discovery.dart` reads exactly this field
  // and this value to decide "alive but not ready" — which is what stops it respawning every minute.
  it('says not-ready in the one field the desktop keys on', () => {
    const body = safeModeStatusBody({ version: '0.3.5', pid: 7, startedAt: 1, computerId: 'c1', error: 'tmux missing' })
    expect(body.discoveryReady).toBe(false)
    expect(body).toMatchObject({ safeMode: true, connected: false, discoveryError: 'tmux missing', computerId: 'c1' })
  })
})

describe('the safe-mode marker', () => {
  it('round-trips, and a marker left by a dead process reads as none', () => {
    writeSafeModeMarker(dir, { pid: 42, version: '0.3.5', at: 5, error: 'boom' })
    expect(readSafeModeMarker(dir, () => true)).toEqual({ pid: 42, version: '0.3.5', at: 5, error: 'boom' })
    expect(readSafeModeMarker(dir, () => false)).toBeNull()
    clearSafeModeMarker(dir)
    expect(readSafeModeMarker(dir, () => true)).toBeNull()
  })

  it('a corrupt marker is no marker, never a crash', () => {
    writeFileSync(safeModeFile(dir), '{ not json')
    expect(readSafeModeMarker(dir, () => true)).toBeNull()
    expect(readFileSync(safeModeFile(dir), 'utf-8')).toBe('{ not json')
  })
})

describe('runBootHandoff', () => {
  function harness(over: Partial<BootHandoffDeps> = {}) {
    const calls: string[] = []
    let exited: number | null = null
    const deps: BootHandoffDeps = {
      closeServer: () => calls.push('close'),
      probeMaster: () => { calls.push('probe'); return null },
      rollBack: () => calls.push('roll back'),
      startMaster: () => calls.push('start the master'),
      exit: ((code: number) => { calls.push(`exit:${code}`); exited = code; return undefined as never }),
      log: () => {},
      ...over,
    }
    return { deps, calls, exited: () => exited }
  }

  it('probes the new build\'s master, releases the port, then starts the master on the new build, and leaves', () => {
    const h = harness()
    runBootHandoff('0.3.5', '0.3.6', h.deps)
    expect(h.calls).toEqual(['probe', 'close', 'start the master', 'exit:0'])
  })

  it('rolls a build whose master does not answer back, and starts this build\'s master instead', () => {
    const lines: string[] = []
    const h = harness({ probeMaster: () => 'harnessd-probe failed: a bad build', log: (m) => lines.push(m) })
    runBootHandoff('0.3.5', '0.3.6', h.deps)
    expect(h.calls).toEqual(['roll back', 'close', 'start the master', 'exit:0'])
    expect(lines[1]).toBe('[update] 0.3.6\'s master did not answer its probe (harnessd-probe failed: a bad build) — rolled back; 0.3.5 goes on under a master of its own')
  })

  it('has already exited by the time it returns — the property that makes two daemons impossible', () => {
    // Nothing is awaited, so the half-built boot cannot interleave between closing the port and the
    // exit, and can never reach the code that would bind the port the successor is taking.
    const h = harness()
    runBootHandoff('0.3.5', '0.3.6', h.deps)
    expect(h.exited()).toBe(0)   // no await, no tick: true immediately after the call returns
  })

  it('says what it hands over, and to whom', () => {
    const lines: string[] = []
    const h = harness({ log: (m) => lines.push(m) })
    runBootHandoff('0.3.5', '0.3.6', h.deps)
    expect(lines[0]).toContain('0.3.5 → 0.3.6')
    expect(lines[0]).toContain('harnessd\'s master')
  })
})
