/** The core stops that keep the daemon stopped: the master exits after them, and launchd, systemd and Windows leave a
 *  clean exit stopped. A revoked sign-in, a computer in use elsewhere, and a Harness Team account's daemon with no agent
 *  left in it (superTabs/inCore/teamRetire.ts). */
const FOR_GOOD = new Set(['revoked', 'busy', 'retired'])

export const stopsForGood = (reason: string): boolean => FOR_GOOD.has(reason)
