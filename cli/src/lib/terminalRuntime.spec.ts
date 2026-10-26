import { describe, expect, it } from 'vitest'
import {
  mergeTerminalRuntimes,
  ownedPanesOf,
  processIdentityKey,
  processIdentityOf,
  primaryRuntime,
  sameProcessIdentity,
  sessionForPaneId,
  terminalInstanceId,
  terminalPlacementKey,
  terminalRouteKey,
  terminalRuntimeLabel,
} from './terminalRuntime.js'
import type { TmuxRuntimeRef } from './terminalTypes.js'

const tmux: TmuxRuntimeRef = { backend: 'tmux', paneId: '%3' }
describe('terminal runtime identity', () => {
  it('hands a backend only the panes on it, each with its row\'s engine', () => {
    // A ptyhost pane has a `%N` id too: handed to tmux, it could rename a legacy session that is not its.
    const ptyhost = { backend: 'ptyhost' as const, instance: 'p1', paneId: '%7' }
    const sessions = [
      { engine: 'claude' as const, runtimes: [tmux, ptyhost] },
      { engine: 'codex' as const, runtimes: [{ backend: 'tmux' as const, paneId: '%8' }] },
      { engine: 'opencode' as const, runtimes: [{ ...ptyhost, paneId: '%9' }] },
    ]
    expect([...ownedPanesOf(sessions, 'tmux')]).toEqual([['%3', 'claude'], ['%8', 'codex']])
  })

  it('keys ptyhost runtimes by instance and pane', () => {
    const r = { backend: 'ptyhost' as const, instance: 'p1', paneId: '%4' }
    expect(terminalRouteKey(r)).toBe('ptyhost\u0000p1\u0000%4')
    expect(terminalInstanceId(r)).toBe('ptyhost:p1')
    expect(terminalRuntimeLabel(r)).toBe('ptyhost:p1:%4')
    expect(terminalRouteKey({ backend: 'tmux', paneId: '%4' })).toBe('tmux\u0000%4')
    expect(terminalInstanceId({ backend: 'tmux', paneId: '%4' })).toBe('tmux:default')
    expect(() => terminalRouteKey({ ...r, instance: '' })).toThrow('invalid pty host instance')
  })

  it('sessionForPaneId accepts p2-0.4.21-dev.win1:%7 and p2-h0123456789ab:%7', () => {
    const row = (agentId: string, instance: string) => ({ agentId, runtimes: [{ backend: 'ptyhost' as const, instance, paneId: '%7' }] })
    // Two builds of one protocol side by side: each pane is its own host's.
    const rows = [row('legacy', 'p2'), row('dev', 'p2-0.4.21-dev.win1'), row('hashed', 'p2-h0123456789ab'), { agentId: 'tmux', runtimes: [{ backend: 'tmux' as const, paneId: '%7' }] }]
    expect(sessionForPaneId(rows, 'p2-0.4.21-dev.win1:%7')?.agentId).toBe('dev')
    expect(sessionForPaneId(rows, 'p2-h0123456789ab:%7')?.agentId).toBe('hashed')
    expect(sessionForPaneId(rows, 'p2:%7')?.agentId).toBe('legacy')
    expect(sessionForPaneId(rows, '%7')?.agentId).toBe('tmux')
    expect(sessionForPaneId(rows, 'p2-0.4.22:%7')).toBeUndefined()
  })

  it('takes a session\'s first runtime as its primary, whatever its backend', () => {
    const ptyhost = { backend: 'ptyhost' as const, instance: 'p1', paneId: '%4' }
    expect(primaryRuntime({ runtimes: [ptyhost, tmux] })).toBe(ptyhost)
    expect(primaryRuntime({ runtimes: [tmux] })).toBe(tmux)
  })

  it('merges observed runtimes without duplicating a placement', () => {
    const other: TmuxRuntimeRef = { backend: 'tmux', paneId: '%4' }
    expect(terminalPlacementKey(tmux)).toBe(terminalRouteKey(tmux))
    expect(mergeTerminalRuntimes([tmux], [other, { ...tmux }])).toEqual([tmux, other])
  })

  it('keys process identity without treating argv-derived executable as authoritative', () => {
    const before = { pid: 42, executable: 'node', startMarker: 'Sat Aug 15 10:00:00 2026' }
    const renamed = { ...before, executable: 'agent title' }
    expect(sameProcessIdentity(before, renamed)).toBe(true)
    expect(processIdentityKey('claude', before)).toBe(processIdentityKey('claude', renamed))
  })

  it('judges a process by its start ticks when both sides have them, else by its ps marker', () => {
    const saved = { pid: 42, executable: 'node', startMarker: 'Wed Oct  7 09:48:11 2026', startTicks: 26385008 }
    // The same process after the clock was stepped: lstart moved, the ticks did not.
    const stepped = { ...saved, startMarker: 'Thu Oct  8 00:46:03 2026' }
    expect(sameProcessIdentity(saved, stepped)).toBe(true)
    expect(processIdentityKey('codex', saved)).toBe(processIdentityKey('codex', stepped))
    expect(sameProcessIdentity(saved, { ...saved, startTicks: 26385009 })).toBe(false)
    expect(sameProcessIdentity(saved, { ...saved, pid: 43 })).toBe(false)
    const { startTicks: _, ...legacy } = saved
    expect(sameProcessIdentity(legacy, saved)).toBe(true)
    expect(sameProcessIdentity(legacy, stepped)).toBe(false)
    expect(sameProcessIdentity(undefined, saved)).toBe(false)
    expect(processIdentityKey('codex', legacy)).not.toBe(processIdentityKey('codex', saved))
    expect(processIdentityOf({ ...stepped, parentPid: 1, args: 'codex' } as typeof stepped)).toEqual(stepped)
    expect(processIdentityOf(legacy)).toEqual(legacy)
  })

  it('rejects separator injection into stable keys', () => {
    expect(() => terminalRouteKey({ backend: 'tmux', paneId: '%1\u0000other' })).toThrow('invalid pane id')
  })
})
