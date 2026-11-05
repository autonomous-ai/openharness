/**
 * A start this host launched whose engine stopped on a screen before it has a session (task #3009). Nobody sits at a Swarm
 * agent's pane, and the backend failed such a start only at its 3-minute limit, as "did not start it", with nothing of what
 * the screen asked: every Team-written Codex start stopped on Codex's trust question that way (10 of 10, 2026-10-29 to
 * 11-05), and two in a row suspended Codex on its machine. Read once a pass, while the start waits for its session:
 *
 * - A Team-written Codex start's own home names its checkout untrusted (start.ts `untrustCheckout`), so Codex asks to open
 *   it restricted, which keeps the branch's settings off: that exact screen alone is answered (engines/codex/screen.ts
 *   `openRestrictedKeys`), and only while the pane still shows it (inCore/terminal.ts `inputIfScreen`).
 * - Any other screen that waits for a person (terminal.ts `WAITING`) fails the start at once, with the screen's words: who
 *   started it, its coordinator and its machine's owner read them (backend startFailure.ts); members read only that the
 *   machine could not prepare or launch it.
 */
import type { CoreApi } from '../core/api.js'
import { openRestrictedKeys } from '../engines/codex/screen.js'
import { WAITING } from './terminal.js'
import type { MessageHold } from '../engines/facets/screen.js'

type Terminal = Pick<NonNullable<CoreApi['superTabs']>, 'screen' | 'inputIfScreen'>

/** The backend keeps a reason whole; a screen's words are cut well before, so a reason stays a line people read. */
const MAX_REASON = 600

/** The screen's words as a failure reason: its lines in order, a link cut to its site (a sign-in link carries its state). */
export function hiddenPromptReason(text: string): string {
  const words = text.split('\n').map(line => line.trim()).filter(Boolean)
    .map(line => line.replace(/https?:\/\/[^\s/?#]+[^\s]*/g, link => new URL(link).origin)).join(' / ')
  const reason = `Its engine stopped on a screen nobody here can answer: ${words}`
  return reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON - 1)}…` : reason
}

/** What the host did with the screen: answered it, failed the start for it, or nothing (no screen waits, or none read). */
export async function settleHiddenScreen(terminal: Terminal | undefined, harnessId: string, request: Record<string, unknown>,
  fail: (reason: string) => Promise<void>, log: (line: string) => void): Promise<'answered' | 'failed' | null> {
  if (!terminal) return null
  const read = await terminal.screen(harnessId, 0).catch(() => null)
  if (!read?.ok || !read.hold || !WAITING.has(read.hold as MessageHold)) return null
  const keys = request.engine === 'codex' && request.projectSettings === 'off' ? openRestrictedKeys(read.text) : null
  if (keys) {
    // A pane that changed meanwhile is read again on the next pass, never answered blind.
    const typed = await terminal.inputIfScreen(harnessId, keys, read.text).catch(() => null)
    if (typed?.ok) log(`Opened the Team-written checkout restricted for session ${harnessId.slice(0, 8)}, as its engine asked`)
    return typed?.ok ? 'answered' : null
  }
  const reason = hiddenPromptReason(read.text)
  await fail(reason)
  log(`Failed a start at once: session ${harnessId.slice(0, 8)} stopped on a ${read.hold.replace(/_open$/, '')} screen`)
  return 'failed'
}
