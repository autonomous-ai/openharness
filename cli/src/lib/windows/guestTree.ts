/**
 * The Windows guests' own tree, by name (docs/superpowers/specs/2026-11-05-windows-guests-design.md): where the setup
 * task's requests, answers, records and scripts are, each guest host's home, and the format the tree is in.
 *
 * The root is **not** under `C:\ProgramData\Harness`: that folder is readable by Users for the Team account, and every
 * guest is in Users (lib/windows/guestRequests.ts says why at length).
 *
 * In a file of their own: the core needs three of these names, for a guest's create and its terminal host, and loaded
 * the setup task's whole protocol and its folder checks for them (the audit of 2026-11-12).
 */
export const WINDOWS_GUEST_ROOT = 'C:\\ProgramData\\HarnessGuests'
export const WINDOWS_GUEST_REQUESTS = `${WINDOWS_GUEST_ROOT}\\requests`
export const WINDOWS_GUEST_ANSWERS = `${WINDOWS_GUEST_ROOT}\\answers`
export const WINDOWS_GUEST_RECORDS = `${WINDOWS_GUEST_ROOT}\\records`
export const WINDOWS_GUEST_SCRIPTS = `${WINDOWS_GUEST_ROOT}\\scripts`
export const WINDOWS_GUEST_RUNTIME = `${WINDOWS_GUEST_ROOT}\\runtime`
export const WINDOWS_GUEST_HOOK = `${WINDOWS_GUEST_ROOT}\\hook`
/** One home per guest host (`hosts\<user>`): its discovery file, logs and `host.cmd`. */
export const WINDOWS_GUEST_HOSTS = `${WINDOWS_GUEST_ROOT}\\hosts`
/** A guest's own host home (lib/windows/guestHostBackend.ts starts its task on it). */
export const guestHostHome = (user: string): string => `${WINDOWS_GUEST_HOSTS}\\${user}`
/** The format the installer/processor tree is in: an installed tree older than this is set up again. */
export const WINDOWS_GUEST_SETUP_VERSION = 3
/** Where the installer writes the version it put in place. */
export const WINDOWS_GUEST_VERSION_FILE = `${WINDOWS_GUEST_ROOT}\\version`
