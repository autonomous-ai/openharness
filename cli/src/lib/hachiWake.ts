/**
 * The line that wakes Hachi (docs/design/2026-11-12-hachi.md, "How it learns about other harnesses"). Between turns
 * Hachi's CLI cannot listen, so the daemon types one short line into its composer when a harness it started needs the
 * person, is done or stopped. Typed there, any words in it read as if the person wrote them, in the one harness that
 * passes the start gate, and a harness's question can quote a pull request or a file. So the line is built here by code,
 * from a fixed template and three fields only: the harness's name and its machine's name, each kept to letters, digits,
 * `-`, `_` and `.`, at most 40 of them, and a state from a closed list. Never a word a harness wrote: Hachi reads that
 * with `harness show`, where it arrives as a tool result, which its instructions treat as data.
 */

/** The states that wake Hachi, and how the line says each. Anything else wakes nothing. */
const SAID = { needs_person: 'needs the person', done: 'done', stopped: 'stopped' } as const
export type WakeState = keyof typeof SAID
export const WAKE_STATES = Object.keys(SAID) as WakeState[]

/** The most of a harness's or a machine's name a line keeps. */
export const WAKE_NAME_MAX = 40

export interface WakeItem { name: string; machine: string; state: WakeState }

const kept = (value: unknown): string => (typeof value === 'string' ? value.replace(/[^A-Za-z0-9._-]/g, '').slice(0, WAKE_NAME_MAX) : '')

/** The items a line may say, from whatever was given: each a name, a machine and a state from the list, nothing else. */
export function wakeItems(given: unknown): WakeItem[] {
  if (!Array.isArray(given)) return []
  const items: WakeItem[] = []
  for (const each of given) {
    const item = each as Record<string, unknown> | null
    const name = kept(item?.name), machine = kept(item?.machine), state = item?.state
    if (!name || !machine || typeof state !== 'string' || !Object.hasOwn(SAID, state)) continue
    items.push({ name, machine, state: state as WakeState })
  }
  return items
}

/** `[harness] api-fix @studio: done. reviewer @laptop: needs the person.`, or null for nothing to say. */
export function wakeLine(items: readonly WakeItem[]): string | null {
  const said = wakeItems(items).map((item) => `${item.name} @${item.machine}: ${SAID[item.state]}.`)
  return said.length ? `[harness] ${said.join(' ')}` : null
}
