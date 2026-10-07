import type { LocalWindows, WindowSurface } from '../core/api.js'

export const WINDOW_SURFACES: readonly WindowSurface[] = ['desktop', 'tui']
/** A surface off the core↔gateway pipe: anything but `tui` is the desktop app. */
export const windowSurfaceOf = (value: unknown): WindowSurface => (value === 'tui' ? 'tui' : 'desktop')
/** Window counts off the core↔gateway pipe; anything unreadable is none. */
export const localWindowsOf = (value: unknown): LocalWindows => {
  const counts = (value ?? {}) as Partial<Record<WindowSurface, unknown>>
  const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)
  return { desktop: count(counts.desktop), tui: count(counts.tui) }
}
