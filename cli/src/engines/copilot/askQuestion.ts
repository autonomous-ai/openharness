/**
 * Copilot's permission prompts name their SUBJECT above the question, not inside it.
 *
 * Measured on 1.0.80, unframed:
 *
 *     Fetch web content
 *     ─────────────────
 *     Copilot is attempting to access the following URL:
 *     ╭─────────────────────╮
 *     │ https://example.com │
 *     ╰─────────────────────╯
 *     Do you want to allow this access?
 *     ❯ 1. Yes
 *       2. Yes, and approve all URLs from "https://example.com" for the rest of the running session
 *       …
 *
 * The shared parser reads that correctly and returns "Do you want to allow this access?" — which is
 * the question, exactly as it should. But on a device that is the whole prompt: four options, and no
 * way to see WHAT is being allowed. Row 1 is a bare "Yes". Approving network access without seeing
 * the domain is not a choice anyone can make well.
 *
 * So the subject is folded into the question. Nothing else is touched: the rows, the decline row and
 * the row numbering all stay as the shared parser produced them.
 */

import type { PaneView } from '../../lib/askQuestion.js'
import { earlierDialogEnd } from '../../lib/dialogEnd.js'

const ESCAPES = /\u001b\[[0-9;:]*[A-Za-z]/g
/** `Copilot is attempting to access the following URL:` / `… to run the following command:` etc. */
const ATTEMPT = /Copilot is attempting to [^:]{0,60}:/i
const MAX_SUBJECT = 120

/**
 * The boxed value Copilot puts between "attempting to …:" and the question.
 *
 * Read from the RAW capture rather than the unframed text: unframing flattens the outer dialog border,
 * and the subject's own inner box is what makes it findable.
 *
 * Only the LIVE dialog's: the nearest "attempting to" above `below` (the line its dialog was anchored on),
 * never one from above an earlier dialog's end. Taken from the first on the pane, an answered prompt's URL
 * in scrollback was stapled to the question under it.
 */
export function copilotPromptSubject(capture: string, below: number): string | null {
  const lines = capture.replace(ESCAPES, '').split('\n').map((line) => line.trim())
  const floor = earlierDialogEnd(lines, below, below)
  let start = -1
  for (let i = Math.min(below, lines.length) - 1; i > floor; i--) {
    if (ATTEMPT.test(lines[i])) { start = i; break }
  }
  if (start === -1) return null
  const parts: string[] = []
  for (let i = start + 1; i < lines.length && i < start + 12; i++) {
    const line = lines[i]
    // Peel the outer dialog border first, then the subject's own box.
    const inner = line.replace(/^│\s*/, '').replace(/\s*│$/, '').trim()
    if (/^[╭╰├└┌]/.test(inner) || !inner) continue
    const value = inner.replace(/^│\s*/, '').replace(/\s*│$/, '').trim()
    if (!value) continue
    // The question itself ends the subject.
    if (/\?\s*$/.test(value)) break
    parts.push(value)
    if (parts.join(' ').length > MAX_SUBJECT) break
  }
  const subject = parts.join(' ').trim()
  return subject ? subject.slice(0, MAX_SUBJECT) : null
}

/** Fold the subject into the question so the device shows what is being approved. `at` is the line the
 *  dialog was anchored on. */
export function withCopilotSubject(view: PaneView, capture: string, at: number): PaneView {
  if (!view || view.kind !== 'question') return view
  const subject = copilotPromptSubject(capture, at)
  if (!subject || view.question.includes(subject)) return view
  return { ...view, question: `${view.question} — ${subject}` }
}
