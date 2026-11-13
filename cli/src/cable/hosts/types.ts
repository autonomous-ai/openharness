// The seam between the dial and wherever an agent runs: Harness's own panes, or an engine seen only through its hooks.
// A later service can lift these out whole if the app or the phone should see the same agents
// (docs/specs/2026-11-13-device-without-the-app.md, "HostSource").
import type { SendResult } from '../../core/api.js'

/** What the dial may do with an agent: show its status, talk to it, open it, answer its question. */
export interface Caps {
  status: boolean
  voice: boolean
  focus: boolean
  answer: boolean
}

export interface HostAgent {
  /** What the dial sends back; a UUID, so it fits the firmware's `ID_MAX`. */
  id: string
  engine: string
  sessionId?: string
  callerPid?: number
  cwd?: string
  name: string
  /** Where the agent runs: 'harness' | 'orca' | 'herdr' | 'ghostty' | 'iterm' | 'vscode' | 'terminal' | … */
  host: string
  state: 'idle' | 'working' | 'needs-you' | 'done' | 'error'
  /** When the state began. */
  since: number
  lastActivityAt: number
  /** The end of the last turn, cut to the card's length. */
  lastAnswer?: string
  unseenDone: boolean
}

export interface HostSource {
  readonly id: 'harness' | 'observed'
  list(): HostAgent[]
  onChange(listener: () => void): () => void
  /** Wave 0: Harness only, the existing path. */
  send?(agent: HostAgent, text: string): Promise<SendResult>
  /** Wave 0: none. */
  focus?(agent: HostAgent): Promise<boolean>
  capabilities(agent: HostAgent): Caps
}

/** The wire's `caps`: one letter per allowed action, always in the order `svfa`. */
export function capsLetters(c: Caps): string {
  return `${c.status ? 's' : ''}${c.voice ? 'v' : ''}${c.focus ? 'f' : ''}${c.answer ? 'a' : ''}`
}
