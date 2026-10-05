import type { Engine } from './engine.js'
import { TRANSCRIPTS } from './transcripts.js'
import { PROCESS_ENGINES } from './types.js'

/**
 * The engines, by name: the one place shared code learns what an engine does
 * (docs/design/2026-10-05-engine-interface.md). Each engine is assembled from the facet tables while the
 * migration runs (section 8.1, rule 5); every engine is loaded with the daemon until lazy loading lands
 * (step 26).
 */
const ENGINES_BY_NAME: ReadonlyMap<string, Engine> = new Map(PROCESS_ENGINES.map((name) => [
  name,
  Object.freeze({ name, transcript: TRANSCRIPTS[name] }),
]))

/** The engine of this name; undefined for a name Harness does not know, and for `terminal`, a plain shell
 *  with no engine behind it. */
export function engineFor(name: string | null | undefined): Engine | undefined {
  return name ? ENGINES_BY_NAME.get(name) : undefined
}
