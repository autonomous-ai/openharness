import type { EngineTranscript } from './facets/transcript.js'
import type { ProcessEngine } from './types.js'

/**
 * One engine: what Harness does differently for it, in one object, so shared code asks the engine instead
 * of branching on its name (docs/design/2026-10-05-engine-interface.md). Facets arrive one migration step
 * at a time. An engine leaves out a facet or a member it has nothing for, and shared code then does what
 * the design says it does for a missing member; it never falls back to another engine's behaviour.
 */
export interface Engine {
  readonly name: ProcessEngine
  /** Reading what the engine writes. */
  readonly transcript?: EngineTranscript
}
