export type HostAgentState = 'idle' | 'working' | 'needs-you' | 'done' | 'error'

/** A multiplexer whose pane can be an agent's own terminal and that has its own page on the dial: tmux and herdr only
 *  (Diego, 2026-11-23); Zellij and Rex stay on their app's. */
export type Nest = 'tmux' | 'herdr'

export interface HostAgent {
  /** What the dial sends back; a UUID. */
  id: string
  engine: string
  sessionId?: string
  /** The keys another source may know the same agent by, beside its session: herdr's pane, `herdr:<pane id>`,
   *  Herdr's terminal, `herdr-app:<address>`, and the Claude app's session, `claude-app:<local id>`. */
  paneKeys?: readonly string[]
  callerPid?: number
  cwd?: string
  name: string
  /** 'harness' | 'orca' | 'herdr' | 'ghostty' | 'iterm' | 'vscode' | 'terminal' | ... */
  host: string
  /** The outermost app the person sees, one of `APP_IDS`: what a tap brings and the tab it raises, and the app a
   *  prompt's follow compares with the front. Its pages are `pagesOf`'s (`select.ts`). The unknown app's while
   *  `appPending` for the scan. */
  app: string
  /** The nearest multiplexer whose pane is the agent's own terminal, as its lookup or the scan's maker read confirmed
   *  (`observed.ts`); tmux and herdr only (Diego, 2026-11-23). It is on that multiplexer's page as well as its app's
   *  (`select.ts` `pagesOf`, Diego 2026-11-26). */
  nest?: Nest
  /**
   * Nothing has said where it runs yet: the open scan found it and no hook has told of it, or its hook came from a
   * multiplexer's pane whose lookup has not answered, with no multiplexer known (`observed.ts` ingest). It sits on the
   * unknown app's page, or its multiplexer's when `nest` is set, or meanwhile the page of the app its hints name, so it
   * can be reached, but is not known to be in that app, so it counts for nothing in the dial's default nor for the app
   * in front (`select.ts` counts).
   */
  appPending?: true
  /** Its session ended and its source still lists it (the observed source's, until its tick drops it): no tap, rest or
   *  voice. The registry gives its row to another source's live copy (`registry.ts`). */
  ended?: true
  /**
   * No process runs it: a row of the Claude app's store (`claudeAppSource.ts`) or of the ChatGPT app's threads
   * (`codexAppSource.ts`). It is on its app's page and counts for nothing in the dial's default app (`select.ts`'s
   * `known`), as `appPending`; it still counts for the app in front (`AppCounts.inFront`). It is left out of the single
   * machine ring of a dial that does not say `appFilter` (`cableHost.ts` `machineSnapshot`), where it would push live
   * agents out.
   */
  resting?: true
  state: HostAgentState
  lastActivityAt: number
  /** The end of the last turn, cut to the card's length. */
  lastAnswer?: string
  unseenDone: boolean
}

/** One app in the dial's list: its agents, how many of them wait on the person, and how many are mid-turn. */
export interface AppEntry {
  id: string
  name: string
  count: number
  waiting: number
  working: number
}

/** The apps the dial can show; `shown` is '' with no agents. */
export interface AppList {
  shown: string
  apps: AppEntry[]
}

/** What a pick on the dial did. `tabs`: with a window open, Harness was picked on an app's ring, and the dials hold the
 *  window's tab again. */
export type AppPick = 'switched' | 'same' | 'ignored' | 'tabs'

/** What the dials that say `appFilter` hold while a window is open: its active tab, or the shown app's ring. */
export type DialView = 'tabs' | 'apps'

/** Why the view was set: an app settled in front or the app in front got known agents, a pick on the dial, the window
 *  opening, the shown app left as Harness or no app. */
export type ViewCause = 'front' | 'pick' | 'window' | 'empty'

/** Why the shown app changed. A follow is never why: it moves the dial on the page shown
 *  (docs/plans/2026-11-26-dial-mux-host-pages-design.md §3). */
export type SwitchCause = 'front' | 'pick' | 'empty' | 'notice'

export interface Caps {
  status: boolean
  voice: boolean
  focus: boolean
  answer: boolean
}

/** What a source's send answers: `reason` is the sentence the dial shows when it refused. */
export type SendResult = { ok: true } | { ok: false; reason: string }

/** Why a terminal tab's words were not sent (docs/plans/2026-11-25-dial-voice-codex-terminals-design.md): the log's
 *  word for each, while the dial says only "did not answer". `busy`: the agent left its prompt during the checks. */
export const TABS_REASONS = ['no-stream', 'nested', 'terminal-app', 'shared', 'process', 'background', 'foreground-child',
  'busy', 'no-session', 'no-answer'] as const
export type TabsReason = typeof TABS_REASONS[number]

export function isTabsReason(word: unknown): word is TabsReason {
  return (TABS_REASONS as readonly unknown[]).includes(word)
}

/** What an adapter's `type` answers: sent (`true`), not sent (`false`), the agent is in a turn (`'busy'`) or waits on
 *  the person (`'waiting'`) as its app says now, a fixed sentence of the adapter's own for the dial (`refused`), or
 *  not sent for a reason of the list (`notSent`): never a value from a hook or an app. */
export type TypeResult = boolean | 'busy' | 'waiting' | { refused: string } | { notSent: TabsReason }

/** What showing an agent's pane did: `busy` when words are still being typed into its terminal, or a Claude app link is
 *  still running for that agent, and then nothing ran. */
export type PaneSwitch = 'ok' | 'failed' | 'busy'

export interface HostSource {
  /** 'harness' | 'observed' | a listing source's name (`herdr`, `herdr-app`, `opencode`, `cmux`,
   *  `claude-app`, `codex-app`). */
  readonly id: string
  list(): HostAgent[]
  capabilities(agent: HostAgent): Caps
  /** The dial turned to the agent: its finished answer has been seen. A source that keeps no unseen answers has none. */
  markSeen?(agentId: string): void
  /** The dial's words for one of its agents, answered once they are delivered or refused. A source without it takes none. */
  send?(agent: HostAgent, text: string): Promise<SendResult>
  /** A sentence that refuses the dial's words at every dictation's start, for an agent with `v` too (cableSession.ts),
   *  said in place of the generic one: so a source gives one only for an agent no route reaches; none lets them go. */
  voiceRefusal?(agent: HostAgent): string | undefined
  /** A tap: bring the agent's terminal forward; false when it did not come, `superseded` when a later tap replaced it
   *  before it acted (eval I13, PM 2026-11-24). [latest] says whether it is still the dial's latest tap, on any agent of
   *  any source: one that waits before it acts asks it then. A source without it opens nothing. */
  focus?(agent: HostAgent, latest: () => boolean): Promise<boolean | 'superseded'>
  /** Whether the agent has a pane its app can show without coming forward. A source without it has none. */
  hasPane?(agent: HostAgent): boolean
  /** Shows the agent's pane inside its app, which stays where it is; `superseded` when a later tap or rest replaced it
   *  before it acted. */
  showPane?(agent: HostAgent): Promise<PaneSwitch | 'superseded'>
}

/** The capabilities as letters, always in the order s v f a. */
export function capsLetters(c: Caps): string {
  return (c.status ? 's' : '') + (c.voice ? 'v' : '') + (c.focus ? 'f' : '') + (c.answer ? 'a' : '')
}
