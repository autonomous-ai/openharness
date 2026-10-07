import { describe, expect, it } from 'vitest'
import { countWindows, localWindowsOf, WINDOW_SURFACES, windowSurfaceOf } from './windowSurfaces.js'

describe('the windows a person has open, per surface', () => {
  it('reads a surface off the pipe: anything but tui is the desktop app', () => {
    expect(WINDOW_SURFACES).toEqual(['desktop', 'tui'])
    expect(windowSurfaceOf('tui')).toBe('tui')
    for (const value of ['desktop', 'web', undefined, null, 3, {}]) expect(windowSurfaceOf(value)).toBe('desktop')
  })

  it('reads window counts off the pipe, and anything unreadable as none', () => {
    expect(localWindowsOf({ desktop: 2, tui: 1 })).toEqual({ desktop: 2, tui: 1 })
    expect(localWindowsOf({ desktop: 2.7, tui: -1 })).toEqual({ desktop: 2, tui: 0 })
    expect(localWindowsOf({ desktop: 'two', tui: Number.NaN })).toEqual({ desktop: 0, tui: 0 })
    expect(localWindowsOf({ desktop: Number.POSITIVE_INFINITY })).toEqual({ desktop: 0, tui: 0 })
    expect(localWindowsOf(undefined)).toEqual({ desktop: 0, tui: 0 })
    expect(localWindowsOf(null)).toEqual({ desktop: 0, tui: 0 })
  })

  it('counts the loopback clients that are windows: tools are none, and tui windows are their own', () => {
    expect(countWindows(0, 0, 0)).toEqual({ desktop: 0, tui: 0 })
    expect(countWindows(5, 2, 1)).toEqual({ desktop: 2, tui: 1 })
    expect(countWindows(3, 0, 3)).toEqual({ desktop: 0, tui: 3 })
  })
})
