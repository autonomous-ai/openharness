import type { LiveEvent } from '../kit/events.js'
import type { LiveTurn } from './live.js'

/** Only the session facts a hook needs; transport authentication and process binding stay in core. */
export interface HookSession {
  sessionId?: string | null
  transcriptPath?: string | null
}

export interface HookStop { sessionId: string; status?: string; firedAt?: number }

/** Core supplies immutable observations and owns the event funnel. The engine decides what its Stop means. */
export interface HookTurnContext {
  turnState(sessionId: string): LiveTurn | undefined
  /** Atomically close only this observed turn; a rejected stale proposal emits nothing. */
  closeTurn(sessionId: string, identity: string): boolean
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
