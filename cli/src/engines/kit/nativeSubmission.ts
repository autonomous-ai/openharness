/**
 * Claude Code's and Codex's reading of a prompt typed into their composer, in their engine worker. The core's
 * session input judged the composer from its last prompt marker down and the Device's route from Claude Code's
 * `❯` or Codex's `›` alone; both readings moved here verbatim (sessionInput.ts, deviceInput.ts), so each route
 * decides as it did before the move.
 */
import type { SubmissionReading } from '../facets/submission.js'
import { composerHolds, composerShown, visibleTerminal } from './submission.js'

/** The Device's reading: only `❯` and `›` start a composer, a pane with neither is unreadable rather than read
 *  whole, and the prompt is compared as typed. */
function nativeDraft(capture: string, content: string): SubmissionReading['nativeDraft'] {
  const lines = visibleTerminal(capture).split('\n')
  const index = lines.findLastIndex(line => /[›❯]/u.test(line) && !/[›❯]\s*\d+\.\s/u.test(line))
  if (index < 0) return 'unreadable'
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
  return normalize(lines.slice(index).join('\n')).includes(normalize(content)) ? 'pending' : 'clear'
}

export function readNativeSubmission(capture: string, prompt: string): SubmissionReading {
  return { draft: composerHolds(capture, prompt), composer: composerShown(capture), nativeDraft: nativeDraft(capture, prompt) }
}
