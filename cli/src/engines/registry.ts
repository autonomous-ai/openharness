import type { Engine } from './engine.js'
import { engineLaunches } from './launches.js'
import { engineHooks } from './hooks.js'
import { transcript as claudeTranscript } from './claude/transcript.js'
import { transcript as codexTranscript } from './codex/transcript.js'

/** Only the migrated engines. Others keep their existing handlers until their own small batch. */
const engines = {
  claude: { name: 'claude', launch: engineLaunches.claude, transcript: claudeTranscript, hooks: engineHooks.claude },
  codex: { name: 'codex', launch: engineLaunches.codex, transcript: codexTranscript, hooks: engineHooks.codex },
} satisfies Record<string, Engine>
type MigratedEngine = keyof typeof engines
export function engineFor(name: string | null | undefined): Engine | undefined {
  return name && Object.hasOwn(engines, name) ? engines[name as MigratedEngine] : undefined
}
