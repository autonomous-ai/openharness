/** Some Codex goal interruptions never write task_complete/turn_aborted to the
 * rollout. An open transcript is then only historical evidence of work. The
 * live footer is one positive idle reading, never a synthetic turn end. */
import { stripVTControlCharacters } from 'node:util'
import type { PaneInspection } from '../facets/screen.js'

/** Read only the UI below the current empty composer, never output/history.
 * An empty composer alone says nothing: Codex accepts drafts while working. */
export function stoppedGoal(screen: string, pane: PaneInspection): boolean {
  if (!screen || !pane.idle) return false
  const lines = stripVTControlCharacters(screen).split(/\r?\n/)
  const prompt = lines.findLastIndex(line => /^\s*›(?:\s|$)/u.test(line))
  if (prompt < 0) return false
  // A live turn can still display the previous goal state during a redraw.
  if (lines.slice(-16).some(line => /\besc to interrupt\b/i.test(line))) return false
  const footer = lines.slice(prompt + 1).filter(line => line.trim())
  return footer.length <= 4
    && footer.some(line => /\bGoal (?:stalled|paused) \(\/goal resume\)\s*$/.test(line))
    && footer.some(line => /\? for shortcuts\b/.test(line))
}
