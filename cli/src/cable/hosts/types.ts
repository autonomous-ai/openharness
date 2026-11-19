export type HostAgentState = 'idle' | 'working' | 'needs-you' | 'done' | 'error'

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
  /** The outermost app, one of `APP_IDS`: the dial's page the agent is on. The unknown app's while `appPending`. */
  app: string
  /**
   * Nothing has said where it runs yet: the open scan found it and no hook has told of it. It sits on the unknown app's
   * page, so it can be reached, but is not known to be in that app, so it counts for nothing in the dial's default.
   */
  appPending?: true
  /** Its session ended and its source still lists it (the observed source's, until its tick drops it): no tap, rest or
   *  voice. The registry gives its row to another source's live copy (`registry.ts`). */
  ended?: true
  /**
   * No process runs it: a row of the Claude app's store (`claudeAppSource.ts`). It is on its app's page and counts for
   * nothing in the dial's default app (`select.ts`'s `known`), as `appPending`; it still counts for the app in front
   * (`AppCounts.inFront`).
   */
  resting?: true
  state: HostAgentState
  lastActivityAt: number
  /** The end of the last turn, cut to the card's length. */
  lastAnswer?: string
  unseenDone: boolean
}

/** One app in the dial's list: its agents, and how many of them wait on the person. */
export interface AppEntry {
  id: string
  name: string
  count: number
  waiting: number
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

/** Why the shown app changed. */
export type SwitchCause = 'front' | 'pick' | 'empty' | 'notice'

export interface Caps {
  status: boolean
  voice: boolean
  focus: boolean
  answer: boolean
}

/** What a source's send answers: `reason` is the sentence the dial shows when it refused. */
export type SendResult = { ok: true } | { ok: false; reason: string }

/** What an adapter's `type` answers: sent (`true`), not sent (`false`), the agent is in a turn (`'busy'`) or waits on
 *  the person (`'waiting'`) as its app says now, or a fixed sentence of the adapter's own for the dial (`refused`):
 *  never a value from a hook or an app. */
export type TypeResult = boolean | 'busy' | 'waiting' | { refused: string }

/** What showing an agent's pane did: `busy` when words are still being typed into its terminal, or a Claude app link is
 *  still running for that agent, and then nothing ran. */
export type PaneSwitch = 'ok' | 'failed' | 'busy'

export interface HostSource {
  /** 'harness' | 'observed' | a listing source's name (`herdr`, `herdr-app`, `opencode`, `cmux`,
   *  `claude-app`). */
  readonly id: string
  list(): HostAgent[]
  capabilities(agent: HostAgent): Caps
  /** The dial turned to the agent: its finished answer has been seen. A source that keeps no unseen answers has none. */
  markSeen?(agentId: string): void
  /** The dial's words for one of its agents, answered once they are delivered or refused. A source without it takes none. */
  send?(agent: HostAgent, text: string): Promise<SendResult>
  /** A tap: bring the agent's terminal forward; false when it did not come. A source without it opens nothing. */
  focus?(agent: HostAgent): Promise<boolean>
  /** Whether the agent has a pane its app can show without coming forward. A source without it has none. */
  hasPane?(agent: HostAgent): boolean
  /** Shows the agent's pane inside its app, which stays where it is. */
  showPane?(agent: HostAgent): Promise<PaneSwitch>
}

/** The capabilities as letters, always in the order s v f a. */
export function capsLetters(c: Caps): string {
  return (c.status ? 's' : '') + (c.voice ? 'v' : '') + (c.focus ? 'f' : '') + (c.answer ? 'a' : '')
}
