/**
 * When a submitted message's Enter follows its paste, on every terminal backend (tmux.ts `sendToTmux`,
 * ptyHostBackend.ts `submitText`). One place, so a pane on either backend gets the same engine the same
 * time to take a paste in.
 */

// Short single-line messages need no settling delay, but still need bracketed-paste boundaries:
// Codex treats Enter immediately after an unbracketed text burst as a pasted newline, not submit.
export const INJECT_FASTPATH_MAXLEN = 500
// Base settle time before the submit Enter; grows with length (Claude needs time to ingest a big paste
// and collapse it to `[Pasted text]` before a clean Enter counts as submit rather than paste content).
export const INJECT_PASTE_DELAY_BASE_MS = 400
/** The longest a paste is given before its Enter. (Verified: reliably submits up to ~28 KB.) */
export const INJECT_PASTE_DELAY_MAX_MS = 1500

/** The text a submit pastes: trailing newlines stripped, so the submit Enter isn't doubled. */
export function submitContent(text: string): string {
  return text.replace(/[\r\n]+$/, '')
}

/** How long to wait between pasting [content] and its Enter: none for a short single line. */
export function submitSettleMs(content: string): number {
  const needsSettle = content.length > INJECT_FASTPATH_MAXLEN || /[\r\n]/.test(content)
  return needsSettle ? Math.min(INJECT_PASTE_DELAY_MAX_MS, INJECT_PASTE_DELAY_BASE_MS + Math.floor(content.length / 60)) : 0
}
