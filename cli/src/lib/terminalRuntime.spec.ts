import { describe, expect, it } from 'vitest'
import {
  mergeTerminalRuntimes,
  processIdentityKey,
  sameProcessIdentity,
  terminalPlacementKey,
  terminalRouteKey,
} from './terminalRuntime.js'
import type { TmuxRuntimeRef } from './terminalTypes.js'

const tmux: TmuxRuntimeRef = { backend: 'tmux', paneId: '%3' }
describe('terminal runtime identity', () => {
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

  it('rejects separator injection into stable keys', () => {
    expect(() => terminalRouteKey({ backend: 'tmux', paneId: '%1\u0000other' })).toThrow('invalid tmux pane id')
  })
})
