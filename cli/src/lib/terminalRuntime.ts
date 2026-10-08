import type { ProcessIdentity, TerminalRuntimeRef } from './terminalTypes.js'

const SEP = '\u0000'

function assertKeyPart(value: string, field: string): string {
  if (!value || value.includes(SEP)) throw new Error(`invalid ${field}`)
  return value
}

/** Stable route key. */
export function terminalRouteKey(runtime: TerminalRuntimeRef): string {
  return `tmux${SEP}${assertKeyPart(runtime.paneId, 'tmux pane id')}`
}

export function terminalInstanceId(_runtime: TerminalRuntimeRef): string {
  return 'tmux:default'
}

/** Human-readable locator label for status and logs. */
export function terminalRuntimeLabel(runtime: TerminalRuntimeRef): string {
  return `tmux:${runtime.paneId}`
}

/** Stable placement key. For tmux the pane id is both the route and the placement identity. */
export function terminalPlacementKey(runtime: TerminalRuntimeRef): string {
  return terminalRouteKey(runtime)
}

function startTicks(identity: ProcessIdentity): number | undefined {
  return Number.isSafeInteger(identity.startTicks) && identity.startTicks! >= 0 ? identity.startTicks : undefined
}

/** Keyed by the start ticks when known: the marker of the same process moves with the wall clock. */
export function processIdentityKey(engine: string, identity: ProcessIdentity): string {
  const ticks = startTicks(identity)
  const start = ticks === undefined ? assertKeyPart(identity.startMarker, 'process start marker') : `t:${ticks}`
  return `${assertKeyPart(engine, 'engine')}${SEP}${identity.pid}${SEP}${start}`
}

/**
 * pid + start time is a process. The start ticks decide when both sides have them (see
 * `ProcessIdentity.startTicks`); otherwise the `ps` marker, as before them — which is also how a row
 * saved before them is matched once, and then saved with them.
 */
export function sameProcessIdentity(a: ProcessIdentity | undefined | null, b: ProcessIdentity | undefined | null): boolean {
  if (!a || !b || a.pid !== b.pid) return false
  const ticksA = startTicks(a)
  const ticksB = startTicks(b)
  return ticksA !== undefined && ticksB !== undefined ? ticksA === ticksB : a.startMarker === b.startMarker
}

/** The identity a row stands for, without the rest of the row. */
export function processIdentityOf(row: ProcessIdentity): ProcessIdentity {
  return {
    pid: row.pid, executable: row.executable, startMarker: row.startMarker,
    ...(row.startTicks !== undefined ? { startTicks: row.startTicks } : {}),
  }
}

export function sameTerminalPlacement(a: TerminalRuntimeRef, b: TerminalRuntimeRef): boolean {
  return terminalPlacementKey(a) === terminalPlacementKey(b)
}

/** Merge observed runtimes into the current set without duplicating a placement. */
export function mergeTerminalRuntimes(
  current: readonly TerminalRuntimeRef[],
  observed: readonly TerminalRuntimeRef[],
): TerminalRuntimeRef[] {
  const merged = new Map<string, TerminalRuntimeRef>()
  for (const runtime of current) merged.set(terminalPlacementKey(runtime), runtime)
  for (const runtime of observed) merged.set(terminalPlacementKey(runtime), runtime)
  return [...merged.values()].sort((a, b) => terminalPlacementKey(a).localeCompare(terminalPlacementKey(b)))
}
