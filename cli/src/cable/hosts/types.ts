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
  state: HostAgentState
  lastActivityAt: number
  /** The end of the last turn, cut to the card's length. */
  lastAnswer?: string
  unseenDone: boolean
}

export interface Caps {
  status: boolean
  voice: boolean
  focus: boolean
  answer: boolean
}

/** What a source's send answers: `reason` is the sentence the dial shows when it refused. */
export type SendResult = { ok: true } | { ok: false; reason: string }

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
}

/** The capabilities as letters, always in the order s v f a. */
export function capsLetters(c: Caps): string {
  return (c.status ? 's' : '') + (c.voice ? 'v' : '') + (c.focus ? 'f' : '') + (c.answer ? 'a' : '')
}
