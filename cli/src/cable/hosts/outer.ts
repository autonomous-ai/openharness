/**
 * An agent nested in a multiplexer (the person's tmux, the person's herdr) runs on that multiplexer's pty, which is no
 * tab: the person sees it in the app that holds the multiplexer's client. Each multiplexer has its own lookup, and
 * neither knows the other; the caller (`devices.ts`: herdr's, then tmux's) picks the order, so herdr inside the
 * person's tmux keeps tmux's answer whenever herdr's finds no app.
 */

/**
 * Where the person sees an agent nested in a multiplexer whose own pty is no tab: `undefined` at once when the agent
 * is not nested in it, else a promise that never rejects, `{}` when no app was found.
 */
export type OuterLookup = (
  hints: Readonly<Record<string, string>>,
  pid: number,
) => Promise<{ app?: string; tty?: string }> | undefined

/** The first lookup's answer when it names an app; else the second's, asked only once the first has settled. */
export function firstOuter(first: OuterLookup, second: OuterLookup): OuterLookup {
  return (hints, pid) => {
    const found = first(hints, pid)
    if (!found) return second(hints, pid)
    return found.then((place) => (place.app ? place : (second(hints, pid) ?? {})))
  }
}
