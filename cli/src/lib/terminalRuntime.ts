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

export function processIdentityKey(engine: string, identity: ProcessIdentity): string {
  return `${assertKeyPart(engine, 'engine')}${SEP}${identity.pid}${SEP}${assertKeyPart(identity.startMarker, 'process start marker')}`
}

export function sameProcessIdentity(a: ProcessIdentity | undefined, b: ProcessIdentity | undefined): boolean {
  return !!a && !!b && a.pid === b.pid && a.startMarker === b.startMarker
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
