/** In-process composition for the live-facet migration. The worker port will replace this in core. */
import { live as claude } from './claude/live.js'
import { live as codex } from './codex/live.js'
import type { EngineLive, LiveFor } from './facets/live.js'

// Preserve the old terminal fallback while moving parser ownership. A plain terminal does not
// normally have a transcript; it must not acquire Claude's read-from-end attach behavior.
const terminal: EngineLive = { create: claude.create }
const adapters: Readonly<Record<string, EngineLive>> = { claude, codex, terminal }
export const liveFor: LiveFor = (engine) => Object.hasOwn(adapters, engine) ? adapters[engine] : undefined
