/**
 * What a person has open on this computer: the desktop app, or `harness tui`. Each is its own presence.
 * Here, not in core/api.ts: the gateway reads these off its pipe to the core, and it may take only types
 * from the core's API (src/architecture.spec.ts), so that it runs in a process of its own without the core.
 */
export type WindowSurface = 'desktop' | 'tui'
export type LocalWindows = Record<WindowSurface, number>
export const WINDOW_SURFACES: readonly WindowSurface[] = ['desktop', 'tui']

/** A surface off the core↔gateway pipe: anything but `tui` is the desktop app. */
export const windowSurfaceOf = (value: unknown): WindowSurface => (value === 'tui' ? 'tui' : 'desktop')

/** Window counts off the core↔gateway pipe; anything unreadable is none. */
export const localWindowsOf = (value: unknown): LocalWindows => {
  const counts = (value ?? {}) as Partial<Record<WindowSurface, unknown>>
  const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)
  return { desktop: count(counts.desktop), tui: count(counts.tui) }
}

/** The windows attached now, per surface, from the loopback clients: a tool (`harness pair`, MCP) is no window. */
export const countWindows = (clients: number, tools: number, tuis: number): LocalWindows =>
  ({ desktop: clients - tools - tuis, tui: tuis })
