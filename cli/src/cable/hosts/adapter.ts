/**
 * The apps the dial reaches an outside agent through (docs/specs/2026-11-15-device-host-adapter.md). Two layers: a
 * source lists the agents, and an adapter is one app they run in, with its own way to bring a pane forward, show it or
 * type in it. Every adapter keeps four rules:
 * 1. `paneOf` checks each hint against its own form, and each verb checks the pane's id again before a command.
 * 2. An adapter is a plain object from a factory. No member uses `this`, so a caller may wrap one by spreading it.
 * 3. A verb that cannot run answers `false`, `'failed'` or `'refused'`; `type` may say why, in a `TypeResult`. It never
 *    throws.
 * 4. An agent may have a pane in more than one adapter: the source keeps them all, and each verb uses the first whose
 *    adapter can do it. So `paneOf` answers from its own app's values alone, never from another app's being absent.
 */
import type { PaneSwitch, TypeResult } from './types.js'

/** The terminal app holding a multiplexer's client, that client's tab and its process: the place the person sees the
 *  agent in. The agent's own process is under the multiplexer's server, which owns no window: the client's is the one in
 *  the app's window (the dial-linux spec, 2.2). */
export interface Outer {
  app: string
  tty?: string
  pid?: number
}

/** Where an outside agent runs, from its latest hook event and what was learnt of its process. */
export interface Place {
  host: string                                  // detectHost
  app: string                                   // detectApp
  hints: Readonly<Record<string, string>>       // that event's host hints, as the core checked them
  tty?: string                                  // its process's tty, read for a tab app (observed.ts learnTty)
  pid?: number                                  // its process: that event's caller
  sessionId?: string                            // the engine's own id of the session: the VS Code extension's link names it
  engine?: string                               // whose session it is: that link names Claude Code's alone
  cwd?: string                                  // the folder its latest event named, else its scan row's: Cursor's folder window opens it
  /** The Claude app's own id of a session the open scan found, from the session's record (record.ts), until its first
   *  hook; only the Claude app's adapter reads it. */
  hostSession?: string
  /** The app and tab of the terminal holding the multiplexer's client the agent runs in, from observed.ts; only the tmux,
   *  herdr and tabs adapters read it. */
  outer?: Outer
  /** The host that made the pseudo-terminal its caller runs on (scannedApp.ts readPtyOwner, observed.ts): a terminal's or a
   *  multiplexer's pane is the agent's own only when that host's, and takes words only then. A hint names the pane a
   *  program was started in, which a terminal, an editor or a multiplexer started there inherits. Undefined while not
   *  read; null once read, when no host the dial types into made it. */
  ptyOwner?: string | null
}

/** What a page guard knows of the agent: whether it waits on the person, the folder its session started in (its
 *  project settings'), and its transcript path as its hook or the scan gave it (the user settings' home:
 *  claudeRenderer.ts). */
export interface PageAgent { asking: boolean; cwd?: string; transcriptPath?: string }

/** One adapter's own handle on one agent: an Orca terminal, a Claude app session, a tab's tty, a pane id. */
export interface Pane {
  adapter: string
  id: string
  /** The pane holds the agent's terminal but its host did not make it: a tap alone, after the agent's other panes. */
  held?: true
}

/** Callers a line is kept said for: more than the agents the observed source lists (MAX_SESSIONS, 50). */
const CALLERS_KEPT = 64

/** Says [line] once per caller process, at most CALLERS_KEPT (64) kept, the oldest going first: an adapter places an
 *  agent at every event, and its log would say the same of one caller at each. */
export function oncePerCaller(log: (line: string) => void, line: string): (pid: number | undefined) => void {
  // A Set keeps the order its callers came in.
  const said = new Set<number | undefined>()
  return (pid) => {
    if (said.has(pid)) return
    said.add(pid)
    if (said.size > CALLERS_KEPT) said.delete(said.values().next().value)
    log(line)
  }
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
  /** True once the pane is shown, false when it was not reached. One that brings its app forward itself when its pane
   *  failed (the Codex app's, appLink.ts `forward`) answers whether the app came, so the opener runs no `open -b` after
   *  it. Refused: the pane is not the agent's, and the adapter said so in a line of its own, so the opener brings the
   *  app forward with no fallback line. */
  focus(pane: Pane): Promise<boolean | 'refused'>
  /** The process whose window holds the pane, as its last `focus` found it; asked once after a `focus` that answered
   *  true, and forgotten then. Absent, or none: the agent's window as the observed source knows it (windowOf). */
  windowPid?(pane: Pane): number | undefined
  /** Whether a rest can show the pane inside its app now (the app in front, a watch open): asked at each look. */
  canShow?(pane: Pane): boolean
  show?(pane: Pane, agentId: string): Promise<PaneSwitch>
  /** Types a line at the agent's prompt and submits it; `engine` is the agent's, for an app that checks who holds the
   *  pane. The source decides that the prompt is free from the hooks; an app that knows better says `'busy'` or
   *  `'waiting'`, or refuses in a fixed sentence of its own, which the dial shows as it is. Only `true` was sent. */
  type?(pane: Pane, text: string, engine: string): Promise<TypeResult>
  /** Whether `type` can reach the pane now (its app's socket there): asked at each look. One that cannot leaves the words
   *  to the agent's next pane whose app types. */
  canType?(pane: Pane): boolean
  /** Whether a stroke on the dial may scroll that pane's view now, as far as the adapter knows without asking its app:
   *  its app in front and the pane in its window. */
  canScroll?(pane: Pane): boolean
  /** Whether the pane is the one its app shows on screen now, asked of the app once a stroke, after `canScroll`. False on
   *  any failure or past its deadline; never throws. An adapter that knows it from `canScroll` alone has none. */
  onScreen?(pane: Pane): Promise<boolean>
  /** Whether the program in the pane takes its own page keys now: Claude Code's fullscreen view keeps no history for its
   *  app to scroll. Asked at a stroke's down, after `canScroll`, only for an agent whose engine has such keys, with
   *  whether it waits on the person, the folder it started in and its transcript path. `false` at once when no key may
   *  go and nothing was read; else a promise, never rejected, settled within the adapter's own deadline. */
  pageKeys?(pane: Pane, agent: PageAgent): false | Promise<boolean>
  /** Scrolls the app's view of the pane's history by whole lines, n < 0 toward older lines. Fire and forget: a line it
   *  could not send is never retried into the program. `page`: this stroke's `pageKeys` said yes, and the lines may
   *  carry those keys too. */
  scroll?(pane: Pane, lines: number, page?: boolean): void
  /** The key a source that lists this app's agents knows the same pane by (registry.ts). Only an app with such a
   *  source has one. */
  paneKey?(pane: Pane): string
  /** A tap's order with the app's own `open -b`: the pane first (Orca, WezTerm, herdr), the pane alone (the Claude
   *  app's link brings the app itself, and Herdr's focus opens Herdr before it switches the window), or the app first
   *  (a tab is selected once its app is in front). A pane that comes after its app is raised by the source once the app
   *  came (observed.ts raiseAfter): the tab holding a nested agent's multiplexer client whenever `canFocus` says so,
   *  another only when it is the pane a rest would show. So for an agent not nested, an adapter with `tap: 'after'`
   *  needs `show`: without it, its `focus` never runs from a tap. */
  readonly tap: 'before' | 'instead' | 'after'
  /** Its app's macOS bundle id: a tap brings that app forward for an agent at one of its panes whose app no hook named,
   *  one its caller placed there or the scan found (observed.ts target()). */
  readonly bundle?: string
}
