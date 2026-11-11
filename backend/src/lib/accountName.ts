import { nameRefusal } from '../superTabs/personNames.js'
import { printable } from '../superTabs/profile.js'

/** Characters, not UTF-16 units: a name in any script, or with an emoji, gets the same room. */
export const MAX_ACCOUNT_NAME_LENGTH = 60

export const INVALID_ACCOUNT_NAME_MESSAGE = `Use 1 to ${MAX_ACCOUNT_NAME_LENGTH} characters, with no hidden ones.`

export type AccountNameRefusal = { ok: false; code: 'INVALID_NAME' | 'NAME_RESERVED'; message: string }

/**
 * The account name a person sets for themselves (`PATCH /api/auth/me`, task #2654): one form (NFC), trimmed, with one
 * space between words; 1 to 60 characters, none of them a control, format (zero-width, bidi), line or paragraph
 * separator, which would hide the name's real shape where it is shown.
 *
 * Outside a Swarm the account name meets no clash check (store reviews, community comments, machine and harness shares,
 * terminal observers), so it also takes the Swarm name's refusals (superTabs/personNames.ts nameRefusal: no web address,
 * no role's or the Swarm's own name; review 1 of #2917), and no `@`: those places show the name alone where people tell
 * each other apart by email, so an email-shaped name could pose as someone else (review 2 of #2917).
 */
export function parseAccountName(input: unknown): { ok: true; name: string } | AccountNameRefusal {
  const invalid: AccountNameRefusal = { ok: false, code: 'INVALID_NAME', message: INVALID_ACCOUNT_NAME_MESSAGE }
  if (typeof input !== 'string') return invalid
  // A tab or any space folds to one space; anything hidden is refused before trim(), which would drop a byte-order mark.
  const folded = input.normalize('NFC').replace(/[\t\p{Zs}]+/gu, ' ')
  if (!printable(folded)) return invalid
  const name = folded.trim()
  if (!name || [...name].length > MAX_ACCOUNT_NAME_LENGTH) return invalid
  // Width variants folded (NFKC), so a full-width ＠ is an @ too.
  if (name.normalize('NFKC').includes('@')) {
    return { ok: false, code: 'INVALID_NAME', message: 'Use a name, not an email address.' }
  }
  const refused = nameRefusal(name)
  if (refused) return { ok: false, ...refused }
  return { ok: true, name }
}
