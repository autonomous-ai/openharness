import { createHash } from 'node:crypto'
/** A guest's OS user, as the guest helper and the Windows set-up name one: `hg_` and 12 hex (lib/guestAccounts.ts
 *  `guestUserFor`). In a file of its own: the core's link to shared machines checks a name with it, and loaded the
 *  whole of the guests' accounts for it (the audit of 2026-11-12). */
const GUEST_USER = /^hg_[0-9a-f]{12}$/

export function isGuestUser(user: string): boolean {
  return GUEST_USER.test(user)
}

/** Where guests' homes are (the helper's HOME_ROOT): never the owner's own home or `staff`'s reach. On Windows the
 *  guests' own tree (lib/windows/guestTree.ts `WINDOWS_GUEST_ROOT`); their profiles are `C:\Users\hg_<12 hex>`. */
export function guestHomeRoot(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return '/Users/Shared/HarnessGuests'
  if (platform === 'win32') return 'C:\\ProgramData\\HarnessGuests'
  return '/home/harness-guests'
}

/** The OS user a guest gets: `hg_` and the first 12 hex of sha256(the lower-cased email). The helper
 *  derives the same name itself; a test holds the two equal. */
export function guestUserFor(email: string): string {
  return `hg_${createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 12)}`
}

/** Where a guest's harnesses start unless it picks a shared folder: `<home>/work`, as the helper makes it. Windows
 *  guests have an ordinary profile (`C:\Users\hg_<12 hex>\work`), made by the setup task. */
export function guestWorkspaceFor(email: string, platform: NodeJS.Platform = process.platform): string {
  const user = guestUserFor(email)
  return platform === 'win32' ? `C:\\Users\\${user}\\work` : `${guestHomeRoot(platform)}/${user}/work`
}
