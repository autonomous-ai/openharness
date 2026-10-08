import { stripVTControlCharacters } from 'node:util'
import type { AgentEngine } from '../types.js'
import type { ComposerState, MessageHold, PaneInspection, PaneModal, PaneView, ScreenReading } from '../facets/screen.js'
import { isApprovalDialog } from './questionPane.js'
const HOLDS: Record<NonNullable<PaneModal>, MessageHold> = {
  rewind: 'rewind_picker_open', transcript: 'transcript_open', search: 'search_open', trust: 'trust_open',
  update: 'update_prompt_open', model: 'model_prompt_open', sign_in: 'sign_in_open', permission: 'permission_open', menu: 'menu_open',
}
export function assembleScreen(engine: AgentEngine, capture: string, pane: PaneInspection, question: PaneView,
  modal: PaneModal = null, composer?: ComposerState, activity: ScreenReading['activity'] = null, stoppedGoal = false): ScreenReading {
  const messageHold = question ? question.kind === 'question' && isApprovalDialog(question) ? 'permission_open' : 'question_open'
    : modal ? HOLDS[modal] : composer === undefined || composer === 'ready' ? null : composer === 'popup' ? 'popup_open' : 'prompt_hidden'
  const footer = stripVTControlCharacters(capture).split('\n').slice(-16).join('\n')
  const busy = !!activity || /\bgoal\s+active\b|\bpursuing goal\b|\b[1-9]\d*\s+background\s+(?:tasks?|agents?)\b/i.test(footer)
  return { pane, question, messageHold, teamHold: teamHold(engine, capture, pane, question), activity, busy, stoppedGoal }
}
function teamHold(engine: AgentEngine, capture: string, pane: PaneInspection, question: PaneView): string | null {
  if (!capture) return 'team_waiting_unavailable'
  if (pane.dialog || question) return 'team_waiting_user'
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
