import type { LiveEvent, TurnState } from '../../lib/normalize.js'

/** Only the session facts a hook needs; transport authentication and process binding stay in core. */
export interface HookSession {
  sessionId?: string | null
  transcriptPath?: string | null
}

export interface HookStop { sessionId: string; status?: string; firedAt?: number }

/** Core owns the state and event funnel. The engine decides what its Stop means. */
export interface HookTurnContext {
  turnState(sessionId: string): TurnState | undefined
  latestPromptAt(sessionId: string): number | undefined
  drain(sessionId: string): Promise<void>
  noteEngineStopped(sessionId: string): void
  emit(sessionId: string, events: LiveEvent[]): void
  graceMs: number
}

export type HookAdmission = { accepted: true } | { accepted: false; reason: string }

export interface EngineHooks {
  install(port: number): void
  installIn(port: number, home: string): void
  transcriptFor?(body: HookSession, agent: HookSession | undefined): string | undefined
  admit?(body: HookSession): HookAdmission
  onStop?(context: HookTurnContext, body: HookStop): void | Promise<void>
}
