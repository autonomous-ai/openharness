/** Inline compatibility; supervised core reads engine screen evidence. */
import { activity as claude } from '../engines/claude/activity.js'
import { activity as codex } from '../engines/codex/activity.js'
export function terminalActivityReading(engine: string, screen: string | null) {
  return !screen ? null : engine === 'claude' ? claude(screen) : engine === 'codex' ? codex(screen) : null
}
export function terminalActivity(engine: string, screen: string | null): string | null { return terminalActivityReading(engine, screen)?.label ?? null }
