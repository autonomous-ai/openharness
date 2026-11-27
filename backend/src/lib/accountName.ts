// Control, format (bidi overrides, zero-width) and line/paragraph separators: words that hide their real shape.
const printable = (value: string) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)

/** A role's name, numbered too ("Lead 2", "pm-3"), and the words readers put in place of a name: never a person's. */
const ROLE = /^(?:lead|builder|agent|new agent|product manager|engineer|pm|dev|reviewer|tester|you|someone)(?:[\s#-]+\d+)?$/i
/** Harness's own voices, compared NFKC and lowercased, numbered too ("System 2"). Look-alike letters of other scripts are out
 *  of scope (review of #2094). */
const RESERVED_NAMES: ReadonlySet<string> = new Set(['admin', 'administrator', 'system', 'harness', 'everyone'])
const reserved = (name: string): boolean => ROLE.test(name) || RESERVED_NAMES.has(name.toLowerCase().replace(/[\s#-]+\d+$/, ''))

/** Characters, not UTF-16 units: a name in any script, or with an emoji, gets the same room. */
export const MAX_ACCOUNT_NAME_LENGTH = 60

export const INVALID_ACCOUNT_NAME_MESSAGE = `Use 1 to ${MAX_ACCOUNT_NAME_LENGTH} characters, with no hidden ones.`

export type AccountNameRefusal = { ok: false; code: 'INVALID_NAME' | 'NAME_RESERVED'; message: string }

/**
 * The account name a person sets for themselves (`PATCH /api/auth/me`, task #2654): one form (NFC), trimmed, with one
 * space between words; 1 to 60 characters, none of them a control, format (zero-width, bidi), line or paragraph
 * separator, which would hide the name's real shape where it is shown.
 *
 * The account name meets no clash check (store reviews, community comments, machine and harness shares, terminal observers),
 * so it refuses a web address, which would show as a link (a protocol-relative one too, security review 2 of #3015), a role's
 * name and Harness's own voices (review 1 of #2917), and an `@`: those places show the name alone where people tell each other
 * apart by email, so an email-shaped name could pose as someone else (review 2 of #2917).
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
  // Read as every compare here reads it: width variants folded (NFKC), so `ＰＭ` is `PM` (review 2 of #2794).
  const wide = name.normalize('NFKC')
  if (/\/\/|^www\./i.test(wide)) return { ok: false, code: 'INVALID_NAME', message: 'Use a name, not a web address.' }
  if (reserved(wide)) return { ok: false, code: 'NAME_RESERVED', message: `${name} is a role's name. Choose another.` }
  return { ok: true, name }
}
