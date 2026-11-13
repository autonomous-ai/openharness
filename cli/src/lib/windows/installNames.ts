/**
 * Two names of the Windows install layout that code beyond the installer and the updater reads (./installLayout.ts,
 * ./cliVersions.ts). In a file of their own: the core needs the one to tell an installed copy by its folder and the
 * other to name the stable hook file, and loaded the layout's pointer files and the updater's version folders for them
 * (the audit of 2026-11-12).
 */

/** `cli\notify.mjs`: the stable copy that hook command lines name. */
export const STABLE_NOTIFY = 'notify.mjs'

/** A build's folder name under cli\: its version, as the release names it (`0.5.0`, `0.5.1-dev.ab12`). Semver's
 *  identifiers, none empty: Windows drops a name's trailing dot, and the pointer refuses `..` (./installLayout.ts). */
export const VERSION_FOLDER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
