import { stripVTControlCharacters } from 'node:util'
import type { RegisteredSession } from './registry.js'
import { inspectRuntimePane } from './runtimeProfileController.js'
import { parseEngineQuestionPane } from './askQuestion.js'

/**
 * Conservative, read-only inspection at the serialized input write boundary. The core's: it writes a team's
 * turn only into a ready composer (core/input.ts), and closes an agent only from one (lib/closeAgentService.ts).
 * Here rather than in teams/ since Tab collaboration left the core's process (step 8); teams/preflight.ts says
 * it as it always did.
 */
export function teamWriteHold(engine: RegisteredSession['engine'], capture: string | null): string | null {
  if (!capture) return 'team_waiting_unavailable'
  const pane = inspectRuntimePane(engine, capture)
  if (pane.dialog || parseEngineQuestionPane(engine, capture)) return 'team_waiting_user'
  if (pane.draft) return 'team_waiting_draft'
  if (!pane.idle) return 'team_waiting_idle'
  const lines = capture.split('\n').map(stripVTControlCharacters)
  if (/esc(?:ape)? to (?:interrupt|cancel|stop)/i.test(lines.slice(-15).join('\n'))) return 'team_waiting_idle'
  // These composers permit an empty first line followed by a multiline human draft.
  // The general profile inspector only needs the first line; team delivery needs every line.
  if (['claude', 'codex', 'cursor', 'hermes'].includes(engine)) {
    const index = lines.findLastIndex(line => /^\s*[›❯→]/u.test(line))
    if (index < 0) return 'team_waiting_idle'
    // Codex shows its styled placeholder only when the whole composer is empty.
    // Its configurable model/cwd/task footer below that placeholder is not draft
    // text. The profile inspector has already proved this visible prompt text is
    // a placeholder; a bare first line still needs the multiline-draft check.
    if (engine === 'codex' && lines[index].replace(/^\s*[›❯→]\s*/u, '').trim()) return null
    for (const line of lines.slice(index + 1)) {
      if (/[─━―]{8,}/u.test(line)) break
      const text = line.trim()
      if (!text || /^(?:\? for shortcuts|\d+% context|context:|ctrl\+|shift\+|tab to|plan mode|accept edits|bypass permissions)/i.test(text)) continue
      return 'team_waiting_draft'
    }
  }
  return null
}
