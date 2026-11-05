/**
 * A start this host launched whose engine stopped on a screen before it has a session (task #3009). Nobody sits at a Swarm
 * agent's pane, and the backend failed such a start only at its 3-minute limit, as "did not start it", with nothing of what
 * the screen asked: every Team-written Codex start stopped on Codex's trust question that way (10 of 10, 2026-10-29 to
 * 11-05), and two in a row suspended Codex on its machine. Read once a pass, while the start waits for its session:
 *
 * - A Team-written Codex start's own home names its checkout untrusted (start.ts `untrustCheckout`), so Codex asks to open
 *   it restricted, which keeps the branch's settings off: that exact screen alone is answered (engines/codex/screen.ts
 *   `openRestrictedKeys`), and only while the pane still shows it (inCore/terminal.ts `inputIfScreen`).
 * - Codex's review of hooks it has not seen, on a computer with another program's new hook, is skipped the same way
 *   (`hooksReviewSkipKeys`): those hooks stay off and nothing is trusted. Trusting one is a person's.
 * - Any other screen that waits for a person (terminal.ts `WAITING`) fails the start at once, saying what kind of screen it
 *   was, in fixed words ([hiddenPromptReason]): who started it, its coordinator and its machine's owner read that (backend
 *   startFailure.ts); members read only that the machine could not prepare or launch it.
 */
import type { CoreApi } from '../core/api.js'
import { hooksReviewSkipKeys, openRestrictedKeys } from '../engines/codex/screen.js'
import { WAITING } from './terminal.js'
import type { MessageHold } from '../engines/facets/screen.js'

type Terminal = Pick<NonNullable<CoreApi['superTabs']>, 'screen' | 'inputIfScreen'>

/** Each screen that waits for a person, as a reason names it: fixed words, the engine's own heading where it has one. */
const KINDS: Partial<Record<MessageHold, string>> = {
  trust_open: 'a folder trust question ("Trust this folder?")', sign_in_open: 'a sign-in screen',
  update_prompt_open: 'an update prompt ("Update available")', model_prompt_open: 'a model choice',
  permission_open: 'a permission question', question_open: 'a question', menu_open: 'a menu',
}

/**
 * A failed start's reason: a fixed summary of the kind of screen its engine stopped on, and none of the screen's words.
 * Security review 2 of #3063: the screen's text carried what a terminal shows only its own session (a sign-in link's state
 * wrapped onto the next line, a device code), and on its second read so did its option labels ("Use code 123456", a name, a
 * private file's path): no list of patterns makes a terminal's words safe to send to the start's maker and coordinator.
 * The kind is what they act on; the screen itself stays on its machine.
 */
export function hiddenPromptReason(hold: MessageHold): string {
  return `Its engine stopped on ${KINDS[hold] ?? 'a screen'} that nobody here can answer.`
}

/** What the host did with the screen: answered it, failed the start for it, saw it once (`screen`, to compare with the next
 *  pass's), or nothing (no screen waits, or none read). */
export async function settleHiddenScreen(terminal: Terminal | undefined, harnessId: string, request: Record<string, unknown>,
  previous: string | undefined, fail: (reason: string) => Promise<void>, log: (line: string) => void,
): Promise<{ outcome: 'answered' | 'failed' | 'seen' | null; screen?: string }> {
  if (!terminal) return { outcome: null }
  const read = await terminal.screen(harnessId, 0).catch(() => null)
  if (!read?.ok || !read.hold || !WAITING.has(read.hold as MessageHold)) return { outcome: null }
  const restricted = request.engine === 'codex' && request.projectSettings === 'off' ? openRestrictedKeys(read.text) : null
  const skipReview = request.engine === 'codex' && !restricted ? hooksReviewSkipKeys(read.text) : null
  const keys = restricted ?? skipReview
  if (keys) {
    // A pane that changed meanwhile is read again on the next pass, never answered blind.
    const typed = await terminal.inputIfScreen(harnessId, keys, read.text).catch(() => null)
    if (typed?.ok) log(restricted
      ? `Opened the Team-written checkout restricted for session ${harnessId.slice(0, 8)}, as its engine asked`
      : `Went past the review of another program's hooks for session ${harnessId.slice(0, 8)}: they stay off, and nothing was trusted`)
    return { outcome: typed?.ok ? 'answered' : null }
  }
  // Security review 1 of #3063: one read of a screen still drawing failed a start that would have gone on, and two failures in
  // a row suspend its engine there. Failed only once the next pass, 5 s or more later, reads the very same screen.
  if (previous !== read.text) return { outcome: 'seen', screen: read.text }
  await fail(hiddenPromptReason(read.hold as MessageHold))
  log(`Failed a start at once: session ${harnessId.slice(0, 8)} stopped on a ${read.hold.replace(/_open$/, '')} screen`)
  return { outcome: 'failed' }
}
