/** Inline compatibility facade. Supervised core reads the engine screen worker. */
import type { AgentEngine } from '../engines/types.js'
import { composerState as claude } from '../engines/claude/composer.js'
import { composerState as codex } from '../engines/codex/composer.js'
export type { ComposerState } from '../engines/facets/screen.js'
export const COMPOSER_ENGINES: ReadonlySet<string> = new Set(['claude', 'codex'])
export function composerState(engine: AgentEngine, capture: string) { return engine === 'codex' ? codex(capture) : claude(capture) }
