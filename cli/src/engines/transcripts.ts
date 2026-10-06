import { transcript as agy } from './agy/transcript.js'
import { transcript as amp } from './amp/transcript.js'
import { transcript as claude } from './claude/transcript.js'
import { transcript as codex } from './codex/transcript.js'
import { transcript as commandcode } from './commandcode/transcript.js'
import { transcript as copilot } from './copilot/transcript.js'
import { transcript as cursor } from './cursor/transcript.js'
import { transcript as devin } from './devin/transcript.js'
import type { EngineTranscript } from './facets/transcript.js'
import { transcript as grok } from './grok/transcript.js'
import { transcript as hermes } from './hermes/transcript.js'
import { transcript as kilo } from './kilo/transcript.js'
import { transcript as muse } from './muse/transcript.js'
import { transcript as opencode } from './opencode/transcript.js'
import { transcript as pi } from './pi/transcript.js'
import type { ProcessEngine } from './types.js'

/**
 * Every engine's transcript facet. While the migration runs each facet has a table of its own
 * (docs/design/2026-10-05-engine-interface.md, section 8.1, rule 5), so steps that add different facets
 * on parallel branches never edit the same file; each engine's own index.ts replaces the tables when
 * engines load lazily (step 26).
 */
export const TRANSCRIPTS: Readonly<Record<ProcessEngine, EngineTranscript>> = {
  claude, codex, cursor, opencode, pi, hermes, commandcode, devin, muse, amp, kilo, grok, agy, copilot,
}
