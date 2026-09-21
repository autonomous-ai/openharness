import { createHash } from 'node:crypto'

/**
 * The user's private harness grid NAME — minted here, remembered here.
 *
 * The CLI cannot do this itself and should not try. `~/.harness/auth/session.json` holds tokens, a
 * machineId and a computerId — not the account's email and not its id — so a name derived on a
 * machine would differ from the one derived on the next machine, and the second machine would create
 * a SECOND grid rather than find the first. The backend holds both inputs and is the only party that
 * can referee two machines signing in at once, so the whole answer is minted here and handed out.
 */

/** Longest the email half may be, so the whole name stays readable at a glance. */
const LOCAL_PART_MAX = 32
/**
 * Hex characters of account-id hash appended to the email half.
 *
 * Collisions only matter between users who share an email local-part — `admin@`, `info@`, `dev@` are
 * the realistic cases, and they are exactly the ones most likely to be shared. At 8 hex (4.3 × 10⁹) a
 * thousand users on one local-part collide with probability ≈ 0.01%; at 6 it is ≈ 3%.
 */
const SUFFIX_HEX = 8

/**
 * `<email local-part>-<8 hex of sha256(user id)>`, e.g. `anhthuychaucfc-7f3a91c4`.
 *
 * Derived rather than random so the value is reproducible when someone has to support it. The stored
 * string is authoritative either way: this runs once, at mint, and changing it later never renames a
 * grid that already exists.
 *
 * The local part is reduced to `[a-z0-9-]` — the same reduction the CLI's `gridProviderId` applies
 * downstream — so what is stored is exactly what is sent to the control plane. `first.last@`,
 * `foo+tag@` and a local part of pure punctuation are all ordinary inputs; the last falls back to
 * `user` rather than producing a name that is only a suffix.
 */
export function harnessGridName(email: string, userId: string): string {
  const localPart = (email.split('@')[0] ?? '').toLowerCase()
  const slug = localPart
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, LOCAL_PART_MAX)
    .replace(/^-+|-+$/g, '')
  const suffix = createHash('sha256').update(userId).digest('hex').slice(0, SUFFIX_HEX)
  return `${slug || 'user'}-${suffix}`
}
