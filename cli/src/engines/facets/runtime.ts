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
