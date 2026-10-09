import type { EngineQuestionControl } from './facets/questionControl.js'
import type { EngineSubmission } from './facets/submission.js'
import type { EngineNativeControl } from './facets/nativeControl.js'
import type { EngineScreen } from './facets/screen.js'
import type { EngineModelControl } from './facets/modelControl.js'
import type { ProcessEngine } from './types.js'
import type { EngineTranscript } from './facets/transcript.js'
import type { EngineLaunch } from './facets/launch.js'
import type { HookContract } from './facets/hooks.js'
import type { EngineLive } from './facets/live.js'
import type { EngineRuntime } from './facets/runtime.js'

/** The engine's own contracts. Claude Code and Codex migrate one small batch at a time. */
export interface Engine {
  readonly name: ProcessEngine
  readonly transcript: EngineTranscript
  readonly launch: EngineLaunch
  /** Declared data that core applies in line (engines/hooks.ts): never run in the engine's worker. */
  readonly hooks: HookContract
  readonly live: EngineLive
  readonly runtime: EngineRuntime
  readonly screen: EngineScreen
  readonly modelControl: EngineModelControl
  readonly questionControl: EngineQuestionControl
  readonly submission: EngineSubmission
  /** Only an engine whose CLI leaves work on a server of its own (Codex). */
  readonly nativeControl?: EngineNativeControl
}
