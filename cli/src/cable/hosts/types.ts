export type HostAgentState = 'idle' | 'working' | 'needs-you' | 'done' | 'error'

export interface HostAgent {
  /** What the dial sends back; a UUID. */
  id: string
  engine: string
  sessionId?: string
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

/** What a pick on the dial did. */
export type AppPick = 'switched' | 'same' | 'ignored'

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

/** What showing an agent's pane did: `busy` when words are still being typed into its terminal, and then nothing ran. */
export type PaneSwitch = 'ok' | 'failed' | 'busy'

export interface HostSource {
  /** 'harness' | 'observed' | a host adapter's name (wave 1). */
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
