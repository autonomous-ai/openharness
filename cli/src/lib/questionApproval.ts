import type { QuestionView } from '../engines/facets/screen.js'

/** The first row of an approval, measured across claude, commandcode, codex, devin, grok, amp and kilo. */
export const APPROVE_RE = /^(yes|allow|approve|accept|proceed|run|continue)\b/i
/** \u2026and the row that declines it. Never dropped \u2014 see the rule amp's parser states: a device user given
 *  three ways to say yes and none to say no cannot answer the prompt at all. */
// `skip` is here because cursor's decline row is "Skip & tell the agent what to do instead" — an engine
// whose only way to refuse says neither "no" nor "reject" would otherwise fail the yes/no guard and its
// whole prompt would go unread.
// Claude's plan review does not use a negative verb at all: its only refusal
// row is "Tell Claude what to change". Keep `tell ... what to change` narrow so
// an ordinary numbered list beginning with "Tell" cannot become an approval.
export const REJECT_RE = /^(no|reject|deny|decline|cancel|skip|don'?t|stop)\b|^tell\b.*\bwhat to change\b/i

/**
 * A dialog that asks to RUN or CHANGE something (an approval), whichever parser read it: a framed
 * permission prompt, or a footer dialog whose first row approves, whose rows include a rejection, and
 * which names a command (`$ …`) or asks "would you like to run / make …". Core consent and worker screen holds share this classification.
 * Keeping typed question facts separate avoids loading raw pane parsers into core.
 */
export function isApprovalDialog(view: QuestionView): boolean {
  if (view.permission) return true
  if (!view.rows.length || !APPROVE_RE.test(view.rows[0].label) || !view.rows.some((row) => REJECT_RE.test(row.label))) return false
  const text = view.dialog ?? view.question
  return /(^|\n)\s*\$ /.test(text) || /would you like to (run|make|apply|execute|edit|write)/i.test(text)
}

