/**
 * An agent nested in a multiplexer (the person's tmux, herdr or Zellij) runs on that multiplexer's pty, which is no
 * tab: the person sees it in the app that holds the multiplexer's client. Each multiplexer has its own lookup, and
 * none knows another; the caller (`devices.ts`: herdr's, then tmux's, then Zellij's) picks the order, so herdr inside
 * the person's tmux keeps tmux's answer whenever herdr's finds no app.
 */
import type { Pane } from './adapter.js'
import type { ProcessName } from './scannedApp.js'
import type { Nest } from './types.js'

/**
 * Where the person sees an agent nested in a multiplexer whose own pty is no tab: `undefined` at once when the agent
 * is not nested in it, else a promise that never rejects, `{}` when no app was found. The client's process comes with
 * its app when known: the agent's own is under the multiplexer's server, which owns no window (observed.ts windowOf).
 * `nest`: this lookup's multiplexer made the caller's terminal, whether or not a client was found, so the agent is on
 * that multiplexer's page even with no app known.
 */
export type OuterLookup = (
  hints: Readonly<Record<string, string>>,
  pid: number,
) => Promise<{ app?: string; tty?: string; pid?: number; nest?: Nest }> | undefined

/**
 * The first lookup's answer when it names an app; else the second's when that names one, asked only once the first
 * has settled; else the first's, whose client's process alone still tells which process to raise. Its `nest` is the
 * first answer's that has one: the app may come from the other lookup, the pane is still the confirming one's.
 */
export function firstOuter(first: OuterLookup, second: OuterLookup): OuterLookup {
  return (hints, pid) => {
    const found = first(hints, pid)
    if (!found) return second(hints, pid)
    return found.then(async (place) => {
      if (place.app) return place
      const next = await second(hints, pid)
      const answer = next?.app ? next : place
      const nest = place.nest ?? next?.nest
      return nest ? { ...answer, nest } : answer
    })
  }
}

/** A process the open scan found on a terminal a multiplexer made, which no hook has told of: no hint names its pane.
 *  The multiplexer's host as the maker's read names it (scannedApp.ts readMadeBy), the process, its own tty, the
 *  multiplexer's process that made that terminal, and the look's process table, which its lookup walks instead of
 *  reading its own. */
export interface Nested { host: string; pid: number; tty: string; maker: number; rows: readonly ProcessName[] }

/** Where the person sees it, as an OuterLookup answers, and its pane in the multiplexer: a rest and a tap show that
 *  pane, and no words reach it before the agent's first hook. */
export interface NestedPlace { app?: string; tty?: string; pid?: number; pane?: Pane }

/** Where the person sees a process the scan found nested (Nested): `undefined` at once for a host with no lookup by
 *  process, else a promise that never rejects, `{}` when no app was found. */
export type NestedLookup = (found: Nested) => Promise<NestedPlace> | undefined
