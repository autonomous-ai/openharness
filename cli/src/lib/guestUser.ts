/** A guest's OS user, as the guest helper and the Windows set-up name one: `hg_` and 12 hex (lib/guestAccounts.ts
 *  `guestUserFor`). In a file of its own: the core's link to shared machines checks a name with it, and loaded the
 *  whole of the guests' accounts for it (the audit of 2026-11-12). */
const GUEST_USER = /^hg_[0-9a-f]{12}$/

export function isGuestUser(user: string): boolean {
  return GUEST_USER.test(user)
}
