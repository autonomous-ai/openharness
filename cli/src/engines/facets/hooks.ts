import type { NativeHookOptions } from '../kit/nativeLocations.js'
import type { Env } from '../../config/env.js'
import type { LiveEvent } from '../kit/events.js'
import type { LiveTurn } from './live.js'

/** Only the session facts a hook needs; transport authentication and process binding stay in core. */
export interface HookSession {
  sessionId?: string | null
  transcriptPath?: string | null
}

export interface HookStop { sessionId: string; status?: string; firedAt?: number }

/** Core supplies immutable observations and owns the event funnel. The kit's Stop rule decides what a Stop means. */
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

/** A daemon setting that names a folder, such as `CODEX_HOME`. */
export type FolderSetting = { [K in keyof Env]: Env[K] extends string ? K : never }[keyof Env]

/**
 * Where an engine reads its hooks, and how Harness keeps its own block there. Declared data, applied by the
 * one kit installer (kit/hookSettings.ts) before spawn. Core authors the command
 * every block runs; unavailable configuration remains unchanged and holds launch.
 */
export interface HookSettings {
  /** The engine's home when core names none: a folder in the person's home, or a daemon setting. */
  home: { inHome: string } | { setting: FolderSetting }
  /** The settings file, in that home. */
  file: string
  /** One block of ours per event, in this order, with a matcher only where the engine honours one. */
  events: ReadonlyArray<{ event: string; matcher?: string }>
  /** Seconds the engine gives the hook. */
  timeout: number
  /**
   * Agent Messages' own block (kit/messagesHook.ts), apart from notify.mjs's: at this event the waiting messages
   * of the agent's pane become the model's context. One block, for every tool, in the person's settings beside
   * the others; absent for an engine with no such event.
   */
  inbox?: { event: string }
  /** The command names this home as the engine's (`--codex-home`): a profile's sessions are in its own store. */
  commandNamesHome: boolean
  /**
   * When the block of ours already there needs no write. It is the only block of ours, and its command is
   * the current one: the command of its first notify.mjs hook (`first-ours`) or of its first hook (`first`).
   * Where `matcher` is set, its matcher is the declared one too.
   */
  upToDate: { command: 'first-ours' | 'first'; matcher: boolean }
  /**
   * The daemon's log lines, with {file}, {script} and {port} filled in. The end-to-end harness checks that
   * every file a line names is inside its throwaway root (e2e/harness/daemon.ts `hookFilesNamed`).
   */
  messages: {
    /** Nothing to write. */
    current: string
    /** After a write; `updated` instead when a block of ours ran another command. */
    installed: string
    updated?: string
    /** After either. */
    after: string
    /** Logged with the error when the write fails. */
    failed: string
    /** The lines for an unreadable file that is kept. */
    malformed?: readonly string[]
  }
  /**
   * Where the engine asks a person to review a hook before it first runs, Harness's own blocks recorded as
   * reviewed, the way the engine records the answer itself (kit/hookReview.ts).
   */
  reviewed?: HookReviewRecord
}

/**
 * An engine's record of hooks a person reviewed: in its config file in the same home, a table per hook keyed
 * `<real path of the settings file>:<event>:<block>:<hook>`, holding the hash the engine computes of that hook
 * (Codex 0.162 `hooks.state`, `trusted_hash`). A hook whose hash differs from the recorded one is asked about again.
 */
export interface HookReviewRecord {
  /** The engine's config file, in the settings' home. */
  file: string
  /** The TOML table the records are sub-tables of. */
  table: string
  /** The field of a record that holds the hash. */
  key: string
  /** The engine's name for each declared event, in keys and in the hash. */
  events: Readonly<Record<string, string>>
  /** The events whose matcher is part of the hash; the engine ignores the others'. */
  matcherEvents: readonly string[]
  /** The timeout, in seconds, the engine assumes for a hook that names none. */
  defaultTimeout: number
  /** The daemon's log lines, with {config} filled in. */
  messages: { recorded: string; skipped: string }
}

/** A session another session delegated to, told apart by its transcript's first record. */
export interface HookChildRule {
  /** The first record's `type`. */
  type: string
  /** The field, from that record, whose presence (anything but null) marks a child. Every step before it is an object. */
  child: readonly string[]
  /** Why its hooks are refused, in the hook server's answer and log. */
  reason: string
}

/** An engine's hooks, declared. Core evaluates every part of it in line: hooks bind sessions and close turns. */
export interface HookContract {
  settings: HookSettings
  /** Refuse a delegated session's hooks before any of them is credited to the pane it runs in. */
  children?: HookChildRule
  /** A session's transcript is named `<sessionId><suffix>` (kit/hookRules.ts `knownTranscript`). */
  sessionFile?: { suffix: string }
  /** The engine's Stop and StopFailure hooks close its turns (kit/stopHook.ts). */
  stopClosesTurns?: boolean
}

/** What core calls, composed from an engine's contract and the kit's mechanics (engines/hooks.ts). */
export interface EngineHooks {
  install(port: number, options?: NativeHookOptions): Promise<boolean>
  installIn(port: number, home: string, options?: NativeHookOptions): Promise<boolean>
  transcriptFor?(body: HookSession, agent: HookSession | undefined): string | undefined
  admit?(body: HookSession): HookAdmission
  onStop?(context: HookTurnContext, body: HookStop): void | Promise<void>
}
