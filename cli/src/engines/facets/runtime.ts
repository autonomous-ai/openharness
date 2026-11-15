import type { AgentEngine } from '../types.js'
import type { RegisteredSession } from '../../lib/registry.js'

export interface RuntimeProfile {
  id: string
  sessionId: string
  engine: AgentEngine
  model: string
  effort: string
}

export interface RuntimeModelOption { id: string; displayName: string }

export interface RuntimeState {
  model: string | null
  effort: string | null
  mode: 'default' | 'plan' | 'unknown'
  cliVersion: string | null
  observedAt: number | null
  /** The effort a configuration read last filled in, the launch flag's or the settings'. While [effort] is still that one,
   * the session has shown none of its own, and a later read may change it; an effort the session showed is never replaced. */
  settingsEffort?: string
}

export type RuntimeField = 'model' | 'effort' | 'mode'
export type RuntimeSession = Pick<RegisteredSession, 'agentId' | 'sessionId' | 'engine' | 'model'
  | 'cliVersion' | 'cwd' | 'transcriptPath' | 'codexHome' | 'launchModel'>

/** The transaction belongs to core. An engine interprets evidence against a supplied snapshot. */
export interface RuntimeControl {
  target: RuntimeProfile
  before: string | null
  modelConfirmed: boolean
  effortConfirmed: boolean
}

/** Plain values only: a worker can reduce a copy, and core can fence the result before committing. */
export interface RuntimeContext {
  session: RuntimeSession
  state: RuntimeState
  control?: RuntimeControl
}

/** Engine-private evidence. Core transports it but never interprets its keys. */
export type RuntimeRecord = Record<string, string | boolean | null>

/**
 * What one transcript record of another engine says of its session's profile, as that engine's reader reads it in their
 * worker (engines/others/streams.ts): plain values the core applies to the state it keeps (kit/runtime.ts
 * `applyProfileEvidence`), so no record of theirs is parsed in the core.
 */
export interface ProfileEvidence {
  cliVersion?: string
  model?: string
  effort?: string
  /** An effort to show while the session has shown none: Cursor names its effort only in its pane. */
  effortUnset?: string
  /** What this names confirms a switch in flight to it: Pi's and omp's records name what they switched to. */
  confirms?: true
  /** A model that changed reads the configuration again: Command Code keeps an effort per model. */
  refresh?: true
  /** The folder the engine's own tools run in (OpenClaw's session header), null when its header names none. */
  workspace?: string | null
}

export interface RuntimeCatalogModel {
  slug: string
  displayName: string
  listed: boolean
  defaultEffort: string
  efforts: string[]
}

export interface EngineRuntime {
  decode(record: Record<string, unknown>): RuntimeRecord | null
  reduce(context: RuntimeContext, record: RuntimeRecord): void
  transcript(context: RuntimeContext, record: Record<string, unknown>): void
  pane(context: RuntimeContext, text: string): void
  /** The effort a session starts with: its launch flag's, else its engine's settings'. A default, which fills an effort the
   * session has not shown and never replaces one it has (a reply's, a pane's), as `fillConfiguredEffort` applies it. */
  configuredEffort?(session: RuntimeSession): Promise<string>
  selectedModel(session: RuntimeSession, state: RuntimeState): string | null
  models(session: RuntimeSession, state: RuntimeState | undefined): Promise<RuntimeModelOption[]>
  supportsControl(session: RuntimeSession): boolean
  catalog?(session: RuntimeSession): Promise<RuntimeCatalogModel[]>
  effortAllowed?(model: string, effort: string, listed: readonly string[] | null): boolean
}

export type RuntimeFor = (engine: string) => EngineRuntime | undefined
