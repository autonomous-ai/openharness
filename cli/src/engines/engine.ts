import type { ProcessEngine } from './types.js'
import type { EngineTranscript } from './facets/transcript.js'
import type { EngineLaunch } from './facets/launch.js'

/** The engine's own contracts. Migration begins with Claude Code and Codex, two facets at a time. */
export interface Engine {
  readonly name: ProcessEngine
  readonly transcript: EngineTranscript
  readonly launch: EngineLaunch
}
