import { describe, expect, it, vi } from 'vitest'
import { canRestart, heldIn, missingBackendCode, noBackendCode, restartTargetOf, terminalTargetOf, type TerminalBackend } from './terminalBackend.js'
import type { TerminalRuntimeRef } from './terminalTypes.js'

const tmux = { backend: 'tmux' as const, paneId: '%3' }
const pty = { backend: 'ptyhost' as const, instance: 'p1', paneId: '%3' }
const restartable = (name: string) => ({ name, holdOpen: vi.fn(), respawn: vi.fn() }) as unknown as TerminalBackend
const plain = { name: 'other' } as unknown as TerminalBackend

describe('the restart gate', () => {
  it('is the two primitives, never the backend name', () => {
    expect(canRestart(restartable('ptyhost'))).toBe(true)
    expect(canRestart({ name: 'tmux', holdOpen: vi.fn() } as unknown as TerminalBackend)).toBe(false)
    expect(canRestart({ name: 'tmux', respawn: vi.fn() } as unknown as TerminalBackend)).toBe(false)
    expect(canRestart(undefined)).toBe(false)
    expect(canRestart(null)).toBe(false)
  })
})

describe('where a row restarts', () => {
  it('is a ptyhost row\'s own runtime, on its own backend', () => {
    const backend = restartable('ptyhost')
    const backendFor = vi.fn((runtime: TerminalRuntimeRef) => runtime.backend === 'ptyhost' ? backend : undefined)
    expect(restartTargetOf({ runtimes: [pty] }, backendFor)).toEqual({ backend, runtime: pty })
    expect(backendFor).toHaveBeenCalledExactlyOnceWith(pty)
  })

  it('prefers the tmux runtime, as before other backends could restart, though ptyhost sorts first', () => {
    const tmuxBackend = restartable('tmux')
    const ptyBackend = restartable('ptyhost')
    const backendFor = (runtime: TerminalRuntimeRef) => runtime.backend === 'tmux' ? tmuxBackend : ptyBackend
    expect(restartTargetOf({ runtimes: [pty, tmux] }, backendFor)).toEqual({ backend: tmuxBackend, runtime: tmux })
  })

  it('falls through to a runtime whose backend can, and is none when none can', () => {
    const ptyBackend = restartable('ptyhost')
    expect(restartTargetOf({ runtimes: [pty, tmux] }, (runtime) => runtime.backend === 'tmux' ? plain : ptyBackend))
      .toEqual({ backend: ptyBackend, runtime: pty })
    expect(restartTargetOf({ runtimes: [pty] }, () => plain)).toBeUndefined()
    expect(restartTargetOf({ runtimes: [tmux] }, () => undefined)).toBeUndefined()
    expect(restartTargetOf({ runtimes: [] }, () => ptyBackend)).toBeUndefined()
  })
})

describe('whether a row\'s pane holds a launch', () => {
  it('is asked of the backend its pane is on, its tmux pane first, and is no where none can say', async () => {
    const tmuxHeld = vi.fn(async () => true as const)
    const ptyHeld = vi.fn(async () => 'unknown' as const)
    const backendFor = (runtime: TerminalRuntimeRef) => ({ isHeld: runtime.backend === 'tmux' ? tmuxHeld : ptyHeld }) as unknown as TerminalBackend
    expect(await heldIn({ runtimes: [pty, tmux] }, 'token', backendFor)).toBe(true)
    expect(tmuxHeld).toHaveBeenCalledExactlyOnceWith(tmux, 'token')
    expect(ptyHeld).not.toHaveBeenCalled()
    expect(await heldIn({ runtimes: [pty] }, 'token', backendFor)).toBe('unknown')
    expect(ptyHeld).toHaveBeenCalledExactlyOnceWith(pty, 'token')
    expect(await heldIn({ runtimes: [pty, tmux] }, 'token', (runtime) => runtime.backend === 'tmux' ? plain : undefined)).toBe(false)
    expect(await heldIn({ runtimes: [] }, 'token', backendFor)).toBe(false)
  })
})

describe('where a row\'s pane is reached', () => {
  it('is its tmux runtime first, then any runtime on a backend this daemon has, and none when none is', () => {
    const tmuxBackend = { name: 'tmux' } as unknown as TerminalBackend
    const ptyBackend = { name: 'ptyhost' } as unknown as TerminalBackend
    const both = (runtime: TerminalRuntimeRef) => runtime.backend === 'tmux' ? tmuxBackend : ptyBackend
    expect(terminalTargetOf({ runtimes: [pty, tmux] }, both)).toEqual({ backend: tmuxBackend, runtime: tmux })
    expect(terminalTargetOf({ runtimes: [pty, tmux] }, (runtime) => runtime.backend === 'ptyhost' ? ptyBackend : undefined))
      .toEqual({ backend: ptyBackend, runtime: pty })
    expect(terminalTargetOf({ runtimes: [pty] }, () => undefined)).toBeUndefined()
    expect(terminalTargetOf({ runtimes: [] }, both)).toBeUndefined()
  })

  it('names the missing backend when none is: tmux for a tmux row, as before, the pty host for a pty host row', () => {
    expect(missingBackendCode({ runtimes: [tmux] })).toBe('TMUX_UNAVAILABLE')
    expect(missingBackendCode({ runtimes: [pty, tmux] })).toBe('TMUX_UNAVAILABLE')
    expect(missingBackendCode({ runtimes: [pty] })).toBe('PTY_HOST_UNAVAILABLE')
    expect(missingBackendCode({ runtimes: [] })).toBe('TMUX_UNAVAILABLE')
  })

  it('names the backend new panes are made on when none could be readied', () => {
    expect(noBackendCode(['tmux'])).toBe('TMUX_UNAVAILABLE')
    expect(noBackendCode(['tmux', 'ptyhost'])).toBe('TMUX_UNAVAILABLE')
    expect(noBackendCode(['ptyhost'])).toBe('PTY_HOST_UNAVAILABLE')
    expect(noBackendCode(['ptyhost', 'tmux'])).toBe('PTY_HOST_UNAVAILABLE')
    expect(noBackendCode([])).toBe('TMUX_UNAVAILABLE')
  })
})
