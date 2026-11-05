/**
 * A start this host launched whose engine stopped on a screen before it has a session (task #3009). Nobody sits at a Swarm
 * agent's pane, and the backend failed such a start only at its 3-minute limit, as "did not start it", with nothing of what
 * the screen asked: every Team-written Codex start stopped on Codex's trust question that way (10 of 10, 2026-10-29 to
 * 11-05), and two in a row suspended Codex on its machine. Read once a pass, while the start waits for its session:
 *
 * - A Team-written Codex start's own home names its checkout untrusted (start.ts `untrustCheckout`), so Codex asks to open
 *   it restricted, which keeps the branch's settings off: that exact screen alone is answered (engines/codex/screen.ts
 *   `openRestrictedKeys`), and only while the pane still shows it (inCore/terminal.ts `inputIfScreen`).
 * - Any other screen that waits for a person (terminal.ts `WAITING`) fails the start at once, saying what kind of screen it
 *   was and its plain option labels ([hiddenPromptReason]): who started it, its coordinator and its machine's owner read
 *   that (backend startFailure.ts); members read only that the machine could not prepare or launch it.
 */
import type { CoreApi } from '../core/api.js'
import { openRestrictedKeys } from '../engines/codex/screen.js'
import { WAITING } from './terminal.js'
import type { MessageHold } from '../engines/facets/screen.js'

type Terminal = Pick<NonNullable<CoreApi['superTabs']>, 'screen' | 'inputIfScreen'>

/** What each screen that waits for a person is called in a reason. */
const KINDS: Partial<Record<MessageHold, string>> = {
  trust_open: 'a folder trust question', sign_in_open: 'a sign-in screen', update_prompt_open: 'an update prompt',
  model_prompt_open: 'a model choice', permission_open: 'a permission question', question_open: 'a question', menu_open: 'a menu',
}
const MAX_OPTIONS = 5, MAX_OPTION = 60
/** Words a terminal shows only its own session: a link (whole or wrapped onto the next line), a query's key=value, an email,
 *  and an opaque code or token (letters and digits mixed, such as a device code). */
const PRIVATE = /:\/\/|www\.|[?&=@]|\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{8,}\b|\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/

/**
 * A failed start's reason: the kind of screen its engine stopped on and the screen's own option labels, nothing else. Security
 * review 2 of #3063: the whole screen carried what a terminal shows only its own session (a sign-in link's state wrapped onto
 * the next line, a device code, an account's email) to the start's maker and coordinator, across the terminal's privacy
 * boundary; and a malformed link threw before the failure was sent. An option that reads like any of those is left out, and
 * nothing here can throw.
 */
export function hiddenPromptReason(text: string, hold: MessageHold): string {
  const options = text.split('\n').map(line => /^\s*[›❯>]?\s*(\d+)\.\s+(.+?)\s*$/u.exec(line)).flatMap(row =>
    row && row[2]!.length <= MAX_OPTION && !PRIVATE.test(row[2]!) ? [`${row[1]}. ${row[2]}`] : []).slice(0, MAX_OPTIONS)
  return `Its engine stopped on ${KINDS[hold] ?? 'a screen'} nobody here can answer${options.length ? ` (${options.join('; ')})` : ''}.`
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
  const reason = hiddenPromptReason(read.text, read.hold as MessageHold)
  await fail(reason)
  log(`Failed a start at once: session ${harnessId.slice(0, 8)} stopped on a ${read.hold.replace(/_open$/, '')} screen`)
  return 'failed'
}
