/**
 * The apps the dial reaches an outside agent through (docs/specs/2026-11-15-device-host-adapter.md). Two layers: a
 * source lists the agents, and an adapter is one app they run in, with its own way to bring a pane forward, show it or
 * type in it. Every adapter keeps four rules:
 * 1. `paneOf` checks each hint against its own form, and each verb checks the pane's id again before a command.
 * 2. An adapter is a plain object from a factory. No member uses `this`, so a caller may wrap one by spreading it.
 * 3. A verb that cannot run answers `false` or `'failed'`. It never throws.
 * 4. An agent may have a pane in more than one adapter: the source keeps them all, and each verb uses the first whose
 *    adapter can do it. So `paneOf` answers from its own app's values alone, never from another app's being absent.
 */
import type { PaneSwitch } from './types.js'

/** Where an outside agent runs, from its latest hook event and what was learnt of its process. */
export interface Place {
  host: string                                  // detectHost
  app: string                                   // detectApp
  hints: Readonly<Record<string, string>>       // that event's host hints, as the core checked them
  tty?: string                                  // its process's tty, read for a tab app (observed.ts learnTty)
}

/** One adapter's own handle on one agent: an Orca terminal, a Claude app session, a tab's tty, a pane id. */
export interface Pane {
  adapter: string
  id: string
}

/** One app the dial reaches an outside agent through. */
export interface HostAdapter {
  /** Its app's short name, fixed in its file: the word its log lines say (`[device] open · <id> · fallback`,
   *  `[device] voice · <id>`), never a value from a hook. */
  readonly id: string
  /** Its pane of the agent at that place, every value checked against its own form; none when the agent is not in it. */
  paneOf(place: Place): Pane | undefined
  /** Whether a tap can bring that pane forward on this computer. */
  canFocus(pane: Pane): boolean
  focus(pane: Pane): Promise<boolean>
  /** Whether a rest can show the pane inside its app now (the app in front, a watch open): asked at each look. */
  canShow?(pane: Pane): boolean
  show?(pane: Pane, agentId: string): Promise<PaneSwitch>
  /** Types a line at the agent's prompt and submits it. Only the source decides that the prompt is free. */
  type?(pane: Pane, text: string): Promise<boolean>
  /** A tap's order with the app's own `open -b`: the pane first (Orca, WezTerm, herdr), the pane alone (the Claude
   *  app's link brings the app itself), or the app first (a tab is selected once its app is in front). A pane that comes
   *  after its app is raised only when it is the pane a rest would show, so an adapter with `tap: 'after'` needs `show`:
   *  without it, its `focus` never runs from a tap. */
  readonly tap: 'before' | 'instead' | 'after'
}
