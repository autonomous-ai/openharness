import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearSafeModeMarker, readSafeModeMarker, runBootHandoff, safeModeDisposition,
  safeModeFile, safeModeStatusBody, writeSafeModeMarker, type BootHandoffDeps,
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
  })

  it('stays when the pid file names us, or names a corpse', () => {
    expect(safeModeDisposition(new Error('boom'), { selfPid: 100, readPid: () => 100, isAlive: () => true }).stay).toBe(true)
    expect(safeModeDisposition(new Error('boom'), { selfPid: 100, readPid: () => 200, isAlive: () => false }).stay).toBe(true)
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
    let env: Record<string, string> = {}
    let exited: number | null = null
    const deps: BootHandoffDeps = {
      closeServer: () => calls.push('close'),
      removePidFile: () => calls.push('removePid'),
      spawn: (extra) => { calls.push('spawn'); env = extra; return { pid: 999, unref: () => calls.push('unref') } },
      exit: ((code: number) => { calls.push(`exit:${code}`); exited = code; return undefined as never }),
      log: () => {},
      ...over,
    }
    return { deps, calls, env: () => env, exited: () => exited }
  }

  it('releases the port, then the pid file, then spawns the successor and leaves', () => {
    const h = harness()
    runBootHandoff('0.3.5', '0.3.6', h.deps)
    expect(h.calls).toEqual(['close', 'removePid', 'spawn', 'unref', 'exit:0'])
    expect(h.env()).toEqual({ ADAPTER_UPDATED_TO: '0.3.6' })
  })

  it('has already exited by the time it returns — the property that makes two daemons impossible', () => {
    // Nothing is awaited, so the half-built boot cannot interleave between closing the port and the
    // exit, and can never reach the code that would bind the port the successor is taking.
    const h = harness()
    runBootHandoff('0.3.5', '0.3.6', h.deps)
    expect(h.exited()).toBe(0)   // no await, no tick: true immediately after the call returns
  })

  it('a start-up that never bound or claimed anything still hands off', () => {
    const h = harness({ closeServer: () => {}, removePidFile: () => {} })
    runBootHandoff('0.3.5', '0.3.6', h.deps)
    expect(h.calls).toEqual(['spawn', 'unref', 'exit:0'])
  })

  it('says which pid took over, so the log names the successor', () => {
    const lines: string[] = []
    const h = harness({ log: (m) => lines.push(m) })
    runBootHandoff('0.3.5', '0.3.6', h.deps)
    expect(lines[0]).toContain('0.3.5 → 0.3.6')
    expect(lines[1]).toContain('pid 999')
  })
})
