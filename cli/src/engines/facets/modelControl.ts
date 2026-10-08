import type { RuntimeCatalogModel, RuntimeModelOption, RuntimeProfile, RuntimeSession, RuntimeState } from './runtime.js'
import type { PaneInspection } from './screen.js'

export type RuntimeProfileErrorCode =
  | 'AGENT_NOT_FOUND' | 'INVALID_RUNTIME_PROFILE' | 'BUSY' | 'UNSUPPORTED_CLI_VERSION'
  | 'MODEL_UNAVAILABLE' | 'EFFORT_UNSUPPORTED' | 'PLAN_SCOPE_AMBIGUOUS' | 'CONFIRM_TIMEOUT' | 'TMUX_FAILED'

export class RuntimeProfileControlError extends Error {
  constructor(readonly code: RuntimeProfileErrorCode) { super(code) }
}

/** Core validates the requested target and owns the profile transaction. */
export interface ModelControlInput {
  session: RuntimeSession
  target: RuntimeProfile
  current: RuntimeProfile | null
  options: RuntimeModelOption[]
  catalog: RuntimeCatalogModel[]
}

/** Before taking the pane, then again with the captured pane under its input lease. */
export interface ModelControlCheck {
  stage: 'target' | 'scope'
  session: RuntimeSession
  target: RuntimeProfile
  state: RuntimeState
  catalog: RuntimeCatalogModel[]
  pane?: PaneInspection
}

/** A single operation's revocable authority, never a terminal locator or arbitrary core API. */
export interface ModelControlHost {
  catalog(): Promise<RuntimeCatalogModel[]>
  capture(historyLines: number): Promise<string | null>
  text(text: string): Promise<boolean>
  key(key: string): Promise<boolean>
  waitForModel(timeoutMs: number): Promise<boolean>
  waitForProfile(timeoutMs: number): Promise<boolean>
  confirmEffort(effort: string): Promise<void>
}

export interface EngineModelControl {
  validate(check: ModelControlCheck): Promise<void>
  apply(input: ModelControlInput, host: ModelControlHost): Promise<void>
}
