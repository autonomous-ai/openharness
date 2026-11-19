/**
 * An agent nested in a multiplexer (the person's tmux, herdr or Zellij) runs on that multiplexer's pty, which is no
 * tab: the person sees it in the app that holds the multiplexer's client. Each multiplexer has its own lookup, and
 * none knows another; the caller (`devices.ts`: herdr's, then tmux's, then Zellij's) picks the order, so herdr inside
 * the person's tmux keeps tmux's answer whenever herdr's finds no app.
 */

/**
 * Where the person sees an agent nested in a multiplexer whose own pty is no tab: `undefined` at once when the agent
 * is not nested in it, else a promise that never rejects, `{}` when no app was found. The client's process comes with
 * its app when known: the agent's own is under the multiplexer's server, which owns no window (observed.ts windowOf).
 */
export type OuterLookup = (
  hints: Readonly<Record<string, string>>,
  pid: number,
) => Promise<{ app?: string; tty?: string; pid?: number }> | undefined

/** The first lookup's answer when it names an app; else the second's, asked only once the first has settled. */
export function firstOuter(first: OuterLookup, second: OuterLookup): OuterLookup {
  return (hints, pid) => {
    const found = first(hints, pid)
    if (!found) return second(hints, pid)
    return found.then((place) => (place.app ? place : (second(hints, pid) ?? {})))
  }
}
