/**
 * The guests' OS accounts on Windows, as services/guestLaunches.ts reads them: a thin adapter over the setup task
 * (lib/windows/guestSetupClient.ts), which does the privileged work through `\Harness\Harness Guests Setup`. There is
 * no `sudo` and no helper here, and the owner never holds a guest's password: the setup task makes the account.
 *
 * Only what a launch, a share change and the sync read is here. Installing an engine as the guest is the guest's own
 * step (the engine is on the guest's PATH in its host's pane), so nothing in this path installs it from the owner's.
 */
import { readdirSync } from 'node:fs'
import { isGuestUser, type GuestAccount, type SharedFolder } from '../guestAccounts.js'
import { WINDOWS_GUEST_HOSTS } from './guestTree.js'
import { createGuestSetupClient, type GuestSetupClient } from './guestSetupClient.js'

export interface WindowsGuestAccountsDeps {
  /** The owner's profile; the setup client uses it to refuse paths inside other profiles. */
  ownerHome: string
  /** The setup task's client; a seam for tests. */
  client?: Pick<GuestSetupClient, 'ensureGuest' | 'setFolders' | 'removeGuest'>
  /** The names in the guest host root (`hosts\<user>`), which the setup task makes per guest; a seam for tests. */
  hosts?: () => string[]
}

/** What guestLaunches needs of the accounts (lib/guestAccounts.ts `GuestAccounts`, narrower). */
export interface WindowsGuestAccounts {
  ensureGuest(email: string): Promise<GuestAccount>
  shareFolders(user: string, folders: readonly SharedFolder[]): Promise<void>
  guests(): string[]
}

export function createWindowsGuestAccounts(deps: WindowsGuestAccountsDeps): WindowsGuestAccounts {
  const client = deps.client ?? createGuestSetupClient({ ownerHome: deps.ownerHome })
  const hosts = deps.hosts ?? (() => {
    try { return readdirSync(WINDOWS_GUEST_HOSTS) } catch { return [] }
  })
  return {
    // The setup task derives the same `hg_<12 hex>` the macOS helper does, and answers with the exact profile.
    ensureGuest: (email) => client.ensureGuest(email),
    // The setup task takes the owner's whole set: it changes only the difference from its own record.
    shareFolders: (user, folders) => client.setFolders(user, folders.map((folder) => ({ path: folder.path, write: folder.write }))),
    // Every guest with a host home has an account the owner may share with; one mid-remove may still be listed and
    // is simply asked for no folders again. A tree that is not there yet is no guest, not an error.
    guests: () => { try { return hosts().filter(isGuestUser).sort() } catch { return [] } },
  }
}
