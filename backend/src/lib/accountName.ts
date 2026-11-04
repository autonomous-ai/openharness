// Control, format (zero-width, bidi, byte-order mark) and line/paragraph separators: words that hide their real shape. The
// same set the Swarm refuses in a person's status and name (superTabs/profile.ts printable), kept here so the account
// route loads no Swarm code.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

/** Characters, not UTF-16 units: a name in any script, or with an emoji, gets the same room. */
export const MAX_ACCOUNT_NAME_LENGTH = 60

export const INVALID_ACCOUNT_NAME_MESSAGE = `Use 1 to ${MAX_ACCOUNT_NAME_LENGTH} characters, with no hidden ones.`

/**
 * The account name a person sets for themselves (`PATCH /api/auth/me`, task #2654): one form (NFC), trimmed, with one
 * space between words; 1 to 60 characters, none of them a control, format (zero-width, bidi), line or paragraph
 * separator, which would hide the name's real shape where it is shown.
 */
export function parseAccountName(input: unknown): { ok: true; name: string } | { ok: false } {
  if (typeof input !== 'string') return { ok: false }
  // A tab or any space folds to one space; anything hidden is refused before trim(), which would drop a byte-order mark.
  const folded = input.normalize('NFC').replace(/[\t\p{Zs}]+/gu, ' ')
  if (HIDDEN.test(folded)) return { ok: false }
  const name = folded.trim()
  if (!name || [...name].length > MAX_ACCOUNT_NAME_LENGTH) return { ok: false }
  return { ok: true, name }
}
